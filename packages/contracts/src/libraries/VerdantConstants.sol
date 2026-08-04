// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title VerdantConstants
/// @notice Protocol-wide constants that are frozen rather than configured.
///
/// @dev This is the **only** place a tick spacing or a usable-tick bound appears
/// in the Solidity. `packages/config/src/bounds.ts` is the only place they appear
/// in the TypeScript, and `packages/sdk/src/config.test.ts` scans the repository
/// to keep both of those statements true.
///
/// Two definitions rather than one is not ideal, but the alternative — generating
/// Solidity from TypeScript — adds a build step to the layer that most needs to be
/// readable without one. The mitigation is that both are asserted against the same
/// arithmetic, and against Uniswap's own constants, by tests in both languages.
library VerdantConstants {
    /// @notice Tick spacing for every Verdant pool.
    ///
    /// @dev 200, and re-asserted by `VerdantHook.beforeInitialize` so a pool with
    /// any other spacing cannot be created through the hook. See
    /// docs/decisions/001-tick-spacing.md — briefly, it is this chain's convention
    /// by 23:1, it crosses materially fewer initialized ticks per swap on markets
    /// that move in multiples, and the granularity given up (2.02% per step
    /// against 0.60%) is irrelevant at the range widths Verdant creates.
    ///
    /// Not a parameter. A per-market spacing would turn a one-line invariant an
    /// auditor can read into a stateful property they have to trace, in exchange
    /// for a choice creators have no basis for making.
    int24 internal constant TICK_SPACING = 200;

    /// @notice The widest ticks a Verdant pool can use.
    ///
    /// @dev The largest multiples of TICK_SPACING strictly inside Uniswap's
    /// ±887 272: `887272 / 200 = 4436.36`, so `4436 * 200 = 887200`. At spacing 60
    /// these would be ±887 220, which is why changing the spacing moved these too.
    ///
    /// Asserted against `TickMath.MAX_TICK` rather than against a literal in
    /// test/VerdantConstants.t.sol, so an upstream change to the tick range fails
    /// here rather than at pool creation.
    int24 internal constant MIN_USABLE_TICK = -887_200;
    int24 internal constant MAX_USABLE_TICK = 887_200;
}
