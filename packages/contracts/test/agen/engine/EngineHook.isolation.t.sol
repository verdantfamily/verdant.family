// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {VerdantConstants} from "../../../src/libraries/VerdantConstants.sol";
import {AgenEngineHook} from "../../../src/agen/engine/AgenEngineHook.sol";
import {AgenEngineVault} from "../../../src/agen/engine/AgenEngineVault.sol";
import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";
import {EngineFixture} from "./EngineFixture.sol";

/// @notice Swaps straight at the PoolManager, with no router in between.
/// @dev The engine must not depend on being reached through `AgenRouter`. A hook whose
/// correctness relies on its callers is a hook with a hole, and the whole reason engine v1
/// has no wallet primitives is that trader identity cannot be trusted here.
contract DirectSwapper is IUnlockCallback {
    IPoolManager private immutable _manager;

    constructor(IPoolManager manager_) {
        _manager = manager_;
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes memory hookData) external {
        _manager.unlock(abi.encode(key, params, hookData));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(_manager), "not the manager");

        (PoolKey memory key, SwapParams memory params, bytes memory hookData) =
            abi.decode(data, (PoolKey, SwapParams, bytes));

        BalanceDelta delta = _manager.swap(key, params, hookData);

        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());
        return "";
    }

    function _settle(Currency currency, int128 amount) private {
        if (amount == 0) return;
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            _manager.sync(currency);
            MockERC20(Currency.unwrap(currency)).transfer(address(_manager), owed);
            _manager.settle();
        } else {
            _manager.take(currency, address(this), uint256(uint128(amount)));
        }
    }
}

/// @title Isolation and adversarial behaviour
///
/// @notice One hook serves every market, so "does pool A leak into pool B" is the question
/// the shared design has to answer. It is answered here by running two markets with
/// deliberately different economics side by side and asserting each behaves as though the
/// other did not exist.
contract EngineHookIsolationTest is EngineFixture {
    using PoolIdLibrary for PoolKey;

    MockERC20 internal secondToken;

    PoolKey internal keyA;
    PoolKey internal keyB;
    AgenEngineVault internal vaultA;
    AgenEngineVault internal vaultB;

    function setUp() public {
        _deployEngine();

        // Market A: the `lower`/`upper` pair, quoted in `lower`, flat 2%, quote-denominated.
        keyA = _keyFor();
        vaultA = _openPool(keyA, _flatConfig(true, 20_000));

        // Market B: a different pair sharing the same quote, tiered, token-denominated, and
        // on a volume ladder — as different from A as the vocabulary allows.
        secondToken = new MockERC20("Gamma", "GAMMA", 18);
        _openSecondMarket();
    }

    function _openSecondMarket() private {
        // Sorted against the quote so the key is valid.
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

        AgenRuleLib.Config memory config;
        config.engineVersion = 1;
        config.referenceSupply = SUPPLY;
        config.quoteAsset = address(lower);
        config.feeCurrency = uint8(AgenRuleLib.FeeCurrency.Token);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.QuoteVolume);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 1_000, sellFeePpm: 1_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 500e18, buyFeePpm: 500, sellFeePpm: 500});
        config.buyTiers = new AgenRuleLib.Tier[](0);
        config.sellTiers = new AgenRuleLib.Tier[](1);
        config.sellTiers[0] = AgenRuleLib.Tier({thresholdTokens: 1e18, feePpm: 60_000});
        config.distribution = new AgenRuleLib.Share[](1);
        config.distribution[0] = AgenRuleLib.Share({
            kind: AgenRuleLib.RecipientKind.Treasury,
            recipient: address(0),
            sharePpm: uint24(AgenRuleLib.PPM_ONE)
        });

        vaultB = _deployVault(keyB, config);
        hook.configure(keyB, config, vaultB);
        manager.initialize(keyB, TickMath.getSqrtPriceAtTick(0));

        lower.mint(address(shim), SUPPLY);
        secondToken.mint(address(shim), SUPPLY);
        int24 spacing = VerdantConstants.TICK_SPACING;
        shim.addLiquidity(keyB, -spacing * 1000, spacing * 1000, 1_000_000e18);

        secondToken.mint(trader, SUPPLY / 10);
        vm.prank(trader);
        secondToken.approve(address(swapRouter), type(uint256).max);
    }

    function _settings() private pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    function _swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified) private {
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            _settings(),
            ""
        );
    }

    // --- configuration does not leak ----------------------------------------

    function test_the_two_markets_keep_their_own_rules() public view {
        assertEq(uint8(hook.feeCurrencyOf(keyA.toId())), uint8(AgenRuleLib.FeeCurrency.Quote));
        assertEq(uint8(hook.feeCurrencyOf(keyB.toId())), uint8(AgenRuleLib.FeeCurrency.Token));

        // Derived from what each market actually stored, not from anything a caller said.
        assertEq(hook.configHashOf(keyA.toId()), AgenRuleLib.hashConfig(_flatConfig(true, 20_000)));
        assertTrue(hook.configHashOf(keyA.toId()) != hook.configHashOf(keyB.toId()), "two markets, one identity");

        assertEq(address(hook.vaultOf(keyA.toId())), address(vaultA));
        assertEq(address(hook.vaultOf(keyB.toId())), address(vaultB));
    }

    function test_each_market_charges_its_own_rate() public {
        // A is 2%, quote-denominated, no tiers. B is 0.1% with a 6% tier.
        uint256 amount = 1_000e18;

        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(keyA, true, -int256(amount));
        assertEq(vaultA.totalAccrued(), (amount * 20_000) / 1e6, "A charged B's rate");

        // A sell on B, above its 1e18 tier, pays 6% of the token leg.
        bool bZeroForOne = Currency.unwrap(keyB.currency0) == address(secondToken);
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(keyB, bZeroForOne, -int256(amount));
        assertEq(vaultB.totalAccrued(), (amount * 60_000) / 1e6, "B charged A's rate");
    }

    // --- state does not leak -------------------------------------------------

    function test_volume_accrues_only_to_the_pool_that_traded() public {
        assertEq(hook.cumulativeQuoteVolume(keyA.toId()), 0);
        assertEq(hook.cumulativeQuoteVolume(keyB.toId()), 0);

        // A has no volume ladder, so its counter must stay at zero however much it trades —
        // a market never pays for a counter it does not read.
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(keyA, true, -int256(1_000e18));
        assertEq(hook.cumulativeQuoteVolume(keyA.toId()), 0, "A accumulated a counter it has no ladder for");
        assertEq(hook.cumulativeQuoteVolume(keyB.toId()), 0, "A's trade moved B's counter");

        bool bZeroForOne = Currency.unwrap(keyB.currency0) == address(secondToken);
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(keyB, bZeroForOne, -int256(1e18));

        assertGt(hook.cumulativeQuoteVolume(keyB.toId()), 0, "B did not accumulate");
        assertEq(hook.cumulativeQuoteVolume(keyA.toId()), 0, "B's trade moved A's counter");
    }

    function test_each_market_keeps_its_own_init_time() public {
        uint40 first = hook.initTimeOf(keyA.toId());
        assertGt(first, 0);

        vm.warp(block.timestamp + 10_000);

        // A third market, opened later. A's clock must not move.
        assertEq(hook.initTimeOf(keyA.toId()), first, "A's clock moved");
    }

    // --- value does not leak -------------------------------------------------

    function test_fees_reach_only_the_trading_market_vault() public {
        uint256 amount = 1_000e18;

        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(keyA, true, -int256(amount));

        assertGt(vaultA.totalAccrued(), 0, "A's vault was not credited");
        assertEq(vaultB.totalAccrued(), 0, "A's trade credited B's vault");

        bool bZeroForOne = Currency.unwrap(keyB.currency0) == address(secondToken);
        uint256 aBefore = vaultA.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(keyB, bZeroForOne, -int256(amount));

        assertGt(vaultB.totalAccrued(), 0, "B's vault was not credited");
        assertEq(vaultA.totalAccrued(), aBefore, "B's trade credited A's vault");
    }

    function test_the_two_vaults_hold_different_currencies() public view {
        // A collects the quote, B collects its own launched token. A vault that could hold
        // two markets' assets is the shared-balance failure this design avoids.
        assertEq(Currency.unwrap(vaultA.currency()), address(lower));
        assertEq(Currency.unwrap(vaultB.currency()), address(secondToken));
    }

    function test_a_vault_refuses_a_credit_from_anyone_but_the_hook() public {
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.NotHook.selector, address(this)));
        vaultA.credit(1 ether);
    }

    function test_one_market_cannot_claim_another_vault() public {
        uint256 amount = 1_000e18;
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(keyA, true, -int256(amount));

        // B's vault has nothing, whatever A collected.
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.NothingToClaim.selector, 0));
        vaultB.claim(0);
    }

    // --- the configuration's identity is derived, never supplied ------------

    /*
     * The hook takes no hash argument at all, so there is no shape in which a caller can
     * claim that hash X describes configuration Y. These tests assert the consequence: the
     * stored identity is a function of the stored rules, and changing any economically
     * relevant field changes it.
     */
    function test_the_stored_hash_is_the_hash_of_the_stored_configuration() public {
        AgenRuleLib.Config memory config = _flatConfig(true, 20_000);
        assertEq(hook.configHashOf(keyA.toId()), AgenRuleLib.hashConfig(config), "the identity was not derived");
    }

    function test_changing_any_economic_field_changes_the_identity() public view {
        AgenRuleLib.Config memory base = _flatConfig(true, 20_000);
        bytes32 identity = AgenRuleLib.hashConfig(base);

        // The rate.
        AgenRuleLib.Config memory other = _flatConfig(true, 20_001);
        assertTrue(AgenRuleLib.hashConfig(other) != identity, "the rate did not change the identity");

        // The quote asset, which decides what a creator is paid in.
        other = _flatConfig(false, 20_000);
        assertTrue(AgenRuleLib.hashConfig(other) != identity, "the quote asset did not change the identity");

        // The reference supply, which every percentage threshold is measured against.
        other = _flatConfig(true, 20_000);
        other.referenceSupply = SUPPLY * 2;
        assertTrue(AgenRuleLib.hashConfig(other) != identity, "the supply did not change the identity");

        // The split.
        other = _flatConfig(true, 20_000);
        other.distribution[0].kind = AgenRuleLib.RecipientKind.Treasury;
        assertTrue(AgenRuleLib.hashConfig(other) != identity, "the recipient did not change the identity");

        // A ceiling.
        other = _flatConfig(true, 20_000);
        other.maxSellTokens = ONE_PERCENT;
        assertTrue(AgenRuleLib.hashConfig(other) != identity, "a ceiling did not change the identity");

        // Adding a tier, which also moves the fee currency.
        other = _tieredConfig(true, 20_000, ONE_PERCENT, 40_000);
        assertTrue(AgenRuleLib.hashConfig(other) != identity, "a tier did not change the identity");
    }

    function test_the_implementation_hash_is_derived_from_the_stored_identity() public view {
        PoolId poolId = keyA.toId();
        bytes32 expected = AgenRuleLib.implementationHash(
            hook.configHashOf(poolId), block.chainid, address(hook), hook.engineVersionOf(poolId)
        );

        assertEq(hook.implementationHashOf(poolId), expected, "the commitment is not derived from the chain");
    }

    function test_the_implementation_hash_binds_the_engine() public view {
        // The same economics pointed at a different hook is a different promise, because the
        // hook is the code that decides what the configuration means.
        bytes32 mine = hook.implementationHashOf(keyA.toId());
        bytes32 elsewhere = AgenRuleLib.implementationHash(
            hook.configHashOf(keyA.toId()), block.chainid, address(0xBEEF), 1
        );

        assertTrue(mine != elsewhere, "the commitment does not bind the engine");
    }

    function test_the_implementation_hash_refuses_an_unconfigured_market() public {
        PoolKey memory fresh = _freshKey();
        vm.expectRevert(abi.encodeWithSelector(AgenEngineHook.NotConfigured.selector, fresh.toId()));
        hook.implementationHashOf(fresh.toId());
    }

    // --- configuration is write-once ----------------------------------------

    function test_a_configured_market_cannot_be_reconfigured() public {
        // The whole immutability guarantee. No owner, no setter, and this.
        vm.expectRevert(abi.encodeWithSelector(AgenEngineHook.AlreadyConfigured.selector, keyA.toId()));
        hook.configure(keyA, _flatConfig(true, 50_000), vaultA);
    }

    function test_only_the_factory_may_configure() public {
        PoolKey memory key = _keyFor();
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(AgenEngineHook.NotFactory.selector, trader));
        hook.configure(key, _flatConfig(true, 20_000), vaultA);
    }

    function test_a_pool_cannot_be_opened_without_rules() public {
        // A foreign pool naming this hook. `beforeInitialize` refuses it, so an unconfigured
        // market can never exist — which is what makes every callback's storage read safe.
        PoolKey memory foreign = PoolKey({
            currency0: Currency.wrap(address(lower)),
            currency1: Currency.wrap(address(secondToken)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        vm.expectRevert();
        manager.initialize(foreign, TickMath.getSqrtPriceAtTick(0));
    }

    /// @dev A pair nothing has configured yet, so a `configure` reaches the checks past the
    /// write-once guard rather than tripping on it.
    function _freshKey() private returns (PoolKey memory) {
        MockERC20 fresh = new MockERC20("Delta", "DELTA", 18);
        (Currency c0, Currency c1) = address(lower) < address(fresh)
            ? (Currency.wrap(address(lower)), Currency.wrap(address(fresh)))
            : (Currency.wrap(address(fresh)), Currency.wrap(address(lower)));

        return PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    function test_the_vault_must_belong_to_the_hook_and_hold_the_right_currency() public {
        PoolKey memory key = _freshKey();
        AgenRuleLib.Config memory config = _flatConfig(true, 20_000);

        // A vault built for a currency this pool does not contain. Caught rather than
        // trusted, because a market whose vault holds the wrong asset would mint claims
        // nobody can redeem.
        address[] memory recipients = new address[](1);
        recipients[0] = creator;
        uint24[] memory shares = new uint24[](1);
        shares[0] = uint24(AgenRuleLib.PPM_ONE);
        AgenEngineVault wrong =
            new AgenEngineVault(address(hook), manager, Currency.wrap(address(upper)), recipients, shares);

        vm.expectRevert(abi.encodeWithSelector(AgenEngineHook.VaultMismatch.selector, address(wrong)));
        hook.configure(key, config, wrong);
    }

    function test_the_vault_split_must_match_the_configuration() public {
        PoolKey memory key = _freshKey();
        AgenRuleLib.Config memory config = _flatConfig(true, 20_000);
        config.distribution = new AgenRuleLib.Share[](2);
        config.distribution[0] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Creator, recipient: address(0), sharePpm: 800_000});
        config.distribution[1] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Treasury, recipient: address(0), sharePpm: 200_000});

        // A vault built with the shares the other way round. The configuration is what the
        // creator signed, so a vault that would pay a different split is refused.
        address[] memory recipients = new address[](2);
        recipients[0] = creator;
        recipients[1] = treasury;
        uint24[] memory shares = new uint24[](2);
        shares[0] = 200_000;
        shares[1] = 800_000;
        AgenEngineVault swapped =
            new AgenEngineVault(address(hook), manager, Currency.wrap(address(lower)), recipients, shares);

        vm.expectRevert(abi.encodeWithSelector(AgenEngineHook.DistributionMismatch.selector, 0));
        hook.configure(key, config, swapped);
    }

    // --- callbacks are the PoolManager's alone -------------------------------

    function test_every_callback_refuses_a_caller_that_is_not_the_pool_manager() public {
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: 0});
        ModifyLiquidityParams memory liq =
            ModifyLiquidityParams({tickLower: 0, tickUpper: 0, liquidityDelta: 0, salt: bytes32(0)});

        vm.expectRevert(abi.encodeWithSelector(AgenEngineHook.NotPoolManager.selector, address(this)));
        hook.beforeInitialize(address(this), keyA, 0);

        vm.expectRevert(abi.encodeWithSelector(AgenEngineHook.NotPoolManager.selector, address(this)));
        hook.afterInitialize(address(this), keyA, 0, 0);

        vm.expectRevert(abi.encodeWithSelector(AgenEngineHook.NotPoolManager.selector, address(this)));
        hook.beforeAddLiquidity(address(this), keyA, liq, "");

        vm.expectRevert(abi.encodeWithSelector(AgenEngineHook.NotPoolManager.selector, address(this)));
        hook.beforeSwap(address(this), keyA, params, "");

        vm.expectRevert(abi.encodeWithSelector(AgenEngineHook.NotPoolManager.selector, address(this)));
        hook.afterSwap(address(this), keyA, params, BalanceDelta.wrap(0), "");
    }

    function test_the_denied_callbacks_revert_even_if_reached() public {
        ModifyLiquidityParams memory liq =
            ModifyLiquidityParams({tickLower: 0, tickUpper: 0, liquidityDelta: 0, salt: bytes32(0)});

        // The address bits mean v4 will never call these. They revert rather than returning a
        // selector so a future hook cannot inherit this one and quietly gain a permission.
        vm.expectRevert(AgenEngineHook.CallbackNotEnabled.selector);
        hook.afterAddLiquidity(address(0), keyA, liq, BalanceDelta.wrap(0), BalanceDelta.wrap(0), "");

        vm.expectRevert(AgenEngineHook.CallbackNotEnabled.selector);
        hook.beforeRemoveLiquidity(address(0), keyA, liq, "");

        vm.expectRevert(AgenEngineHook.CallbackNotEnabled.selector);
        hook.afterRemoveLiquidity(address(0), keyA, liq, BalanceDelta.wrap(0), BalanceDelta.wrap(0), "");

        vm.expectRevert(AgenEngineHook.CallbackNotEnabled.selector);
        hook.beforeDonate(address(0), keyA, 0, 0, "");

        vm.expectRevert(AgenEngineHook.CallbackNotEnabled.selector);
        hook.afterDonate(address(0), keyA, 0, 0, "");
    }

    function test_liquidity_cannot_be_added_by_anyone_but_the_factory() public {
        // The launch position is the only position, forever. `modifyLiquidityRouter` is not
        // the pinned position manager, so v4 calls the hook and the hook refuses.
        vm.expectRevert();
        modifyLiquidityRouter.modifyLiquidity(
            keyA,
            ModifyLiquidityParams({tickLower: -200, tickUpper: 200, liquidityDelta: 1e18, salt: bytes32(0)}),
            ""
        );
    }

    // --- the engine does not trust its callers -------------------------------

    function test_a_direct_pool_manager_swap_is_charged_identically() public {
        // No router, no `AgenHookData`, no identity. The fee must be exactly the same,
        // because a hook whose correctness depends on how it was reached has a hole.
        DirectSwapper direct = new DirectSwapper(manager);
        lower.mint(address(direct), 100_000e18);

        uint256 amount = 1_000e18;
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(keyA, true, -int256(amount));
        uint256 viaRouter = vaultA.totalAccrued();

        uint256 before = vaultA.totalAccrued();
        direct.swap(
            keyA,
            SwapParams({
                zeroForOne: true,
                // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: MIN_PRICE_LIMIT
            }),
            ""
        );

        assertEq(vaultA.totalAccrued() - before, viaRouter, "a direct swap paid a different fee");
    }

    function test_arbitrary_hook_data_changes_nothing() public {
        // `hookData` is caller-supplied and therefore not a credential. Engine v1 reads none
        // of it, and this is the assertion that says so.
        DirectSwapper direct = new DirectSwapper(manager);
        lower.mint(address(direct), 100_000e18);

        uint256 amount = 1_000e18;
        uint256 before = vaultA.totalAccrued();

        direct.swap(
            keyA,
            SwapParams({
                zeroForOne: true,
                // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: MIN_PRICE_LIMIT
            }),
            abi.encode(address(0xBADBAD), uint256(type(uint256).max), keccak256("nonsense"))
        );

        assertEq(vaultA.totalAccrued() - before, (amount * 20_000) / 1e6, "hookData moved the fee");
    }

    function test_the_hook_holds_nothing_after_many_swaps_in_two_markets() public {
        bool bZeroForOne = Currency.unwrap(keyB.currency0) == address(secondToken);

        for (uint256 i = 0; i < 5; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
            _swap(keyA, true, -int256(100e18));
            // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
            _swap(keyB, bZeroForOne, -int256(1e18));
        }

        assertEq(lower.balanceOf(address(hook)), 0);
        assertEq(upper.balanceOf(address(hook)), 0);
        assertEq(secondToken.balanceOf(address(hook)), 0);
        assertEq(manager.balanceOf(address(hook), keyA.currency0.toId()), 0);
        assertEq(manager.balanceOf(address(hook), keyA.currency1.toId()), 0);
        assertEq(manager.balanceOf(address(hook), keyB.currency0.toId()), 0);
        assertEq(manager.balanceOf(address(hook), keyB.currency1.toId()), 0);
    }

    function test_both_vaults_stay_solvent_across_interleaved_trading() public {
        bool bZeroForOne = Currency.unwrap(keyB.currency0) == address(secondToken);

        for (uint256 i = 0; i < 5; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
            _swap(keyA, true, -int256(100e18));
            // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
            _swap(keyB, bZeroForOne, -int256(1e18));
        }

        // Every base unit the ledger promises is backed, in both markets. `credit` reverts
        // if that ever stops being true, so reaching here is itself the assertion — but it is
        // stated explicitly so a reader does not have to know that.
        assertEq(vaultA.unaccounted(), 0, "A holds value no ledger accounts for");
        assertEq(vaultB.unaccounted(), 0, "B holds value no ledger accounts for");

        assertGt(vaultA.outstanding(), 0);
        assertGt(vaultB.outstanding(), 0);

        vaultA.claim(0);
        vaultB.claim(0);

        assertEq(vaultA.outstanding(), 0, "A did not pay out in full");
        assertEq(vaultB.outstanding(), 0, "B did not pay out in full");
    }
}
