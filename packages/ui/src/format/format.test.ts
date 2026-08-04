/**
 * The formatting layer's tests.
 *
 * These functions are the last step before a number reaches a person, and the failure
 * mode is not a crash — it is a market that appears to cost a thousand times what it
 * costs. So the cases here are chosen around the two places that actually goes wrong:
 * magnitudes past what a float can hold, and prices small enough that naive rounding
 * flattens them to zero.
 */

import { describe, expect, it } from "vitest";

import { shortenAddress, shortenHash } from "./address.js";
import { formatAmount, formatBps, formatCompact, formatEther, formatFeeRate } from "./amount.js";
import {
  amountsForLiquidity,
  formatPrice,
  impliedValueInQuote,
  lockedReserves,
  lockedValueInQuote,
  priceChangeBps,
  quotePerToken,
  tokensPerQuote,
  LAUNCH_RANGE_MIN_SQRT_PRICE_X96,
} from "./price.js";
import { formatAge, formatDuration, formatInstant } from "./time.js";

describe("amounts", () => {
  it("renders whole and fractional parts", () => {
    expect(formatAmount(1_234_560_000_000_000_000_000n)).toBe("1,234.56");
    expect(formatAmount(10n ** 18n)).toBe("1");
    expect(formatAmount(0n)).toBe("0");
  });

  it("keeps a supply that a float would round", () => {
    // 10^27 wei — a billion tokens. Number() gives 1e+27, which cannot represent the
    // last nine digits, so any float path would invent them.
    const supply = 10n ** 27n;
    expect(formatAmount(supply)).toBe("1,000,000,000");
    expect(formatCompact(supply)).toBe("1B");
  });

  it("truncates rather than rounds up", () => {
    // 0.99999999 ether. Rounding would show 1 ether, which is more than the holder
    // has, and a balance that reads high is a balance that gets spent.
    expect(formatEther(999_999_990_000_000_000n, 4)).toBe("0.9999");
  });

  it("shows dust as nothing rather than as precise nothing", () => {
    expect(formatAmount(1n)).toBe("0");
  });

  it("handles negative values", () => {
    expect(formatAmount(-1_500_000_000_000_000_000n)).toBe("-1.5");
    expect(formatCompact(-2n * 10n ** 24n)).toBe("-2M");
  });

  it("abbreviates by magnitude and falls through below a thousand", () => {
    expect(formatCompact(45_600_000n * 10n ** 18n)).toBe("45.6M");
    expect(formatCompact(1_200_000_000n * 10n ** 18n)).toBe("1.2B");
    expect(formatCompact(900n * 10n ** 18n)).toBe("900");
  });

  it("reads a fee rate out of hundredths of a basis point", () => {
    expect(formatFeeRate(10_000)).toBe("1%");
    expect(formatFeeRate(3_000)).toBe("0.3%");
    expect(formatFeeRate(100)).toBe("0.01%"); // the floor the bounds allow
    expect(formatFeeRate(100_000)).toBe("10%"); // the ceiling
  });

  it("keeps fee rates and shares in different units", () => {
    // 9 000 is a 90% share of fees, and 9 000 ppm is a 0.9% fee. Confusing the two is
    // the mistake this pair of functions exists to make visible.
    expect(formatBps(9_000)).toBe("90%");
    expect(formatFeeRate(9_000)).toBe("0.9%");
  });
});

describe("prices", () => {
  // A pool opened at tick 200 000, which is what every market the seed script creates
  // starts at. Taken from a live rig rather than computed here, so this also pins the
  // conversion against a real v4 pool.
  const OPENING_SQRT_PRICE = 1_744_244_129_640_337_381_386_292_603_617_838n;

  /** Ether, and every reviewed equity in `QUOTE_ASSETS`, carry 18 decimals. */
  const EIGHTEEN = 18;

  it("undoes the square root in both directions", () => {
    const perQuote = tokensPerQuote(OPENING_SQRT_PRICE, EIGHTEEN);
    const perToken = quotePerToken(OPENING_SQRT_PRICE, EIGHTEEN);

    // ~4.85 × 10^8 tokens per unit of the quote asset at this tick.
    expect(perQuote / 10n ** 18n).toBeGreaterThan(400_000_000n);
    expect(perQuote / 10n ** 18n).toBeLessThan(500_000_000n);

    // And the reciprocal, ~2.06 × 10^-9 of the quote asset per token, which needs 36
    // decimals to have any significant digits at all.
    expect(formatPrice(perToken)).toBe("0.00000000206");
  });

  it("rescales when the quote asset does not carry the token's decimals", () => {
    // The same pool, read as though it were quoted in a six-decimal asset. v4 stores a
    // ratio of base units, so a whole unit of that asset buys 10^12 times fewer whole
    // tokens — and a price that ignored the difference would be wrong by exactly that
    // factor while still looking like a price.
    expect(tokensPerQuote(OPENING_SQRT_PRICE, 6)).toBe(
      tokensPerQuote(OPENING_SQRT_PRICE, EIGHTEEN) / 10n ** 12n,
    );

    // And in the other direction, where the same factor appears the other way up: a
    // whole unit of a six-decimal asset is a smaller thing, so a token is worth more
    // of them.
    expect(quotePerToken(OPENING_SQRT_PRICE, 6) / 10n ** 12n).toBe(
      quotePerToken(OPENING_SQRT_PRICE, EIGHTEEN),
    );
  });

  it("renders a small price with significant digits, not decimal places", () => {
    // Three decimal places would render every launch price as "0.000".
    expect(formatPrice(2_061_000_000_000_000_000_000_000_000n)).toBe("0.00000000206");
    expect(formatPrice(4_700_000_000_000_000_000_000_000_000_000_000_000n)).toBe("4.7");
  });

  it("rounds a price only when asked, and carries where rounding carries", () => {
    // 0.0000000020699…, a ulp below the round number a chart's axis means by it. Left to
    // truncate, that gridline is labelled as the one beneath it.
    const nearly = 2_069_999_999_999_999_999_999_999_999n;
    expect(formatPrice(nearly)).toBe("0.00000000206");
    expect(formatPrice(nearly, { round: true })).toBe("0.00000000207");

    // A carry that shortens the run of leading zeros: 0.00999… is 0.01, not 0.00100.
    expect(formatPrice(9_999_000_000_000_000_000_000_000_000_000_000n, { round: true })).toBe(
      "0.01",
    );

    // And half a unit rounds up, at the resolution actually being shown.
    expect(formatPrice(2_065_000_000_000_000_000_000_000_000n, { round: true })).toBe(
      "0.00000000207",
    );
    expect(formatPrice(2_064_999_999_999_999_999_999_999_999n, { round: true })).toBe(
      "0.00000000206",
    );

    // A price with fewer digits than were asked for has nothing below its last one, so
    // rounding it is a no-op rather than a collapse to zero.
    expect(formatPrice(1n, { round: true })).toBe(formatPrice(1n));
  });

  it("returns zero for an uninitialised pool rather than dividing by it", () => {
    expect(tokensPerQuote(0n, EIGHTEEN)).toBe(0n);
    expect(quotePerToken(0n, EIGHTEEN)).toBe(0n);
    expect(impliedValueInQuote(10n ** 27n, 0n)).toBe(0n);
    expect(formatPrice(0n)).toBe("0");
  });

  it("extrapolates a supply to an implied value", () => {
    const value = impliedValueInQuote(10n ** 27n, OPENING_SQRT_PRICE);
    // A billion tokens at ~2.06 × 10^-9 of the quote asset is ~2.06 of it.
    expect(formatEther(value, 2)).toBe("2.06");
  });

  it("states an implied value in the quote asset's own base units", () => {
    // The decimals cancel: both the supply and the answer are base-unit quantities, and
    // so is the ratio the pool stores. A market whose quote side had six decimals would
    // hold this same figure, and only its formatting would differ.
    const value = impliedValueInQuote(10n ** 27n, OPENING_SQRT_PRICE);
    expect(formatAmount(value, { decimals: 6, places: 0 })).toBe("2,063,215,669,444");
  });

  it("reports a price move in basis points, and nothing without a baseline", () => {
    expect(priceChangeBps(110n, 100n)).toBe(1_000);
    expect(priceChangeBps(95n, 100n)).toBe(-500);
    expect(priceChangeBps(100n, 0n)).toBeNull();
  });
});

/**
 * What is actually in the pool, as distinct from what the supply would be worth.
 *
 * The case that matters is the one the factory asserts on chain: a position minted at the
 * top of its range needs none of the quote asset, "not approximately zero". If this
 * arithmetic disagreed with that, a market page would report liquidity on the day it
 * launched and before anyone had put anything in.
 */
describe("pool reserves", () => {
  const OPENING_SQRT_PRICE = 1_744_244_129_640_337_381_386_292_603_617_838n;
  const LOWER = LAUNCH_RANGE_MIN_SQRT_PRICE_X96;
  const Q96 = 2n ** 96n;

  /** Eight hundred million of a billion-token supply, a normal share to lock. */
  const LOCKED_TOKENS = 800_000_000n * 10n ** 18n;

  /**
   * The liquidity the factory would mint for that, by its own `getLiquidityForAmount1`.
   * Deriving it here rather than pasting a number makes the assertions below a
   * round trip through the inverse of the function under test.
   */
  const LIQUIDITY = (LOCKED_TOKENS * Q96) / (OPENING_SQRT_PRICE - LOWER);

  it("holds only the token at the price the pool opened at", () => {
    const { quote, token } = lockedReserves(LIQUIDITY, OPENING_SQRT_PRICE, OPENING_SQRT_PRICE);

    expect(quote).toBe(0n);
    // Back to where it started, short only by what integer division discarded — which is
    // bounded by (upper - lower) / 2^96, some ten thousand wei against 8 × 10^26.
    expect(LOCKED_TOKENS - token).toBeGreaterThanOrEqual(0n);
    expect(LOCKED_TOKENS - token).toBeLessThan(10n ** 9n);
  });

  it("turns into the quote asset as the price is bought down", () => {
    const halfway = OPENING_SQRT_PRICE / 2n;
    const { quote, token } = lockedReserves(LIQUIDITY, halfway, OPENING_SQRT_PRICE);

    // Both sides present once the price is inside the range, which is the state every
    // traded market is in.
    expect(quote).toBeGreaterThan(0n);
    expect(token).toBeGreaterThan(0n);
    expect(token).toBeLessThan(LOCKED_TOKENS);
  });

  it("is entirely the quote asset at the bottom of the range", () => {
    const { quote, token } = lockedReserves(LIQUIDITY, LOWER, OPENING_SQRT_PRICE);

    expect(token).toBe(0n);
    expect(quote).toBeGreaterThan(0n);
  });

  it("values an untraded pool at the tokens sitting in it", () => {
    const { token } = lockedReserves(LIQUIDITY, OPENING_SQRT_PRICE, OPENING_SQRT_PRICE);
    const value = lockedValueInQuote(LIQUIDITY, OPENING_SQRT_PRICE, OPENING_SQRT_PRICE);

    // No quote side yet, so the whole figure is the token side priced at the open.
    expect(value).toBe(impliedValueInQuote(token, OPENING_SQRT_PRICE));

    // ~800M tokens at ~2.06 × 10^-9 ether each is ~1.65 ether.
    expect(formatEther(value, 2)).toBe("1.65");
  });

  it("is worth less than the supply it is a part of", () => {
    // The locked position holds some of the supply, so whatever it is worth has to be
    // under what all of the supply would be worth at the same price. A sign error in
    // either direction of the range breaks this before it breaks anything visible.
    const halfway = OPENING_SQRT_PRICE / 2n;
    const pool = lockedValueInQuote(LIQUIDITY, halfway, OPENING_SQRT_PRICE);
    const supply = impliedValueInQuote(10n ** 27n, halfway);

    expect(pool).toBeLessThan(supply);
  });

  it("returns nothing for an uninitialised or empty position", () => {
    expect(amountsForLiquidity(0n, OPENING_SQRT_PRICE, LOWER, OPENING_SQRT_PRICE)).toEqual({
      amount0: 0n,
      amount1: 0n,
    });
    expect(amountsForLiquidity(LIQUIDITY, 0n, LOWER, OPENING_SQRT_PRICE)).toEqual({
      amount0: 0n,
      amount1: 0n,
    });
  });

  it("does not care which way round the bounds are given", () => {
    expect(amountsForLiquidity(LIQUIDITY, OPENING_SQRT_PRICE / 2n, LOWER, OPENING_SQRT_PRICE)).toEqual(
      amountsForLiquidity(LIQUIDITY, OPENING_SQRT_PRICE / 2n, OPENING_SQRT_PRICE, LOWER),
    );
  });
});

describe("time", () => {
  it("shows the two coarsest units that apply", () => {
    expect(formatDuration(3 * 86_400 + 4 * 3_600)).toBe("3d 4h");
    expect(formatDuration(12 * 60 + 30)).toBe("12m 30s");
    expect(formatDuration(7_200)).toBe("2h");
    expect(formatDuration(45)).toBe("45s");
  });

  it("treats a transition that has passed as zero, not as negative", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-10)).toBe("0s");
  });

  it("does not render a negative age when the clocks disagree by a block", () => {
    const now = 1_800_000_000;
    expect(formatAge(now + 3, now)).toBe("just now");
    expect(formatAge(now - 240, now)).toBe("4m ago");
  });

  it("renders instants in UTC, labelled", () => {
    expect(formatInstant(1_800_000_000)).toBe("2027-01-15 08:00 UTC");
  });
});

describe("addresses", () => {
  it("keeps enough of an address to compare against one you have", () => {
    expect(shortenAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe("0xf39F…2266");
  });

  it("leaves short strings alone", () => {
    expect(shortenAddress("0x1234")).toBe("0x1234");
  });

  it("shortens a hash from the front, since that is what gets scanned", () => {
    expect(shortenHash("0xbda74a90ed941825d76a804624e0054bcb911bb896a9754adb583db911969a2a")).toBe("0xbda74a90…");
  });
});
