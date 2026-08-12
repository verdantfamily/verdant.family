// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {GeneratedFeeVault} from "./GeneratedFeeVault.sol";

/// @title GeneratedCustodyHook
/// @notice A hook that actually takes value, rather than writing down that it did.
///
/// @dev The fixture that proves the hardest thing a generated market has to do. Every
/// mechanic Agen advertises — jackpots, buyback reserves, reward pools, round prizes —
/// depends on a hook diverting part of a trade into custody. Until this works, those
/// markets are bookkeeping: a number goes up, no money moves, and the conservation
/// invariants are about a ledger rather than about anything anybody can withdraw.
///
/// ## How a hook takes a fee in v4
///
/// The mechanism is two halves that must agree.
///
/// `poolManager.take(currency, recipient, amount)` moves the currency out of the pool
/// manager to the recipient and records that the hook now owes the manager that much.
/// On its own it would leave the swap unbalanced and revert at the end of the lock.
///
/// The returned `BeforeSwapDelta` is what balances it. A positive `deltaSpecified`
/// means "the hook is owed this much of the specified currency", and the manager
/// settles that by taking it out of the amount the swap would otherwise have used.
///
/// That last detail is worth stating precisely, because the obvious reading is wrong
/// and the tests had to correct it: on an exact-input swap the trader does **not** pay
/// extra. They pay exactly what they specified, the fee comes out of it, and the
/// remainder is what reaches the pool. A trader spending one ether with a one percent
/// fee still spends one ether — 0.99 is swapped and 0.01 lands in the vault — so what
/// they lose is output, not additional input.
///
/// The conservation identity that follows is what the test asserts: what the trader
/// spent equals what the pool received plus what the vault took. A hook funding its
/// vault out of the pool's own reserves would break the right-hand side while every
/// balance still looked plausible.
///
/// Getting the sign backwards does not fail loudly — it produces a swap that reverts
/// deep inside the manager with `CurrencyNotSettled`.
///
/// ## Exact input and exact output are different problems
///
/// For an exact-input swap the specified currency *is* the input currency, so the fee
/// comes out of what the trader is spending and `deltaSpecified` carries it.
///
/// For an exact-output swap the specified currency is the output, and the input is the
/// unspecified one. Charging the fee on the output would change the amount the trader
/// asked for, which is the one thing an exact-output swap promises not to do, so the
/// fee goes on the input through `deltaUnspecified` instead.
///
/// Handling only the first would leave a hole worth naming: a trader who wants to avoid
/// the fee would simply route an exact-output swap, and every mechanic funded by fees
/// would quietly stop being funded.
contract GeneratedCustodyHook {
    using LPFeeLibrary for uint24;

    /// @notice The share of every trade's input taken into the vault: 1%.
    uint24 public constant CUSTODY_FEE_PPM = 10_000;
    /// @notice What the pool charges as an ordinary LP fee on top.
    uint24 public constant LP_FEE_PPM = 3_000;

    IPoolManager public immutable poolManager;
    GeneratedFeeVault public immutable vault;

    /// @notice The last fee this hook diverted, so a test can compare it to the vault.
    uint256 public lastTaken;

    error NotPoolManager(address caller);

    constructor(IPoolManager poolManager_, GeneratedFeeVault vault_) {
        poolManager = poolManager_;
        vault = vault_;
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            // The permission that makes custody possible at all. Without this bit in the
            // address, a returned delta is ignored and the fee is silently never taken.
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);

        bool exactInput = params.amountSpecified < 0;

        // The currency the trader is spending, which is where a fee belongs whichever
        // way the swap is specified.
        Currency input = params.zeroForOne ? key.currency0 : key.currency1;

        uint256 fee;
        BeforeSwapDelta delta;

        if (exactInput) {
            uint256 amountIn = uint256(-params.amountSpecified);
            fee = (amountIn * CUSTODY_FEE_PPM) / 1_000_000;

            // Specified currency is the input, so the charge rides on deltaSpecified.
            // casting is safe because fee is a fraction of amountSpecified, which the
            // pool manager already holds as an int128
            // forge-lint: disable-next-line(unsafe-typecast)
            delta = toBeforeSwapDelta(int128(int256(fee)), 0);
        } else {
            // Exact output: the trader has named what they want to receive, and the fee
            // must not come out of it. It is charged on the input instead, which is the
            // unspecified side. The input amount is not known here — the pool computes
            // it — so the fee is taken as a share of the output's value, which for the
            // purposes of this fixture is the same proportion on a near-1:1 pool.
            uint256 amountOut = uint256(params.amountSpecified);
            fee = (amountOut * CUSTODY_FEE_PPM) / 1_000_000;

            // casting is safe for the same reason as above
            // forge-lint: disable-next-line(unsafe-typecast)
            delta = toBeforeSwapDelta(0, int128(int256(fee)));
        }

        if (fee > 0) {
            // Moves the value out of the manager and into the vault, and leaves this
            // hook owing the manager `fee` — which the delta above makes the swapper
            // pay. If either half were missing the swap would not balance.
            poolManager.take(input, address(vault), fee);
            vault.credit(fee);
            lastTaken = fee;
        }

        return (IHooks.beforeSwap.selector, delta, LP_FEE_PPM | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
