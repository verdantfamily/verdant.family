import { describe, expect, it } from "vitest";

import {
  BOOST_PROMISE,
  agenContributionNote,
  boostBreakdown,
  boostCommitment,
  boostStatusLabel,
  boostTotalLine,
  circulatingSupply,
  lastBoostLabel,
  nextBoostLabel,
  queuedForBoost,
  sunkPercent,
  type BoostState,
} from "./boost";

const SUPPLY = 1_000_000_000n * 10n ** 18n;

function state(over: Partial<BoostState> = {}): BoostState {
  return {
    vault: "0x0000000000000000000000000000000000000001",
    enrolled: true,
    enabled: false,
    locked: false,
    pending: 0n,
    creatorPending: 0n,
    // Both streams captured, which is what a market from a Boost-aware Instant deployment looks
    // like and therefore the default these cases are written against.
    platformBoosted: true,
    platformPending: 0n,
    platformRouted: 0n,
    boostTreasury: "0x0000000000000000000000000000000000000002",
    vaultClaimable: 0n,
    agenContributed: 0n,
    spent: 0n,
    bought: 0n,
    sunk: 0n,
    deadBalance: 0n,
    lastBoostAt: 0,
    nextBoostAt: 0,
    boostCount: 0,
    ready: false,
    ...over,
  };
}

/**
 * The sink is not a burn, and the numbers must not pretend otherwise.
 *
 * Instant tokens are `VerdantToken`, which has no `burn` — so `totalSupply()` never moves and a
 * market cap computed from it counts tokens nobody can sell. These are the assertions that keep
 * the correction in place.
 */
describe("supply, once Boost has sunk some of it", () => {
  it("subtracts the dead address's balance rather than the total", () => {
    const sunk = 25_000_000n * 10n ** 18n;
    expect(circulatingSupply({ totalSupply: SUPPLY, deadBalance: sunk })).toBe(SUPPLY - sunk);
  });

  it("does not report a negative supply if the sink somehow exceeds the total", () => {
    // Unreachable through the contracts, and clamped anyway: a negative circulating supply
    // would propagate into a negative market cap, which reads as data rather than as a bug.
    expect(circulatingSupply({ totalSupply: 100n, deadBalance: 500n })).toBe(0n);
  });

  it("is unchanged for a market Boost has never touched", () => {
    expect(circulatingSupply({ totalSupply: SUPPLY, deadBalance: 0n })).toBe(SUPPLY);
  });

  it("states the sunk share without losing precision on a 1e27 supply", () => {
    // A float division of 1e25 by 1e27 is exactly the case where doing this in `Number` first
    // quietly rounds. One percent has to read as one percent.
    expect(sunkPercent({ totalSupply: SUPPLY, deadBalance: SUPPLY / 100n })).toBeCloseTo(1, 6);
    expect(sunkPercent({ totalSupply: SUPPLY, deadBalance: 0n })).toBe(0);
  });

  it("has no share to report for a supply of nothing", () => {
    // Null rather than zero, so a caller renders nothing instead of "0.000% burned".
    expect(sunkPercent({ totalSupply: 0n, deadBalance: 0n })).toBeNull();
  });
});

/**
 * What the product claims, checked as text.
 *
 * The one sentence that must not overstate: Boost spends the *creator's* fees. Agen's 0.50% is a
 * voluntary contribution that the deployed Instant stack cannot route, so it must never appear
 * in the promise.
 */
describe("the sentence the product says", () => {
  it("promises trading fees rather than only the creator's", () => {
    // Both streams are captured now, so "your creator fees" would understate it and hide that Agen
    // gives up its platform revenue as well.
    expect(BOOST_PROMISE).toMatch(/trading fees/i);
    expect(BOOST_PROMISE).not.toMatch(/creator fees/i);
  });

  /**
   * The number is never hardcoded, and this is the assertion that keeps it that way.
   *
   * A market whose Instant deployment routes both shares recycles 1.50%; one that routes only the
   * creator's recycles 1.00%. A single literal in the copy would be a false claim on one of them.
   */
  it("states 1.50% only when both fee streams are actually captured", () => {
    expect(boostTotalLine(state({ platformBoosted: true }))).toContain("1.50%");
    expect(boostTotalLine(state({ platformBoosted: false }))).toContain("1.00%");
    expect(boostTotalLine(state({ platformBoosted: false }))).not.toContain("1.50%");
  });

  it("breaks the total down into who is giving up what", () => {
    const both = boostBreakdown(state({ platformBoosted: true }));
    expect(both).toEqual([
      { label: "Creator contribution", percent: "1.00%" },
      { label: "Agen contribution", percent: "0.50%" },
      { label: "Total Boost", percent: "1.50%" },
    ]);
  });

  it("omits Agen's row rather than showing it as zero where it cannot contribute", () => {
    // A "0.00%" line would read as Agen declining, when the truth is that the market's deployment
    // cannot route the platform share at all.
    const creatorOnly = boostBreakdown(state({ platformBoosted: false }));
    expect(creatorOnly.map((row) => row.label)).toEqual(["Creator contribution", "Total Boost"]);
    expect(creatorOnly.at(-1)?.percent).toBe("1.00%");
  });

  it("states the commitment against the total that market actually recycles", () => {
    expect(boostCommitment(state({ platformBoosted: true }))).toContain("100% of the 1.50%");
    expect(boostCommitment(state({ platformBoosted: true }))).toMatch(/Agen's 0\.50%/);
    expect(boostCommitment(state({ platformBoosted: false }))).toContain("100% of your 1.00%");
  });

  it("says Agen's half percent is not part of Boost where it is not", () => {
    const note = agenContributionNote(state({ platformBoosted: false }));
    expect(note).toMatch(/not part of Boost/i);
  });

  it("says it is part of Boost where the architecture routes it", () => {
    const note = agenContributionNote(state({ platformBoosted: true }));
    expect(note).toMatch(/goes into this market's buybacks/i);
    // "Routed" is a guarantee and "contributed" is a choice. They must not be worded alike.
    expect(note).not.toMatch(/contributed/i);
  });

  it("distinguishes a routed fee from a voluntary top-up", () => {
    const note = agenContributionNote(
      state({ platformBoosted: true, platformRouted: 10n ** 18n, agenContributed: 2n * 10n ** 18n }),
    );
    expect(note).toMatch(/1 ETH so far/);
    expect(note).toMatch(/also contributed 2 ETH from outside the fee split/i);
  });
});

/**
 * What the next cycle will spend, which is both streams.
 *
 * A figure that summed only the escrow's own balance would understate a Boosted market's queue by
 * roughly a third — the platform share sits at the treasury until the cycle pulls it.
 */
describe("the queued figure", () => {
  it("adds the platform share and the vault's outstanding creator share", () => {
    const queued = queuedForBoost(
      state({ enabled: true, pending: 3n, platformPending: 2n, vaultClaimable: 5n }),
    );
    expect(queued).toBe(10n);
  });

  it("excludes the vault's balance while Boost is off, because it is the creator's then", () => {
    const queued = queuedForBoost(
      state({ enabled: false, pending: 3n, platformPending: 2n, vaultClaimable: 5n }),
    );
    expect(queued).toBe(5n);
  });
});

describe("the status a holder reads", () => {
  it("calls out the lock ahead of the switch, because it is the stronger claim", () => {
    expect(boostStatusLabel(state({ enabled: true, locked: true }))).toBe("Locked forever");
    expect(boostStatusLabel(state({ enabled: true }))).toBe("Active");
  });

  it("distinguishes off-and-empty from off-with-money-still-committed", () => {
    // Switching Boost off does not release what was already committed, so a market in that state
    // is still buying back and the label has to say so.
    expect(boostStatusLabel(state())).toBe("Off");
    expect(boostStatusLabel(state({ pending: 10n ** 15n }))).toMatch(/still buying back/i);
  });
});

describe("when the next cycle is", () => {
  const now = 1_800_000_000;

  it("says nothing at all for a market with no Boost and no commitment", () => {
    expect(nextBoostLabel(state(), now)).toBe("—");
  });

  it("reads as ready rather than as a missed appointment once the interval has passed", () => {
    // A past timestamp would suggest the keeper failed. It has not: the market is simply
    // eligible, and whether a cycle runs depends on the threshold too.
    const elapsed = state({ enabled: true, lastBoostAt: now - 3_600, nextBoostAt: now - 1_800, ready: true });
    expect(nextBoostLabel(elapsed, now)).toBe("Ready now");
  });

  it("says what is actually blocking a cycle when the clock is not", () => {
    const thin = state({ enabled: true, lastBoostAt: now - 3_600, nextBoostAt: now - 1_800, ready: false });
    expect(nextBoostLabel(thin, now)).toMatch(/minimum/i);
  });

  it("counts down in minutes while the interval is running", () => {
    expect(nextBoostLabel(state({ enabled: true, nextBoostAt: now + 600 }), now)).toBe(
      "In about 10 minutes",
    );
    expect(nextBoostLabel(state({ enabled: true, nextBoostAt: now + 20 }), now)).toBe(
      "In under a minute",
    );
  });
});

describe("when the last cycle was", () => {
  const now = 1_800_000_000;

  it("says so plainly for a market that has never had one", () => {
    expect(lastBoostLabel(state(), now)).toBe("Not yet");
  });

  it("scales the unit to the age", () => {
    expect(lastBoostLabel(state({ lastBoostAt: now - 30 }), now)).toBe("Just now");
    expect(lastBoostLabel(state({ lastBoostAt: now - 600 }), now)).toBe("10m ago");
    expect(lastBoostLabel(state({ lastBoostAt: now - 7_200 }), now)).toBe("2h ago");
    expect(lastBoostLabel(state({ lastBoostAt: now - 172_800 }), now)).toBe("2d ago");
  });
});
