/**
 * Adversarial semantic audit.
 *
 * Written after the implementation rather than alongside it, and looking for one specific
 * class of bug: a place where the four representations of a market disagree.
 *
 *   canonical config  what deploys
 *   review            what the creator reads
 *   simulation        what they are shown it costs
 *   encoding/hash     what they sign
 *
 * Engine 0's defining failure was not a crash. It was a review screen describing one market
 * while a separately generated contract ran another, and nothing in the system able to notice.
 * The engine's answer is that all four derive from one object — so the audit is: try to find a
 * prompt shape where they come apart anyway.
 *
 * These are properties rather than examples wherever a property is available, because an
 * example only proves the case somebody thought of.
 */

import { describe, expect, it } from "vitest";

import { compile } from "./compile.js";
import { configHash, encodeConfig, implementationHash } from "./encode.js";
import { evaluate, maximumFeePpm } from "./evaluate.js";
import { BINDING, EQUITY_QUOTE, ONE_PERCENT_OF_SUPPLY, REFERENCE_SUPPLY, flat } from "./fixtures.js";
import { executionGraph } from "./graph.js";
import { review } from "./review.js";
import { simulate } from "./simulate.js";
import type { AgenMarketSpec, CanonicalConfig, MarketBinding } from "./spec.js";
import { formatPercent } from "./units.js";

const ONE_ETH = 10n ** 18n;
const IDENTITY = { chainId: 4663, engine: "0x000000000000000000000000000000000000c0de", engineVersion: 1 } as const;

/** JSON with bigints as strings, since simulation carries token amounts. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
}

function compiled(spec: AgenMarketSpec, binding: MarketBinding = BINDING): CanonicalConfig {
  const result = compile(spec, binding);
  if (!result.ok) throw new Error(result.problems.map((p) => `${p.code} ${p.detail}`).join("; "));
  return result.config;
}

function tier(side: "BUY" | "SELL", percent: string, rate: string, operator: "GT" | "GTE" = "GTE") {
  return { side, measure: { kind: "PERCENT_REFERENCE_SUPPLY" as const, percent, operator }, rate };
}

/**
 * A market of every shape v1 has, so a property can be asserted across all of them rather
 * than on whichever one the author had in mind.
 */
const EVERY_SHAPE: readonly { readonly name: string; readonly spec: AgenMarketSpec }[] = [
  { name: "zero fee", spec: { ...flat("0"), distribution: [] } },
  { name: "flat", spec: flat("2") },
  { name: "at the ceiling", spec: flat("10") },
  { name: "one ppm", spec: flat("0.0001") },
  { name: "asymmetric", spec: { ...flat("1"), baseRate: { buy: "1", sell: "2" } } },
  { name: "buys free", spec: { ...flat("1"), baseRate: { buy: "0", sell: "3" } } },
  { name: "one sell tier", spec: { ...flat("1"), sizeTiers: [tier("SELL", "1", "4")] } },
  { name: "exclusive sell tier", spec: { ...flat("1"), sizeTiers: [tier("SELL", "1", "4", "GT")] } },
  {
    name: "four sell tiers",
    spec: {
      ...flat("1"),
      sizeTiers: [tier("SELL", "0.5", "2"), tier("SELL", "1", "3"), tier("SELL", "2", "5"), tier("SELL", "5", "8")],
    },
  },
  {
    name: "tiers both sides",
    spec: { ...flat("1"), sizeTiers: [tier("BUY", "1", "3"), tier("SELL", "2", "6")] },
  },
  {
    name: "whale discount",
    spec: { ...flat("1"), sizeTiers: [tier("SELL", "1", "5"), tier("SELL", "2", "2")] },
  },
  {
    name: "time ladder",
    spec: {
      ...flat("3"),
      ladder: {
        axis: "TIME",
        stages: [
          { afterSeconds: 3_600, rate: { buy: "2", sell: "2" } },
          { afterSeconds: 90_000, rate: { buy: "1", sell: "1" } },
        ],
      },
    },
  },
  {
    name: "volume ladder",
    spec: {
      ...flat("2"),
      ladder: {
        axis: "QUOTE_VOLUME",
        stages: [{ afterQuoteAmount: (100n * ONE_ETH).toString(), rate: { buy: "1", sell: "1" } }],
      },
    },
  },
  {
    name: "tiered volume ladder",
    spec: {
      ...flat("2"),
      sizeTiers: [tier("SELL", "1", "6")],
      ladder: {
        axis: "QUOTE_VOLUME",
        stages: [{ afterQuoteAmount: (100n * ONE_ETH).toString(), rate: { buy: "1", sell: "1" } }],
      },
    },
  },
  {
    name: "four recipients",
    spec: {
      ...flat("2"),
      distribution: [
        { recipient: { kind: "CREATOR" }, share: "40" },
        { recipient: { kind: "TREASURY" }, share: "30" },
        { recipient: { kind: "ADDRESS", address: "0x1111111111111111111111111111111111111111" }, share: "20" },
        { recipient: { kind: "ADDRESS", address: "0x2222222222222222222222222222222222222222" }, share: "10" },
      ],
    },
  },
  {
    name: "thirds",
    spec: {
      ...flat("2"),
      distribution: [
        { recipient: { kind: "CREATOR" }, share: "33.3333" },
        { recipient: { kind: "TREASURY" }, share: "33.3333" },
        { recipient: { kind: "ADDRESS", address: "0x3333333333333333333333333333333333333333" }, share: "33.3334" },
      ],
    },
  },
  {
    name: "with a ceiling",
    spec: {
      ...flat("1"),
      sizeTiers: [tier("SELL", "1", "4")],
      protections: [{ kind: "MAX_TRADE_SIZE", side: "SELL", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "5" } }],
    },
  },
];

describe("semantic audit: the four representations cannot disagree", () => {
  /*
   * The headline property. Every rate the review shows is a rate the evaluator produces, and
   * every rate the evaluator produces on a boundary case is a rate the review shows.
   *
   * A one-directional check would miss the interesting failure. "Every shown rate is real"
   * permits a review that omits a tier; "every real rate is shown" permits a review that
   * invents one. Both directions together are what makes the screen a description.
   */
  it("shows exactly the rates the market can charge, no more and no fewer", () => {
    for (const shape of EVERY_SHAPE) {
      const config = compiled(shape.spec);

      const shown = new Set<string>();
      for (const card of review(config).cards) {
        for (const row of card.rows) {
          // Distribution rows are shares, not rates, and live on their own card.
          if (card.heading === "Where the fees go") continue;
          for (const percent of row.then.match(/\d+(?:\.\d+)?%/g) ?? []) shown.add(percent);
        }
      }

      const produced = new Set(
        simulate(config).cases.map((one) => formatPercent(one.evaluation.effectiveFeePpm)),
      );

      for (const rate of produced) {
        expect(shown.has(rate), `${shape.name}: the simulation charges ${rate} and no card says so`).toBe(true);
      }
    }
  });

  it("never shows a rate the configuration does not contain", () => {
    for (const shape of EVERY_SHAPE) {
      const config = compiled(shape.spec);

      const real = new Set<string>([
        ...config.stages.flatMap((stage) => [formatPercent(stage.buyFeePpm), formatPercent(stage.sellFeePpm)]),
        ...[...config.buyTiers, ...config.sellTiers].map((one) => formatPercent(one.feePpm)),
      ]);

      for (const card of review(config).cards) {
        if (card.heading === "Where the fees go" || card.heading === "Trade ceilings") continue;
        for (const row of card.rows) {
          for (const percent of row.then.match(/\d+(?:\.\d+)?%/g) ?? []) {
            expect(real.has(percent), `${shape.name}: a card shows ${percent} and the market cannot charge it`).toBe(
              true,
            );
          }
        }
      }
    }
  });

  it("states a worst case that the market can actually reach", () => {
    for (const shape of EVERY_SHAPE) {
      const config = compiled(shape.spec);
      const stated = review(config).maximumFee;
      const reachable = simulate(config).cases.map((one) => one.evaluation.effectiveFeePpm);

      expect(stated).toBe(formatPercent(maximumFeePpm(config)));
      if (reachable.length > 0) {
        expect(Math.max(...reachable)).toBeLessThanOrEqual(maximumFeePpm(config));
      }
    }
  });

  it("names the same fee currency everywhere it is named", () => {
    for (const shape of EVERY_SHAPE) {
      const config = compiled(shape.spec);
      const shown = review(config);

      // The card, the field and the evaluator all have to agree, because the card is what a
      // creator reads and the evaluator is what pays them.
      const evaluated = evaluate(config, {
        side: "SELL",
        grossTokenAmount: ONE_PERCENT_OF_SUPPLY,
        grossQuoteAmount: ONE_ETH,
        elapsedSeconds: 0n,
        cumulativeQuoteVolume: 0n,
      });

      expect(shown.feeCurrency).toBe(config.feeCurrency);
      expect(evaluated.feeCurrency).toBe(config.feeCurrency);

      const split = shown.cards.find((card) => card.heading === "Where the fees go");
      if (split?.summary != null) {
        expect(split.summary).toContain(shown.feeCurrencySymbol);
      }
    }
  });

  it("shows the same split the evaluator pays", () => {
    for (const shape of EVERY_SHAPE) {
      const config = compiled(shape.spec);
      if (config.distribution.length === 0) continue;

      const split = review(config).cards.find((card) => card.heading === "Where the fees go");
      const shown = (split?.rows ?? []).map((row) => row.then);

      for (const share of config.distribution) {
        expect(shown, `${shape.name}: a recipient's share is missing from the card`).toContain(
          formatPercent(share.sharePpm),
        );
      }
    }
  });

  it("puts every rate in the graph that the review shows", () => {
    for (const shape of EVERY_SHAPE) {
      const config = compiled(shape.spec);

      const inGraph = new Set(
        executionGraph(config)
          .nodes.filter((node) => node.feePpm !== null)
          .map((node) => formatPercent(node.feePpm!)),
      );

      for (const stage of config.stages) {
        expect(inGraph.has(formatPercent(stage.buyFeePpm))).toBe(true);
        expect(inGraph.has(formatPercent(stage.sellFeePpm))).toBe(true);
      }
      for (const one of [...config.buyTiers, ...config.sellTiers]) {
        expect(inGraph.has(formatPercent(one.feePpm))).toBe(true);
      }
    }
  });

  it("commits to the configuration it describes", () => {
    // The hash is over the encoding, the encoding is over the configuration, and the review is
    // over the same configuration. So two markets the review distinguishes must hash
    // differently, and two it describes identically must hash identically.
    const seen = new Map<string, string>();

    for (const shape of EVERY_SHAPE) {
      const config = compiled(shape.spec);
      const hash = configHash(config);
      const described = JSON.stringify(review(config));

      const previous = seen.get(described);
      if (previous !== undefined) {
        expect(previous, `two markets read identically and hash differently: ${shape.name}`).toBe(hash);
      }
      seen.set(described, hash);

      expect(configHash(config)).toBe(configHash(compiled(shape.spec)));
      expect(encodeConfig(config)).toBe(encodeConfig(compiled(shape.spec)));
      expect(implementationHash(config, IDENTITY)).toBe(implementationHash(compiled(shape.spec), IDENTITY));
    }
  });
});

describe("semantic audit: boundaries", () => {
  it("has a simulation case on both sides of every threshold, in every shape", () => {
    for (const shape of EVERY_SHAPE) {
      const config = compiled(shape.spec);
      const sizes = new Set(simulate(config).cases.map((one) => one.context.grossTokenAmount));

      for (const one of [...config.buyTiers, ...config.sellTiers]) {
        expect(sizes.has(one.thresholdTokens - 1n), `${shape.name}: no case below a threshold`).toBe(true);
        expect(sizes.has(one.thresholdTokens), `${shape.name}: no case at a threshold`).toBe(true);
        expect(sizes.has(one.thresholdTokens + 1n), `${shape.name}: no case above a threshold`).toBe(true);
      }
    }
  });

  it("changes rate across every threshold it claims to", () => {
    for (const shape of EVERY_SHAPE) {
      const config = compiled(shape.spec);

      for (const side of ["BUY", "SELL"] as const) {
        const tiers = side === "BUY" ? config.buyTiers : config.sellTiers;
        for (const [index, one] of tiers.entries()) {
          const below = evaluate(config, {
            side,
            grossTokenAmount: one.thresholdTokens - 1n,
            grossQuoteAmount: ONE_ETH,
            elapsedSeconds: 0n,
            cumulativeQuoteVolume: 0n,
          });
          const at = evaluate(config, {
            side,
            grossTokenAmount: one.thresholdTokens,
            grossQuoteAmount: ONE_ETH,
            elapsedSeconds: 0n,
            cumulativeQuoteVolume: 0n,
          });

          expect(at.tierIndex, `${shape.name}: the tier at its own threshold`).toBe(index);
          expect(below.tierIndex, `${shape.name}: a tier fired below its threshold`).not.toBe(index);
        }
      }
    }
  });

  it("keeps GT and GTE one base unit apart and never confuses them", () => {
    const inclusive = compiled({ ...flat("1"), sizeTiers: [tier("SELL", "1", "4", "GTE")] });
    const exclusive = compiled({ ...flat("1"), sizeTiers: [tier("SELL", "1", "4", "GT")] });

    const at = (config: CanonicalConfig, amount: bigint): number =>
      evaluate(config, {
        side: "SELL",
        grossTokenAmount: amount,
        grossQuoteAmount: ONE_ETH,
        elapsedSeconds: 0n,
        cumulativeQuoteVolume: 0n,
      }).effectiveFeePpm;

    expect(at(inclusive, ONE_PERCENT_OF_SUPPLY)).toBe(40_000);
    expect(at(exclusive, ONE_PERCENT_OF_SUPPLY)).toBe(10_000);
    expect(at(exclusive, ONE_PERCENT_OF_SUPPLY + 1n)).toBe(40_000);

    // And the two are different markets, which is the thing a creator is relying on.
    expect(configHash(inclusive)).not.toBe(configHash(exclusive));
  });

  it("does not let fee rounding move a classification, at any size", () => {
    const config = compiled({
      ...flat("0.5"),
      sizeTiers: [{ side: "SELL", measure: { kind: "ABSOLUTE_TOKENS", tokens: "1000", operator: "GTE" }, rate: "4" }],
    });

    for (let amount = 990n; amount <= 1_010n; amount++) {
      const evaluated = evaluate(config, {
        side: "SELL",
        grossTokenAmount: amount,
        grossQuoteAmount: ONE_ETH,
        elapsedSeconds: 0n,
        cumulativeQuoteVolume: 0n,
      });

      expect(evaluated.effectiveFeePpm).toBe(amount >= 1_000n ? 40_000 : 5_000);
    }
  });
});

describe("semantic audit: denominations", () => {
  it("keeps volume in the quote asset whatever the fee is taken in", () => {
    const config = compiled({
      ...flat("2"),
      sizeTiers: [tier("SELL", "1", "6")],
      ladder: {
        axis: "QUOTE_VOLUME",
        stages: [{ afterQuoteAmount: (100n * ONE_ETH).toString(), rate: { buy: "1", sell: "1" } }],
      },
    });

    // Fee in the launched token, trigger in the quote asset. Both true, neither redefined.
    expect(config.feeCurrency).toBe("TOKEN");
    expect(config.ladderAxis).toBe("QUOTE_VOLUME");

    const ladder = review(config).cards.find((card) => card.heading.startsWith("How the rate changes"));
    expect(ladder?.caution).toContain("not a dollar figure");
    expect(ladder?.summary).toContain(config.quoteAsset.symbol);
  });

  it("labels a native quote as native and a token quote as a token", () => {
    const native = review(compiled(flat("2")));
    const equity = review(compiled(flat("2"), { ...BINDING, quoteAsset: EQUITY_QUOTE }));

    expect(native.quoteAssetLabel).toBe("Native ETH — Robinhood Chain");
    expect(equity.quoteAssetLabel).toContain("NVDA");
    expect(equity.quoteAssetLabel).not.toContain("Native");

    for (const shown of [native, equity]) {
      expect(JSON.stringify(shown)).not.toContain("WETH");
    }
  });

  it("measures a supply threshold against supply, never against anything else", () => {
    // The one place a percentage could quietly mean something else. A doubled supply must
    // double the absolute threshold and nothing else about the market may move.
    const single = compiled({ ...flat("1"), sizeTiers: [tier("SELL", "1", "4")] });
    const doubled = compiled({ ...flat("1"), sizeTiers: [tier("SELL", "1", "4")] }, {
      ...BINDING,
      referenceSupply: REFERENCE_SUPPLY * 2n,
    });

    expect(doubled.sellTiers[0]?.thresholdTokens).toBe((single.sellTiers[0]?.thresholdTokens ?? 0n) * 2n);
    expect(doubled.stages[0]?.sellFeePpm).toBe(single.stages[0]?.sellFeePpm);
    expect(configHash(doubled)).not.toBe(configHash(single));
  });
});

describe("semantic audit: conflicts are refused, not resolved", () => {
  const refused: readonly { readonly what: string; readonly spec: AgenMarketSpec; readonly code: string }[] = [
    {
      what: "the same threshold charging two rates",
      spec: { ...flat("1"), sizeTiers: [tier("SELL", "1", "4"), tier("SELL", "1", "6")] },
      code: "DUPLICATE_THRESHOLD",
    },
    {
      what: "a rate above the ceiling",
      spec: flat("40"),
      code: "INVALID_FEE",
    },
    {
      what: "a share total that is not one whole",
      spec: {
        ...flat("1"),
        distribution: [
          { recipient: { kind: "CREATOR" }, share: "80" },
          { recipient: { kind: "TREASURY" }, share: "10" },
        ],
      },
      code: "INVALID_DISTRIBUTION",
    },
    {
      what: "a tier its own ceiling makes unreachable",
      spec: {
        ...flat("1"),
        sizeTiers: [tier("SELL", "5", "4")],
        protections: [
          { kind: "MAX_TRADE_SIZE", side: "SELL", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2" } },
        ],
      },
      code: "CONFLICTING_RULES",
    },
    {
      what: "a threshold no trade can reach",
      spec: { ...flat("1"), sizeTiers: [tier("SELL", "101", "4")] },
      code: "INVALID_THRESHOLD",
    },
  ];

  for (const entry of refused) {
    it(`refuses ${entry.what} rather than picking one`, () => {
      const result = compile(entry.spec, BINDING);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.problems.map((problem) => problem.code)).toContain(entry.code);
    });
  }

  it("does not depend on the order rules were written in", () => {
    // Reordering is the cheapest way to find an ordering dependency, and a model's output order
    // is arbitrary.
    const forwards = compiled({
      ...flat("1"),
      sizeTiers: [tier("SELL", "1", "3"), tier("SELL", "2", "5"), tier("BUY", "1", "2")],
      distribution: [
        { recipient: { kind: "CREATOR" }, share: "60" },
        { recipient: { kind: "TREASURY" }, share: "40" },
      ],
    });

    const backwards = compiled({
      ...flat("1"),
      sizeTiers: [tier("BUY", "1", "2"), tier("SELL", "2", "5"), tier("SELL", "1", "3")],
      distribution: [
        { recipient: { kind: "TREASURY" }, share: "40" },
        { recipient: { kind: "CREATOR" }, share: "60" },
      ],
    });

    expect(configHash(backwards)).toBe(configHash(forwards));
    expect(JSON.stringify(review(backwards))).toBe(JSON.stringify(review(forwards)));
    expect(stable(simulate(backwards))).toBe(stable(simulate(forwards)));
  });
});
