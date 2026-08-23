import { describe, expect, it } from "vitest";

import { compile } from "./compile.js";
import { distribute, distributionIsWhole, evaluate, maximumFeePpm } from "./evaluate.js";
import type { SwapContext } from "./evaluate.js";
import { BINDING, ONE_PERCENT_OF_SUPPLY, REFERENCE_SUPPLY, exactFlow, flat } from "./fixtures.js";
import type { AgenMarketSpec, CanonicalConfig, Side, SizeTier } from "./spec.js";
import { MAX_FEE_PPM, PPM_ONE } from "./units.js";

const ONE_ETH = 10n ** 18n;

function configOf(spec: AgenMarketSpec): CanonicalConfig {
  const result = compile(spec, BINDING);
  if (!result.ok) throw new Error(result.problems.map((p) => `${p.code} ${p.detail}`).join("; "));
  return result.config;
}

function context(overrides: Partial<SwapContext> & { readonly side: Side }): SwapContext {
  return {
    grossTokenAmount: 1n,
    grossQuoteAmount: ONE_ETH,
    elapsedSeconds: 0n,
    cumulativeQuoteVolume: 0n,
    ...overrides,
  };
}

function sellTier(percent: string, rate: string, operator: "GT" | "GTE" = "GTE"): SizeTier {
  return { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent, operator }, rate };
}

describe("evaluate", () => {
  it("charges the base rate on both sides of a flat market", () => {
    const config = configOf(flat("2"));

    expect(evaluate(config, context({ side: "BUY" })).effectiveFeePpm).toBe(20_000);
    expect(evaluate(config, context({ side: "SELL" })).effectiveFeePpm).toBe(20_000);
  });

  it("takes a tier-free market's fee from the quote leg", () => {
    // With no size rule there is nothing forcing the token leg, so the fee is taken in the
    // asset a creator would rather hold — whichever way the trade went.
    const config = configOf(flat("2"));
    const evaluation = evaluate(
      config,
      context({ side: "SELL", grossQuoteAmount: 100n * ONE_ETH, grossTokenAmount: 7n }),
    );

    expect(config.feeCurrency).toBe("QUOTE");
    expect(evaluation.feeAmount).toBe(2n * ONE_ETH);
  });

  it("takes a tier-bearing market's fee from the token leg", () => {
    /*
     * The constraint that decided this, in one test. A tier is measured on the token leg.
     * A fee can only be taken in the callback that settles its currency. For all four
     * swap shapes to be able to apply a tier, the fee has to come out of the same leg the
     * tier reads — see orientation.ts for the full table.
     */
    const config = configOf(exactFlow());
    const evaluation = evaluate(
      config,
      context({ side: "SELL", grossTokenAmount: 1_000n, grossQuoteAmount: 10n ** 27n }),
    );

    expect(config.feeCurrency).toBe("TOKEN");
    expect(evaluation.feeAmount).toBe(5n);
  });

  describe("the Exact Flow boundary", () => {
    /*
     * The prompt this refactor started from said, in as many words: "A sell of exactly 1%
     * must pay 4%, not 0.5%, and the fees must not be added together." The build that
     * passed had no test for it at all. These three are that test.
     */
    const config = configOf(exactFlow());

    it("charges the base rate one token below the threshold", () => {
      const evaluation = evaluate(config, context({ side: "SELL", grossTokenAmount: ONE_PERCENT_OF_SUPPLY - 1n }));
      expect(evaluation.effectiveFeePpm).toBe(5_000);
      expect(evaluation.tierIndex).toBeNull();
    });

    it("charges the tier at exactly the threshold", () => {
      const evaluation = evaluate(config, context({ side: "SELL", grossTokenAmount: ONE_PERCENT_OF_SUPPLY }));
      expect(evaluation.effectiveFeePpm).toBe(40_000);
      expect(evaluation.tierIndex).toBe(0);
    });

    it("charges the tier one token above the threshold", () => {
      expect(
        evaluate(config, context({ side: "SELL", grossTokenAmount: ONE_PERCENT_OF_SUPPLY + 1n })).effectiveFeePpm,
      ).toBe(40_000);
    });

    it("replaces the base rate instead of adding to it", () => {
      // 4%, not 4.5%. The single most common way a generated hook got this wrong.
      const evaluation = evaluate(config, context({ side: "SELL", grossTokenAmount: ONE_PERCENT_OF_SUPPLY }));
      expect(evaluation.effectiveFeePpm).toBe(40_000);
      expect(evaluation.effectiveFeePpm).not.toBe(45_000);
    });

    it("leaves the other side alone", () => {
      // The tier is a sell rule. A buy of the same size pays the base rate.
      expect(evaluate(config, context({ side: "BUY", grossTokenAmount: ONE_PERCENT_OF_SUPPLY })).effectiveFeePpm).toBe(
        5_000,
      );
    });
  });

  /*
   * Trade size is pre-fee, and this is where that is nailed down.
   *
   * A size threshold is evaluated against the launched-token amount attributable to the
   * underlying pool swap *before* Agen's fee is applied. If it were evaluated after, the
   * rate would depend on the amount, which would depend on the fee, which would depend on
   * the rate — and the market would have no defined answer at its own boundary.
   *
   * Two ways that could silently break, both tested: the fee being denominated in the
   * launched token (so subtracting it would move the amount across the threshold), and fee
   * rounding (so a sub-unit fee could tip a classification).
   */
  describe("size thresholds are evaluated pre-fee", () => {
    const config = configOf(exactFlow());

    it("classifies exactly at the threshold as the tier, in a token-fee market", () => {
      // The fee here is 4% of the launched token. Net of fee the trade is 96% of the
      // threshold, which is below it — so a post-fee reading would charge 0.5% and the
      // market would never once apply its own tier at the boundary.
      expect(config.feeCurrency).toBe("TOKEN");

      const evaluation = evaluate(config, context({ side: "SELL", grossTokenAmount: ONE_PERCENT_OF_SUPPLY }));
      expect(evaluation.effectiveFeePpm).toBe(40_000);
      expect(evaluation.tierIndex).toBe(0);
    });

    it("does not let the fee it charges move it back below the threshold", () => {
      // Explicitly: gross is at the threshold, gross-minus-fee is under it, and the answer
      // is the tier. The post-fee amount is computed here only to prove it differs.
      const gross = ONE_PERCENT_OF_SUPPLY;
      const evaluation = evaluate(config, context({ side: "SELL", grossTokenAmount: gross }));
      const net = gross - evaluation.feeAmount;

      expect(net).toBeLessThan(ONE_PERCENT_OF_SUPPLY);
      expect(evaluation.effectiveFeePpm).toBe(40_000);
    });

    it("is not moved by fee rounding at the smallest amounts", () => {
      // A one-token trade owes a fee of zero, because 4% of one token rounds down to
      // nothing. Classification must come out the same whether the fee rounded to zero or
      // not, which it does because the fee is not an input to it.
      const tiny = configOf({
        ...flat("0.5"),
        sizeTiers: [
          { side: "SELL", measure: { kind: "ABSOLUTE_TOKENS", tokens: "10", operator: "GTE" }, rate: "4" },
        ],
      });

      expect(evaluate(tiny, context({ side: "SELL", grossTokenAmount: 9n })).effectiveFeePpm).toBe(5_000);
      expect(evaluate(tiny, context({ side: "SELL", grossTokenAmount: 10n })).effectiveFeePpm).toBe(40_000);
      expect(evaluate(tiny, context({ side: "SELL", grossTokenAmount: 11n })).effectiveFeePpm).toBe(40_000);

      // And the fee genuinely rounds to zero at these sizes, which is the condition that
      // makes the assertion above worth making.
      expect(evaluate(tiny, context({ side: "SELL", grossTokenAmount: 10n })).feeAmount).toBe(0n);
    });

    it("applies the same rule to a ceiling", () => {
      // A ceiling is a statement about the trade the trader asked for, not about what was
      // left of it after Agen took a cut.
      const guarded = configOf({
        ...flat("1"),
        sizeTiers: [
          { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "4" },
        ],
        protections: [
          { kind: "MAX_TRADE_SIZE", side: "SELL", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2" } },
        ],
      });
      const limit = REFERENCE_SUPPLY / 50n;

      expect(evaluate(guarded, context({ side: "SELL", grossTokenAmount: limit })).blocked).toBeNull();

      const over = evaluate(guarded, context({ side: "SELL", grossTokenAmount: limit + 1n }));
      expect(over.blocked?.attemptedTokens).toBe(limit + 1n);
      // Net of a 4% fee, `limit + 1` would sit comfortably under the ceiling. It is still
      // refused, because the ceiling reads the gross amount.
      expect(limit + 1n - over.feeAmount).toBeLessThan(limit);
    });

    it("is monotonic across the whole boundary neighbourhood", () => {
      // No amount below the threshold pays the tier, and none at or above it pays the base
      // rate. Stated as a sweep because an off-by-one in either direction is the failure
      // this whole section exists to prevent.
      for (let offset = -3n; offset <= 3n; offset++) {
        const evaluation = evaluate(
          config,
          context({ side: "SELL", grossTokenAmount: ONE_PERCENT_OF_SUPPLY + offset }),
        );
        expect(evaluation.effectiveFeePpm).toBe(offset < 0n ? 5_000 : 40_000);
      }
    });
  });

  describe("GT and GTE differ by exactly one trade", () => {
    it("admits the exact threshold under GTE", () => {
      const config = configOf({ ...flat("1"), sizeTiers: [sellTier("1", "4", "GTE")] });
      expect(evaluate(config, context({ side: "SELL", grossTokenAmount: ONE_PERCENT_OF_SUPPLY })).effectiveFeePpm).toBe(
        40_000,
      );
    });

    it("excludes the exact threshold under GT", () => {
      const config = configOf({ ...flat("1"), sizeTiers: [sellTier("1", "4", "GT")] });
      expect(evaluate(config, context({ side: "SELL", grossTokenAmount: ONE_PERCENT_OF_SUPPLY })).effectiveFeePpm).toBe(
        10_000,
      );
      expect(
        evaluate(config, context({ side: "SELL", grossTokenAmount: ONE_PERCENT_OF_SUPPLY + 1n })).effectiveFeePpm,
      ).toBe(40_000);
    });
  });

  describe("multiple tiers", () => {
    const config = configOf({
      ...flat("1"),
      sizeTiers: [sellTier("1", "3"), sellTier("2", "5")],
    });

    it("picks the highest matching tier, not the first", () => {
      // The user's own example: at 3% of supply with rules at 1% and 2%, the answer is
      // the 2% rule. It must not depend on the order the model emitted them in.
      const at3 = evaluate(config, context({ side: "SELL", grossTokenAmount: (REFERENCE_SUPPLY * 3n) / 100n }));
      expect(at3.effectiveFeePpm).toBe(50_000);
    });

    it("picks the lower tier between the two thresholds", () => {
      const between = evaluate(
        config,
        context({ side: "SELL", grossTokenAmount: (REFERENCE_SUPPLY * 15n) / 1_000n }),
      );
      expect(between.effectiveFeePpm).toBe(30_000);
    });

    it("does not depend on the order the model listed them", () => {
      const reversed = configOf({ ...flat("1"), sizeTiers: [sellTier("2", "5"), sellTier("1", "3")] });
      const size = (REFERENCE_SUPPLY * 3n) / 100n;

      expect(evaluate(reversed, context({ side: "SELL", grossTokenAmount: size })).effectiveFeePpm).toBe(
        evaluate(config, context({ side: "SELL", grossTokenAmount: size })).effectiveFeePpm,
      );
    });

    it("allows a discount for larger trades, since that is a real market", () => {
      const discount = configOf({ ...flat("1"), sizeTiers: [sellTier("1", "5"), sellTier("2", "3")] });
      expect(
        evaluate(discount, context({ side: "SELL", grossTokenAmount: (REFERENCE_SUPPLY * 3n) / 100n })).effectiveFeePpm,
      ).toBe(30_000);
    });
  });

  describe("the time ladder", () => {
    const config = configOf({
      ...flat("1"),
      ladder: {
        axis: "TIME",
        stages: [
          { afterSeconds: 3_600, rate: { buy: "2", sell: "2" } },
          { afterSeconds: 7_200, rate: { buy: "3", sell: "3" } },
        ],
      },
    });

    it("charges the base rate before the first stage", () => {
      expect(evaluate(config, context({ side: "BUY", elapsedSeconds: 0n })).effectiveFeePpm).toBe(10_000);
      expect(evaluate(config, context({ side: "BUY", elapsedSeconds: 3_599n })).effectiveFeePpm).toBe(10_000);
    });

    it("advances exactly on the boundary second", () => {
      expect(evaluate(config, context({ side: "BUY", elapsedSeconds: 3_600n })).effectiveFeePpm).toBe(20_000);
    });

    it("holds the last stage forever", () => {
      expect(
        evaluate(config, context({ side: "BUY", elapsedSeconds: 10n ** 9n })).effectiveFeePpm,
      ).toBe(30_000);
    });

    it("lets a size tier override the active stage", () => {
      const withTier = configOf({
        ...flat("1"),
        ladder: { axis: "TIME", stages: [{ afterSeconds: 3_600, rate: { buy: "2", sell: "2" } }] },
        sizeTiers: [sellTier("1", "6")],
      });

      const evaluation = evaluate(
        withTier,
        context({ side: "SELL", elapsedSeconds: 7_200n, grossTokenAmount: ONE_PERCENT_OF_SUPPLY }),
      );
      expect(evaluation.stageFeePpm).toBe(20_000);
      expect(evaluation.effectiveFeePpm).toBe(60_000);
    });
  });

  /*
   * Volume is quote-denominated whatever the fee is denominated in.
   *
   * The two are independent concepts and neither is defined in terms of the other. A market
   * that collects its fee in the launched token because it has size tiers still counts its
   * volume trigger in the quote asset, because "after 100 ETH of volume" is a statement
   * about ETH and redefining it as tokens would silently change when the market's own rate
   * changes.
   */
  describe("volume stays quote-denominated when the fee is not", () => {
    const config = configOf({
      ...flat("2"),
      sizeTiers: [
        { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "5" },
      ],
      ladder: {
        axis: "QUOTE_VOLUME",
        stages: [{ afterQuoteAmount: (100n * ONE_ETH).toString(), rate: { buy: "1", sell: "1" } }],
      },
    });

    it("is a valid combination: token fee, quote-denominated trigger", () => {
      expect(config.feeCurrency).toBe("TOKEN");
      expect(config.ladderAxis).toBe("QUOTE_VOLUME");
      expect(config.stages[1]?.threshold).toBe(100n * ONE_ETH);
    });

    it("advances the ladder on quote volume, not on token volume", () => {
      const at = (cumulativeQuoteVolume: bigint): number =>
        evaluate(config, context({ side: "BUY", cumulativeQuoteVolume })).stageFeePpm;

      expect(at(99n * ONE_ETH)).toBe(20_000);
      expect(at(100n * ONE_ETH)).toBe(10_000);
    });

    it("takes the fee from the token leg while reading the quote leg for the stage", () => {
      // Both legs are used in the same evaluation, for different purposes, and neither
      // definition bleeds into the other.
      const evaluation = evaluate(
        config,
        context({
          side: "SELL",
          grossTokenAmount: 1_000n,
          grossQuoteAmount: 500n * ONE_ETH,
          cumulativeQuoteVolume: 100n * ONE_ETH,
        }),
      );

      expect(evaluation.stageIndex).toBe(1);
      expect(evaluation.feeCurrency).toBe("TOKEN");
      // Stage rate 1%, no tier matched at 1000 tokens, fee is 1% of the token leg.
      expect(evaluation.effectiveFeePpm).toBe(10_000);
      expect(evaluation.feeAmount).toBe(10n);
    });
  });

  describe("the volume ladder", () => {
    const config = configOf({
      ...flat("1"),
      ladder: {
        axis: "QUOTE_VOLUME",
        stages: [{ afterQuoteAmount: (100n * ONE_ETH).toString(), rate: { buy: "2", sell: "2" } }],
      },
    });

    it("charges the base rate below the threshold", () => {
      expect(
        evaluate(config, context({ side: "BUY", cumulativeQuoteVolume: 99n * ONE_ETH })).effectiveFeePpm,
      ).toBe(10_000);
    });

    it("advances exactly on the boundary unit", () => {
      expect(
        evaluate(config, context({ side: "BUY", cumulativeQuoteVolume: 100n * ONE_ETH })).effectiveFeePpm,
      ).toBe(20_000);
      expect(
        evaluate(config, context({ side: "BUY", cumulativeQuoteVolume: 100n * ONE_ETH - 1n })).effectiveFeePpm,
      ).toBe(10_000);
    });

    it("does not let a trade advance its own stage", () => {
      // Counting the trade itself would make its own fee depend on its own size, and
      // would charge a rate no prior trade could have predicted.
      const justUnder = evaluate(
        config,
        context({ side: "BUY", cumulativeQuoteVolume: 99n * ONE_ETH, grossQuoteAmount: 50n * ONE_ETH }),
      );
      expect(justUnder.effectiveFeePpm).toBe(10_000);
    });
  });

  describe("ceilings", () => {
    const config = configOf({
      ...flat("1"),
      protections: [
        { kind: "MAX_TRADE_SIZE", side: "SELL", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2" } },
      ],
    });
    const limit = REFERENCE_SUPPLY / 50n;

    it("permits a trade exactly at the ceiling", () => {
      expect(evaluate(config, context({ side: "SELL", grossTokenAmount: limit })).blocked).toBeNull();
    });

    it("refuses one base unit above it", () => {
      const evaluation = evaluate(config, context({ side: "SELL", grossTokenAmount: limit + 1n }));
      expect(evaluation.blocked?.reason).toBe("MAX_TRADE_SIZE");
      expect(evaluation.blocked?.limitTokens).toBe(limit);
    });

    it("leaves the unprotected side alone", () => {
      expect(evaluate(config, context({ side: "BUY", grossTokenAmount: REFERENCE_SUPPLY })).blocked).toBeNull();
    });

    it("still reports what a refused trade would have cost", () => {
      // So the review screen can show a creator both facts about a trade at the ceiling.
      const evaluation = evaluate(config, context({ side: "SELL", grossTokenAmount: limit + 1n }));
      expect(evaluation.effectiveFeePpm).toBe(10_000);
    });
  });

  describe("distribute", () => {
    it("splits a fee in the stated shares", () => {
      const config = configOf(exactFlow());
      const payouts = distribute(config, 1_000n);

      expect(payouts.map((payout) => payout.amount)).toEqual([800n, 200n]);
    });

    /*
     * The property that matters: the sum of the payouts equals the fee, exactly, always.
     * Every share rounds down and the remainder goes to the first recipient in canonical
     * order. Rounding each share to nearest can pay out more than was collected, which is
     * the one arithmetic mistake a splitter must be unable to make.
     */
    it("conserves the fee exactly, at every amount", () => {
      const config = configOf({
        ...flat("1"),
        distribution: [
          { recipient: { kind: "CREATOR" }, share: "33.3333" },
          { recipient: { kind: "TREASURY" }, share: "33.3333" },
          { recipient: { kind: "ADDRESS", address: "0x3333333333333333333333333333333333333333" }, share: "33.3334" },
        ],
      });

      for (let fee = 0n; fee < 500n; fee++) {
        const payouts = distribute(config, fee);
        const total = payouts.reduce((sum, payout) => sum + payout.amount, 0n);
        expect(total).toBe(fee);
      }
    });

    it("gives the rounding remainder to the first recipient in canonical order", () => {
      const config = configOf({
        ...flat("1"),
        distribution: [
          { recipient: { kind: "CREATOR" }, share: "50" },
          { recipient: { kind: "TREASURY" }, share: "50" },
        ],
      });

      // 1 wei cannot be halved. Canonical order puts CREATOR first.
      const payouts = distribute(config, 1n);
      expect(payouts[0]?.recipient.kind).toBe("CREATOR");
      expect(payouts[0]?.amount).toBe(1n);
      expect(payouts[1]?.amount).toBe(0n);
    });

    it("pays nothing out of nothing", () => {
      const config = configOf(exactFlow());
      expect(distribute(config, 0n).every((payout) => payout.amount === 0n)).toBe(true);
    });
  });

  describe("invariants", () => {
    const specs: readonly AgenMarketSpec[] = [
      flat("0"),
      flat("2"),
      exactFlow(),
      { ...flat("1"), baseRate: { buy: "0", sell: "3" } },
      { ...flat("1"), sizeTiers: [sellTier("1", "3"), sellTier("2", "5")] },
      {
        ...flat("1"),
        ladder: { axis: "TIME", stages: [{ afterSeconds: 3_600, rate: { buy: "2", sell: "4" } }] },
      },
      {
        ...flat("1"),
        ladder: {
          axis: "QUOTE_VOLUME",
          stages: [{ afterQuoteAmount: (100n * ONE_ETH).toString(), rate: { buy: "2", sell: "2" } }],
        },
      },
    ];

    it("never charges more than the configuration's own maximum", () => {
      for (const spec of specs) {
        const config = configOf(spec);
        const bound = maximumFeePpm(config);

        for (const side of ["BUY", "SELL"] as const) {
          for (const grossTokenAmount of [0n, 1n, ONE_PERCENT_OF_SUPPLY, REFERENCE_SUPPLY]) {
            for (const elapsed of [0n, 3_600n, 10n ** 9n]) {
              const evaluation = evaluate(
                config,
                context({ side, grossTokenAmount, elapsedSeconds: elapsed, cumulativeQuoteVolume: elapsed }),
              );
              expect(evaluation.effectiveFeePpm).toBeLessThanOrEqual(bound);
              expect(evaluation.effectiveFeePpm).toBeLessThanOrEqual(MAX_FEE_PPM);
            }
          }
        }
      }
    });

    it("never charges a fee larger than the leg it comes out of", () => {
      // Which leg that is depends on the configuration rather than the swap: a market with
      // size tiers collects in the launched token so the tier and the fee read the same
      // leg. See orientation.ts.
      for (const spec of specs) {
        const config = configOf(spec);
        for (const amount of [0n, 1n, 7n, ONE_ETH, 10n ** 27n]) {
          for (const side of ["BUY", "SELL"] as const) {
            const evaluation = evaluate(
              config,
              context({ side, grossQuoteAmount: amount, grossTokenAmount: amount }),
            );
            expect(evaluation.feeAmount).toBeLessThanOrEqual(amount);
          }
        }
      }
    });

    it("takes the fee from the token leg exactly when the market has tiers", () => {
      for (const spec of specs) {
        const config = configOf(spec);
        const hasTiers = config.buyTiers.length > 0 || config.sellTiers.length > 0;
        expect(config.feeCurrency).toBe(hasTiers ? "TOKEN" : "QUOTE");
      }
    });

    it("always distributes exactly one whole", () => {
      for (const spec of specs) {
        expect(distributionIsWhole(configOf(spec))).toBe(true);
      }
    });

    it("never selects a stage or tier that does not exist", () => {
      for (const spec of specs) {
        const config = configOf(spec);
        for (const side of ["BUY", "SELL"] as const) {
          const tiers = side === "BUY" ? config.buyTiers : config.sellTiers;
          const evaluation = evaluate(config, context({ side, grossTokenAmount: REFERENCE_SUPPLY }));

          expect(evaluation.stageIndex).toBeGreaterThanOrEqual(0);
          expect(evaluation.stageIndex).toBeLessThan(config.stages.length);
          if (evaluation.tierIndex !== null) {
            expect(evaluation.tierIndex).toBeLessThan(tiers.length);
          }
        }
      }
    });

    it("is total: no context makes it throw", () => {
      const config = configOf(exactFlow());
      const extremes = [0n, 1n, 2n ** 128n];

      for (const side of ["BUY", "SELL"] as const) {
        for (const grossTokenAmount of extremes) {
          for (const grossQuoteAmount of extremes) {
            expect(() =>
              evaluate(config, context({ side, grossTokenAmount, grossQuoteAmount })),
            ).not.toThrow();
          }
        }
      }
    });
  });

  it("reports a distribution totalling one whole as whole, and an empty one only at zero fees", () => {
    expect(distributionIsWhole(configOf(flat("2")))).toBe(true);
    expect(distributionIsWhole(configOf({ ...flat("0"), distribution: [] }))).toBe(true);
  });

  it("sums a canonical distribution to exactly PPM_ONE", () => {
    const config = configOf(exactFlow());
    expect(config.distribution.reduce((sum, share) => sum + share.sharePpm, 0)).toBe(PPM_ONE);
  });
});
