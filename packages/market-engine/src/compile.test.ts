import { describe, expect, it } from "vitest";

import { MAX_RECIPIENTS, MAX_STAGES, MAX_TIERS_PER_SIDE } from "./bounds.js";
import { compile } from "./compile.js";
import { BINDING, ONE_PERCENT_OF_SUPPLY, REFERENCE_SUPPLY, exactFlow, flat } from "./fixtures.js";
import type { AgenMarketSpec, CanonicalConfig, SizeTier } from "./spec.js";

function ok(spec: AgenMarketSpec): CanonicalConfig {
  const result = compile(spec, BINDING);
  if (!result.ok) throw new Error(`expected a compile, got ${result.problems.map((p) => p.code).join(", ")}`);
  return result.config;
}

function codes(spec: AgenMarketSpec): readonly string[] {
  const result = compile(spec, BINDING);
  return result.ok ? [] : result.problems.map((problem) => problem.code);
}

function sellTier(percent: string, rate: string, operator: "GT" | "GTE" = "GTE"): SizeTier {
  return { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent, operator }, rate };
}

describe("compile", () => {
  it("turns the base rate into stage 0", () => {
    // A market with one rate is a ladder with one stage. That unification is why there is
    // no precedence question between "the base fee" and "the ladder".
    const config = ok(flat("2"));
    expect(config.stages).toHaveLength(1);
    expect(config.stages[0]).toEqual({ threshold: 0n, buyFeePpm: 20_000, sellFeePpm: 20_000 });
    expect(config.ladderAxis).toBeNull();
  });

  it("keeps asymmetric rates apart", () => {
    const config = ok({ ...flat("1"), baseRate: { buy: "1", sell: "2" } });
    expect(config.stages[0]?.buyFeePpm).toBe(10_000);
    expect(config.stages[0]?.sellFeePpm).toBe(20_000);
  });

  it("resolves a supply percentage into an absolute token amount", () => {
    // Resolved once here so the swap path never divides and never calls totalSupply().
    const config = ok({ ...exactFlow() });
    expect(config.sellTiers[0]?.thresholdTokens).toBe(ONE_PERCENT_OF_SUPPLY);
    expect(config.sellTiers[0]?.feePpm).toBe(40_000);
  });

  describe("GT folds into GTE", () => {
    /*
     * `> T` and `>= T + 1` admit exactly the same trades over integers, so the operator
     * can be normalized away entirely. The runtime then has one comparison, and the
     * Solidity cannot disagree with the TypeScript about which operator a tier meant.
     */
    it("shifts an exclusive threshold up by one base unit", () => {
      const inclusive = ok({ ...flat("1"), sizeTiers: [sellTier("1", "4", "GTE")] });
      const exclusive = ok({ ...flat("1"), sizeTiers: [sellTier("1", "4", "GT")] });

      expect(inclusive.sellTiers[0]?.thresholdTokens).toBe(ONE_PERCENT_OF_SUPPLY);
      expect(exclusive.sellTiers[0]?.thresholdTokens).toBe(ONE_PERCENT_OF_SUPPLY + 1n);
    });

    it("leaves no operator in the canonical form at all", () => {
      const config = ok({ ...flat("1"), sizeTiers: [sellTier("1", "4", "GT")] });
      expect(Object.keys(config.sellTiers[0] ?? {})).toEqual(["thresholdTokens", "feePpm"]);
    });
  });

  describe("ordering is imposed, not inherited", () => {
    it("sorts tiers ascending however the model listed them", () => {
      const descending = ok({
        ...flat("1"),
        sizeTiers: [sellTier("3", "6"), sellTier("1", "4"), sellTier("2", "5")],
      });

      expect(descending.sellTiers.map((tier) => tier.feePpm)).toEqual([40_000, 50_000, 60_000]);
    });

    it("sorts ladder stages ascending however the model listed them", () => {
      const config = ok({
        ...flat("1"),
        ladder: {
          axis: "TIME",
          stages: [
            { afterSeconds: 7_200, rate: { buy: "3", sell: "3" } },
            { afterSeconds: 3_600, rate: { buy: "2", sell: "2" } },
          ],
        },
      });

      expect(config.stages.map((stage) => stage.threshold)).toEqual([0n, 3_600n, 7_200n]);
    });

    it("orders recipients canonically", () => {
      const config = ok({
        ...flat("1"),
        distribution: [
          { recipient: { kind: "ADDRESS", address: "0x2222222222222222222222222222222222222222" }, share: "20" },
          { recipient: { kind: "TREASURY" }, share: "30" },
          { recipient: { kind: "CREATOR" }, share: "50" },
        ],
      });

      expect(config.distribution.map((share) => share.recipient.kind)).toEqual([
        "CREATOR",
        "TREASURY",
        "ADDRESS",
      ]);
    });
  });

  describe("duplicates", () => {
    it("drops a tier stated twice identically", () => {
      const config = ok({ ...flat("1"), sizeTiers: [sellTier("1", "4"), sellTier("1", "4")] });
      expect(config.sellTiers).toHaveLength(1);
    });

    it("refuses two tiers at the same threshold with different rates", () => {
      // Which one applies would depend on the order they were written in, which makes the
      // market ambiguous rather than merely redundant.
      expect(codes({ ...flat("1"), sizeTiers: [sellTier("1", "4"), sellTier("1", "5")] })).toContain(
        "DUPLICATE_THRESHOLD",
      );
    });

    it("merges two shares to the same recipient", () => {
      // Economics-preserving: addition is not a judgement, and [creator 50, creator 50]
      // is the same market as [creator 100].
      const config = ok({
        ...flat("1"),
        distribution: [
          { recipient: { kind: "CREATOR" }, share: "50" },
          { recipient: { kind: "CREATOR" }, share: "50" },
        ],
      });

      expect(config.distribution).toHaveLength(1);
      expect(config.distribution[0]?.sharePpm).toBe(1_000_000);
    });

    it("refuses two ladder stages at the same threshold", () => {
      expect(
        codes({
          ...flat("1"),
          ladder: {
            axis: "TIME",
            stages: [
              { afterSeconds: 3_600, rate: { buy: "2", sell: "2" } },
              { afterSeconds: 3_600, rate: { buy: "3", sell: "3" } },
            ],
          },
        }),
      ).toContain("DUPLICATE_THRESHOLD");
    });
  });

  describe("fees", () => {
    it("refuses a rate above the ceiling rather than clamping to it", () => {
      // A market that asked for 40% did not ask for 10%.
      expect(codes(flat("40"))).toContain("INVALID_FEE");
    });

    it("accepts a rate exactly at the ceiling", () => {
      expect(ok(flat("10")).stages[0]?.buyFeePpm).toBe(100_000);
    });

    it("refuses a rate finer than one ppm", () => {
      expect(codes(flat("0.000001"))).toContain("INVALID_FEE");
    });

    it("allows a zero rate on one side", () => {
      // "buys pay nothing" is a real market, and a common one.
      const config = ok({ ...flat("1"), baseRate: { buy: "0", sell: "1" } });
      expect(config.stages[0]?.buyFeePpm).toBe(0);
    });
  });

  describe("thresholds", () => {
    it("refuses a threshold that matches every trade", () => {
      expect(
        codes({
          ...flat("1"),
          sizeTiers: [{ side: "SELL", measure: { kind: "ABSOLUTE_TOKENS", tokens: "0", operator: "GTE" }, rate: "4" }],
        }),
      ).toContain("INVALID_THRESHOLD");
    });

    it("refuses a threshold no trade could reach", () => {
      // Above the whole supply, so the rule could never fire.
      expect(
        codes({
          ...flat("1"),
          sizeTiers: [
            {
              side: "SELL",
              measure: { kind: "ABSOLUTE_TOKENS", tokens: (REFERENCE_SUPPLY + 1n).toString(), operator: "GTE" },
              rate: "4",
            },
          ],
        }),
      ).toContain("INVALID_THRESHOLD");
    });

    it("refuses a supply share above one whole", () => {
      expect(codes({ ...flat("1"), sizeTiers: [sellTier("101", "4")] })).toContain("INVALID_THRESHOLD");
    });
  });

  describe("distribution", () => {
    it("refuses shares that do not total one whole", () => {
      expect(
        codes({
          ...flat("1"),
          distribution: [
            { recipient: { kind: "CREATOR" }, share: "80" },
            { recipient: { kind: "TREASURY" }, share: "10" },
          ],
        }),
      ).toContain("INVALID_DISTRIBUTION");
    });

    it("refuses shares that total more than one whole", () => {
      expect(
        codes({
          ...flat("1"),
          distribution: [
            { recipient: { kind: "CREATOR" }, share: "80" },
            { recipient: { kind: "TREASURY" }, share: "30" },
          ],
        }),
      ).toContain("INVALID_DISTRIBUTION");
    });

    it("refuses a fee with nowhere to go", () => {
      // The engine never chooses a recipient. A default applied here would be a decision
      // nobody was told about; the interpretation layer proposes one and discloses it.
      expect(codes({ ...flat("1"), distribution: [] })).toContain("INVALID_DISTRIBUTION");
    });

    it("allows an empty distribution when the market charges nothing", () => {
      expect(compile({ ...flat("0"), distribution: [] }, BINDING).ok).toBe(true);
    });

    it("refuses the zero address as a recipient", () => {
      expect(
        codes({
          ...flat("1"),
          distribution: [
            { recipient: { kind: "ADDRESS", address: "0x0000000000000000000000000000000000000000" }, share: "100" },
          ],
        }),
      ).toContain("INVALID_RECIPIENT");
    });
  });

  describe("bounds", () => {
    it("refuses more tiers than the engine evaluates", () => {
      const tiers = Array.from({ length: MAX_TIERS_PER_SIDE + 1 }, (_, index) =>
        sellTier(String(index + 1), "4"),
      );
      expect(codes({ ...flat("1"), sizeTiers: tiers })).toContain("TOO_MANY_RULES");
    });

    it("counts tiers per side, so each side gets its own budget", () => {
      const spec: AgenMarketSpec = {
        ...flat("1"),
        sizeTiers: [
          ...Array.from({ length: MAX_TIERS_PER_SIDE }, (_, index) => sellTier(String(index + 1), "4")),
          ...Array.from(
            { length: MAX_TIERS_PER_SIDE },
            (_, index): SizeTier => ({
              side: "BUY",
              measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: String(index + 1), operator: "GTE" },
              rate: "3",
            }),
          ),
        ],
      };
      expect(compile(spec, BINDING).ok).toBe(true);
    });

    it("refuses more stages than the engine evaluates", () => {
      const stages = Array.from({ length: MAX_STAGES }, (_, index) => ({
        afterSeconds: (index + 1) * 3_600,
        rate: { buy: "2", sell: "2" },
      }));
      // MAX_STAGES later stages plus the base is one too many.
      expect(codes({ ...flat("1"), ladder: { axis: "TIME", stages } })).toContain("TOO_MANY_RULES");
    });

    it("refuses more recipients than the engine settles", () => {
      const distribution = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, index) => ({
        recipient: {
          kind: "ADDRESS" as const,
          address: `0x${String(index + 1).repeat(40).slice(0, 40)}` as `0x${string}`,
        },
        share: index === 0 ? "20" : "20",
      }));
      expect(codes({ ...flat("1"), distribution })).toContain("TOO_MANY_RULES");
    });
  });

  describe("time stages", () => {
    it("refuses a stage at zero, which is the base rate", () => {
      expect(
        codes({ ...flat("1"), ladder: { axis: "TIME", stages: [{ afterSeconds: 0, rate: { buy: "2", sell: "2" } }] } }),
      ).toContain("INVALID_THRESHOLD");
    });

    it("refuses two stages closer than the minimum gap", () => {
      // A gap that small is usually one instruction read as two.
      expect(
        codes({
          ...flat("1"),
          ladder: {
            axis: "TIME",
            stages: [
              { afterSeconds: 3_600, rate: { buy: "2", sell: "2" } },
              { afterSeconds: 3_601, rate: { buy: "3", sell: "3" } },
            ],
          },
        }),
      ).toContain("CONFLICTING_RULES");
    });

    it("refuses a stage beyond the horizon", () => {
      expect(
        codes({
          ...flat("1"),
          ladder: { axis: "TIME", stages: [{ afterSeconds: 1_000 * 24 * 60 * 60, rate: { buy: "2", sell: "2" } }] },
        }),
      ).toContain("INVALID_THRESHOLD");
    });
  });

  describe("ceilings", () => {
    it("records a per-side ceiling", () => {
      const config = ok({
        ...flat("1"),
        protections: [{ kind: "MAX_TRADE_SIZE", side: "SELL", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "5" } }],
      });
      expect(config.maxSellTokens).toBe(REFERENCE_SUPPLY / 20n);
      expect(config.maxBuyTokens).toBeNull();
    });

    it("applies BOTH to each side", () => {
      const config = ok({
        ...flat("1"),
        protections: [{ kind: "MAX_TRADE_SIZE", side: "BOTH", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "5" } }],
      });
      expect(config.maxBuyTokens).toBe(REFERENCE_SUPPLY / 20n);
      expect(config.maxSellTokens).toBe(REFERENCE_SUPPLY / 20n);
    });

    it("takes the tightest of two ceilings on the same side", () => {
      const config = ok({
        ...flat("1"),
        protections: [
          { kind: "MAX_TRADE_SIZE", side: "SELL", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "5" } },
          { kind: "MAX_TRADE_SIZE", side: "BOTH", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2" } },
        ],
      });
      expect(config.maxSellTokens).toBe(REFERENCE_SUPPLY / 50n);
    });

    it("refuses a tier that its own ceiling makes unreachable", () => {
      // One of the two rules is not what was meant.
      expect(
        codes({
          ...flat("1"),
          sizeTiers: [sellTier("5", "4")],
          protections: [
            { kind: "MAX_TRADE_SIZE", side: "SELL", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2" } },
          ],
        }),
      ).toContain("CONFLICTING_RULES");
    });
  });

  describe("the binding", () => {
    it("refuses to compile without a reference supply", () => {
      const result = compile(flat("1"), { ...BINDING, referenceSupply: 0n });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.problems[0]?.code).toBe("INVALID_REFERENCE_SUPPLY");
    });
  });

  it("is deterministic", () => {
    const first = ok(exactFlow());
    const second = ok(exactFlow());
    expect(first).toEqual(second);
  });

  it("collects every problem rather than stopping at the first", () => {
    const problems = codes({
      ...flat("40"),
      sizeTiers: [sellTier("1", "4"), sellTier("1", "5")],
      distribution: [{ recipient: { kind: "CREATOR" }, share: "80" }],
    });
    expect(problems).toContain("INVALID_FEE");
    expect(problems).toContain("DUPLICATE_THRESHOLD");
    expect(problems).toContain("INVALID_DISTRIBUTION");
  });
});
