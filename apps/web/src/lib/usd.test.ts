import { describe, expect, it } from "vitest";

import {
  formatUsd,
  formatUsdPrecise,
  formatUsdPrice,
  formatUsdSignificant,
  usdPriceOf,
  usdValueOf,
} from "./usd";

describe("formatUsd", () => {
  it("compacts thousands, millions and billions", () => {
    expect(formatUsd(16_000)).toBe("$16K");
    expect(formatUsd(26_100)).toBe("$26.1K");
    expect(formatUsd(4_200_000)).toBe("$4.2M");
    expect(formatUsd(1_100_000_000)).toBe("$1.1B");
  });

  it("writes amounts below a thousand plainly", () => {
    expect(formatUsd(940)).toBe("$940");
    expect(formatUsd(12.5)).toBe("$12.50");
  });

  it("renders nothing traded as a plain zero", () => {
    expect(formatUsd(0)).toBe("$0");
  });

  it("refuses a value it cannot render", () => {
    expect(formatUsd(Number.NaN)).toBe("—");
  });
});

/**
 * The axis formatter, which exists because `formatUsd` cannot label a chart.
 *
 * The failure it was written for is not a crash and not an obviously wrong number: it is
 * four gridlines that all say "$3.9K", which looks like a working axis right up until
 * somebody tries to read a value off it.
 */
describe("formatUsdSignificant", () => {
  it("separates gridlines that two significant digits would collapse", () => {
    // A market between $3 870 and $3 910. `formatUsd` renders every one of these as
    // "$3.9K"; at four digits they are three different labels.
    expect(formatUsd(3_870)).toBe(formatUsd(3_910));
    expect(formatUsdSignificant(3_870, 4)).toBe("$3.87K");
    expect(formatUsdSignificant(3_890, 4)).toBe("$3.89K");
    expect(formatUsdSignificant(3_910, 4)).toBe("$3.91K");
  });

  it("drops decimals a wide range does not need", () => {
    // The range that wants three digits is the one where the round numbers are the
    // gridlines, and "$400.0K" would be noise.
    expect(formatUsdSignificant(400_000, 3)).toBe("$400K");
    expect(formatUsdSignificant(350_000, 3)).toBe("$350K");
    expect(formatUsdSignificant(4_230_000, 3)).toBe("$4.23M");
  });

  it("keeps the magnitude suffixes and the zero", () => {
    expect(formatUsdSignificant(1_250_000_000, 3)).toBe("$1.25B");
    expect(formatUsdSignificant(62.18, 4)).toBe("$62.18");
    expect(formatUsdSignificant(0, 4)).toBe("$0");
    expect(formatUsdSignificant(Number.NaN, 4)).toBe("—");
  });
});

describe("formatUsdPrecise", () => {
  it("keeps two decimals so a headline moves when a trade lands", () => {
    expect(formatUsdPrecise(328_990)).toBe("$328.99K");
    expect(formatUsdPrecise(3_902)).toBe("$3.90K");
    expect(formatUsdPrecise(4_230_000)).toBe("$4.23M");
  });
});

describe("formatUsdPrice", () => {
  it("collapses a long run of leading zeros into a subscript count", () => {
    // 0.000000004213 — eight zeros between the point and the first digit.
    expect(formatUsdPrice(0.000000004213)).toBe("$0.0₈4213");
  });

  it("writes a short run of zeros out, where a subscript would not pay", () => {
    expect(formatUsdPrice(0.0123)).toBe("$0.0123");
    expect(formatUsdPrice(0.00042)).toBe("$0.00042");
  });

  it("handles prices at and above a dollar", () => {
    expect(formatUsdPrice(2.5)).toBe("$2.50");
    expect(formatUsdPrice(4_200_000)).toBe("$4.2M");
  });

  it("renders zero plainly", () => {
    expect(formatUsdPrice(0)).toBe("$0");
  });
});

describe("usdValueOf", () => {
  const ether = { decimals: 18, isNative: true };

  it("converts a quote-asset amount at the given rate", () => {
    expect(usdValueOf(10n ** 18n, ether, 3_000)).toBe(3_000);
  });

  it("refuses a market it has no rate for", () => {
    expect(usdValueOf(10n ** 18n, { decimals: 18, isNative: false }, 3_000)).toBeNull();
    expect(usdValueOf(10n ** 18n, ether, null)).toBeNull();
  });
});

describe("usdPriceOf", () => {
  it("converts a 36-decimal price into dollars", () => {
    // 2e-9 ether per token, at $3,000 an ether, is $6e-6.
    const price = 2n * 10n ** 27n;
    expect(usdPriceOf(price, { isNative: true }, 3_000)).toBeCloseTo(6e-6, 12);
  });

  it("refuses a market it has no rate for", () => {
    expect(usdPriceOf(10n ** 36n, { isNative: false }, 3_000)).toBeNull();
    expect(usdPriceOf(10n ** 36n, { isNative: true }, null)).toBeNull();
  });
});
