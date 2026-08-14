// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";

import {InstantFeeVault} from "./InstantFeeVault.sol";
import {InstantFees} from "./libraries/InstantFees.sol";
import {VerdantConstants} from "./libraries/VerdantConstants.sol";

/// @title InstantHook
/// @notice The whole fee mechanism of an Instant market: 1.50% of every trade, taken
/// from the ether leg in both directions, and nothing else.
///
/// @dev One hook for every Instant market. The fee is a constant of the deployment
/// (`InstantFees`), so there is nothing per-market for a hook to store except where that
/// market's fees go — which is the vault registered at creation.
///
/// This is deliberately a different contract from `VerdantHook` rather than a version of
/// it. `VerdantHook` declares no delta-returning permissions at all and takes no custody;
/// its own header records that the design below was *rejected* for v1 because it puts a
/// settle/take pair inside the swap. That reasoning was right for a hook whose fee could
/// be an ordinary LP fee. It does not survive the requirement that a creator is paid in
/// ether: Uniswap takes an LP fee from whichever currency is going *into* the pool, which
/// is ether on a buy and the launched token on a sell, so a creator would earn half their
/// fee in a token they never asked to hold. See ADR-014.
///
/// ## Where the fee is taken, and why it is two callbacks
///
/// Ether is always `currency0` here — Instant is ether-quoted and the zero address sorts
/// below every token — so the launched token is always `currency1` and a buy is always
/// `zeroForOne`. What varies is whether ether is the swap's *specified* currency, and
/// that decides which callback can charge:
///
/// | direction | kind | ether is | charged in |
/// | --- | --- | --- | --- |
/// | buy | exact input | specified (input) | `beforeSwap` |
/// | buy | exact output | unspecified (input) | `afterSwap` |
/// | sell | exact input | unspecified (output) | `afterSwap` |
/// | sell | exact output | specified (output) | `beforeSwap` |
///
/// The rule behind the table is `(amountSpecified < 0) == zeroForOne`, which is precisely
/// the test `Hooks.afterSwap` uses to decide which currency a returned delta lands on.
/// When ether is specified its amount is known before the swap runs, so the charge rides
/// on `BeforeSwapDelta`'s specified component. When it is unspecified the amount is
/// whatever the pool computes, so there is nothing to take a percentage of until
/// `afterSwap` has the `BalanceDelta` in hand.
///
/// Handling only the first pair would leave the obvious hole: a trader avoiding the fee
/// entirely by routing every trade as the other kind.
///
/// In all four cases the charge is `InstantFees.split(...).total` of the trader's own
/// ether leg — what they spend on a buy, what they receive on a sell — and in all four
/// the mechanism is the same pair of halves. `poolManager.mint` credits the vault with a
/// claim on that much ether and leaves this hook owing the manager the same amount; the
/// returned delta is what makes the trader settle it. Either half without the other is a
/// swap that does not balance.
///
/// ## The pool charges nothing
///
/// `beforeSwap` returns a zero LP fee with `OVERRIDE_FEE_FLAG` on every swap, and
/// `afterInitialize` writes zero as the stored fee. That is not a default, it is the
/// invariant: the 1.50% here is the whole cost of a trade, so any LP fee at all would be
/// a second charge on the same swap and would make the number on the launch screen false.
/// It also means the locked position accrues nothing, which is why an Instant market's
/// fees are claimed from its vault rather than through `PositionLocker.collect`.
///
/// ## Custody
///
/// This contract never holds a balance, in ether or in claims. The mint names the vault
/// as the recipient, and the vault is the only thing with a withdrawal path. A hook is
/// called on every swap, so a hook holding money would make "can this be drained" a
/// question about the correctness of the swap logic above.
contract InstantHook is IHooks {
    using CurrencyLibrary for Currency;
    using LPFeeLibrary for uint24;
    using PoolIdLibrary for PoolKey;

    // --- permissions ---------------------------------------------------------

    /// @notice The low 14 bits this contract's address must have.
    ///
    /// @dev Composed from Uniswap's own flags rather than written as a literal, so a
    /// change to their meaning upstream is a compile-time change here. The two
    /// `RETURNS_DELTA` bits are the ones that make custody possible at all: without them
    /// v4 does not even read a returned delta, and the fee would be silently uncharged
    /// while `take` left the swap unbalanced.
    uint160 internal constant REQUIRED_PERMISSIONS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    // --- immutables ----------------------------------------------------------

    IPoolManager public immutable poolManager;

    /// @notice The Instant factory, and the only contract that may register a market.
    address public immutable factory;

    /// @notice The pinned PositionManager, for the same reason `VerdantHook` pins one:
    /// `beforeAddLiquidity` reports the PoolManager's caller, and only a known contract's
    /// claim about who asked is worth believing.
    address public immutable positionManager;

    // --- storage -------------------------------------------------------------

    /// @dev Where each market's fees go. The only per-market state this hook has, and
    /// the swap path's only SLOAD.
    mapping(PoolId poolId => InstantFeeVault vault) private _vaults;

    // --- events --------------------------------------------------------------

    event MarketRegistered(PoolId indexed poolId, address vault);
    event MarketInitialized(PoolId indexed poolId);

    /// @notice A trade paid its fee. Carries the ether leg it was charged on so an
    /// indexer never has to infer the direction to reconstruct the number.
    event FeeTaken(PoolId indexed poolId, bool isBuy, uint256 etherLeg, uint256 fee);

    // --- errors --------------------------------------------------------------

    error NotPoolManager(address caller);
    error NotFactory(address caller);
    error HookAddressMismatch(address hook, uint160 actualBits, uint160 requiredBits);
    error AlreadyRegistered(PoolId poolId);
    error NotRegistered(PoolId poolId);
    error ZeroVault();

    /// @notice The pool is not quoted in ether.
    /// @dev Instant is ether-only, and the whole fee design depends on it: every branch
    /// below assumes `currency0` is the ether leg. A pool quoted in anything else would
    /// charge the fee on the wrong currency, so it is refused at initialisation rather
    /// than mishandled on every swap.
    error QuoteNotEther(Currency currency0);

    error FeeNotDynamic(uint24 fee);
    error TickSpacingMismatch(int24 provided, int24 required);
    error HookNotThis(IHooks provided, address expected);
    error NotPositionManager(address sender);
    error NotTheFactorysLiquidity(address initiator);
    error CallbackNotEnabled();

    // --- construction --------------------------------------------------------

    /// @dev The address check is why this constructor exists. v4 does not verify that a
    /// hook's address grants the permissions it implements, so an unmined address would
    /// be accepted by `initialize` and then never called — here, that would mean a
    /// market that charges nobody anything, discovered after it held money.
    constructor(IPoolManager poolManager_, address factory_, address positionManager_) {
        uint160 bits = uint160(address(this)) & Hooks.ALL_HOOK_MASK;
        if (bits != REQUIRED_PERMISSIONS) {
            revert HookAddressMismatch(address(this), bits, REQUIRED_PERMISSIONS);
        }

        poolManager = poolManager_;
        factory = factory_;
        positionManager = positionManager_;
    }

    // --- configuration -------------------------------------------------------

    /// @notice Point a market at the vault that will hold its fees. Once per pool, by
    /// the factory, and never again by anyone.
    ///
    /// @dev Separate from `beforeInitialize` because v4's initialise path carries no
    /// hook data at the pinned commit, which is the same constraint `VerdantHook.configure`
    /// works around. `beforeInitialize` then refuses any pool that has not been through
    /// here, so the two cannot come apart.
    function register(PoolKey calldata key, InstantFeeVault vault) external {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        if (address(vault) == address(0)) revert ZeroVault();
        _requireInstantKey(key);

        PoolId poolId = key.toId();
        if (address(_vaults[poolId]) != address(0)) revert AlreadyRegistered(poolId);

        _vaults[poolId] = vault;
        emit MarketRegistered(poolId, address(vault));
    }

    /// @notice The vault holding a market's fees, or the zero address.
    function vaultOf(PoolKey calldata key) external view returns (InstantFeeVault) {
        return _vaults[key.toId()];
    }

    // --- v4 callbacks --------------------------------------------------------

    /// @inheritdoc IHooks
    function beforeInitialize(address, PoolKey calldata key, uint160) external view override returns (bytes4) {
        _requirePoolManager();
        _requireInstantKey(key);

        PoolId poolId = key.toId();
        if (address(_vaults[poolId]) == address(0)) revert NotRegistered(poolId);

        return IHooks.beforeInitialize.selector;
    }

    /// @inheritdoc IHooks
    /// @dev Writes zero as the pool's stored LP fee. `beforeSwap` overrides it to zero on
    /// every swap as well, which is belt and braces on the one invariant a trader can
    /// check for themselves: that the pool takes nothing.
    function afterInitialize(address, PoolKey calldata key, uint160, int24) external override returns (bytes4) {
        _requirePoolManager();

        poolManager.updateDynamicLPFee(key, 0);

        emit MarketInitialized(key.toId());
        return IHooks.afterInitialize.selector;
    }

    /// @inheritdoc IHooks
    /// @notice Exactly one position ever exists in an Instant pool: the locked one the
    /// factory mints at creation.
    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        _requirePoolManager();

        // Two checks, and neither is sufficient alone. The first establishes that the
        // contract about to be asked who initiated this is one whose answer can be
        // trusted; the second asks it.
        if (sender != positionManager) revert NotPositionManager(sender);

        address initiator = IMsgSender(sender).msgSender();
        if (initiator != factory) revert NotTheFactorysLiquidity(initiator);

        return IHooks.beforeAddLiquidity.selector;
    }

    /// @inheritdoc IHooks
    /// @dev Charges when ether is the swap's specified currency, which is a buy priced by
    /// its input or a sell priced by its output. In both the ether amount is
    /// `amountSpecified`, so the fee is known before the pool computes anything.
    ///
    /// `amountToSwap` becomes `amountSpecified + deltaSpecified` inside `Hooks.beforeSwap`.
    /// On an exact-input buy that is a smaller input, so the trader spends what they said
    /// and receives less output. On an exact-output sell it is a larger output, so the
    /// pool produces the fee on top and the trader still receives exactly what they asked
    /// for, paying for it in the token they are selling.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _requirePoolManager();

        // Zero fee, always. The flag is what makes v4 use this instead of the stored one.
        uint24 zeroLpFee = LPFeeLibrary.OVERRIDE_FEE_FLAG;

        if (!_etherIsSpecified(params)) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, zeroLpFee);
        }

        uint256 etherLeg =
            params.amountSpecified < 0 ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);

        uint256 fee = _collect(key, params.zeroForOne, etherLeg);
        if (fee == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, zeroLpFee);
        }

        // The fee is a fraction of an amount v4 already holds as an int128, so it cannot
        // exceed one.
        // forge-lint: disable-next-line(unsafe-typecast)
        BeforeSwapDelta delta = toBeforeSwapDelta(int128(int256(fee)), 0);

        return (IHooks.beforeSwap.selector, delta, zeroLpFee);
    }

    /// @inheritdoc IHooks
    /// @dev Charges when ether is the swap's *unspecified* currency — a buy priced by its
    /// output, or a sell priced by its input. Neither knows the ether amount in advance,
    /// so the charge waits for the `BalanceDelta`.
    ///
    /// The returned `int128` lands on the unspecified currency, which is `currency0` in
    /// both of these cases, and `Hooks.afterSwap` subtracts it from the caller's delta:
    /// on a buy that means the trader pays the fee on top of the input the pool needed,
    /// and on a sell it means they receive the ether the pool produced less the fee.
    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        override
        returns (bytes4, int128)
    {
        _requirePoolManager();

        if (_etherIsSpecified(params)) return (IHooks.afterSwap.selector, 0);

        // `amount0` is the pool's view of the ether leg: negative when the trader is
        // paying ether in, positive when they are receiving it.
        int128 amount0 = delta.amount0();
        uint256 etherLeg = amount0 < 0 ? uint256(uint128(-amount0)) : uint256(uint128(amount0));

        uint256 fee = _collect(key, params.zeroForOne, etherLeg);

        // forge-lint: disable-next-line(unsafe-typecast) -- a fraction of an int128 leg
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    // --- internals -----------------------------------------------------------

    /// @dev Whether ether — always `currency0` here — is the currency the swap named an
    /// amount for. The same test `Hooks.afterSwap` uses to place a returned delta, so
    /// this hook charges on exactly the side v4 will settle against.
    function _etherIsSpecified(SwapParams calldata params) private pure returns (bool) {
        return (params.amountSpecified < 0) == params.zeroForOne;
    }

    /// @dev Move the fee out of the pool and into the market's vault, and record it.
    ///
    /// Returns the amount taken so the caller can balance it with a delta. Returns zero
    /// on a leg too small to owe a wei, and must not revert on one: this runs inside
    /// every swap, and a revert here is a market that cannot be traded.
    function _collect(PoolKey calldata key, bool zeroForOne, uint256 etherLeg) private returns (uint256 fee) {
        (,, fee) = InstantFees.split(etherLeg);
        if (fee == 0) return 0;

        PoolId poolId = key.toId();
        InstantFeeVault vault = _vaults[poolId];

        // Unreachable: `beforeInitialize` refuses a pool with no vault, so a swap
        // implies a registration. Checked because the alternative is `take` sending
        // ether to the zero address.
        if (address(vault) == address(0)) revert NotRegistered(poolId);

        // `mint`, not `take`. At this point in a swap the trader has not settled, so the
        // manager may hold no ether at all — which is exactly the state a freshly
        // launched Instant pool is in until its first buy. Minting credits the vault
        // with a claim on ether and leaves this hook owing the manager the same amount,
        // which the returned delta makes the trader cover. The vault redeems the claim
        // later, outside any swap. See InstantFeeVault's header.
        poolManager.mint(address(vault), key.currency0.toId(), fee);
        vault.credit(etherLeg);

        emit FeeTaken(poolId, zeroForOne, etherLeg, fee);
    }

    function _requirePoolManager() private view {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);
    }

    /// @dev Everything about a key that this hook's arithmetic depends on. Checked at
    /// registration and again at initialisation, because a `PoolId` is a hash of the
    /// whole key — so a key validated here is necessarily the key that gets a pool.
    function _requireInstantKey(PoolKey calldata key) private view {
        if (Currency.unwrap(key.currency0) != address(0)) revert QuoteNotEther(key.currency0);
        if (!key.fee.isDynamicFee()) revert FeeNotDynamic(key.fee);
        if (key.tickSpacing != VerdantConstants.TICK_SPACING) {
            revert TickSpacingMismatch(key.tickSpacing, VerdantConstants.TICK_SPACING);
        }
        if (address(key.hooks) != address(this)) revert HookNotThis(key.hooks, address(this));
    }

    // --- callbacks this hook does not have permission to receive --------------

    /// @dev Present only because `IHooks` declares them. The address bits mean v4 will
    /// never call these, so reaching one is a bug in something else.
    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert CallbackNotEnabled();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert CallbackNotEnabled();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }
}
