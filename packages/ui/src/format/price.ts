/**
 * Prices, out of the square-root form Uniswap stores them in.
 *
 * v4 keeps a pool's price as `sqrtPriceX96`: the square root of the ratio of
 * currency1 to currency0, times 2^96. Two conversions are needed from it, and both
 * are done in integer arithmetic for the reason described in `amount.ts` — the
 * numbers involved here are far larger. `sqrtPriceX96` squared is around 2^200, and
 * a float would lose the low bits of it entirely.
 *
 * ## Why the quote asset's decimals are a parameter
 *
 * In a Verdant market currency1 is always the launch token (ADR-008) and currency0
 * is whatever the market is quoted in — native ether for some markets, a tokenized
 * equity for others. The ratio v4 stores is a ratio of *base units*, so turning it
 * into a price a person reads needs the decimal count of both sides. The token's is
 * fixed by the contracts and is taken from `@verdant/config`; the quote asset's is
 * a property of somebody else's ERC-20 and is therefore asked for.
 *
 * It is asked for rather than defaulted to 18 on purpose. Every reviewed equity in
 * `QUOTE_ASSETS` happens to have 18 decimals today, so a default would be correct
 * everywhere and would stay correct right up until it was not — and the failure
 * would be a price wrong by a power of ten on one market, which looks like a market
 * rather than like a bug.
 */

import { BOUNDS, MIN_USABLE_TICK } from "@verdant/config";

import { sqrtPriceX96AtTick } from "./tick.js";

/** 2^96, the fixed-point base v4 uses for the square root. */
const Q96 = 2n ** 96n;

/** The scale prices are computed at internally. Well beyond what is displayed. */
const PRECISION = 10n ** 36n;

/**
 * The launch token's decimals, which the contracts fix for every market.
 *
 * From `@verdant/config` rather than written as 18, so that this file and the supply
 * the factory mints cannot come to disagree about what a whole token is.
 */
const TOKEN_DECIMALS = BOUNDS.token.decimals;

/**
 * Whole launch tokens per one whole unit of the quote asset, as a fixed-point
 * integer with 18 decimals.
 *
 * This is the ratio v4 stores, undone and then rescaled from base units to whole
 * ones: `(sqrtPriceX96 / 2^96)^2` is token base units per quote base unit, and the
 * two powers of ten convert that into the units a reader thinks in.
 */
export function tokensPerQuote(sqrtPriceX96: bigint, quoteDecimals: number): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  return (
    (sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(quoteDecimals + 18 - TOKEN_DECIMALS)) /
    (Q96 * Q96)
  );
}

/**
 * Units of the quote asset per whole launch token, as a fixed-point integer with 36
 * decimals.
 *
 * The reciprocal, and the number a market page actually shows. It needs 36 decimals
 * rather than 18 because a launch price is genuinely tiny: a market opening at tick
 * 200 000 is around 2 × 10^-9 ether per token, which has no significant digits at all
 * in 18-decimal fixed point after the division rounds.
 */
export function quotePerToken(sqrtPriceX96: bigint, quoteDecimals: number): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  return (
    (Q96 * Q96 * 10n ** BigInt(36 + TOKEN_DECIMALS - quoteDecimals)) /
    (sqrtPriceX96 * sqrtPriceX96)
  );
}

/**
 * A price, rendered with a fixed number of significant digits.
 *
 * Significant digits rather than decimal places, because a price of 0.0000000021 and
 * a price of 4.7 both need to be readable and no single number of decimal places
 * serves both. Leading zeros after the point are not significant, so they are kept
 * and then three digits are shown after them.
 *
 * Truncates rather than rounds by default, for the same reason as `formatAmount`: a
 * figure a reader might act on should not be shown larger than it is.
 *
 * ## When to round instead
 *
 * `round` exists for one caller and should stay that way. A chart's price axis labels
 * gridlines whose values it did not choose — the library computes them as floats, and
 * one of them is routinely a ulp below the round number it stands for. Truncated, that
 * line is labelled as the line beneath it, and two adjacent lines can end up carrying
 * the same label. Nobody trades on an axis tick, so rounding it is free; rounding a
 * balance or a quote is not, which is why this is off unless asked for.
 */
export function formatPrice(
  value: bigint,
  options: { decimals?: number; significant?: number; round?: boolean } = {},
): string {
  const { decimals = 36, significant = 3, round = false } = options;

  if (value === 0n) return "0";

  if (round) {
    // Rounded to the resolution this call would have shown, then formatted by the
    // truncating path — which now has nothing left to truncate. Going through the
    // integer keeps a carry that shortens the run of leading zeros (0.00999 to 0.01)
    // correct, rather than printing a digit that no longer exists.
    const unit = displayUnit(value, decimals, significant);
    return formatPrice(((value + unit / 2n) / unit) * unit, { decimals, significant });
  }

  const digits = value.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);

  // At or above 1, significance starts at the decimal point.
  if (whole !== "0") {
    const trimmed = fraction.slice(0, Math.max(significant, 2)).replace(/0+$/, "");
    return trimmed === "" ? whole : `${whole}.${trimmed}`;
  }

  // Below 1, significance starts at the first non-zero digit.
  const firstSignificant = fraction.search(/[1-9]/);
  if (firstSignificant === -1) return "0";

  const kept = fraction.slice(0, firstSignificant + significant).replace(/0+$/, "");
  return `0.${kept}`;
}

/**
 * The place value of the last digit `formatPrice` would print.
 *
 * The same two regimes the formatter has: at or above 1 the digits shown are decimal
 * places, and below it they are counted from the first non-zero digit.
 */
function displayUnit(value: bigint, decimals: number, significant: number): bigint {
  const digits = value.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);

  const shown =
    whole !== "0"
      ? Math.max(significant, 2)
      : Math.max(fraction.search(/[1-9]/), 0) + significant;

  return 10n ** BigInt(Math.max(decimals - shown, 0));
}

/**
 * A market's implied value in its quote asset: every token at the current price.
 *
 * Named for what it is rather than "market cap", which invites a comparison with a
 * company's equity that does not hold. Nobody could sell the whole supply at this
 * price — the pool's liquidity is finite and one-sided at launch — so this is the
 * price extrapolated, not a valuation.
 *
 * Returns base units of the quote asset, so a caller formats it with that asset's
 * decimals. No decimal count is needed to compute it: both `totalSupply` and the
 * result are base-unit quantities and the stored ratio is itself a ratio of base
 * units, so the two conversions that would appear cancel exactly.
 */
export function impliedValueInQuote(totalSupply: bigint, sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  return (totalSupply * Q96 * Q96) / (sqrtPriceX96 * sqrtPriceX96);
}

/**
 * The bottom of every Verdant launch position's range, as a square root price.
 *
 * `VerdantFactory._mintLockedPosition` mints between `VerdantConstants.MIN_USABLE_TICK`
 * and the creator's opening tick, so the lower bound is a protocol-wide constant rather
 * than a per-market choice — which is why the indexer does not carry it on every row.
 *
 * Computed through the same `TickMath` transliteration the launch form prices with,
 * rather than written out as a literal. The literal would be defensible arithmetic and
 * still wrong in principle: it would be a second definition of a bound that
 * `@verdant/config` already owns, and it would not track the constant if the usable range
 * ever moved with the tick spacing — which is exactly what happened when the spacing went
 * from 60 to 200.
 */
export const LAUNCH_RANGE_MIN_SQRT_PRICE_X96 = sqrtPriceX96AtTick(MIN_USABLE_TICK);

/**
 * How much of each currency a position holds, from its liquidity and the pool's price.
 *
 * Uniswap's `LiquidityAmounts.getAmountsForLiquidity`, in integer arithmetic. A position
 * is one currency at each end of its range and a mix in between, which is the three cases
 * below: entirely currency0 at or under the bottom, entirely currency1 at or over the
 * top, and split where the price actually sits.
 *
 * Both results are base units. In a Verdant market `amount0` is the quote asset and
 * `amount1` is the launch token, which is why `lockedReserves` renames them.
 */
export function amountsForLiquidity(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  sqrtLowerX96: bigint,
  sqrtUpperX96: bigint,
): { readonly amount0: bigint; readonly amount1: bigint } {
  if (liquidity <= 0n || sqrtLowerX96 <= 0n || sqrtUpperX96 <= 0n || sqrtPriceX96 <= 0n) {
    return { amount0: 0n, amount1: 0n };
  }

  const lower = sqrtLowerX96 < sqrtUpperX96 ? sqrtLowerX96 : sqrtUpperX96;
  const upper = sqrtLowerX96 < sqrtUpperX96 ? sqrtUpperX96 : sqrtLowerX96;

  // Currency0 between two square roots: L * 2^96 * (b - a) / (b * a).
  const amount0Between = (a: bigint, b: bigint) => (liquidity * Q96 * (b - a)) / (b * a);
  // Currency1 between two square roots: L * (b - a) / 2^96.
  const amount1Between = (a: bigint, b: bigint) => (liquidity * (b - a)) / Q96;

  if (sqrtPriceX96 <= lower) {
    return { amount0: amount0Between(lower, upper), amount1: 0n };
  }

  if (sqrtPriceX96 < upper) {
    return {
      amount0: amount0Between(sqrtPriceX96, upper),
      amount1: amount1Between(lower, sqrtPriceX96),
    };
  }

  return { amount0: 0n, amount1: amount1Between(lower, upper) };
}

/**
 * What is actually in a market's pool, in base units of each side.
 *
 * The launch position is the only liquidity a Verdant pool has, so the pool's reserves
 * and the position's holdings are the same quantity — which is what makes this
 * computable from three numbers the indexer already returns.
 *
 * The upper bound is the pool's opening price rather than something separate: the factory
 * initialises at `TickMath.getSqrtPriceAtTick(initialTick)` and mints up to that same
 * tick, so the price the pool opened at *is* the top of the range. That is also why a
 * market with no trades reports no quote asset at all — the position starts at the top of
 * its range holding only the token, and the first buyer is the first source of the other
 * side.
 */
export function lockedReserves(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  initialSqrtPriceX96: bigint,
): { readonly quote: bigint; readonly token: bigint } {
  const { amount0, amount1 } = amountsForLiquidity(
    liquidity,
    sqrtPriceX96,
    LAUNCH_RANGE_MIN_SQRT_PRICE_X96,
    initialSqrtPriceX96,
  );

  return { quote: amount0, token: amount1 };
}

/**
 * Everything in the pool, valued in the quote asset.
 *
 * The quote side counted directly and the token side at the price the pool is quoting,
 * which is the figure an exchange calls liquidity. It is a real balance rather than an
 * extrapolation — unlike `impliedValueInQuote`, which prices a supply nobody could sell.
 * Reusing that function for the token half is exactly right: it is the same conversion.
 */
export function lockedValueInQuote(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  initialSqrtPriceX96: bigint,
): bigint {
  const { quote, token } = lockedReserves(liquidity, sqrtPriceX96, initialSqrtPriceX96);
  return quote + impliedValueInQuote(token, sqrtPriceX96);
}

/**
 * How far a price has moved from another, in hundredths of a percent.
 *
 * Basis points rather than a float, so the caller decides how to render it and no
 * rounding happens twice. Returns null when there is no baseline to compare against,
 * which is a different thing from a move of zero.
 */
export function priceChangeBps(current: bigint, baseline: bigint): number | null {
  if (baseline <= 0n) return null;
  const delta = ((current - baseline) * 10_000n) / baseline;
  return Number(delta);
}

export { PRECISION as PRICE_PRECISION, Q96 };
