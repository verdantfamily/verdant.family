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

import { BOUNDS } from "@verdant/config";

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
 * Truncates rather than rounds, for the same reason as `formatAmount`.
 */
export function formatPrice(value: bigint, options: { decimals?: number; significant?: number } = {}): string {
  const { decimals = 36, significant = 3 } = options;

  if (value === 0n) return "0";

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
