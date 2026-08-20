/**
 * What a trade of a given size pays, which is the question PUSH got wrong.
 *
 * Its prompt asked for 2% on every trade and 5% on any sell above 2% of the token's
 * immutable total supply. What it got was a market whose surcharge began at one percent,
 * described as one percent everywhere it was described, because a single wrong number in
 * the specification is faithfully reproduced by everything downstream of it.
 *
 * So the ladder below is asserted at the boundary rather than in the middle. A threshold is
 * only ever wrong in three ways — the figure, what it is a figure of, and whether the
 * boundary itself is over the line — and only the first is visible in a screenshot. The
 * cases at exactly 2% and at 2.01% are the ones a creator checks by hand and the ones no
 * generated suite thinks to write.
 */

import { describe, expect, it } from "vitest";

import {
  basisIn,
  feeAt,
  feeSchedule,
  inclusivityIn,
  overThreshold,
  thresholdEnglish,
  thresholdIn,
  thresholdSolidity,
  type SizeThreshold,
} from "./threshold";
import type { MarketSpecification } from "./spec";

function specification(partial: Partial<MarketSpecification>): MarketSpecification {
  return {
    version: 1,
    name: "Test",
    symbol: "TEST",
    summary: "A market.",
    baseFeePpm: 20_000,
    maxFeePpm: 50_000,
    rules: [],
    state: [],
    phases: [],
    invariants: [],
    externalDependencies: [],
    assumptions: [],
    ambiguities: [],
    unsupported: [],
    disclosures: [],
    ...partial,
  } as MarketSpecification;
}

const SUPPLY = 1_000_000_000n * 10n ** 18n;

/** A percentage of the supply as a token amount, exactly. */
const share = (percent: number): bigint => (SUPPLY * BigInt(Math.round(percent * 10_000))) / 1_000_000n;

/**
 * PUSH, as its prompt describes it: 2% on every trade, 5% on a sell over 2% of the supply.
 *
 * The threshold is exclusive, because "over 2%" is what was asked for. A sale of exactly two
 * percent is therefore an ordinary sell.
 */
const PUSH = specification({
  name: "Push",
  symbol: "PUSH",
  rules: [
    {
      id: "base-fee",
      title: "BASE FEE",
      when: { kind: "swap", description: "Any trade" },
      conditions: [],
      then: [{ kind: "setFee", description: "Charge 2%", parameters: { feePpm: 20_000 } }],
    },
    {
      id: "large-sell",
      title: "LARGE SELL",
      when: { kind: "sell", description: "Somebody sells into the pool" },
      conditions: [
        {
          kind: "tradeSizeVsSupply",
          description: "The sell is more than 2% of the token's total supply",
          parameters: { operator: ">", percent: 2, basis: "totalSupply" },
        },
      ],
      then: [{ kind: "setFee", description: "Charge 5%", parameters: { feePpm: 50_000 } }],
    },
  ],
} as Partial<MarketSpecification>);

describe("a threshold read out of a condition", () => {
  it("keeps the figure, what it is a figure of, and the comparison", () => {
    const threshold = thresholdIn(PUSH.rules[1]!.conditions[0]!)!;

    expect(threshold.percent).toBe(2);
    expect(threshold.basis).toBe("supply");
    expect(threshold.inclusive).toBe(false);
  });

  /**
   * A share of a fixed supply and a share of a moving pool are different mechanics, and they
   * are written with the same words. `describe.ts` used to say "of liquidity" for both.
   */
  it("tells a share of the supply from a share of the pool", () => {
    expect(basisIn("2% of the immutable token total supply")).toBe("supply");
    expect(basisIn("1% of current pool liquidity")).toBe("liquidity");
    expect(basisIn("5% of the market cap")).toBe("marketCap");
    expect(basisIn("a fifth of the fees collected")).toBe(null);
  });

  it("reads the comparison from the words, and says nothing where there are none", () => {
    expect(inclusivityIn("sells over 2% of supply")).toBe(false);
    expect(inclusivityIn("sells of more than 2%")).toBe(false);
    expect(inclusivityIn("a sell greater than 2%")).toBe(false);
    expect(inclusivityIn("sells of at least 2%")).toBe(true);
    expect(inclusivityIn("2% or more")).toBe(true);
    expect(inclusivityIn("a sell of 2% of supply")).toBe(null);
  });

  /** The operator beside the number outranks the prose, being the field made for it. */
  it("prefers a recorded operator to the sentence next to it", () => {
    const threshold = thresholdIn({
      kind: "tradeSizeVsSupply",
      description: "A large sell, meaning at least 2% of supply",
      parameters: { operator: ">", percent: 2 },
    })!;

    expect(threshold.inclusive).toBe(false);
  });

  /**
   * Never from the size of the number. A bare `2` next to `percent` is two percent and the
   * same `2` next to `ppm` is two ten-thousandths of a percent, and guessing between them
   * moves a threshold by four orders of magnitude.
   */
  it("takes the unit from the key rather than from the value", () => {
    const at = (parameters: Record<string, string | number>): number | null =>
      thresholdIn({ kind: "tradeSizeVsSupply", description: "of total supply", parameters })
        ?.percent ?? null;

    expect(at({ percent: 2 })).toBe(2);
    expect(at({ thresholdPpm: 20_000 })).toBe(2);
    expect(at({ thresholdBps: 200 })).toBe(2);
    expect(at({ threshold: 2 })).toBe(null);
  });
});

describe("the fee a market charges at a size", () => {
  const sell = feeSchedule(PUSH, "sell")!;
  const buy = feeSchedule(PUSH, "buy")!;

  it("reads PUSH as two percent with a five percent tier above two percent of supply", () => {
    expect(sell.basePpm).toBe(20_000);
    expect(sell.tier?.ppm).toBe(50_000);
    expect(sell.tier?.threshold.percent).toBe(2);
    expect(sell.tier?.threshold.basis).toBe("supply");
  });

  /** Buys have no size tier at all: the surcharge rule fires on sells. */
  it("leaves the buy side flat, because the rule that tiers is a sell rule", () => {
    expect(buy.basePpm).toBe(20_000);
    expect(buy.tier).toBe(null);
  });

  it("charges two percent on a buy of any size", () => {
    for (const percent of [0.5, 1, 1.99, 2, 2.01, 5]) {
      expect(feeAt(buy, { amount: share(percent), basisAmount: SUPPLY })).toBe(20_000);
    }
  });

  /**
   * The ladder, at the boundary.
   *
   * Exactly two percent pays two percent: the request said "over 2%", and a threshold that
   * includes its own boundary is a different market from the one described. One basis point
   * of supply above it pays five.
   */
  it.each([
    [0.5, 20_000],
    [1, 20_000],
    [1.99, 20_000],
    [2, 20_000],
    [2.01, 50_000],
    [5, 50_000],
  ])("charges %s%% of supply at %i ppm", (percent, expected) => {
    expect(feeAt(sell, { amount: share(percent), basisAmount: SUPPLY })).toBe(expected);
  });

  /**
   * One wei either side, which is the case integer arithmetic gets wrong.
   *
   * `amount > basis * percent / 100` truncates, so a sale one wei over the boundary reads as
   * being on it. `overThreshold` scales the amount up instead.
   */
  it("classifies a single wei above the boundary as over it", () => {
    const boundary = share(2);

    expect(feeAt(sell, { amount: boundary, basisAmount: SUPPLY })).toBe(20_000);
    expect(feeAt(sell, { amount: boundary + 1n, basisAmount: SUPPLY })).toBe(50_000);
  });

  it("charges the base fee when there is nothing to measure against", () => {
    expect(feeAt(sell, { amount: share(5), basisAmount: 0n })).toBe(20_000);
  });

  /** The same market written with "at least" is a market where the boundary pays five. */
  it("moves exactly the boundary trade when the comparison is inclusive", () => {
    const threshold: SizeThreshold = {
      basis: "supply",
      percent: 2,
      inclusive: true,
      phrase: "at least 2% of supply",
    };

    expect(overThreshold(threshold, { amount: share(2), basisAmount: SUPPLY })).toBe(true);
    expect(overThreshold(threshold, { amount: share(2) - 1n, basisAmount: SUPPLY })).toBe(false);
  });

  /**
   * A market this cannot read completely says so, rather than answering about a simpler
   * market than the one it was given. A second gated fee rule is a schedule with steps.
   */
  it("refuses to summarise a market whose fee turns on more than one size", () => {
    const stepped = specification({
      rules: [
        ...PUSH.rules,
        {
          id: "huge-sell",
          title: "HUGE SELL",
          when: { kind: "sell", description: "A very large sell" },
          conditions: [
            {
              kind: "tradeSizeVsSupply",
              description: "more than 10% of total supply",
              parameters: { operator: ">", percent: 10 },
            },
          ],
          then: [{ kind: "setFee", description: "Charge 9%", parameters: { feePpm: 90_000 } }],
        },
      ],
    } as Partial<MarketSpecification>);

    expect(feeSchedule(stepped, "sell")).toBe(null);
  });
});

describe("the same threshold in the two languages that have to agree", () => {
  const threshold = thresholdIn(PUSH.rules[1]!.conditions[0]!)!;

  it("says it in English the way the creator wrote it", () => {
    expect(thresholdEnglish(threshold)).toBe("more than 2% of the total supply");
    expect(thresholdEnglish({ ...threshold, inclusive: true })).toBe(
      "at least 2% of the total supply",
    );
  });

  it("writes the comparison a hook has to make", () => {
    expect(thresholdSolidity(threshold, "sellAmount")).toBe("sellAmount > totalSupply * 2 / 100");
    expect(thresholdSolidity({ ...threshold, inclusive: true }, "sellAmount")).toBe(
      "sellAmount >= totalSupply * 2 / 100",
    );
  });

  /**
   * A fractional threshold gets the ppm form, because `2.5 / 100` is not expressible in
   * integer arithmetic and rounding it to two or three would move the boundary silently.
   */
  it("does not round a fractional threshold into whole percent", () => {
    expect(thresholdSolidity({ ...threshold, percent: 2.5 }, "sellAmount")).toBe(
      "sellAmount * 1_000_000 > totalSupply * 25_000",
    );
  });

  it("names the basis the contract holds it under", () => {
    expect(thresholdSolidity({ ...threshold, basis: "liquidity" })).toContain("poolLiquidity");
  });
});
