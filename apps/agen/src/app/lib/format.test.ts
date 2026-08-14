import { describe, expect, it } from "vitest";

import { marketCapUsd } from "./format";

/**
 * A market capitalisation, in the notation a trading interface uses.
 *
 * The shapes below are the requirement, not an implementation detail: `$14.7k`,
 * `$591.4k`, `$1.92M`. A lowercase `k` and an uppercase `M` is what `Intl` does not do on
 * its own, and the precision changes at a million because the step between `$1.9M` and
 * `$2.0M` is a hundred thousand dollars.
 */
describe("a capitalisation in dollars", () => {
  const rate = 2_000;

  const cap = (eth: number): string | null => marketCapUsd(eth, rate);

  it("writes thousands with a lowercase k and one decimal", () => {
    expect(cap(7.35)).toBe("$14.7k");
    expect(cap(295.7)).toBe("$591.4k");
  });

  it("writes millions with an uppercase M and two decimals", () => {
    expect(cap(960)).toBe("$1.92M");
    expect(cap(5_000)).toBe("$10M");
  });

  it("keeps the precision that distinguishes two large markets", () => {
    // The reason millions get a second decimal: at one, these collapse to the same
    // string, and they are a hundred thousand dollars apart.
    expect(cap(955)).not.toBe(cap(960));
  });

  it("writes hundreds in full, where compacting has nothing to shorten", () => {
    expect(cap(0.25)).toBe("$500");
    expect(cap(0.4995)).toBe("$999");
  });

  it("keeps a young market off $0.00", () => {
    // A token minutes old is worth fractions of a cent, and two places would render every
    // one of them as the same number.
    expect(cap(0.0000001)).toBe("$0.00020");
  });

  it("says zero is zero, because zero was measured", () => {
    expect(cap(0)).toBe("$0");
  });
});

/**
 * The fallback, which is what keeps a dollar sign honest.
 *
 * Callers render the ether figure when this returns null, so a rate that could not be
 * fetched shows the unit the market is actually quoted in rather than a stale number. A
 * `$` anywhere on the site therefore means a live rate was obtained.
 */
describe("what happens without a rate", () => {
  it("declines to price anything", () => {
    expect(marketCapUsd(7.35, null)).toBeNull();
    expect(marketCapUsd(0, null)).toBeNull();
  });

  it("declines an absent capitalisation, rate or no rate", () => {
    expect(marketCapUsd(null, 2_000)).toBeNull();
    expect(marketCapUsd(undefined, 2_000)).toBeNull();
    expect(marketCapUsd(Number.NaN, 2_000)).toBeNull();
  });
});
