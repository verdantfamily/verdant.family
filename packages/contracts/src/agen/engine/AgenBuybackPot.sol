// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {AgenEngineVault} from "./AgenEngineVault.sol";
import {IAgenEngineHookV2} from "./IAgenEngineHookV2.sol";
import {VerdantNotifyingToken} from "./VerdantNotifyingToken.sol";

/// @title AgenBuybackPot
/// @notice Accrues a market's buyback share and spends it in a later transaction.
///
/// @dev Armed by the hook when a sell meets the trigger. Executed by anyone, never
/// inside the triggering swap, with a caller-supplied minimum-out. Bought tokens are
/// burned. Sandwichable; bounded to one execution per arm. ADR-019.
contract AgenBuybackPot is IUnlockCallback {
    using CurrencyLibrary for Currency;

    IAgenEngineHookV2 public immutable hook;
    uint256 public immutable slot;

    AgenEngineVault public vault;
    PoolId public poolId;
    address public token;
    bool public bound;

    bool public armed;
    uint256 public armedEpoch;
    uint256 public lastExecutedEpoch;

    event Bound(address vault, PoolId poolId, address token);
    event Armed(uint256 epoch);
    event Executed(uint256 epoch, uint256 spent, uint256 bought);

    error AlreadyBound();
    error NotBound();
    error NotHook(address caller);
    error NotPoolManager(address caller);
    error InSwap();
    error NotArmed();
    error NothingToSpend();
    error Slippage(uint256 bought, uint256 minOut);

    constructor(IAgenEngineHookV2 hook_, uint256 slot_) {
        hook = hook_;
        slot = slot_;
    }

    function bind(AgenEngineVault vault_, PoolId poolId_, address token_) external {
        if (msg.sender != address(hook)) revert NotHook(msg.sender);
        if (bound) revert AlreadyBound();
        vault = vault_;
        poolId = poolId_;
        token = token_;
        bound = true;
        emit Bound(address(vault_), poolId_, token_);
    }

    function arm() external {
        if (msg.sender != address(hook)) revert NotHook(msg.sender);
        if (!bound) revert NotBound();
        uint256 epoch = hook.epochOf(poolId, block.timestamp);
        armed = true;
        armedEpoch = epoch;
        emit Armed(epoch);
    }

    /// @notice Pull the vault share and buy (or burn) with it. Anyone may call.
    /// @param key The market's own pool. The hook refuses any other.
    /// @param minOut Tokens the swap must produce. Required: a public buyback is sandwichable.
    function execute(PoolKey calldata key, uint256 minOut) external {
        if (!bound) revert NotBound();
        if (!armed) revert NotArmed();
        if (hook.inSwap(poolId)) revert InSwap();
        hook.requireOwnPool(poolId, key);

        try vault.claim(slot) {} catch {}

        Currency fee = vault.currency();
        uint256 spend = fee.isAddressZero() ? address(this).balance : fee.balanceOfSelf();
        if (spend == 0) revert NothingToSpend();

        uint256 bought;
        if (Currency.unwrap(fee) == token) {
            bought = spend;
            VerdantNotifyingToken(token).burn(bought);
        } else {
            bytes memory result = hook.poolManager().unlock(abi.encode(key, spend, minOut));
            bought = abi.decode(result, (uint256));
            if (bought < minOut) revert Slippage(bought, minOut);
            VerdantNotifyingToken(token).burn(bought);
        }

        armed = false;
        lastExecutedEpoch = armedEpoch;
        emit Executed(armedEpoch, spend, bought);
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(hook.poolManager())) revert NotPoolManager(msg.sender);

        (PoolKey memory key, uint256 spend, uint256 minOut) = abi.decode(data, (PoolKey, uint256, uint256));

        IPoolManager manager = hook.poolManager();
        Currency fee = vault.currency();
        bool zeroForOne = Currency.unwrap(key.currency0) == Currency.unwrap(fee);

        // Exact-in: spend the whole pot, refuse if the token leg is below `minOut`.
        BalanceDelta delta = manager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                // forge-lint: disable-next-line(unsafe-typecast) -- a balance this contract holds
                amountSpecified: -int256(spend),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        /*
         * Both legs are read from the delta rather than assumed from `spend`.
         *
         * What is owed is not necessarily what was asked for: the hook takes its fee out of
         * this swap like any other, so the input leg the manager wants settled includes it,
         * and one-sided launch liquidity can leave part of a large input unconsumed. Taking
         * the figures from the delta is the only version that is right in both cases.
         *
         * The signs are v4's convention and are the whole of the arithmetic here — negative
         * is owed to the manager, positive is owed to this contract. Getting them backwards
         * produced a `bought` of about 2^256 that sailed past the minimum-out check and died
         * in `take`, which is a revert rather than a loss but is also a buyback that never
         * happened.
         */
        int128 inLeg = zeroForOne ? delta.amount0() : delta.amount1();
        int128 outLeg = zeroForOne ? delta.amount1() : delta.amount0();

        uint256 bought = outLeg > 0 ? uint256(uint128(outLeg)) : 0;
        if (bought < minOut) revert Slippage(bought, minOut);

        if (inLeg < 0) {
            uint256 owed = uint256(uint128(-inLeg));
            if (fee.isAddressZero()) {
                manager.settle{value: owed}();
            } else {
                manager.sync(fee);
                fee.transfer(address(manager), owed);
                manager.settle();
            }
        }

        Currency launched = zeroForOne ? key.currency1 : key.currency0;
        manager.take(launched, address(this), bought);
        return abi.encode(bought);
    }

    receive() external payable {}
}
