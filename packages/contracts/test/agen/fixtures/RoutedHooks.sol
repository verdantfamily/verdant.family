// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {AgenRouted} from "../../../src/agen/AgenRouted.sol";

/// @dev The parts of `AgenBaseHook` these fixtures need, restated here rather than
/// imported from the generated Ember copy. These stand in for four *kinds* of generated
/// market, and pinning them to one build's snapshot of the base would make this suite
/// fail whenever that snapshot aged.
abstract contract BaseHook is IHooks {
    IPoolManager public immutable poolManager;

    error NotPoolManager(address caller);
    error CallbackNotEnabled();

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);
        _;
    }

    function getHookPermissions() public pure virtual returns (Hooks.Permissions memory);

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        (BeforeSwapDelta delta, uint24 fee) = _beforeSwap(sender, key, params, hookData);
        return (IHooks.beforeSwap.selector, delta, fee);
    }

    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        virtual
        returns (BeforeSwapDelta, uint24)
    {
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function isBuy(SwapParams calldata params) internal pure returns (bool) {
        return params.zeroForOne;
    }

    function inputCurrency(PoolKey calldata key, SwapParams calldata params) internal pure returns (Currency) {
        return params.zeroForOne ? key.currency0 : key.currency1;
    }

    function swapAmount(SwapParams calldata params) internal pure returns (uint256) {
        return params.amountSpecified < 0 ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
    }

    /// @dev Every callback below is unreachable: the address these fixtures are mined to
    /// grants only `beforeSwap`. Present because `IHooks` demands them.
    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert CallbackNotEnabled();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert CallbackNotEnabled();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert CallbackNotEnabled();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
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
    ) external pure returns (bytes4, BalanceDelta) {
        revert CallbackNotEnabled();
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert CallbackNotEnabled();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert CallbackNotEnabled();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert CallbackNotEnabled();
    }
}

/// @notice A. The market that does not care who is trading.
///
/// @dev Charges the same fee on every swap and sends it to a vault. It never mentions
/// `AgenRouted`, which is the point: this is what a market generated before the router
/// existed looks like, and it has to keep working through every route.
contract BasicFeeHook is BaseHook {
    uint256 public collected;
    uint24 public constant FEE_PPM = 10_000; // 1%

    constructor(IPoolManager poolManager_) BaseHook(poolManager_) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
        permissions.beforeSwapReturnDelta = true;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
        uint256 fee = (swapAmount(params) * FEE_PPM) / 1_000_000;
        if (fee == 0) return (BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);

        poolManager.take(inputCurrency(key, params), address(this), fee);
        collected += fee;

        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by the swap amount
        return (toBeforeSwapDelta(int128(int256(fee)), 0), LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    receive() external payable {}
}

/// @notice SIMPLE. A fee on sells, paid to a receiver, and no interest in who is trading.
///
/// @dev The ordinary case, and the one most generated markets are: a rule that is true of
/// the market rather than of a trader. It inherits nothing from `AgenRouted` and takes no
/// router, so it is also the market that proves the router did not become mandatory.
///
/// The fee receiver is a constructor argument because that is how a real generated market
/// takes one — the deployment resolves it, and a hook holding it in an immutable is how
/// the market keeps the promise for its whole life.
contract SellFeeHook is BaseHook {
    uint24 public constant SELL_FEE_PPM = 10_000; // 1%

    address public immutable feeReceiver;
    uint256 public collected;

    constructor(IPoolManager poolManager_, address feeReceiver_) BaseHook(poolManager_) {
        feeReceiver = feeReceiver_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
        permissions.beforeSwapReturnDelta = true;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
        // Sells only. A buy spends the quote asset and pays nothing here.
        if (isBuy(params)) return (BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);

        uint256 fee = (swapAmount(params) * SELL_FEE_PPM) / 1_000_000;
        if (fee == 0) return (BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);

        // Straight to the receiver. A hook is called on every swap, so a hook holding a
        // balance has a withdrawal path in every callback.
        poolManager.take(inputCurrency(key, params), feeReceiver, fee);
        collected += fee;

        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by the swap amount
        return (toBeforeSwapDelta(int128(int256(fee)), 0), LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}

/// @notice B. The market that will only be traded through Agen.
///
/// @dev Uses `_requireTrader`, so a swap arriving any other way reverts. A real market
/// does this when attributing a trade to a router would corrupt its accounting rather
/// than merely blur it.
contract RouterAuthHook is BaseHook, AgenRouted {
    mapping(address => uint256) public tradesBy;
    address public lastTrader;

    constructor(IPoolManager poolManager_, address router_) BaseHook(poolManager_) AgenRouted(router_) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
    }

    function _beforeSwap(address sender, PoolKey calldata, SwapParams calldata, bytes calldata hookData)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
        address trader = _requireTrader(sender, hookData);

        tradesBy[trader] += 1;
        lastTrader = trader;

        return (BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}

/// @notice C. The market that prefers an identity and survives without one.
///
/// @dev Uses `_traderOr`, so it keeps trading through the Universal Router and simply
/// attributes those trades to whoever called. Records both what it was told and what it
/// would have recorded without the router, so a test can see the difference.
contract TraderIdentityHook is BaseHook, AgenRouted {
    mapping(address => uint256) public buysBy;
    address public lastTrader;
    address public lastSender;

    constructor(IPoolManager poolManager_, address router_) BaseHook(poolManager_) AgenRouted(router_) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
    }

    function _beforeSwap(address sender, PoolKey calldata, SwapParams calldata params, bytes calldata hookData)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
        address trader = _traderOr(sender, hookData);

        lastSender = sender;
        lastTrader = trader;
        if (isBuy(params)) buysBy[trader] += 1;

        return (BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}

/// @notice D. PULSE — per-wallet streaks, which is the shape that motivated all of this.
///
/// @dev Every third consecutive buy by the same wallet is fee-free; that wallet's own
/// sell resets its streak. Impossible to build correctly on a route that reports the
/// router: every trader in the world would share one streak.
contract PulseStreakHook is BaseHook, AgenRouted {
    uint24 public constant FEE_PPM = 20_000; // 2%
    uint256 public constant STREAK = 3;

    mapping(address => uint256) public streakOf;
    mapping(address => uint256) public freeTradesOf;
    uint256 public collected;

    constructor(IPoolManager poolManager_, address router_) BaseHook(poolManager_) AgenRouted(router_) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
        permissions.beforeSwapReturnDelta = true;
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
        address trader = _requireTrader(sender, hookData);

        if (!isBuy(params)) {
            streakOf[trader] = 0;
            return _charge(key, params);
        }

        uint256 streak = streakOf[trader] + 1;

        if (streak >= STREAK) {
            streakOf[trader] = 0;
            freeTradesOf[trader] += 1;
            return (BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);
        }

        streakOf[trader] = streak;
        return _charge(key, params);
    }

    function _charge(PoolKey calldata key, SwapParams calldata params)
        private
        returns (BeforeSwapDelta, uint24)
    {
        uint256 fee = (swapAmount(params) * FEE_PPM) / 1_000_000;
        if (fee == 0) return (BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);

        poolManager.take(inputCurrency(key, params), address(this), fee);
        collected += fee;

        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by the swap amount
        return (toBeforeSwapDelta(int128(int256(fee)), 0), LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    receive() external payable {}
}
