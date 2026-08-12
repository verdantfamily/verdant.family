// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title GeneratedStreakHook
/// @notice A stand-in for generator output, used to prove the deployment path.
///
/// @dev This file is a **test fixture**, not a template and not a library. It exists so
/// `AgenFactory.t.sol` can prove that a market deployed through the Agen path has a
/// hook whose rule actually changes what a trade costs on chain — a claim that needs
/// some hook, and needs one whose effect is observable in a swap's output rather than
/// only in its own storage.
///
/// It is deliberately the *shape* of generated code rather than anything Agen ships:
/// one contract, one small rule, state written during a swap, a fee returned with the
/// override flag. Nothing in `src/agen/` imports it or knows it exists, which is the
/// property that matters — if the factory needed to recognise this contract, the
/// factory would be a template engine.
///
/// The rule: every third consecutive buy trades free, and any sell resets the streak.
/// Chosen because its effect is measurable from outside. Three identical buys produce
/// three different outputs, and the third is strictly larger — which cannot happen
/// unless the hook's returned fee reached the pool.
contract GeneratedStreakHook {
    /// @notice The fee charged on any trade that is not the free one, in hundredths of
    /// a basis point. 10_000 is 1%.
    uint24 public constant BASE_FEE_PPM = 10_000;

    /// @notice How many buys in a row earn the free trade.
    uint256 public constant STREAK_LENGTH = 3;

    /// @notice The only address permitted to drive this hook's state.
    address public immutable poolManager;

    /// @notice Buys since the last sell.
    uint256 public consecutiveBuys;

    /// @notice The fee applied to the most recent swap, for assertions and for the feed.
    uint24 public lastFeePpm;

    /// @notice How many trades have gone through free.
    uint256 public freeTrades;

    error NotPoolManager(address caller);

    event StreakAdvanced(uint256 consecutiveBuys, uint24 feePpm, bool free);

    constructor(address poolManager_) {
        poolManager = poolManager_;
    }

    /// @notice The permissions this hook needs, and therefore the bits its address must
    /// carry. `beforeSwap` alone: it changes the fee and nothing else.
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
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @dev In an Agen pool `currency1` is the launched token, so `zeroForOne` spends
    /// the quote asset to receive it: a buy.
    function beforeSwap(address, PoolKey calldata, SwapParams calldata params, bytes calldata)
        external
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != poolManager) revert NotPoolManager(msg.sender);

        uint24 feePpm = BASE_FEE_PPM;
        bool free = false;

        if (params.zeroForOne) {
            consecutiveBuys += 1;
            if (consecutiveBuys % STREAK_LENGTH == 0) {
                feePpm = 0;
                free = true;
                freeTrades += 1;
            }
        } else {
            consecutiveBuys = 0;
        }

        lastFeePpm = feePpm;
        emit StreakAdvanced(consecutiveBuys, feePpm, free);

        // Without OVERRIDE_FEE_FLAG the pool keeps its stored fee and this whole rule
        // is decoration.
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, feePpm | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
