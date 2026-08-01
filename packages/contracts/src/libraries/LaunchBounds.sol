// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title LaunchBounds
/// @notice The creation-time bounds the factory enforces, as constants.
///
/// @dev These are the bounds that are **not** in `ModelRegistry`, and the
/// distinction is deliberate. The registry holds what Verdant may want to change
/// for future markets — which models are open, how many stages they may have,
/// what share the protocol takes. This file holds what a market has to satisfy to
/// be a coherent market at all: a symbol short enough to display, a supply large
/// enough to divide, a tick on the grid the pool actually uses.
///
/// Freezing them buys two things. The factory needs no registry read per field,
/// which keeps creation to one call into the registry. And a creator reading these
/// numbers is reading a property of the deployment rather than a current setting,
/// so a launch that would have been valid yesterday is valid today.
///
/// ## One source
///
/// Every value here is transcribed from `packages/config/src/bounds.ts` by way of
/// `packages/config/generated/bounds.json`, and `test/BoundsParity.t.sol` asserts
/// each one against that file. A number that drifts fails CI in this repository
/// rather than in a creator's transaction.
library LaunchBounds {
    /// @notice Basis-point denominator, and the sum of every split.
    uint16 internal constant BPS_DENOMINATOR = 10_000;

    // --- token ---------------------------------------------------------------

    uint256 internal constant MIN_NAME_LENGTH = 1;
    uint256 internal constant MAX_NAME_LENGTH = 32;
    uint256 internal constant MIN_SYMBOL_LENGTH = 1;
    uint256 internal constant MAX_SYMBOL_LENGTH = 11;
    uint256 internal constant MAX_METADATA_URI_LENGTH = 256;

    /// @notice Supply is chosen in whole tokens and scaled by this factor.
    ///
    /// @dev Creators think in whole tokens, and a factory that accepted wei would
    /// accept a supply a thousand times off by one missing zero. Taking whole
    /// tokens makes that class of mistake unrepresentable rather than merely
    /// unlikely, and it is why the bounds below are small enough to read.
    uint256 internal constant TOKEN_SCALE = 1e18;

    uint256 internal constant MIN_SUPPLY_TOKENS = 1_000_000;
    uint256 internal constant MAX_SUPPLY_TOKENS = 1_000_000_000_000_000;

    /// @notice The largest share of supply a creator may keep for themselves.
    ///
    /// @dev 20%. The rest goes into the locked position, which is the number a
    /// buyer is actually pricing: everything not held back is depth they can trade
    /// against and cannot be withdrawn. `liquidity.tokenShareBps` in the register
    /// says the position must hold at least 60% of supply, and this cap makes that
    /// unreachable from below — the position always gets at least 80%.
    uint16 internal constant MAX_CREATOR_ALLOCATION_BPS = 2_000;

    // --- vesting -------------------------------------------------------------

    /// @notice A vesting schedule shorter than this is theatre.
    /// @dev Zero duration means no vesting at all, which is a different thing and
    /// is allowed; what is refused is a schedule that exists and ends immediately.
    uint64 internal constant MIN_VESTING_DURATION = 30 days;
    uint64 internal constant MAX_VESTING_DURATION = 730 days;
}
