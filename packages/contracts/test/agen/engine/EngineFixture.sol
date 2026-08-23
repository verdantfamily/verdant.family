// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {VerdantConstants} from "../../../src/libraries/VerdantConstants.sol";
import {AgenEngineHook} from "../../../src/agen/engine/AgenEngineHook.sol";
import {AgenEngineVault} from "../../../src/agen/engine/AgenEngineVault.sol";
import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";
import {HookMiner} from "../../utils/HookMiner.sol";

/// @notice Stands in for the PositionManager so liquidity can be minted in a test.
///
/// @dev `AgenEngineHook.beforeAddLiquidity` asks two questions: is `sender` the pinned
/// position manager, and does that contract report the factory as its own caller. Both are
/// real authentication rather than ceremony — the second is what stops anyone but the
/// factory adding liquidity — so a test cannot skip them, it has to satisfy them.
///
/// This is the smallest thing that does: it answers `msgSender()` with the address it was
/// told to, and it performs a `modifyLiquidity` inside its own unlock, settling whatever the
/// pool asks for. It is a test contract and lives nowhere near production.
contract LiquidityShim is IUnlockCallback {
    IPoolManager private immutable _manager;
    address private immutable _initiator;

    constructor(IPoolManager manager_, address initiator_) {
        _manager = manager_;
        _initiator = initiator_;
    }

    /// @dev What the hook believes about who asked. Named to match `IMsgSender`.
    function msgSender() external view returns (address) {
        return _initiator;
    }

    function addLiquidity(PoolKey memory key, int24 tickLower, int24 tickUpper, uint256 liquidity) external {
        _manager.unlock(abi.encode(key, tickLower, tickUpper, liquidity));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(_manager), "not the manager");

        (PoolKey memory key, int24 tickLower, int24 tickUpper, uint256 liquidity) =
            abi.decode(data, (PoolKey, int24, int24, uint256));

        (BalanceDelta delta,) = _manager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
                liquidityDelta: int256(liquidity),
                salt: bytes32(0)
            }),
            ""
        );

        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());

        return "";
    }

    function _settle(Currency currency, int128 amount) private {
        if (amount >= 0) return;

        uint256 owed = uint256(uint128(-amount));
        _manager.sync(currency);
        MockERC20(Currency.unwrap(currency)).transfer(address(_manager), owed);
        _manager.settle();
    }
}

/// @notice The engine's test fixture: a real PoolManager, a real pool, a mined hook.
///
/// @dev Deliberately not a mock of anything. The whole reason this exists is that the four
/// swap shapes and the two currency orientations are decided by v4's own accounting, and a
/// harness that stood in for the PoolManager would be a second implementation of exactly
/// the thing under test.
///
/// ## Both orientations from one pair
///
/// Two ERC-20s are deployed and sorted, so `currency0 < currency1` as v4 requires. Which of
/// them is the *quote* asset is then a configuration choice rather than a deployment one:
/// naming `currency0` as the quote puts the launched token at `currency1`, and naming
/// `currency1` puts it at `currency0`. That gives both orientations over the same pool
/// shape, which is the cleanest way to be sure the difference under test is the orientation
/// and nothing else.
///
/// Ether is not used as the quote here for a specific reason: ether always sorts to
/// `currency0`, so an ether-quoted market can only ever exercise one orientation. It gets
/// its own tests.
abstract contract EngineFixture is Deployers {
    uint160 internal constant ENGINE_FLAGS = 0x38CC;

    /// @dev One billion at eighteen decimals, which is what an Agen launch mints and what
    /// `packages/market-engine/src/fixtures.ts` uses as its reference supply.
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint128 internal constant ONE_PERCENT = uint128(SUPPLY / 100);

    AgenEngineHook internal hook;
    LiquidityShim internal shim;

    MockERC20 internal lower;
    MockERC20 internal upper;

    address internal creator = address(0xC0FFEE);
    address internal treasury = address(0x7EA5);
    address internal trader = address(0xDECAF);

    function _deployEngine() internal {
        deployFreshManagerAndRouters();

        // Two tokens, sorted, so either can play either role.
        MockERC20 a = new MockERC20("Alpha", "ALPHA", 18);
        MockERC20 b = new MockERC20("Beta", "BETA", 18);
        (lower, upper) = address(a) < address(b) ? (a, b) : (b, a);

        // The shim has to exist before the hook, because the hook pins it. The factory is
        // this test contract, which is what `configure` and `beforeAddLiquidity` will check.
        shim = new LiquidityShim(manager, address(this));

        bytes memory args = abi.encode(manager, address(this), address(shim));
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), ENGINE_FLAGS, type(AgenEngineHook).creationCode, args);

        hook = new AgenEngineHook{salt: salt}(manager, address(this), address(shim));
        require(address(hook) == predicted, "hook did not land at its mined address");
    }

    /// @dev A pool key for this pair. `quoteIsLower` decides the orientation.
    function _keyFor() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(lower)),
            currency1: Currency.wrap(address(upper)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    /// @dev Mint, approve and seed a full-range position so swaps in both directions have
    /// depth. Deep enough that the price impact of the test trades is irrelevant to what is
    /// being asserted.
    function _openPool(PoolKey memory key, AgenRuleLib.Config memory config)
        internal
        returns (AgenEngineVault vault)
    {
        vault = _deployVault(key, config);

        hook.configure(key, config, vault);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));

        lower.mint(address(shim), SUPPLY);
        upper.mint(address(shim), SUPPLY);

        int24 spacing = VerdantConstants.TICK_SPACING;
        shim.addLiquidity(key, -spacing * 1000, spacing * 1000, 1_000_000e18);

        lower.mint(trader, SUPPLY / 10);
        upper.mint(trader, SUPPLY / 10);
        vm.startPrank(trader);
        lower.approve(address(swapRouter), type(uint256).max);
        upper.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev The vault the configuration implies: one currency, and the recipients resolved.
    function _deployVault(PoolKey memory key, AgenRuleLib.Config memory config)
        internal
        returns (AgenEngineVault)
    {
        bool quoteIsZero = Currency.unwrap(key.currency0) == config.quoteAsset;
        bool feeIsZero = AgenRuleLib.FeeCurrency(config.feeCurrency) == AgenRuleLib.FeeCurrency.Quote
            ? quoteIsZero
            : !quoteIsZero;

        address[] memory recipients = new address[](config.distribution.length);
        uint24[] memory shares = new uint24[](config.distribution.length);
        for (uint256 i = 0; i < config.distribution.length; i++) {
            AgenRuleLib.RecipientKind kind = config.distribution[i].kind;
            recipients[i] = kind == AgenRuleLib.RecipientKind.Creator
                ? creator
                : kind == AgenRuleLib.RecipientKind.Treasury ? treasury : config.distribution[i].recipient;
            shares[i] = config.distribution[i].sharePpm;
        }

        return new AgenEngineVault(
            address(hook), manager, feeIsZero ? key.currency0 : key.currency1, recipients, shares
        );
    }

    // --- configuration builders ---------------------------------------------

    /// @dev A flat market quoted in whichever currency `quoteIsLower` names.
    function _flatConfig(bool quoteIsLower, uint24 feePpm) internal view returns (AgenRuleLib.Config memory config) {
        config.engineVersion = 1;
        config.referenceSupply = SUPPLY;
        config.quoteAsset = quoteIsLower ? address(lower) : address(upper);
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

    /// @dev The same market with one sell tier, which by ADR-018 moves the fee currency to
    /// the launched token.
    function _tieredConfig(bool quoteIsLower, uint24 baseFeePpm, uint128 threshold, uint24 tierFeePpm)
        internal
        view
        returns (AgenRuleLib.Config memory config)
    {
        config = _flatConfig(quoteIsLower, baseFeePpm);
        config.feeCurrency = uint8(AgenRuleLib.FeeCurrency.Token);
        config.sellTiers = new AgenRuleLib.Tier[](1);
        config.sellTiers[0] = AgenRuleLib.Tier({thresholdTokens: threshold, feePpm: tierFeePpm});
    }

    /// @dev The same pair with no hook, for a gas baseline. A static fee rather than the
    /// dynamic sentinel, since nothing is going to set one.
    function _plainKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(lower)),
            currency1: Currency.wrap(address(upper)),
            fee: 3000,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(address(0))
        });
    }

    function _openPlainPool(PoolKey memory key) internal {
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));

        lower.mint(address(shim), SUPPLY);
        upper.mint(address(shim), SUPPLY);

        int24 spacing = VerdantConstants.TICK_SPACING;
        shim.addLiquidity(key, -spacing * 1000, spacing * 1000, 1_000_000e18);

        lower.mint(trader, SUPPLY / 10);
        upper.mint(trader, SUPPLY / 10);
        vm.startPrank(trader);
        lower.approve(address(swapRouter), type(uint256).max);
        upper.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev The launched token, given the orientation.
    function _token(bool quoteIsLower) internal view returns (MockERC20) {
        return quoteIsLower ? upper : lower;
    }

    function _quote(bool quoteIsLower) internal view returns (MockERC20) {
        return quoteIsLower ? lower : upper;
    }
}
