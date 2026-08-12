// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AgenCurve
/// @notice The shape of every Agen launch: three one-sided positions stacked above the
/// opening price, thin at the bottom and heavy at the top.
///
/// @dev A launch has to solve a cold start. Nobody has the paired asset yet, so the
/// pool cannot be opened with a balanced position, and asking the creator to fund one
/// is the LP flow this product exists not to have. Verdant's answer, inherited here, is
/// to place the supply entirely above the opening price: a position whose upper tick is
/// at or below the current tick holds only `currency1`, so it costs zero quote to mint
/// and the first buyer is the first source of quote in the pool.
///
/// What Verdant does with one such position, this does with three, and that is the only
/// difference between the two launches.
///
/// ## Why one position was not enough
///
/// A single range spanning the whole price axis is not a neutral choice; it is a
/// constant product curve, and it behaves like one. Simulated at a $5,000 opening
/// valuation — `apps/agen/scripts/curve.ts`, which is the reference these constants
/// were derived from and the regression test for them — a $1,000 buy moves such a
/// market to $7,200. Worse, its depth *falls* relative to valuation as it grows: the
/// pool holds 25% of market cap at $20k and under 5% at $2M. A launch is supposed to
/// become sturdier as it succeeds, and that one becomes flimsier.
///
/// ## Why three
///
/// Splitting the supply across several one-sided ranges buys a depth profile, because
/// each range's contribution can be stated independently. Writing `D` for the cost of a
/// 1% price move relative to the single-range launch, a range holding fraction `f` of
/// supply between valuation multiples `A` and `B` has
///
///     D = f · √(A·B) / (√B − √A)
///
/// which is constant across the range, so `D = 1` is exactly today's launch, `D = 0.25`
/// is four times as responsive, and `D = 4.19` is four times as heavy. Summing the
/// supply gives the one constraint the whole geometry has to satisfy:
///
///     Σ Dᵢ · (1/√Aᵢ − 1/√Bᵢ) = 1
///
/// That measure is violently front-loaded — the first 6× of price movement carries 59%
/// of the budget and everything above 40× carries 16% — which is the happy part: a thin
/// opening range does not merely permit a heavy tail, it forces one. The supply an
/// opening range does not spend has nowhere to live except at higher prices, where it
/// absorbs far more quote per unit.
///
/// Four ranges were simulated and rejected. The fourth boundary changes nothing about
/// how a launch opens, reaches a $500k valuation holding *less* quote than three ranges
/// do, and costs another position to mint, lock and index.
///
/// ## The numbers
///
/// | range | valuation      | supply  |   D  |
/// |-------|----------------|---------|------|
/// | 1     | 1× →  6.05×    | 14.84%  | 0.25 |
/// | 2     | 6.05× → 39.65× | 18.58%  | 0.75 |
/// | 3     | 39.65× → ceil  | 66.58%  | 4.19 |
///
/// which opens responsively (a buy worth 20% of the opening valuation multiplies it by
/// 3.24), keeps running through the middle, and ends up roughly four times heavier than
/// a conventional launch once the market is large. Liquidity as a share of valuation
/// runs 6% → 9% → 19% as the market grows, instead of falling.
///
/// The allocations are basis points and sum to exactly 10 000; they are the `f` column
/// above and are not independent of the boundaries. Moving a boundary without
/// recomputing them silently changes all three depths, so `apps/agen/scripts/curve.ts`
/// is the place to change this geometry and this library is where the result is copied
/// to.
library AgenCurve {
    /// @notice The spacing every Agen pool uses.
    /// @dev Not a parameter. The band widths below are multiples of it, and a market
    /// that chose its own spacing would either not land on the grid or land on a
    /// different geometry than the one that was simulated.
    int24 internal constant TICK_SPACING = 200;

    /// @notice The widest ticks a position may span, being the largest multiples of
    /// `TICK_SPACING` strictly inside Uniswap's ±887 272.
    int24 internal constant MIN_USABLE_TICK = -887_200;
    int24 internal constant MAX_USABLE_TICK = 887_200;

    /// @dev A rising token price is a *falling* tick, because the launch token is
    /// `currency1`. So the bands run downward from the opening tick and every width
    /// below is subtracted.
    ///
    /// 18 000 ticks is 1.0001^18000 = 6.049×, and 36 800 is 39.65×. Both are multiples
    /// of 200, so the boundaries are exactly representable rather than nearly.
    int24 internal constant OPENING_WIDTH = 18_000;
    int24 internal constant MIDDLE_WIDTH = 36_800;

    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Share of supply in the fast opening band. Depth 0.25.
    uint16 internal constant OPENING_BPS = 1_484;
    /// @notice Share of supply in the middle band. Depth 0.75.
    uint16 internal constant MIDDLE_BPS = 1_858;
    /// @notice Share of supply in the deep band. Depth 4.19.
    uint16 internal constant DEEP_BPS = 6_658;

    /// @notice How many positions a launch mints. Three, and fixed.
    uint256 internal constant BANDS = 3;

    struct Band {
        int24 tickLower;
        int24 tickUpper;
        uint16 allocationBps;
    }

    /// @notice The opening tick is not on the grid, or leaves no room for the bands.
    error InitialTickInvalid(int24 initialTick);

    /// @notice The three positions a launch at `initialTick` mints, in the order they
    /// are minted.
    ///
    /// @dev Every band's upper tick is at or below `initialTick`, which is what makes
    /// all three one-sided. The first band's upper tick *is* `initialTick`, so the pool
    /// opens exactly at the top of it — the property that lets the mint pass
    /// `amount0Max: 0` as an assertion rather than a hope.
    function bands(int24 initialTick) internal pure returns (Band[3] memory band) {
        validate(initialTick);

        band[0] = Band({tickLower: initialTick - OPENING_WIDTH, tickUpper: initialTick, allocationBps: OPENING_BPS});
        band[1] = Band({
            tickLower: initialTick - MIDDLE_WIDTH, tickUpper: initialTick - OPENING_WIDTH, allocationBps: MIDDLE_BPS
        });
        // The tail runs to the floor of the usable range, which in price terms is
        // 10^38 times the opening — infinity for any market that will ever exist. It is
        // where the supply nobody buys stays, permanently.
        band[2] = Band({tickLower: MIN_USABLE_TICK, tickUpper: initialTick - MIDDLE_WIDTH, allocationBps: DEEP_BPS});
    }

    /// @notice Whether a launch can open here.
    /// @dev Three conditions, all structural: the tick must be on the grid v4 will
    /// accept, it must be inside the usable range, and there must be room below it for
    /// the middle band's floor to sit strictly above the tail's.
    function validate(int24 initialTick) internal pure {
        if (initialTick % TICK_SPACING != 0) revert InitialTickInvalid(initialTick);
        if (initialTick > MAX_USABLE_TICK) revert InitialTickInvalid(initialTick);
        if (initialTick - MIDDLE_WIDTH <= MIN_USABLE_TICK) revert InitialTickInvalid(initialTick);
    }
}
