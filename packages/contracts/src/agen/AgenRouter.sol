// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {AgenHookData} from "./AgenHookData.sol";

/// @title AgenRouter
/// @notice The route an Agen trade takes, and the only one that can say who is trading.
///
/// @dev Shared infrastructure: one of these per chain, named by every generated market
/// that cares about identity, and never redeployed — a market's hook holds the address in
/// an immutable, so replacing this contract would orphan every market that trusts it.
///
/// ## What this exists for
///
/// Uniswap's own Universal Router is a perfectly good way to swap and a useless way to
/// tell a hook anything. It reports itself as the caller and sends empty `hookData`, so
/// to a market that counts a wallet's buys, every trade in the world is the same wallet
/// making its millionth purchase. Agen advertises markets whose whole point is per-trader
/// behaviour — streaks, jackpots, holder rewards — and none of them can be built on a
/// route that does not know who is there.
///
/// The fix is not clever and should not be. This router does what the Universal Router
/// does, and writes `msg.sender` into the hook data on the way past. A hook that trusts
/// this address gets an identity it can account to; a hook that does not is unaffected,
/// which is why markets built before this contract existed keep trading through it
/// unchanged.
///
/// ## Why the identity can be trusted
///
/// Only because of where it is written. `trader` is `msg.sender`, taken here, not passed
/// in — there is no parameter for it and no way to ask for one. A wallet that wants to be
/// credited as somebody else would have to make the pool manager report this contract as
/// the caller, which means being this contract.
///
/// Everything else follows from the hook's side: it compares the swap's sender against
/// the router address it was constructed with, and only then reads the data. `AgenRouted`
/// is that check, written once. A hook that skips it and trusts `hookData` from any
/// sender has a faucet, which is why the base contract exists and the generation context
/// tells models to use it rather than to write their own.
///
/// ## Custody
///
/// None. The input is settled to the pool manager and the output is taken to the trader,
/// both inside the lock, so between transactions this contract holds nothing. Native
/// value arrives with the call and leaves in the same call; an ERC-20 input is pulled
/// from the trader straight to the manager rather than through here.
contract AgenRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;

    /// @dev What `unlock` carries to the callback. Not part of the interface.
    struct Trade {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minAmountOut;
        address trader;
        bytes extra;
        /// @dev Set by `quote`. Throws the result away instead of paying it out.
        bool quoting;
    }

    error NotPoolManager(address caller);
    error AmountZero();
    error WrongValue(uint256 sent, uint256 required);
    error BelowMinimum(uint256 received, uint256 required);

    /// @notice What a quote returns. Always thrown, never a failure.
    /// @dev See `quote`.
    error QuoteResult(uint256 amountOut, uint256 amountSpent);

    /// @notice One trade, as the market's own accounting will see it.
    /// @dev Emitted here as well as by the pool so that a market's history can be read
    /// without decoding hook data: `Swap` names this contract, and this names the trader.
    event AgenSwap(
        bytes32 indexed poolId,
        address indexed trader,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    /// @notice Swap an exact amount in, as `msg.sender`.
    ///
    /// @dev The output goes to `msg.sender` and there is deliberately no recipient
    /// parameter. A router that pays somebody other than the trader it declared would
    /// make "who traded" and "who was paid" two different questions, and a market's
    /// mechanic reading the first while the value went to the second is the sort of
    /// discrepancy that is discovered by being exploited.
    ///
    /// @param key The market's pool. Quote is always currency0; the launched token is
    /// currency1.
    /// @param zeroForOne True to buy the token with the quote asset.
    /// @param amountIn Exactly what is spent. Native input must arrive as `msg.value`.
    /// @param minAmountOut The floor on the output, enforced before anything is paid out.
    /// @param extra The market's own hook data, if it asks for any. Usually empty.
    /// @return amountOut What the trader received.
    function swap(
        PoolKey calldata key,
        bool zeroForOne,
        uint128 amountIn,
        uint128 minAmountOut,
        bytes calldata extra
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (amountIn == 0) revert AmountZero();

        Currency currencyIn = zeroForOne ? key.currency0 : key.currency1;
        bool native = Currency.unwrap(currencyIn) == address(0);

        // Exact, not "at least". Excess native value sent here would either be stranded
        // in a contract with no withdrawal path or refunded by logic that has to be right
        // about a case nobody tests; refusing it is neither.
        uint256 required = native ? amountIn : 0;
        if (msg.value != required) revert WrongValue(msg.value, required);

        bytes memory result = poolManager.unlock(
            abi.encode(
                Trade({
                    key: key,
                    zeroForOne: zeroForOne,
                    amountIn: amountIn,
                    minAmountOut: minAmountOut,
                    trader: msg.sender,
                    extra: extra,
                    quoting: false
                })
            )
        );

        amountOut = abi.decode(result, (uint256));
    }

    /// @notice What a trade would return, run as the trade itself.
    ///
    /// @dev Always reverts, with `QuoteResult`. Call it, never send it.
    ///
    /// This exists because a market that authenticates its route cannot be quoted any
    /// other way. Uniswap's `V4Quoter` calls the pool as itself with empty hook data, so
    /// a hook using `_requireTrader` refuses it — and the markets that refuse it are
    /// precisely the ones this router was built for. Quoting them through the router
    /// makes the hook see the same sender and the same identity it will see for real.
    ///
    /// It runs the identical path rather than an approximation of it, which is the whole
    /// value: the answer includes whatever the hook did, including a fee that depends on
    /// who is asking. The revert is what undoes it — every settle, take and state change
    /// inside the lock is rolled back with the frame.
    ///
    /// The caller must be simulated as the trader, since that is who the hook is told
    /// about, and a sell needs that trader's allowance in place exactly as a real sell
    /// would. A quote that could be taken without an approval would be quoting a
    /// different transaction from the one on offer.
    function quote(PoolKey calldata key, bool zeroForOne, uint128 amountIn, bytes calldata extra)
        external
        payable
    {
        if (amountIn == 0) revert AmountZero();

        poolManager.unlock(
            abi.encode(
                Trade({
                    key: key,
                    zeroForOne: zeroForOne,
                    amountIn: amountIn,
                    minAmountOut: 0,
                    trader: msg.sender,
                    extra: extra,
                    quoting: true
                })
            )
        );
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Reachable only through `swap` above: `unlock` calls back whoever called it,
    /// so the sender check is what makes that the only route in.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);

        Trade memory trade = abi.decode(data, (Trade));

        Currency currencyIn = trade.zeroForOne ? trade.key.currency0 : trade.key.currency1;
        Currency currencyOut = trade.zeroForOne ? trade.key.currency1 : trade.key.currency0;

        // Settled before the swap, not after, and the ordering is load-bearing for
        // exactly the markets this router exists to serve. A hook that diverts part of a
        // trade calls `poolManager.take` from inside `beforeSwap`, and at that moment the
        // manager must already hold the input — otherwise it reverts inside the hook, and
        // the market looks broken when it is the settlement order that was wrong. See the
        // same reasoning, learned the same way, in `AgenFactory.unlockCallback`.
        _settle(currencyIn, trade.amountIn, trade.trader);

        BalanceDelta delta = poolManager.swap(
            trade.key,
            SwapParams({
                zeroForOne: trade.zeroForOne,
                // Negative is exact input.
                // forge-lint: disable-next-line(unsafe-typecast) -- a uint128 widened
                amountSpecified: -int256(uint256(trade.amountIn)),
                // The extreme rather than a chosen bound. `minAmountOut` is the trader's
                // slippage control and it is the one they can see; a second, silent limit
                // here would reject trades for a reason no interface could explain.
                sqrtPriceLimitX96: trade.zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            AgenHookData.encode(trade.trader, trade.extra)
        );

        // forge-lint: disable-next-line(unsafe-typecast) -- v4 guarantees the sign
        uint256 spent = trade.zeroForOne
            ? uint256(uint128(-delta.amount0()))
            : uint256(uint128(-delta.amount1()));
        // forge-lint: disable-next-line(unsafe-typecast) -- v4 guarantees the sign
        uint256 received = trade.zeroForOne
            ? uint256(uint128(delta.amount1()))
            : uint256(uint128(delta.amount0()));

        // A quote has its answer now. Thrown rather than returned, which unwinds the
        // lock and every balance this function has touched — the caller reads the
        // revert data.
        if (trade.quoting) revert QuoteResult(received, spent);

        if (received < trade.minAmountOut) revert BelowMinimum(received, trade.minAmountOut);

        poolManager.take(currencyOut, trade.trader, received);

        // One-sided launch liquidity is finite, so an input larger than the pool can
        // serve is only partly consumed. What is left is this contract's credit inside
        // the lock and has to leave before it closes.
        uint256 unspent = trade.amountIn - spent;
        if (unspent != 0) poolManager.take(currencyIn, trade.trader, unspent);

        emit AgenSwap(
            PoolId.unwrap(trade.key.toId()), trade.trader, trade.zeroForOne, spent, received
        );

        return abi.encode(received);
    }

    /// @dev Native value is already here, having arrived with the call. An ERC-20 input
    /// is pulled from the trader directly to the manager, so it never rests in this
    /// contract and no allowance to this contract can be drained by anybody else.
    function _settle(Currency currency, uint256 amount, address from) private {
        if (Currency.unwrap(currency) == address(0)) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransferFrom(from, address(poolManager), amount);
            poolManager.settle();
        }
    }
}
