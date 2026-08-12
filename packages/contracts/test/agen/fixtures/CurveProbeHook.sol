// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title CurveProbeHook
/// @notice A generated hook that charges nothing and remembers everything.
///
/// @dev Written for the launch curve tests, which compare the pool's behaviour against
/// `apps/agen/scripts/curve.ts` to a fraction of a percent. A fee would make that
/// comparison meaningless — the simulator models geometry, and every basis point a hook
/// takes is a basis point the pool does not move — so this one overrides the fee to
/// zero and leaves the arithmetic to the ranges.
///
/// It still has to be a real hook. The factory refuses a hook whose address carries no
/// permission bits, on the grounds that such a market advertises rules it can never run,
/// and a launch that bypassed the hook entirely would not be testing the launch. So this
/// takes `beforeSwap`, does the smallest honest thing with it, and records what it saw —
/// which is also what proves the creator's dev buy went through the hook rather than
/// around it.
contract CurveProbeHook {
    IPoolManager public immutable poolManager;

    /// @notice How many swaps this hook has been called for. Never reset.
    uint256 public swaps;
    /// @notice Who the PoolManager reported as the initiator of the last swap.
    address public lastSender;
    /// @notice Whether the last swap was a buy. Buys are `zeroForOne`, always.
    bool public lastZeroForOne;

    /// @notice The LP fee this hook imposes, in ppm. Zero unless a test asks otherwise.
    ///
    /// @dev Settable because two different tests want opposite things from it. The curve
    /// assertions need zero, or the pool moves less than the geometry says it should for
    /// reasons that are about fees. The locked-liquidity assertions need a fee, because
    /// a position that has earned nothing cannot demonstrate that collecting its
    /// earnings leaves its principal alone.
    uint24 public feePpm;

    error NotPoolManager(address caller);

    function setFeePpm(uint24 feePpm_) external {
        feePpm = feePpm_;
    }

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            // Deliberately false. A generated hook that gated liquidity would refuse the
            // launch's own mint, and the launch would fail at deployment rather than
            // silently — but this fixture is here to measure the curve, not that.
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

    function beforeSwap(address sender, PoolKey calldata, SwapParams calldata params, bytes calldata)
        external
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);

        swaps++;
        lastSender = sender;
        lastZeroForOne = params.zeroForOne;

        // Overriding rather than declining to answer: the pool is opened with the
        // dynamic fee flag, so without an override it would fall back to whatever the
        // pool's stored fee is.
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, feePpm | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
