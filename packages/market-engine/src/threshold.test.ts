/**
 * That every screen describes a threshold the same way, and describes it truthfully.
 *
 * Both regressions here were found by an adversarial audit that did the one thing no unit test
 * was doing: it read the review, the execution graph and the simulation table side by side and
 * asked whether they agreed. They did not.
 *
 *  - A tier stated in absolute tokens rendered as a percentage of supply, and against a large
 *    supply that percentage truncated to zero. *"A sell of more than 0% of supply"* — a
 *    sentence describing every trade ever made, on a market where the tier fires on almost
 *    none of them.
 *  - The execution graph named the quote asset as the leg every fee is taken from, including
 *    on markets where ADR-018 makes it the launched token. So the graph and the review screen
 *    disagreed about which asset a creator receives, on exactly the markets where that is the
 *    surprising part.
 *  - The graph and the simulation both hardcoded *"or more"*, so a `GT` tier read as inclusive
 *    in the very table whose purpose is to show what happens at the boundary — one row above
 *    the rate that proves otherwise.
 *
 * The fix was one describer instead of three, so most of these tests assert agreement between
 * renderers rather than exact strings. Agreement is the property; the wording is allowed to
 * improve.
 */

import { describe, expect, it } from "vitest";

import { compile } from "./compile.js";
import { evaluate } from "./evaluate.js";
import { executionGraph } from "./graph.js";
import { review } from "./review.js";
import { simulate } from "./simulate.js";
import type { AgenMarketSpec, CanonicalConfig, MarketBinding } from "./spec.js";
import { exactAmount, thresholdPhrase, thresholdWords } from "./threshold.js";

const SUPPLY = 1_000_000_000n * 10n ** 18n;

const BINDING: MarketBinding = {
  launchedTokenSymbol: "EXCT",
  quoteAsset: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 },
  referenceSupply: SUPPLY,
};

function config(spec: Partial<AgenMarketSpec>, binding: MarketBinding = BINDING): CanonicalConfig {
  const result = compile(
    {
      engineVersion: 1,
      baseRate: { buy: "0.5", sell: "0.5" },
      ladder: null,
      sizeTiers: [],
      distribution: [{ recipient: { kind: "CREATOR" }, share: "100" }],
      protections: [],
      ...spec,
    } as AgenMarketSpec,
    binding,
  );

  if (!result.ok) throw new Error(`the fixture did not compile: ${JSON.stringify(result.problems)}`);
  return result.config;
}

/** A tier at a percentage of supply, with the operator under test. */
function percentTier(percent: string, operator: "GT" | "GTE") {
  return {
    sizeTiers: [
      {
        side: "SELL" as const,
        measure: { kind: "PERCENT_REFERENCE_SUPPLY" as const, percent, operator },
        rate: "4",
      },
    ],
  };
}

/**
 * A tier at an absolute quantity — the case a percentage cannot express.
 *
 * `ABSOLUTE_TOKENS` is denominated in base units, which is the right unit for the compiler and
 * is why the model is no longer allowed to write one (see `interpret.ts`). The quantities here
 * are therefore whole tokens scaled by 10^18, and they are chosen below one part per million of
 * supply on purpose: one ppm of a billion tokens is a thousand tokens, so anything smaller
 * truncates to zero and is exactly the case that used to render as "0% of supply".
 */
function tokenTier(wholeTokens: bigint) {
  return {
    sizeTiers: [
      {
        side: "SELL" as const,
        measure: {
          kind: "ABSOLUTE_TOKENS" as const,
          tokens: (wholeTokens * 10n ** 18n).toString(),
          operator: "GTE" as const,
        },
        rate: "4",
      },
    ],
  };
}

/** Every sentence any screen would show for this market. */
function everySentence(built: CanonicalConfig): readonly string[] {
  return [
    ...review(built).cards.flatMap((card) => [
      card.heading,
      card.summary,
      ...card.rows.flatMap((row) => [row.when, row.then]),
    ]),
    ...executionGraph(built).nodes.map((node) => node.label),
    ...executionGraph(built).edges.map((edge) => edge.when ?? ""),
    ...simulate(built).cases.flatMap((one) => [one.label, one.because]),
  ];
}

describe("a threshold stated in absolute tokens", () => {
  /*
   * The regression itself. A thousand tokens out of a billion is 0.0000001% of supply, which
   * truncates to zero parts per million — so the only honest rendering is the token amount.
   */
  it("is never described as a percentage that rounds to nothing", () => {
    const built = config(tokenTier(500n));

    for (const sentence of everySentence(built)) {
      expect(sentence, `a screen described the tier as a share of nothing: ${sentence}`).not.toMatch(
        /\b0% of supply\b/,
      );
    }
  });

  it("states the token amount instead, exactly", () => {
    const built = config(tokenTier(500n));
    const words = thresholdWords(built, built.sellTiers[0]!.thresholdTokens);

    expect(words.isShare).toBe(false);
    expect(words.amount).toBe("500 EXCT");

    // And it reaches the screen a creator reads.
    const tierRow = review(built)
      .cards.flatMap((card) => card.rows)
      .find((row) => row.when.includes("EXCT"));

    expect(tierRow?.when).toContain("500 EXCT");
  });

  it("keeps using percentages where a percentage is faithful", () => {
    const built = config(percentTier("1", "GTE"));
    const words = thresholdWords(built, built.sellTiers[0]!.thresholdTokens);

    expect(words.isShare).toBe(true);
    expect(words.amount).toBe("1%");
  });
});

describe("more than, versus at least", () => {
  it("recovers the difference from the canonical form", () => {
    const inclusive = config(percentTier("1", "GTE"));
    const exclusive = config(percentTier("1", "GT"));

    expect(thresholdWords(inclusive, inclusive.sellTiers[0]!.thresholdTokens).inclusive).toBe(true);
    expect(thresholdWords(exclusive, exclusive.sellTiers[0]!.thresholdTokens).inclusive).toBe(false);

    // The two markets differ by exactly one base unit, which is the whole difficulty: no
    // percentage precision can separate them, so the phrasing has to carry it.
    expect(exclusive.sellTiers[0]!.thresholdTokens - inclusive.sellTiers[0]!.thresholdTokens).toBe(1n);
  });

  /*
   * The agreement property, and the one the audit actually broke. Every renderer must reach
   * the same verdict about inclusivity, because a creator reading "more than 1%" on one panel
   * and "1% or more" on the next has been shown two different markets.
   */
  it("reads the same on every screen", () => {
    for (const operator of ["GT", "GTE"] as const) {
      const built = config(percentTier("1", operator));
      const expected = operator === "GTE";

      const sentences = everySentence(built).filter((sentence) => sentence.includes("1%"));
      expect(sentences.length, "no screen mentioned the tier at all").toBeGreaterThan(0);

      for (const sentence of sentences) {
        // A sentence about the tier either says "or more" or says "more than". Never both,
        // and never the wrong one for this operator.
        if (!/or more|more than/.test(sentence)) continue;

        expect(
          /or more/.test(sentence),
          `"${sentence}" disagrees with ${operator} about whether the boundary is included`,
        ).toBe(expected);
      }
    }
  });

  /*
   * And the execution has to agree with all of them. A sell of exactly 1% pays the tier rate
   * under GTE and the base rate under GT; if the wording ever inverts, this is the assertion
   * that says which one was telling the truth.
   */
  it("matches what a trade at the boundary actually pays", () => {
    const onePercent = SUPPLY / 100n;

    // A sell of exactly one percent of supply: the trade the two readings disagree about, and
    // the trade the wording has to get right, because it is the one a creator asks about.
    const paidAt = (operator: "GT" | "GTE") =>
      evaluate(config(percentTier("1", operator)), {
        side: "SELL",
        grossTokenAmount: onePercent,
        grossQuoteAmount: 10n ** 18n,
        elapsedSeconds: 0n,
        cumulativeQuoteVolume: 0n,
      }).effectiveFeePpm;

    expect(paidAt("GTE")).toBe(40_000);
    expect(paidAt("GT")).toBe(5_000);
  });
});

describe("which asset a rate is a percentage of", () => {
  /*
   * ADR-018: a market with size tiers collects its fee in the launched token, because a size
   * rule can only be applied to the leg it measures. The graph said "of the ETH leg" anyway.
   */
  it("is the launched token on a tiered market, everywhere it is named", () => {
    const built = config(percentTier("1", "GTE"));
    expect(built.feeCurrency).toBe("TOKEN");

    const graph = executionGraph(built);
    const rates = graph.nodes.filter((node) => node.kind === "RATE");
    expect(rates.length).toBeGreaterThan(0);

    for (const node of rates) {
      expect(node.label, `the graph named the wrong leg: ${node.label}`).not.toContain("ETH leg");
      expect(node.label).toContain("EXCT");
    }

    // And it agrees with the review screen, which was right all along.
    expect(review(built).feeCurrencySymbol).toBe("EXCT");
  });

  it("is the quote asset on a market without tiers", () => {
    const built = config({});
    expect(built.feeCurrency).toBe("QUOTE");

    for (const node of executionGraph(built).nodes.filter((one) => one.kind === "RATE")) {
      expect(node.label).toContain("ETH");
    }

    expect(review(built).feeCurrencySymbol).toBe("Native ETH");
  });
});

describe("a ceiling", () => {
  it("states the amount above which a trade is refused, exactly", () => {
    const built = config({
      protections: [
        {
          kind: "MAX_TRADE_SIZE",
          side: "BOTH",
          amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2" },
        },
      ],
    });

    expect(exactAmount(built, built.maxSellTokens!)).toBe("2% of supply");
  });

  /*
   * A ceiling has no folded `GT` in it — the trade *above* it is refused, and that is stated
   * by the sentence rather than recovered from the number. So it must not pick up a spurious
   * "more than" from arithmetic, and must still fall back to tokens where a percentage lies.
   */
  it("does not invent an inclusivity it does not have", () => {
    const built = config({
      protections: [
        {
          kind: "MAX_TRADE_SIZE",
          side: "BOTH",
          amount: { kind: "ABSOLUTE_TOKENS", tokens: (500n * 10n ** 18n).toString() },
        },
      ],
    });

    const stated = exactAmount(built, built.maxSellTokens!);

    expect(stated).toBe("500 EXCT");
    expect(stated).not.toContain("more than");
    expect(stated).not.toContain("0%");
  });
});

describe("the shared describer", () => {
  /*
   * The reason this module exists. Three copies of one derivation is three chances to describe
   * a market the chain does not run, and the copies had already drifted before anyone noticed.
   */
  it("is what every renderer phrases a tier with", () => {
    const built = config(percentTier("3", "GT"));
    const phrase = thresholdPhrase(built, built.sellTiers[0]!.thresholdTokens);

    expect(phrase).toBe("more than 3% of supply");

    const graph = executionGraph(built).nodes.find((node) => node.kind === "TIER");
    expect(graph?.label).toBe(phrase);

    const tierCase = simulate(built).cases.find((one) => one.because.includes("size tier"));
    expect(tierCase?.because).toContain(phrase);

    const row = review(built)
      .cards.flatMap((card) => card.rows)
      .find((one) => one.when.includes("3%"));
    expect(row?.when).toContain("more than 3% of supply");
  });
});
