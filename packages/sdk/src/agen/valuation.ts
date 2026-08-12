/**
 * Turning "open this market at fifty ether" into the tick the pool opens at.
 *
 * A creator launching a token chooses a starting valuation. Uniswap opens a pool at a
 * tick. This is the whole of the translation between them, and it lives here rather than
 * in the interface because it is arithmetic with a direction that is easy to get
 * backwards — and getting it backwards launches a market at the reciprocal of the price
 * that was asked for, which is not a rounding error, it is a different market.
 *
 * ## The direction
 *
 * An Agen pool is always `(quote, token)`: the launched token is `currency1`, which is
 * what makes `zeroForOne` mean "buy" in every generated market. v4's price is
 * `amount1 / amount0`, so `1.0001^tick` is **tokens per unit of quote** — and a rising
 * token price is therefore a *falling* tick. `AgenCurve` says the same thing where it
 * explains why the bands run downward from the opening tick.
 *
 * So a market's opening valuation, in the quote asset's own units, is
 *
 *     valuation = supply × 1.0001^(−tick)
 *
 * and the tick that produces a wanted valuation is the log of the other side.
 *
 * ## Rounding is not optional
 *
 * Every Agen pool uses `AgenCurve.TICK_SPACING`, and the factory refuses an opening tick
 * that is not on that grid — `AgenCurve.validate` reverts before anything is deployed.
 * The grid is 200 ticks, which is about 2% of price, so the valuation a creator asked
 * for and the one they get are close but not equal. `valuationAtTick` exists so the
 * screen can show the one they will actually get rather than the one they typed.
 */

import {
  AGEN_BAND_WIDTHS,
  MAX_USABLE_TICK,
  MIN_USABLE_TICK,
  TICK_SPACING,
} from "@verdant/config";

/** The grid every Agen pool opens on. One definition, in `@verdant/config`. */
export { TICK_SPACING };

/** `AgenCurve.MAX_USABLE_TICK`. */
export const MAX_INITIAL_TICK = MAX_USABLE_TICK;

/**
 * The lowest tick a launch can open at.
 *
 * `AgenCurve.validate` requires room below the opening tick for the middle band's floor
 * to sit strictly above the tail's, so the bound is the tail's floor plus the middle
 * band's width plus one grid step. In price terms this is so far below anything real
 * that it exists to be checked rather than to be reached.
 */
export const MIN_INITIAL_TICK = MIN_USABLE_TICK + AGEN_BAND_WIDTHS.middle + TICK_SPACING;

/** `Math.log(1.0001)`, named because the literal is unreadable and easy to mistype. */
const LOG_TICK_BASE = Math.log(1.0001);

/** Round to the nearest multiple of the grid, halves away from zero. */
function toGrid(tick: number): number {
  return Math.round(tick / TICK_SPACING) * TICK_SPACING;
}

export interface ValuationInput {
  /** The token's whole supply, in its own base units. */
  readonly supply: bigint;
  /** What the market should be worth at the opening price, in the quote's base units. */
  readonly valuation: bigint;
}

/**
 * The opening tick for a wanted valuation, on the grid.
 *
 * Throws rather than clamping when the answer is outside what a launch can open at: a
 * clamped tick is a market opened at a valuation nobody chose, and the two inputs that
 * produce one — a dust valuation, or one larger than the supply can express — are both
 * worth telling a creator about.
 */
export function initialTickForValuation({ supply, valuation }: ValuationInput): number {
  if (supply <= 0n) throw new Error("a market with no supply has no price");
  if (valuation <= 0n) throw new Error("a market has to be worth something to open");

  const exact = (Math.log(Number(supply)) - Math.log(Number(valuation))) / LOG_TICK_BASE;
  const tick = toGrid(exact);

  if (tick > MAX_INITIAL_TICK || tick < MIN_INITIAL_TICK) {
    throw new Error(
      `a supply of ${supply.toString()} cannot open at a valuation of ${valuation.toString()}: ` +
        `it needs tick ${String(tick)}, and a launch can open between ${String(MIN_INITIAL_TICK)} ` +
        `and ${String(MAX_INITIAL_TICK)}`,
    );
  }

  return tick;
}

/**
 * What a market opening at this tick is worth, in the quote asset's base units.
 *
 * The inverse of the above, and the one the interface should display: rounding to the
 * grid moves the valuation by up to about 1%, and showing a creator the number they
 * typed while launching a different one is the kind of small dishonesty that is only
 * discovered by someone checking.
 */
export function valuationAtTick({ supply, tick }: { supply: bigint; tick: number }): bigint {
  const scaled = Number(supply) * Math.pow(1.0001, -tick);
  if (!Number.isFinite(scaled) || scaled < 0) return 0n;
  return BigInt(Math.round(scaled));
}
