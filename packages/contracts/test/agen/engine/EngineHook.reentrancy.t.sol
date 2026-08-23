// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {VerdantConstants} from "../../../src/libraries/VerdantConstants.sol";
import {AgenEngineHook} from "../../../src/agen/engine/AgenEngineHook.sol";
import {AgenEngineVault} from "../../../src/agen/engine/AgenEngineVault.sol";
import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";
import {EngineFixture} from "./EngineFixture.sol";

/// @notice Several swaps inside one `unlock`, which is the only reentrant shape v4 permits.
///
/// @dev v4 has no per-callback lock. `unlock` cannot be nested, but *within* one unlock a
/// caller may perform as many operations as it likes in any order, so the hook can be entered
/// several times before any of them settles. That is the reentrancy the engine actually faces,
/// and a router, an aggregator or an arbitrageur reaches it in the ordinary course of business
/// rather than as an attack.
///
/// Settlement is deferred to the end deliberately: every swap's delta accumulates and is
/// settled once, so the hook is entered repeatedly with the manager holding nothing settled
/// for the currencies involved. A fee path that assumed it could observe settled balances, or
/// that credited the vault from a running total rather than from its own swap, comes apart
/// here and nowhere else.
contract Batcher is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager private immutable _manager;

    struct Leg {
        PoolKey key;
        SwapParams params;
    }

    constructor(IPoolManager manager_) {
        _manager = manager_;
    }

    function run(Leg[] memory legs) external {
        _manager.unlock(abi.encode(legs));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(_manager), "not the manager");

        Leg[] memory legs = abi.decode(data, (Leg[]));

        // Every swap first, settlement afterwards. See the note above: this is what makes the
        // hook run several times against unsettled state.
        for (uint256 i = 0; i < legs.length; i++) {
            _manager.swap(legs[i].key, legs[i].params, "");
        }

        for (uint256 i = 0; i < legs.length; i++) {
            _settle(legs[i].key.currency0);
            _settle(legs[i].key.currency1);
        }

        return "";
    }

    function _settle(Currency currency) private {
        int256 owed = _manager.currencyDelta(address(this), currency);
        if (owed == 0) return;

        if (owed < 0) {
            _manager.sync(currency);
            MockERC20(Currency.unwrap(currency)).transfer(address(_manager), uint256(-owed));
            _manager.settle();
        } else {
            _manager.take(currency, address(this), uint256(owed));
        }
    }
}

/// @notice A vault that tries to call back into the hook while the hook is inspecting it.
///
/// @dev `configure` reads four things off the vault it is handed — `hook()`, `currency()`,
/// `recipientCount()` and `shareAt()` — before it writes anything, and the write is what sets
/// `configured`. Read in isolation that looks like a reentrancy: a vault whose getters called
/// back would find the market not yet configured and could try to configure it again.
///
/// It is not one, and the reason is worth having a test for because it is not visible in the
/// hook's own source. All four members are declared `public immutable` or `view` on
/// `AgenEngineVault`, and `configure` calls them through that type — so Solidity emits
/// `STATICCALL`, and the EVM forbids any state change beneath a static call. A vault that
/// tries to reenter does not fail a check; it cannot execute at all.
///
/// That makes the boundary structural rather than a matter of ordering. Even if `configured`
/// were written last on purpose, and even if the factory could be made to hand over a foreign
/// vault, this path stays shut. The tests below assert both halves: that the attempt reverts,
/// and that the same vault configures normally once it stops trying — so the revert is the
/// reentrancy being refused rather than the fixture being broken.
contract ReenteringVault {
    AgenEngineHook public immutable engineHook;
    /// @dev `configure` checks this against the fee currency it derived, so a hostile vault
    /// still has to claim the right one to get as far as the reentry.
    Currency public immutable currency;

    PoolKey private _key;
    /// @dev Held encoded, because Solidity cannot copy a struct array from memory to storage
    /// and `Config` carries four of them.
    bytes private _encodedConfig;
    bool public armed;
    uint256 public attempts;
    bool public innerSucceeded;

    constructor(AgenEngineHook hook_, Currency currency_) {
        engineHook = hook_;
        currency = currency_;
    }

    function arm(PoolKey memory key, AgenRuleLib.Config memory config) external {
        _key = key;
        _encodedConfig = abi.encode(config);
        armed = true;
    }

    function hook() external returns (address) {
        if (armed) {
            armed = false;
            attempts++;

            AgenRuleLib.Config memory config = abi.decode(_encodedConfig, (AgenRuleLib.Config));
            try engineHook.configure(_key, config, AgenEngineVault(payable(address(this)))) {
                innerSucceeded = true;
            } catch {
                innerSucceeded = false;
            }
        }
        return address(engineHook);
    }

    function recipientCount() external pure returns (uint256) {
        return 1;
    }

    function shareAt(uint256) external pure returns (uint24) {
        return uint24(AgenRuleLib.PPM_ONE);
    }

    function credit(uint256) external {}
}

/// @title Reentrancy against the engine hook
///
/// @notice Whether the hook can be made to charge twice, credit the wrong vault, mutate a
/// configuration or accept an unauthorised callback, by entering it while it is already in
/// flight.
///
/// @dev `EngineHook.isolation.t.sol` proves two markets do not leak into each other across
/// separate transactions, and that every callback refuses a caller that is not the
/// PoolManager. What neither establishes is what happens when the hook is entered *again
/// before the first entry has settled*, which is the shape a reentrancy actually takes.
///
/// ## Why the interesting version of this attack does not exist
///
/// The finding worth recording is a negative one, and it is structural rather than tested:
/// **the engine's swap path contains no call to any address a creator, a trader or a model
/// chooses.**
///
/// `_charge` makes exactly two external calls — `poolManager.mint` and `vault.credit` — and
/// both targets are fixed. The manager is an immutable of the hook. The vault is
/// `AgenEngineVault` bytecode deployed by `AgenEngineDeployer` in the launch transaction, it
/// has no owner and no upgrade path, and `credit` makes no call of its own. Fee recipients are
/// addresses a creator chose, and they are never called during a swap: they are paid only by
/// `claim`, which happens in its own transaction. `AgenRuleLib.Recipient` carries no calldata,
/// no target and no selector, so a "recipient" cannot be a callback.
///
/// So there is no attacker-controlled code to reenter *from*. The only remaining reentrancy is
/// the one v4 permits by design — a caller performing several operations inside one unlock —
/// and that is what the tests below do, in the shapes that would expose a double charge, a
/// mis-credited vault or cross-pool corruption if any existed.
///
/// The one place the hook does call an address it was handed is `configure`, and that argument
/// comes from the factory alone. `test_a_vault_that_reenters_configure` establishes what
/// happens there and why it is not reachable.
contract EngineHookReentrancyTest is EngineFixture {
    using PoolIdLibrary for PoolKey;

    MockERC20 internal secondToken;

    PoolKey internal keyA;
    PoolKey internal keyB;
    AgenEngineVault internal vaultA;
    AgenEngineVault internal vaultB;

    Batcher internal batcher;

    /// @dev A's rate, flat, quote-denominated.
    uint24 internal constant RATE_A = 20_000;
    /// @dev B's base rate, with a sell tier above it and fees in the launched token.
    uint24 internal constant RATE_B = 5_000;
    uint24 internal constant TIER_B = 40_000;

    function setUp() public {
        _deployEngine();

        keyA = _keyFor();
        vaultA = _openPool(keyA, _flatConfig(true, RATE_A));

        secondToken = new MockERC20("Gamma", "GAMMA", 18);
        _openSecondMarket();

        batcher = new Batcher(manager);
        _fundBatcher();
    }

    /// @dev A second market sharing A's quote asset, with deliberately different economics —
    /// a different rate, a different fee currency, a tier where A has none. Sharing the quote
    /// is what makes a cross-pool mistake possible at all: a hook that keyed anything off a
    /// currency rather than a `PoolId` would conflate them.
    function _openSecondMarket() private {
        (Currency c0, Currency c1) = address(lower) < address(secondToken)
            ? (Currency.wrap(address(lower)), Currency.wrap(address(secondToken)))
            : (Currency.wrap(address(secondToken)), Currency.wrap(address(lower)));

        keyB = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        AgenRuleLib.Config memory config = _flatConfig(true, RATE_B);
        config.quoteAsset = address(lower);
        config.feeCurrency = uint8(AgenRuleLib.FeeCurrency.Token);
        config.sellTiers = new AgenRuleLib.Tier[](1);
        config.sellTiers[0] = AgenRuleLib.Tier({thresholdTokens: ONE_PERCENT, feePpm: TIER_B});

        bool quoteIsZero = Currency.unwrap(c0) == address(lower);
        address[] memory recipients = new address[](1);
        recipients[0] = creator;
        uint24[] memory shares = new uint24[](1);
        shares[0] = uint24(AgenRuleLib.PPM_ONE);

        vaultB = new AgenEngineVault(address(hook), manager, quoteIsZero ? c1 : c0, recipients, shares);

        hook.configure(keyB, config, vaultB);
        manager.initialize(keyB, _sqrtAtZero());

        secondToken.mint(address(shim), SUPPLY);
        int24 spacing = VerdantConstants.TICK_SPACING;
        shim.addLiquidity(keyB, -spacing * 1000, spacing * 1000, 1_000_000e18);
    }

    function _sqrtAtZero() private pure returns (uint160) {
        // 1:1, which is what `TickMath.getSqrtPriceAtTick(0)` returns.
        return 79_228_162_514_264_337_593_543_950_336;
    }

    function _fundBatcher() private {
        lower.mint(address(batcher), SUPPLY / 10);
        upper.mint(address(batcher), SUPPLY / 10);
        secondToken.mint(address(batcher), SUPPLY / 10);
    }

    /// @dev An exact-input buy of `amount` of the quote asset.
    ///
    /// Both markets are quoted in `lower`, but it does not sort to the same side in both — it
    /// is `currency0` against `upper` and either side against `secondToken`. A buy spends the
    /// quote, so `zeroForOne` is whether the quote is `currency0`, worked out from the key
    /// rather than assumed.
    function _buy(PoolKey memory key, uint256 amount) private view returns (Batcher.Leg memory) {
        bool quoteIsZero = Currency.unwrap(key.currency0) == address(lower);

        return Batcher.Leg({
            key: key,
            params: SwapParams({
                zeroForOne: quoteIsZero,
                // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: quoteIsZero ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            })
        });
    }

    // --- several swaps in one unlock ----------------------------------------

    /// @notice Two swaps against the same market in one unlock are charged once each.
    ///
    /// @dev The double-charge case. The hook is entered four times here — `beforeSwap` and
    /// `afterSwap` for each leg — with nothing settled in between, so a fee path that
    /// accumulated across entries, or that read a balance to decide what it had already taken,
    /// would charge the second leg twice or not at all.
    function test_two_swaps_on_one_market_in_one_unlock_are_charged_once_each() public {
        uint256 amount = 1e18;

        Batcher.Leg[] memory legs = new Batcher.Leg[](2);
        legs[0] = _buy(keyA, amount);
        legs[1] = _buy(keyA, amount);

        uint256 before = vaultA.totalAccrued();
        batcher.run(legs);

        assertEq(
            vaultA.totalAccrued() - before,
            2 * ((amount * RATE_A) / 1e6),
            "two buys in one unlock did not pay exactly two fees"
        );
    }

    /// @notice Interleaved swaps across two markets credit each market's own vault.
    ///
    /// @dev The cross-pool corruption case, in the one ordering that could produce it. The two
    /// markets share a quote asset and differ in every rule, so a hook that resolved a market
    /// by currency, by the shared hook address, or by anything other than the `PoolId` would
    /// credit the wrong vault or apply the wrong rate — and interleaving them inside a single
    /// unlock is what removes any chance of the first market's state having been cleared before
    /// the second is entered.
    function test_interleaved_markets_in_one_unlock_do_not_contaminate_each_other() public {
        uint256 amount = 1e18;

        Batcher.Leg[] memory legs = new Batcher.Leg[](4);
        legs[0] = _buy(keyA, amount);
        legs[1] = _buy(keyB, amount);
        legs[2] = _buy(keyA, amount);
        legs[3] = _buy(keyB, amount);

        uint256 beforeA = vaultA.totalAccrued();
        uint256 beforeB = vaultB.totalAccrued();

        batcher.run(legs);

        // A charges its own flat rate on the quote leg it named, twice.
        assertEq(
            vaultA.totalAccrued() - beforeA,
            2 * ((amount * RATE_A) / 1e6),
            "market A was charged at something other than its own rate"
        );

        // B's fee is token-denominated, so its amount depends on the pool's output and is not
        // a fixed figure. What must hold is that it was charged at all, at its own base rate
        // rather than A's, and into its own vault.
        uint256 chargedB = vaultB.totalAccrued() - beforeB;
        assertGt(chargedB, 0, "market B was not charged");
        assertEq(uint256(hook.feePpmFor(keyB.toId(), true, 0)), RATE_B, "market B's rate moved because market A traded");

        // Neither vault holds the other's currency, which is the crude form of the same check
        // and the one that would catch a mint to the wrong vault.
        assertTrue(
            Currency.unwrap(vaultA.currency()) != Currency.unwrap(vaultB.currency()),
            "this test is not comparing two different fee currencies"
        );
    }

    /// @notice The hook keeps nothing, however many times it is entered in one unlock.
    ///
    /// @dev Custody, under the reentrant shape. `_charge` mints to the vault rather than to
    /// itself and the hook has no withdrawal path at all, so the balance must be zero — and a
    /// balance that only became non-zero under batching would be the kind of leak that is
    /// invisible in single-swap tests.
    function test_the_hook_holds_nothing_after_a_batch() public {
        Batcher.Leg[] memory legs = new Batcher.Leg[](4);
        legs[0] = _buy(keyA, 1e18);
        legs[1] = _buy(keyB, 1e18);
        legs[2] = _buy(keyA, 2e18);
        legs[3] = _buy(keyB, 3e18);

        batcher.run(legs);

        assertEq(lower.balanceOf(address(hook)), 0, "the hook kept quote asset");
        assertEq(upper.balanceOf(address(hook)), 0, "the hook kept market A's token");
        assertEq(secondToken.balanceOf(address(hook)), 0, "the hook kept market B's token");

        // And no claims either, which is the form the fee is in at the moment it is created.
        // A hook that minted to itself rather than to the vault would show up here and nowhere
        // in the ERC-20 balances above.
        assertEq(
            manager.balanceOf(address(hook), Currency.wrap(address(lower)).toId()),
            0,
            "the hook kept claims on the quote asset"
        );
        assertEq(
            manager.balanceOf(address(hook), Currency.wrap(address(upper)).toId()),
            0,
            "the hook kept claims on market A's token"
        );
        assertEq(
            manager.balanceOf(address(hook), Currency.wrap(address(secondToken)).toId()),
            0,
            "the hook kept claims on market B's token"
        );
    }

    /// @notice Both vaults remain solvent after a batch, so no credit outran its backing.
    ///
    /// @dev `AgenEngineVault.credit` reverts with `Undercredited` if the ledger would promise
    /// more than the vault's claims and balance cover. Inside a batch the claims arrive several
    /// times before anything settles, which is precisely the state in which a mint and a credit
    /// could come apart — so a successful batch is itself the assertion, and `outstanding`
    /// against backing is the explicit form of it.
    function test_no_credit_outruns_its_backing_inside_a_batch() public {
        Batcher.Leg[] memory legs = new Batcher.Leg[](3);
        legs[0] = _buy(keyA, 1e18);
        legs[1] = _buy(keyA, 5e18);
        legs[2] = _buy(keyB, 2e18);

        batcher.run(legs);

        for (uint256 i = 0; i < 2; i++) {
            AgenEngineVault vault = i == 0 ? vaultA : vaultB;
            uint256 backing = manager.balanceOf(address(vault), vault.currency().toId())
                + MockERC20(Currency.unwrap(vault.currency())).balanceOf(address(vault));

            assertGe(backing, vault.outstanding(), "a vault owes more than it holds");
        }
    }

    // --- configuration under attack -----------------------------------------

    /// @notice A vault cannot reenter `configure`, because it is not called with the power to.
    ///
    /// @dev The one place the hook calls an address it was handed, and the reason the call is
    /// safe is not the ordering of the writes — it is that `AgenEngineVault.hook()` is an
    /// immutable getter, so `configure` reaches it by `STATICCALL`. A vault that attempts
    /// anything stateful beneath that, including calling back into `configure`, fails with the
    /// EVM's own `StateChangeDuringStaticCall` and takes the outer call down with it.
    ///
    /// So the market is left exactly as it was: unconfigured. Nothing partial is written,
    /// because a revert is a revert.
    function test_a_vault_cannot_reenter_configure() public {
        (PoolKey memory key, AgenRuleLib.Config memory config, ReenteringVault hostile) = _hostileMarket();
        hostile.arm(key, config);

        vm.expectRevert();
        hook.configure(key, config, AgenEngineVault(payable(address(hostile))));

        // Not merely refused: left untouched. A market half-configured by a reverted call would
        // be a pool that `beforeInitialize` lets through with rules nobody agreed to.
        PoolId poolId = key.toId();
        assertFalse(hook.isConfigured(poolId), "a reverted configure left the market configured");
        assertEq(hook.configHashOf(poolId), bytes32(0), "a reverted configure wrote an identity");
    }

    /// @notice The same vault, no longer trying to reenter, configures normally.
    ///
    /// @dev The control. Without it the test above passes just as happily if the hostile vault
    /// were rejected for some unrelated reason — a wrong currency, a share that does not total
    /// one whole — and would be asserting nothing about reentrancy at all.
    function test_the_same_vault_configures_once_it_stops_reentering() public {
        (PoolKey memory key, AgenRuleLib.Config memory config, ReenteringVault hostile) = _hostileMarket();

        bytes32 stored = hook.configure(key, config, AgenEngineVault(payable(address(hostile))));

        PoolId poolId = key.toId();
        assertTrue(hook.isConfigured(poolId), "the market was not configured");
        assertEq(stored, AgenRuleLib.hashConfig(config), "the stored hash is not the hash of the stored rules");
        assertEq(hostile.attempts(), 0, "the vault reentered when it was not armed to");

        // And once written, never again — whoever asks.
        vm.expectRevert(abi.encodeWithSelector(AgenEngineHook.AlreadyConfigured.selector, poolId));
        hook.configure(key, config, AgenEngineVault(payable(address(hostile))));
    }

    /// @dev A fresh pair, a valid configuration for it, and a vault that will reenter if armed.
    function _hostileMarket()
        private
        returns (PoolKey memory key, AgenRuleLib.Config memory config, ReenteringVault hostile)
    {
        MockERC20 third = new MockERC20("Delta", "DELTA", 18);

        (Currency c0, Currency c1) = address(lower) < address(third)
            ? (Currency.wrap(address(lower)), Currency.wrap(address(third)))
            : (Currency.wrap(address(third)), Currency.wrap(address(lower)));

        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        config = _flatConfig(true, 30_000);
        config.quoteAsset = address(lower);

        // The fee is quote-denominated, so the vault must claim to hold the quote asset.
        bool quoteIsZero = Currency.unwrap(c0) == address(lower);
        hostile = new ReenteringVault(hook, quoteIsZero ? c0 : c1);
    }

    /// @notice The factory is the only account that can reach `configure` at all.
    ///
    /// @dev Restated here rather than left to the isolation suite, because it is the check
    /// that makes the test above a documentation of a boundary rather than a live hole. If
    /// `configure` were ever opened up, the reentrancy above becomes reachable by anybody.
    function test_configure_is_reachable_only_by_the_factory() public {
        MockERC20 third = new MockERC20("Delta", "DELTA", 18);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(lower)),
            currency1: Currency.wrap(address(third)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(AgenEngineHook.NotFactory.selector, trader));
        hook.configure(key, _flatConfig(true, 10_000), vaultA);
    }

    // --- unauthorised callbacks, under a live unlock -------------------------

    /// @notice A swap callback called directly is refused even while a swap is in progress.
    ///
    /// @dev The isolation suite proves the callbacks refuse a non-manager caller from a plain
    /// transaction. This asserts the check is `msg.sender` rather than anything about whether
    /// the manager happens to be mid-unlock — a hook whose authorisation weakened during a
    /// swap would be exploitable by any contract a swap touches.
    function test_a_callback_is_refused_from_inside_a_live_unlock() public {
        Prober prober = new Prober(manager, hook);

        lower.mint(address(prober), SUPPLY / 100);
        upper.mint(address(prober), SUPPLY / 100);

        prober.probe(keyA);

        assertTrue(prober.beforeSwapRefused(), "beforeSwap was accepted from a stranger mid-unlock");
        assertTrue(prober.afterSwapRefused(), "afterSwap was accepted from a stranger mid-unlock");
    }
}

/// @notice Calls the hook's swap callbacks directly from inside its own unlock.
///
/// @dev Separate from `Batcher` because it must reach the hook while an unlock is open but
/// without performing a swap the hook would legitimately be called for.
contract Prober is IUnlockCallback {
    IPoolManager private immutable _manager;
    AgenEngineHook private immutable _hook;

    bool public beforeSwapRefused;
    bool public afterSwapRefused;

    constructor(IPoolManager manager_, AgenEngineHook hook_) {
        _manager = manager_;
        _hook = hook_;
    }

    function probe(PoolKey memory key) external {
        _manager.unlock(abi.encode(key));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(_manager), "not the manager");

        PoolKey memory key = abi.decode(data, (PoolKey));

        SwapParams memory params =
            SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: 4_295_128_740});

        try _hook.beforeSwap(address(this), key, params, "") {
            beforeSwapRefused = false;
        } catch {
            beforeSwapRefused = true;
        }

        try _hook.afterSwap(address(this), key, params, BalanceDelta.wrap(0), "") {
            afterSwapRefused = false;
        } catch {
            afterSwapRefused = true;
        }

        return "";
    }
}
