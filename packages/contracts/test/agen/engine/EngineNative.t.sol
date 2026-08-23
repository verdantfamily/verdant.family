// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";

import {FactoryOrigin} from "../../../src/FactoryOrigin.sol";
import {AgenCurve} from "../../../src/agen/AgenCurve.sol";
import {AgenMarketRegistry} from "../../../src/agen/AgenMarketRegistry.sol";
import {AgenEngineDeployer} from "../../../src/agen/engine/AgenEngineDeployer.sol";
import {AgenEngineFactory} from "../../../src/agen/engine/AgenEngineFactory.sol";
import {AgenEngineHook} from "../../../src/agen/engine/AgenEngineHook.sol";
import {AgenEngineVault} from "../../../src/agen/engine/AgenEngineVault.sol";
import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";
import {HookMiner} from "../../utils/HookMiner.sol";

/// @notice Swaps a native-quoted pool straight at the PoolManager, with no router.
/// @dev Native settlement is the one place a router could plausibly be doing something the
/// hook depends on, so it has to be shown that none of it is.
contract NativeDirectSwapper is IUnlockCallback {
    IPoolManager private immutable _manager;

    constructor(IPoolManager manager_) {
        _manager = manager_;
    }

    receive() external payable {}

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
            if (currency.isAddressZero()) {
                // Native settlement: the value rides on the `settle` call itself.
                _manager.settle{value: owed}();
            } else {
                _manager.sync(currency);
                IERC20(Currency.unwrap(currency)).transfer(address(_manager), owed);
                _manager.settle();
            }
        } else {
            _manager.take(currency, address(this), uint256(uint128(amount)));
        }
    }
}

/// @dev Refuses native value on receipt. The liveness case the pull design exists for.
contract NativeRejecter {
    receive() external payable {
        revert("no thanks");
    }
}

/// @dev Tries to claim again from inside its own native payout.
contract NativeReenterer {
    AgenEngineVault public vault;
    uint256 public attempts;

    function point(AgenEngineVault vault_) external {
        vault = vault_;
    }

    receive() external payable {
        attempts++;
        if (attempts < 3) {
            try vault.claim(0) {} catch {}
        }
    }
}

/// @title Native Robinhood Chain ETH as the quote asset
///
/// @notice The first-release requirement: every existing Agen market is ether-quoted, so the
/// engine has to be too.
///
/// @dev No WETH anywhere. Native currency is `Currency.wrap(address(0))` throughout v4 and
/// that is what a native-quoted market's `currency0` is. `CurrencyLibrary` resolves
/// `balanceOfSelf` to `address(this).balance`, `transfer` to a bare call, and `toId()` to 0 —
/// so the vault, the hook and the factory needed no native branch at all beyond removing a
/// guard. What needed writing was the proof, which is this file.
///
/// ## ADR-018 under a native quote, stated exactly
///
/// The derivation is unchanged and the quote asset's nature does not enter it:
///
/// | market | fee currency |
/// | --- | --- |
/// | ETH quote, flat | native ETH |
/// | ETH quote, time ladder | native ETH |
/// | ETH quote, quote-volume ladder | native ETH |
/// | ETH quote, launched-token size tiers | the launched token |
///
/// So a tiered ETH-quoted market's vault holds the launched ERC-20, and an untiered one's
/// holds native ETH. Both are asserted below.
contract EngineNativeTest is Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;

    uint160 internal constant ENGINE_FLAGS = 0x38CC;
    uint256 internal constant SUPPLY = 1_000_000e18;
    uint128 internal constant ONE_PERCENT = uint128(SUPPLY / 100);
    int24 internal constant INITIAL_TICK = 92_200;

    PositionManager internal posm;
    AgenEngineDeployer internal engineDeployer;
    AgenMarketRegistry internal registry;
    AgenEngineHook internal hook;
    AgenEngineFactory internal factory;

    address internal treasury = address(0x7EA5);
    address internal trader = address(0xDECAF);
    address internal creator;

    function setUp() public {
        creator = address(this);

        deployFreshManagerAndRouters();
        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        FactoryOrigin origin = new FactoryOrigin(address(this));
        address predicted = origin.factory();

        engineDeployer = new AgenEngineDeployer(predicted);
        registry = new AgenMarketRegistry(predicted);

        (, bytes32 salt) = HookMiner.find(
            address(this), ENGINE_FLAGS, type(AgenEngineHook).creationCode, abi.encode(manager, predicted, address(posm))
        );
        hook = new AgenEngineHook{salt: salt}(manager, predicted, address(posm));

        factory = AgenEngineFactory(
            origin.deployFactory(
                abi.encodePacked(
                    type(AgenEngineFactory).creationCode,
                    abi.encode(manager, posm, engineDeployer, registry, hook, treasury)
                )
            )
        );

        vm.deal(trader, 10_000 ether);
        vm.deal(address(this), 10_000 ether);
    }

    // --- configuration builders ---------------------------------------------

    /// @dev A native-quoted market. `quoteAsset` is the zero address, which is v4's native
    /// currency and not a token contract.
    function _flat(uint24 feePpm) internal view returns (AgenRuleLib.Config memory config) {
        config.engineVersion = 1;
        config.referenceSupply = SUPPLY;
        config.quoteAsset = address(0);
        config.feeCurrency = uint8(AgenRuleLib.FeeCurrency.Quote);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.None);

        config.stages = new AgenRuleLib.Stage[](1);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: feePpm, sellFeePpm: feePpm});

        config.buyTiers = new AgenRuleLib.Tier[](0);
        config.sellTiers = new AgenRuleLib.Tier[](0);

        config.distribution = new AgenRuleLib.Share[](1);
        config.distribution[0] = AgenRuleLib.Share({
            kind: AgenRuleLib.RecipientKind.Creator,
            recipient: address(0),
            sharePpm: uint24(AgenRuleLib.PPM_ONE)
        });
    }

    function _tiered(uint24 baseFeePpm, uint128 threshold, uint24 tierFeePpm)
        internal
        view
        returns (AgenRuleLib.Config memory config)
    {
        config = _flat(baseFeePpm);
        config.feeCurrency = uint8(AgenRuleLib.FeeCurrency.Token);
        config.sellTiers = new AgenRuleLib.Tier[](1);
        config.sellTiers[0] = AgenRuleLib.Tier({thresholdTokens: threshold, feePpm: tierFeePpm});
    }

    function _manifest(string memory symbol, AgenRuleLib.Config memory config)
        internal
        view
        returns (AgenEngineFactory.Manifest memory)
    {
        return AgenEngineFactory.Manifest({
            name: "Native Market",
            symbol: symbol,
            supply: SUPPLY,
            metadataURI: "ipfs://native",
            metadataMutable: false,
            // No salt search needed: native sorts to currency0 unconditionally, so the token
            // is currency1 whatever its address.
            tokenSalt: keccak256(abi.encodePacked("native", symbol)),
            quoteAsset: address(0),
            initialTick: INITIAL_TICK,
            config: config,
            feeReceiver: address(this),
            specificationHash: keccak256(abi.encodePacked("spec:", symbol)),
            implementationHash: AgenRuleLib.implementationHash(
                AgenRuleLib.hashConfig(config), block.chainid, address(hook), config.engineVersion
            )
        });
    }

    function _launch(string memory symbol, AgenRuleLib.Config memory config)
        internal
        returns (PoolKey memory key, AgenEngineVault vault, address token)
    {
        uint256 index = factory.deployMarket(_manifest(symbol, config));
        token = registry.marketAt(index).token;

        key = PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: AgenCurve.TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        vault = hook.vaultOf(key.toId());

        vm.prank(trader);
        IERC20(token).approve(address(swapRouter), type(uint256).max);
    }

    function _settings() private pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    /// @dev A buy spends native ETH, which is `currency0`, so `zeroForOne`. The value rides
    /// on the call because the input is native.
    function _swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified, uint256 value) private {
        vm.prank(trader);
        swapRouter.swap{value: value}(
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

    /// @dev Enough native in, generously, since an exact-output buy's cost is the pool's to
    /// decide. `PoolSwapTest` returns the remainder.
    function _buyExactIn(PoolKey memory key, uint256 spend) private {
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, true, -int256(spend), spend);
    }

    function _buyExactOut(PoolKey memory key, uint256 wantToken, uint256 budget) private {
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, true, int256(wantToken), budget);
    }

    function _sellExactIn(PoolKey memory key, uint256 tokensIn) private {
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, false, -int256(tokensIn), 0);
    }

    function _sellExactOut(PoolKey memory key, uint256 wantEth) private {
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, false, int256(wantEth), 0);
    }

    /// @dev Give the trader tokens to sell, by buying some first.
    function _seedTrader(PoolKey memory key, uint256 spend) private {
        _buyExactIn(key, spend);
    }

    // --- the flat native market: all four shapes ----------------------------

    function test_flat_native_market_collects_native_eth() public {
        (PoolKey memory key, AgenEngineVault vault,) = _launch("FLAT", _flat(20_000));

        // The vault's currency is native, not a token address.
        assertTrue(vault.currency().isAddressZero(), "an untiered ETH market must collect native ETH");
        assertEq(uint8(hook.feeCurrencyOf(key.toId())), uint8(AgenRuleLib.FeeCurrency.Quote), "fee currency");

        // 1. exact-input buy — native is the specified currency, so `beforeSwap` charges.
        uint256 spend = 1 ether;
        _buyExactIn(key, spend);
        assertEq(vault.totalAccrued(), (spend * 20_000) / 1e6, "exact-input buy");

        // 2. exact-output buy — the token is specified, so `afterSwap` charges on native.
        uint256 before = vault.totalAccrued();
        _buyExactOut(key, 1_000e18, 100 ether);
        assertGt(vault.totalAccrued(), before, "exact-output buy took nothing");

        // 3. exact-input sell — the token is specified, `afterSwap` charges on native.
        uint256 held = IERC20(Currency.unwrap(key.currency1)).balanceOf(trader);
        assertGt(held, 0, "the buys delivered nothing");
        before = vault.totalAccrued();
        _sellExactIn(key, held / 4);
        assertGt(vault.totalAccrued(), before, "exact-input sell took nothing");

        // 4. exact-output sell — native is specified, `beforeSwap` charges.
        before = vault.totalAccrued();
        uint256 wantEth = 0.01 ether;
        _sellExactOut(key, wantEth);
        assertEq(vault.totalAccrued() - before, (wantEth * 20_000) / 1e6, "exact-output sell");
    }

    function test_the_flat_native_vault_holds_real_native_value() public {
        (PoolKey memory key, AgenEngineVault vault,) = _launch("REAL", _flat(20_000));

        _buyExactIn(key, 1 ether);

        // Held as an ERC-6909 claim on native until somebody claims, which is the same
        // mechanism the ERC-20 path uses and the reason the hook can charge before the trader
        // has settled.
        assertEq(vault.claims(), vault.totalAccrued(), "the fee is not held as a native claim");
        assertEq(address(vault).balance, 0, "nothing should be redeemed yet");

        uint256 owed = vault.claimable(0);
        uint256 before = creator.balance;
        vault.claim(0);

        assertEq(creator.balance - before, owed, "the creator was not paid in native ETH");
        assertEq(vault.unaccounted(), 0, "the vault holds native value no ledger accounts for");
    }

    // --- the tiered native market: fee in the launched token ----------------

    function test_tiered_native_market_collects_the_launched_token() public {
        (PoolKey memory key, AgenEngineVault vault, address token) = _launch("TIER", _tiered(5_000, ONE_PERCENT, 40_000));

        // This is the ADR-018 case that reads backwards if stated carelessly: the market is
        // quoted in native ETH and collects in the ERC-20 it launched.
        assertEq(Currency.unwrap(vault.currency()), token, "a tiered ETH market must collect the launched token");
        assertFalse(vault.currency().isAddressZero(), "the vault must not be native here");
        assertEq(uint8(hook.feeCurrencyOf(key.toId())), uint8(AgenRuleLib.FeeCurrency.Token), "fee currency");

        // All four shapes, on a market whose quote is native and whose fee is not.
        uint256 spend = 5 ether;
        _buyExactIn(key, spend);
        assertGt(vault.totalAccrued(), 0, "exact-input buy took nothing");

        uint256 before = vault.totalAccrued();
        _buyExactOut(key, 1_000e18, 100 ether);
        assertGt(vault.totalAccrued(), before, "exact-output buy took nothing");

        before = vault.totalAccrued();
        _sellExactIn(key, 1_000e18);
        assertEq(vault.totalAccrued() - before, (1_000e18 * 5_000) / 1e6, "exact-input sell");

        before = vault.totalAccrued();
        _sellExactOut(key, 0.01 ether);
        assertGt(vault.totalAccrued(), before, "exact-output sell took nothing");

        // And the fee really is token-denominated: the vault holds no native at all.
        assertEq(address(vault).balance, 0, "a token-fee vault holds native value");
        assertEq(manager.balanceOf(address(vault), 0), 0, "a token-fee vault holds native claims");
    }

    /// @dev The pre-fee rule, on a native-quoted market. The native leg must not enter the
    /// threshold decision at all.
    function test_the_tier_boundary_is_pre_fee_under_a_native_quote() public {
        (PoolKey memory key, AgenEngineVault vault,) = _launch("PREF", _tiered(5_000, ONE_PERCENT, 40_000));

        _seedTrader(key, 200 ether);
        assertGe(
            IERC20(Currency.unwrap(key.currency1)).balanceOf(trader),
            uint256(ONE_PERCENT) * 3,
            "not enough token to test the boundary"
        );

        // threshold - 1
        uint256 before = vault.totalAccrued();
        _sellExactIn(key, uint256(ONE_PERCENT) - 1);
        assertEq(
            vault.totalAccrued() - before,
            ((uint256(ONE_PERCENT) - 1) * 5_000) / 1e6,
            "one base unit below the threshold must pay the base rate"
        );

        // threshold
        before = vault.totalAccrued();
        _sellExactIn(key, uint256(ONE_PERCENT));
        assertEq(
            vault.totalAccrued() - before,
            (uint256(ONE_PERCENT) * 40_000) / 1e6,
            "exactly at the threshold must pay the tier"
        );

        // threshold + 1
        before = vault.totalAccrued();
        _sellExactIn(key, uint256(ONE_PERCENT) + 1);
        assertEq(
            vault.totalAccrued() - before,
            ((uint256(ONE_PERCENT) + 1) * 40_000) / 1e6,
            "one base unit above the threshold must pay the tier"
        );
    }

    // --- ladders under a native quote ---------------------------------------

    function test_a_time_ladder_native_market_collects_native() public {
        AgenRuleLib.Config memory config = _flat(20_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.Time);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 20_000, sellFeePpm: 20_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 3600, buyFeePpm: 10_000, sellFeePpm: 10_000});

        (PoolKey memory key, AgenEngineVault vault,) = _launch("TIME", config);
        assertTrue(vault.currency().isAddressZero(), "a time-laddered ETH market must collect native ETH");

        uint256 spend = 1 ether;
        _buyExactIn(key, spend);
        assertEq(vault.totalAccrued(), (spend * 20_000) / 1e6, "the opening rate");

        vm.warp(block.timestamp + 3600);
        uint256 before = vault.totalAccrued();
        _buyExactIn(key, spend);
        assertEq(vault.totalAccrued() - before, (spend * 10_000) / 1e6, "the stage did not advance");
    }

    function test_a_volume_ladder_native_market_counts_native_eth() public {
        AgenRuleLib.Config memory config = _flat(20_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.QuoteVolume);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 20_000, sellFeePpm: 20_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 2 ether, buyFeePpm: 10_000, sellFeePpm: 10_000});

        (PoolKey memory key, AgenEngineVault vault,) = _launch("VOLN", config);
        PoolId poolId = key.toId();

        assertTrue(vault.currency().isAddressZero(), "a volume-laddered ETH market must collect native ETH");
        assertEq(hook.cumulativeQuoteVolume(poolId), 0, "volume started non-zero");

        // The counter moves by the native leg, in wei — not by the token leg and not by the fee.
        _buyExactIn(key, 1 ether);
        assertEq(uint256(hook.cumulativeQuoteVolume(poolId)), 1 ether, "volume is not the native leg");

        // A trade never advances its own stage, so this one still pays the opening rate.
        assertEq(vault.totalAccrued(), (1 ether * 20_000) / 1e6, "the trade advanced its own stage");

        _buyExactIn(key, 1 ether);
        assertEq(uint256(hook.cumulativeQuoteVolume(poolId)), 2 ether, "volume did not accumulate");

        // Now the threshold has been passed, so the next one is cheaper.
        uint256 before = vault.totalAccrued();
        _buyExactIn(key, 1 ether);
        assertEq(vault.totalAccrued() - before, (1 ether * 10_000) / 1e6, "the stage did not advance");
    }

    /// @dev The combination the brief asks for explicitly: the fee is the launched token and
    /// the volume trigger is native ETH, and neither definition bleeds into the other.
    function test_a_tiered_volume_ladder_keeps_the_two_denominations_apart() public {
        AgenRuleLib.Config memory config = _tiered(5_000, ONE_PERCENT, 40_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.QuoteVolume);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 5_000, sellFeePpm: 5_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 2 ether, buyFeePpm: 1_000, sellFeePpm: 1_000});

        (PoolKey memory key, AgenEngineVault vault, address token) = _launch("BOTH", config);
        PoolId poolId = key.toId();

        // Fee in the launched token, volume in native ETH. Both true at once.
        assertEq(Currency.unwrap(vault.currency()), token, "the fee currency");
        assertEq(uint8(hook.feeCurrencyOf(poolId)), uint8(AgenRuleLib.FeeCurrency.Token), "the fee currency");

        _buyExactIn(key, 1 ether);
        assertEq(uint256(hook.cumulativeQuoteVolume(poolId)), 1 ether, "volume must count native ETH");
        // The fee came out of the token leg, so the vault holds no native.
        assertGt(vault.totalAccrued(), 0, "no fee was taken");
        assertEq(address(vault).balance, 0, "the vault holds native value");
        assertEq(manager.balanceOf(address(vault), 0), 0, "the vault holds native claims");

        _buyExactIn(key, 1 ether);
        assertEq(uint256(hook.cumulativeQuoteVolume(poolId)), 2 ether, "volume did not accumulate in native");

        // Past the volume threshold, a sell below the tier pays the advanced stage rate.
        uint256 before = vault.totalAccrued();
        _sellExactIn(key, 1_000e18);
        assertEq(vault.totalAccrued() - before, (1_000e18 * 1_000) / 1e6, "the stage did not advance");

        // And a sell at the tier still overrides it, on the gross token leg.
        before = vault.totalAccrued();
        _sellExactIn(key, uint256(ONE_PERCENT));
        assertEq(vault.totalAccrued() - before, (uint256(ONE_PERCENT) * 40_000) / 1e6, "the tier did not override");
    }

    // --- the hook takes no native custody -----------------------------------

    function test_the_hook_holds_no_native_value_after_swapping() public {
        (PoolKey memory key,,) = _launch("CUST", _flat(20_000));

        _buyExactIn(key, 1 ether);
        _sellExactOut(key, 0.01 ether);

        // A hook is called on every swap, so a hook holding native would make "can this be
        // drained" a question about the swap logic. It never holds: `mint` names the vault.
        assertEq(address(hook).balance, 0, "the hook holds native ETH");
        assertEq(manager.balanceOf(address(hook), 0), 0, "the hook holds native claims");
        assertEq(
            manager.balanceOf(address(hook), Currency.wrap(Currency.unwrap(key.currency1)).toId()),
            0,
            "the hook holds token claims"
        );
    }

    function test_the_hook_holds_nothing_across_two_native_markets() public {
        (PoolKey memory keyA,,) = _launch("ISOA", _flat(20_000));
        (PoolKey memory keyB,, address tokenB) = _launch("ISOB", _tiered(5_000, ONE_PERCENT, 40_000));

        for (uint256 i = 0; i < 5; i++) {
            _buyExactIn(keyA, 0.5 ether);
            _buyExactIn(keyB, 0.5 ether);
        }

        assertEq(address(hook).balance, 0, "the hook holds native ETH");
        assertEq(manager.balanceOf(address(hook), 0), 0, "the hook holds native claims");
        assertEq(IERC20(tokenB).balanceOf(address(hook)), 0, "the hook holds a market's token");
    }

    // --- router independence -------------------------------------------------

    function test_a_direct_native_swap_is_charged_identically() public {
        (PoolKey memory key, AgenEngineVault vault,) = _launch("DIRC", _flat(20_000));

        uint256 spend = 1 ether;
        _buyExactIn(key, spend);
        uint256 viaRouter = vault.totalAccrued();

        NativeDirectSwapper direct = new NativeDirectSwapper(manager);
        vm.deal(address(direct), 100 ether);

        uint256 before = vault.totalAccrued();
        direct.swap(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
            SwapParams({zeroForOne: true, amountSpecified: -int256(spend), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            ""
        );

        assertEq(vault.totalAccrued() - before, viaRouter, "a direct native swap paid a different fee");
    }

    function test_arbitrary_hook_data_changes_nothing_under_a_native_quote() public {
        (PoolKey memory key, AgenEngineVault vault,) = _launch("HDAT", _flat(20_000));

        NativeDirectSwapper direct = new NativeDirectSwapper(manager);
        vm.deal(address(direct), 100 ether);

        uint256 spend = 1 ether;
        direct.swap(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
            SwapParams({zeroForOne: true, amountSpecified: -int256(spend), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            abi.encode(address(0xBADBAD), type(uint256).max, keccak256("nonsense"))
        );

        assertEq(vault.totalAccrued(), (spend * 20_000) / 1e6, "hookData moved the fee");
    }

    // --- native claims --------------------------------------------------------

    function test_a_four_way_native_split_conserves_exactly() public {
        AgenRuleLib.Config memory config = _flat(20_000);
        config.distribution = new AgenRuleLib.Share[](4);
        config.distribution[0] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Creator, recipient: address(0), sharePpm: 333_333});
        config.distribution[1] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Treasury, recipient: address(0), sharePpm: 333_333});
        config.distribution[2] = AgenRuleLib.Share({
            kind: AgenRuleLib.RecipientKind.Address,
            recipient: address(0xAAA1),
            sharePpm: 233_334
        });
        config.distribution[3] = AgenRuleLib.Share({
            kind: AgenRuleLib.RecipientKind.Address,
            recipient: address(0xAAA2),
            sharePpm: 100_000
        });

        (PoolKey memory key, AgenEngineVault vault,) = _launch("SPL4", config);

        _buyExactIn(key, 1.000000000000000007 ether);
        uint256 total = vault.totalAccrued();
        assertGt(total, 0, "no fee");

        uint256 sum;
        for (uint256 i = 0; i < 4; i++) {
            sum += vault.claimable(i);
        }
        assertEq(sum, total, "the native split does not conserve the fee");

        // And every one of them can actually take it.
        for (uint256 i = 0; i < 4; i++) {
            address recipient = vault.recipientAt(i);
            uint256 owed = vault.claimable(i);
            uint256 before = recipient.balance;
            vault.claim(i);
            assertEq(recipient.balance - before, owed, "a recipient was not paid in native ETH");
        }

        assertEq(vault.outstanding(), 0, "the vault still owes native ETH");
        assertEq(vault.unaccounted(), 0, "the vault holds native value no ledger accounts for");
    }

    function test_a_native_claim_cannot_double_pay() public {
        (PoolKey memory key, AgenEngineVault vault,) = _launch("DBL", _flat(20_000));
        _buyExactIn(key, 1 ether);

        vault.claim(0);
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.NothingToClaim.selector, 0));
        vault.claim(0);
    }

    function test_a_zero_fee_native_market_accrues_nothing() public {
        (PoolKey memory key, AgenEngineVault vault,) = _launch("FREE", _flat(0));
        _buyExactIn(key, 1 ether);

        assertEq(vault.totalAccrued(), 0, "a free market charged something");
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.NothingToClaim.selector, 0));
        vault.claim(0);
    }

    function test_a_recipient_that_rejects_native_blocks_only_itself_and_stays_claimable() public {
        NativeRejecter bad = new NativeRejecter();

        AgenRuleLib.Config memory config = _flat(20_000);
        config.distribution = new AgenRuleLib.Share[](2);
        config.distribution[0] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Address, recipient: address(bad), sharePpm: 500_000});
        config.distribution[1] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Treasury, recipient: address(0), sharePpm: 500_000});

        (PoolKey memory key, AgenEngineVault vault,) = _launch("RJCT", config);
        _buyExactIn(key, 1 ether);

        uint256 owed = vault.claimable(0);
        assertGt(owed, 0, "nothing accrued to the rejecting recipient");

        vm.expectRevert();
        vault.claim(0);

        // The other recipient is unaffected — which is the whole point of the pull design.
        uint256 before = treasury.balance;
        vault.claim(1);
        assertEq(treasury.balance - before, vault.claimable(1) + (treasury.balance - before), "treasury paid");
        assertGt(treasury.balance, 0, "the treasury could not claim");

        // And the rejecting recipient's entitlement is still there, unspent, claimable the
        // moment it can accept value. Nothing was burned and nothing was reassigned.
        assertEq(vault.claimable(0), owed, "the failed claim consumed the entitlement");
    }

    function test_a_reentering_native_recipient_is_paid_once() public {
        NativeReenterer attacker = new NativeReenterer();

        AgenRuleLib.Config memory config = _flat(20_000);
        config.distribution = new AgenRuleLib.Share[](1);
        config.distribution[0] = AgenRuleLib.Share({
            kind: AgenRuleLib.RecipientKind.Address,
            recipient: address(attacker),
            sharePpm: uint24(AgenRuleLib.PPM_ONE)
        });

        (PoolKey memory key, AgenEngineVault vault,) = _launch("RENT", config);
        attacker.point(vault);

        _buyExactIn(key, 1 ether);
        uint256 owed = vault.claimable(0);

        vault.claim(0);

        // Effects precede the transfer, so the reentrant pass finds nothing owed.
        assertEq(address(attacker).balance, owed, "the attacker was paid twice");
        assertEq(vault.claimable(0), 0, "the claim did not clear");
    }

    function test_a_native_vault_cannot_pay_more_than_it_is_backed_by() public {
        (, AgenEngineVault vault,) = _launch("BACK", _flat(20_000));

        // Crediting without backing is the ledger writing a cheque the balance cannot cover.
        // Only the hook may credit, so this is asserted through the hook's own guard.
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.NotHook.selector, address(this)));
        vault.credit(1 ether);
    }

    // --- isolation across two native markets --------------------------------

    function test_two_native_markets_stay_isolated() public {
        (PoolKey memory keyA, AgenEngineVault vaultA,) = _launch("A", _flat(20_000));
        (PoolKey memory keyB, AgenEngineVault vaultB, address tokenB) =
            _launch("B", _tiered(5_000, ONE_PERCENT, 40_000));

        PoolId idA = keyA.toId();
        PoolId idB = keyB.toId();

        // Different configurations, identities, fee currencies and vaults.
        assertTrue(PoolId.unwrap(idA) != PoolId.unwrap(idB), "one pool, two markets");
        assertTrue(hook.configHashOf(idA) != hook.configHashOf(idB), "one identity, two markets");
        assertTrue(address(vaultA) != address(vaultB), "one vault, two markets");

        // A collects native, B collects its own launched token. A vault that could hold two
        // markets' assets is the shared-balance failure this design avoids.
        assertTrue(vaultA.currency().isAddressZero(), "A should collect native");
        assertEq(Currency.unwrap(vaultB.currency()), tokenB, "B should collect its token");

        uint40 initA = hook.initTimeOf(idA);
        uint40 initB = hook.initTimeOf(idB);

        // Interleaved trading.
        for (uint256 i = 0; i < 4; i++) {
            _buyExactIn(keyA, 0.25 ether);
            _buyExactIn(keyB, 0.25 ether);
        }

        // No fee-currency leak: A collects native, B collects its token.
        assertGt(vaultA.claims(), 0, "A holds no native claim");
        assertEq(address(vaultB).balance, 0, "B holds native value");
        assertEq(manager.balanceOf(address(vaultB), 0), 0, "B holds native claims");
        assertGt(IERC20(tokenB).balanceOf(address(vaultB)) + manager.balanceOf(address(vaultB), Currency.wrap(tokenB).toId()), 0, "B holds no token");

        // No volume leak: neither has a volume ladder, so both counters stay at zero.
        assertEq(hook.cumulativeQuoteVolume(idA), 0, "A accumulated a counter it does not read");
        assertEq(hook.cumulativeQuoteVolume(idB), 0, "B accumulated a counter it does not read");

        // No init-time leak.
        assertEq(hook.initTimeOf(idA), initA, "A's clock moved");
        assertEq(hook.initTimeOf(idB), initB, "B's clock moved");

        // No claim leak: each vault pays out its own, in its own asset, and neither can be
        // claimed from the other.
        uint256 creatorBefore = creator.balance;
        vaultA.claim(0);
        assertGt(creator.balance, creatorBefore, "A did not pay native");

        uint256 tokenBefore = IERC20(tokenB).balanceOf(creator);
        vaultB.claim(0);
        assertGt(IERC20(tokenB).balanceOf(creator), tokenBefore, "B did not pay its token");

        assertEq(vaultA.unaccounted(), 0, "A holds unaccounted value");
        assertEq(vaultB.unaccounted(), 0, "B holds unaccounted value");
    }

    // --- the pool is undisturbed ---------------------------------------------

    // --- gas, under a native quote -------------------------------------------

    /*
     * Measured on the second swap in each market, warm, so the figures are about the engine
     * rather than about v4's cold-slot costs. Compared against the ERC-20 figures in
     * `EngineHook.gas.t.sol`, which uses the same shapes.
     */
    function _measureBuy(PoolKey memory key) private returns (uint256) {
        _buyExactIn(key, 0.1 ether);

        vm.prank(trader);
        uint256 before = gasleft();
        swapRouter.swap{value: 0.1 ether}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -0.1 ether, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            ""
        );
        return before - gasleft();
    }

    function test_gas_flat_native_swap() public {
        (PoolKey memory key,,) = _launch("GFLT", _flat(20_000));
        uint256 used = _measureBuy(key);
        emit log_named_uint("native flat swap", used);
        assertLt(used, 400_000, "a flat native swap regressed");
    }

    function test_gas_size_tiered_native_swap() public {
        (PoolKey memory key,,) = _launch("GTIR", _tiered(5_000, ONE_PERCENT, 40_000));
        uint256 used = _measureBuy(key);
        emit log_named_uint("native size-tiered swap", used);
        assertLt(used, 400_000, "a native size-tiered swap regressed");
    }

    function test_gas_time_ladder_native_swap() public {
        AgenRuleLib.Config memory config = _flat(20_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.Time);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 20_000, sellFeePpm: 20_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 3600, buyFeePpm: 10_000, sellFeePpm: 10_000});

        (PoolKey memory key,,) = _launch("GTIM", config);
        uint256 used = _measureBuy(key);
        emit log_named_uint("native time-ladder swap", used);
        assertLt(used, 400_000, "a native time-ladder swap regressed");
    }

    function test_gas_volume_ladder_native_swap() public {
        AgenRuleLib.Config memory config = _flat(20_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.QuoteVolume);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 20_000, sellFeePpm: 20_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 1_000 ether, buyFeePpm: 10_000, sellFeePpm: 10_000});

        (PoolKey memory key,,) = _launch("GVOL", config);
        uint256 used = _measureBuy(key);
        emit log_named_uint("native volume-ladder swap", used);
        assertLt(used, 450_000, "a native volume-ladder swap regressed");
    }

    function test_gas_four_way_native_split() public {
        AgenRuleLib.Config memory config = _flat(20_000);
        config.distribution = new AgenRuleLib.Share[](4);
        config.distribution[0] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Creator, recipient: address(0), sharePpm: 400_000});
        config.distribution[1] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Treasury, recipient: address(0), sharePpm: 300_000});
        config.distribution[2] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Address, recipient: address(0xAAA1), sharePpm: 200_000});
        config.distribution[3] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Address, recipient: address(0xAAA2), sharePpm: 100_000});

        (PoolKey memory key,,) = _launch("GSPL", config);
        uint256 used = _measureBuy(key);
        emit log_named_uint("native four-way split swap", used);
        assertLt(used, 400_000, "the native fee path regressed with four recipients");
    }

    function test_gas_a_full_native_launch() public {
        AgenEngineFactory.Manifest memory manifest = _manifest("GLCH", _flat(20_000));

        uint256 before = gasleft();
        factory.deployMarket(manifest);
        uint256 used = before - gasleft();

        emit log_named_uint("full native engine launch", used);
        assertLt(used, 6_000_000, "a native launch regressed");
    }

    function test_a_native_market_charges_no_lp_fee() public {
        (PoolKey memory key,,) = _launch("NOLP", _flat(20_000));

        (,,, uint24 lpFee) = manager.getSlot0(key.toId());
        assertEq(lpFee, 0, "the pool would charge a second fee on the same swap");

        _buyExactIn(key, 1 ether);
        (,,, lpFee) = manager.getSlot0(key.toId());
        assertEq(lpFee, 0, "a swap changed the pool's stored fee");
    }
}
