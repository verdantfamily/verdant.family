import { describe, expect, it } from "vitest";

import { marketCapUsd, sinceLaunch } from "./format";

/**
 * How new a token is, as a card says it.
 *
 * The unit changes at each natural boundary and stops at weeks, and the case changes with
 * it: lowercase for minutes and hours, uppercase for days and weeks, which is what stops
 * `1d` and `1D` reading as the same span at two precisions.
 */
describe("how long ago a token launched", () => {
  const ago = (seconds: number): string => sinceLaunch(1_000_000, 1_000_000 + seconds);

  it("says just now for the first minute", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(59)).toBe("just now");
  });

  it("counts minutes, then hours", () => {
    expect(ago(60)).toBe("1m ago");
    expect(ago(20 * 60)).toBe("20m ago");
    expect(ago(3_599)).toBe("59m ago");
    expect(ago(3_600)).toBe("1h ago");
    expect(ago(3 * 3_600)).toBe("3h ago");
  });

  it("turns over to days at twenty-four hours, and to weeks at seven days", () => {
    expect(ago(86_399)).toBe("23h ago");
    expect(ago(86_400)).toBe("1D ago");
    expect(ago(6 * 86_400)).toBe("6D ago");
    expect(ago(604_800)).toBe("1W ago");
    expect(ago(3 * 604_800)).toBe("3W ago");
  });

  it("does not go negative on a clock that disagrees with the chain", () => {
    expect(sinceLaunch(1_000_000, 999_000)).toBe("just now");
  });
});

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
