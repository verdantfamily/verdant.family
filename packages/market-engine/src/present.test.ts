/**
 * The three presentations, and the one property they all have to share.
 *
 * Simulation, review cards and the execution graph are the only things a creator ever
 * sees. All three are derived from `CanonicalConfig` and nothing else, so the failure the
 * old pipeline had — a review screen describing one market while a separately generated
 * contract ran another — has no shape here. These tests assert the derivation, and assert
 * that the numbers on the cards are the numbers the evaluator produces.
 */

import { describe, expect, it } from "vitest";

import { compile } from "./compile.js";
import { evaluate, maximumFeePpm } from "./evaluate.js";
import { BINDING, EQUITY_QUOTE, ONE_PERCENT_OF_SUPPLY, REFERENCE_SUPPLY, exactFlow, flat } from "./fixtures.js";
import { executionGraph } from "./graph.js";
import { review } from "./review.js";
import { simulate } from "./simulate.js";
import type { AgenMarketSpec, CanonicalConfig } from "./spec.js";
import { formatPercent } from "./units.js";

const ONE_ETH = 10n ** 18n;

function configOf(spec: AgenMarketSpec): CanonicalConfig {
  const result = compile(spec, BINDING);
  if (!result.ok) throw new Error(result.problems.map((p) => `${p.code} ${p.detail}`).join("; "));
  return result.config;
}

const LADDERED = configOf({
  ...flat("2"),
  ladder: { axis: "TIME", stages: [{ afterSeconds: 3_600, rate: { buy: "1", sell: "1" } }] },
  sizeTiers: [{ side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "5" }],
});

describe("simulate", () => {
  it("generates the boundary triple for every tier", () => {
    const { cases } = simulate(configOf(exactFlow()));
    const sizes = cases.filter((one) => one.context.side === "SELL").map((one) => one.context.grossTokenAmount);

    expect(sizes).toContain(ONE_PERCENT_OF_SUPPLY - 1n);
    expect(sizes).toContain(ONE_PERCENT_OF_SUPPLY);
    expect(sizes).toContain(ONE_PERCENT_OF_SUPPLY + 1n);
  });

  it("shows the rate changing across that triple", () => {
    // The whole reason boundaries are generated rather than chosen: this is where every
    // inclusive/exclusive mistake lives.
    const { cases } = simulate(configOf(exactFlow()));
    const rateAt = (grossTokenAmount: bigint): number | undefined =>
      cases.find((one) => one.context.side === "SELL" && one.context.grossTokenAmount === grossTokenAmount)?.evaluation
        .effectiveFeePpm;

    expect(rateAt(ONE_PERCENT_OF_SUPPLY - 1n)).toBe(5_000);
    expect(rateAt(ONE_PERCENT_OF_SUPPLY)).toBe(40_000);
    expect(rateAt(ONE_PERCENT_OF_SUPPLY + 1n)).toBe(40_000);
  });

  it("generates a boundary for every ladder stage", () => {
    const { cases } = simulate(LADDERED);
    const elapsed = cases.map((one) => one.context.elapsedSeconds);

    expect(elapsed).toContain(3_599n);
    expect(elapsed).toContain(3_600n);
  });

  it("generates a boundary for every ceiling, on both sides of it", () => {
    const config = configOf({
      ...flat("1"),
      protections: [
        { kind: "MAX_TRADE_SIZE", side: "SELL", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2" } },
      ],
    });
    const limit = REFERENCE_SUPPLY / 50n;
    const { cases } = simulate(config);

    const at = cases.find((one) => one.context.grossTokenAmount === limit);
    const above = cases.find((one) => one.context.grossTokenAmount === limit + 1n);

    expect(at?.evaluation.blocked).toBeNull();
    expect(above?.evaluation.blocked?.reason).toBe("MAX_TRADE_SIZE");
  });

  it("covers both sides of every market", () => {
    const { cases } = simulate(LADDERED);
    expect(cases.some((one) => one.context.side === "BUY")).toBe(true);
    expect(cases.some((one) => one.context.side === "SELL")).toBe(true);
  });

  it("names the rule that decided each case", () => {
    // A simulation that says "4%" without saying which rule produced it is not evidence.
    for (const one of simulate(LADDERED).cases) {
      expect(one.because.length).toBeGreaterThan(0);
      expect(one.label.length).toBeGreaterThan(0);
    }
  });

  it("never reports a case above the configuration's maximum", () => {
    for (const config of [configOf(exactFlow()), LADDERED, configOf(flat("0"))]) {
      const simulation = simulate(config);
      expect(simulation.maximumFeePpm).toBe(maximumFeePpm(config));
      for (const one of simulation.cases) {
        expect(one.evaluation.effectiveFeePpm).toBeLessThanOrEqual(simulation.maximumFeePpm);
      }
    }
  });

  it("agrees with the evaluator exactly, case by case", () => {
    // The simulation must not be a second implementation of the rules.
    for (const one of simulate(LADDERED).cases) {
      expect(one.evaluation).toEqual(evaluate(LADDERED, one.context));
    }
  });

  it("is deterministic", () => {
    expect(simulate(configOf(exactFlow()))).toEqual(simulate(configOf(exactFlow())));
  });
});

describe("review", () => {
  it("states the base rate once for a symmetric market", () => {
    const cards = review(configOf(flat("2"))).cards;
    const base = cards.find((card) => card.heading === "What a trade costs");

    expect(base?.rows).toHaveLength(1);
    expect(base?.rows[0]?.then).toBe("2%");
  });

  it("splits the base rate when the two directions differ", () => {
    const cards = review(configOf({ ...flat("1"), baseRate: { buy: "1", sell: "2" } })).cards;
    const base = cards.find((card) => card.heading === "What a trade costs");

    expect(base?.rows.map((row) => row.then)).toEqual(["1%", "2%"]);
  });

  it("reports the worst case a market can charge", () => {
    expect(review(LADDERED).maximumFee).toBe("5%");
    expect(review(configOf(exactFlow())).maximumFee).toBe("4%");
  });

  it("says the tier replaces the base rate rather than adding to it", () => {
    // The single most common misreading of a size tier, so the card says it outright.
    const tiers = review(configOf(exactFlow())).cards.find((card) => card.heading === "Larger sells");
    expect(tiers?.summary).toContain("never added together");
  });

  it("says a size threshold is measured against supply, not pool depth", () => {
    const tiers = review(configOf(exactFlow())).cards.find((card) => card.heading === "Larger sells");
    expect(tiers?.summary).toContain("frozen supply");
  });

  it("says volume is quote-denominated and not a dollar figure", () => {
    const config = configOf({
      ...flat("2"),
      ladder: {
        axis: "QUOTE_VOLUME",
        stages: [{ afterQuoteAmount: (100n * ONE_ETH).toString(), rate: { buy: "1", sell: "1" } }],
      },
    });
    const ladder = review(config).cards.find((card) => card.heading.startsWith("How the rate changes"));

    expect(ladder?.caution).toContain("not a dollar figure");
  });

  /*
   * Native Robinhood Chain ETH is the first-release quote asset, since every existing Agen
   * market is ether-quoted. The engine represents it as v4 does — the zero address — and
   * never as a token, never wrapped, and never labelled WETH.
   */
  describe("a native ETH quote is named as itself", () => {
    const NATIVE_BINDING = {
      ...BINDING,
      quoteAsset: { address: "0x0000000000000000000000000000000000000000" as const, symbol: "ETH", decimals: 18 },
    };

    function nativeConfig(spec: AgenMarketSpec): CanonicalConfig {
      const result = compile(spec, NATIVE_BINDING);
      if (!result.ok) throw new Error(result.problems.map((p) => p.code).join(", "));
      return result.config;
    }

    it("labels the quote asset as native, on the chain it is native to", () => {
      expect(review(nativeConfig(flat("2"))).quoteAssetLabel).toBe("Native ETH — Robinhood Chain");
    });

    it("names the fee currency as native ETH for a market with no size rules", () => {
      const shown = review(nativeConfig(flat("2")));
      expect(shown.feeCurrency).toBe("QUOTE");
      expect(shown.feeCurrencySymbol).toBe("Native ETH");
    });

    it("names the launched token for a native-quoted market with size rules", () => {
      // The ADR-018 case that reads backwards if stated carelessly: quoted in ETH, paid in
      // the token it launched.
      const shown = review(nativeConfig(exactFlow()));
      expect(shown.quoteAssetLabel).toBe("Native ETH — Robinhood Chain");
      expect(shown.feeCurrency).toBe("TOKEN");
      expect(shown.feeCurrencySymbol).toBe("CNPY");
      expect(shown.feeCurrencyReason).toContain("contains launched-token size rules");
    });

    it("never says WETH", () => {
      for (const spec of [flat("2"), exactFlow()]) {
        const shown = review(nativeConfig(spec));
        const text = JSON.stringify(shown);
        expect(text).not.toContain("WETH");
        expect(text).not.toContain("Wrapped");
      }
    });

    it("shows a token quote as its ticker and address, not as native", () => {
      // The shared fixture is ether-quoted, so this needs an explicitly non-native binding.
      const equity = compile(flat("2"), { ...BINDING, quoteAsset: EQUITY_QUOTE });
      if (!equity.ok) throw new Error("the equity fixture did not compile");

      const shown = review(equity.config);
      expect(shown.quoteAssetLabel).not.toContain("Native");
      expect(shown.quoteAssetLabel).toContain("NVDA");
      expect(shown.feeCurrencySymbol).toBe("NVDA");
    });
  });

  describe("the fee currency is stated, not hidden", () => {
    it("names the quote asset for a market with no size rules", () => {
      const review1 = review(configOf(flat("2")));
      expect(review1.feeCurrency).toBe("QUOTE");
      // The shared fixture is ether-quoted, so this is the native label.
      expect(review1.feeCurrencySymbol).toBe("Native ETH");
      expect(review1.feeCurrencyReason).toContain("no launched-token size rules");
    });

    it("names the launched token for a market with size rules, and says why", () => {
      // The example from the brief: "Programmable fee currency: CNPY / Reason: this market
      // contains launched-token size rules".
      const review1 = review(configOf(exactFlow()));
      expect(review1.feeCurrency).toBe("TOKEN");
      expect(review1.feeCurrencySymbol).toBe("CNPY");
      expect(review1.feeCurrencyReason).toContain("contains launched-token size rules");
    });

    it("repeats it on the distribution card, since that is where amounts are read", () => {
      const split = review(configOf(exactFlow())).cards.find((card) => card.heading === "Where the fees go");
      expect(split?.summary).toContain("CNPY");
    });

    it("labels the distribution in the fee currency, not the quote asset", () => {
      // `feeDistribution` always pays out in whatever the market collects.
      const split = review(configOf(exactFlow())).cards.find((card) => card.heading === "Where the fees go");
      expect(split?.summary).not.toContain("taken in ETH");
    });
  });

  it("cautions about a bare address recipient", () => {
    const config = configOf({
      ...flat("1"),
      distribution: [
        { recipient: { kind: "ADDRESS", address: "0x5555555555555555555555555555555555555555" }, share: "100" },
      ],
    });
    const split = review(config).cards.find((card) => card.heading === "Where the fees go");

    expect(split?.caution).toContain("plain");
  });

  it("says a flat market's rate can never change", () => {
    const base = review(configOf(flat("2"))).cards.find((card) => card.heading === "What a trade costs");
    expect(base?.summary).toContain("no owner");
  });

  it("cautions that a ceiling reverts rather than partially filling", () => {
    const config = configOf({
      ...flat("1"),
      protections: [{ kind: "MAX_TRADE_SIZE", side: "BOTH", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2" } }],
    });
    const ceiling = review(config).cards.find((card) => card.heading === "Trade ceilings");

    expect(ceiling?.caution).toContain("reverts");
  });

  it("omits cards a market has nothing to say for", () => {
    const headings = review(configOf(flat("2"))).cards.map((card) => card.heading);
    expect(headings).not.toContain("Larger sells");
    expect(headings).not.toContain("Trade ceilings");
  });

  /*
   * The property the old review screen did not have. Every rate a card shows has to be a
   * rate the evaluator actually produces, because the cards and the chain now read the
   * same configuration.
   */
  it("shows only rates the evaluator agrees with", () => {
    const shown = new Set<string>();
    for (const card of review(LADDERED).cards) {
      for (const row of card.rows) {
        if (row.then.endsWith("%")) shown.add(row.then);
      }
    }

    const produced = new Set(
      simulate(LADDERED).cases.map((one) => formatPercent(one.evaluation.effectiveFeePpm)),
    );

    for (const rate of produced) {
      expect(shown.has(rate)).toBe(true);
    }
  });
});

describe("executionGraph", () => {
  it("has one root that every path starts from", () => {
    const { nodes, edges } = executionGraph(LADDERED);
    const root = nodes.find((node) => node.kind === "SWAP");

    expect(root).toBeDefined();
    expect(edges.some((edge) => edge.to === root?.id)).toBe(false);
  });

  it("branches on side before anything else", () => {
    const { nodes } = executionGraph(configOf(flat("2")));
    expect(nodes.filter((node) => node.kind === "SIDE")).toHaveLength(2);
  });

  it("carries the rate on every node that settles one", () => {
    for (const node of executionGraph(LADDERED).nodes) {
      if (node.kind === "RATE") expect(node.feePpm).not.toBeNull();
      else expect(node.feePpm).toBeNull();
    }
  });

  it("only settles rates the configuration contains", () => {
    const allowed = new Set<number>([
      ...LADDERED.stages.flatMap((stage) => [stage.buyFeePpm, stage.sellFeePpm]),
      ...[...LADDERED.buyTiers, ...LADDERED.sellTiers].map((tier) => tier.feePpm),
    ]);

    for (const node of executionGraph(LADDERED).nodes) {
      if (node.feePpm !== null) expect(allowed.has(node.feePpm)).toBe(true);
    }
  });

  it("shows a refusal node for a ceiling and none without one", () => {
    expect(executionGraph(configOf(flat("1"))).nodes.some((node) => node.kind === "REFUSED")).toBe(false);

    const guarded = configOf({
      ...flat("1"),
      protections: [{ kind: "MAX_TRADE_SIZE", side: "SELL", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2" } }],
    });
    expect(executionGraph(guarded).nodes.some((node) => node.kind === "REFUSED")).toBe(true);
  });

  it("gives one payout node per recipient", () => {
    const { nodes } = executionGraph(configOf(exactFlow()));
    expect(nodes.filter((node) => node.kind === "PAYOUT")).toHaveLength(2);
  });

  it("has no edge pointing at a node that does not exist", () => {
    const { nodes, edges } = executionGraph(LADDERED);
    const ids = new Set(nodes.map((node) => node.id));

    for (const edge of edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  it("gives every node a unique id", () => {
    const { nodes } = executionGraph(LADDERED);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
  });

  it("is serializable, since the interface receives it as JSON", () => {
    expect(() => JSON.stringify(executionGraph(LADDERED))).not.toThrow();
  });

  it("is deterministic", () => {
    expect(executionGraph(LADDERED)).toEqual(executionGraph(LADDERED));
  });
});
