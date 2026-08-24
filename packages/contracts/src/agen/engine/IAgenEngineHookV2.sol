// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @title IAgenEngineHookV2
/// @notice The surface the v2 pots read. Kept as an interface so the pots and the hook
/// do not import each other.
interface IAgenEngineHookV2 {
    function poolManager() external view returns (IPoolManager);
    function epochOf(PoolId poolId, uint256 timestamp) external view returns (uint256);
    /// @notice When the market's clock started, and how long an epoch is.
    /// @dev The two facts the holder pot needs to turn its own checkpoints into a weight.
    /// Returned together because they are only ever useful together, and a reader that had
    /// one without the other could compute an epoch boundary from a market that has none.
    function epochWindow(PoolId poolId) external view returns (uint256 initTime, uint32 period);
    function inSwap(PoolId poolId) external view returns (bool);
    function requireOwnPool(PoolId poolId, PoolKey calldata key) external view;
}
