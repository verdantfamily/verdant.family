/**
 * That a market's one-line description is the market's own.
 *
 * `engineSummary` exists because a discovery card has room for a sentence and not a review, and
 * the tempting way to produce that sentence is for the interface to write it. That is how a
 * shelf ends up advertising economics nobody deployed. So the sentence is derived here, from
 * the same canonical configuration the commitment is taken over, and these tests hold it to
 * three properties:
 *
 *  - it states the rate a trade actually pays, and states asymmetric rates as two rates;
 *  - it never claims a mechanic the configuration does not contain;
 *  - it agrees with the review screen on the one number both of them show.
 *
 * The last is the one worth having. `maximumFee` appears on the review screen and on the card,
 * computed by two functions, and a market whose card says 4% and whose review says 5% is a
 * market somebody launches by mistake.
 */

import { describe, expect, it } from "vitest";

import { compile } from "./compile.js";
import { engineSummary, review } from "./review.js";
import type { AgenMarketSpec, MarketBinding } from "./spec.js";

const BINDING: MarketBinding = {
  launchedTokenSymbol: "EXCT",
  quoteAsset: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 },
  referenceSupply: 1_000_000_000n * 10n ** 18n,
};

function config(spec: Partial<AgenMarketSpec>) {
  const result = compile(
    {
      engineVersion: 1,
      baseRate: { buy: "1", sell: "1" },
      ladder: null,
      sizeTiers: [],
      distribution: [{ recipient: { kind: "CREATOR" }, share: "100" }],
      protections: [],
      ...spec,
    } as AgenMarketSpec,
    BINDING,
  );

  if (!result.ok) throw new Error(`the fixture did not compile: ${JSON.stringify(result.problems)}`);
  return result.config;
}

describe("a market in one line", () => {
  it("states one rate when both sides pay the same", () => {
    expect(engineSummary(config({})).headline).toBe("1% on every trade.");
  });

  it("states two rates when they differ, rather than averaging them", () => {
    const summary = engineSummary(config({ baseRate: { buy: "0.5", sell: "2" } }));

    expect(summary.headline).toContain("0.5% to buy");
    expect(summary.headline).toContain("2% to sell");
  });

  it("names the worst case when the market has size tiers", () => {
    const summary = engineSummary(
      config({
        baseRate: { buy: "0.5", sell: "0.5" },
        sizeTiers: [
          {
            side: "SELL",
            measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" },
            rate: "4",
          },
        ],
      }),
    );

    expect(summary.headline).toContain("rising to 4%");
    expect(summary.ruleCount).toBe(1);
  });

  it("says a ladder changes and does not pretend to say when", () => {
    const summary = engineSummary(
      config({
        ladder: {
          axis: "TIME",
          stages: [{ afterSeconds: 86_400, rate: { buy: "0.5", sell: "0.5" } }],
        },
      }),
    );

    expect(summary.headline).toContain("changing on a schedule");
    expect(summary.hasPhases).toBe(true);
  });

  it("distinguishes a volume ladder from a time one", () => {
    const summary = engineSummary(
      config({
        ladder: {
          axis: "QUOTE_VOLUME",
          stages: [
            { afterQuoteAmount: "1000000000000000000000", rate: { buy: "0.5", sell: "0.5" } },
          ],
        },
      }),
    );

    expect(summary.headline).toContain("volume");
    expect(summary.headline).not.toContain("schedule");
  });

  /*
   * The claim-nothing property. A market with a flat rate and no other mechanic must produce a
   * sentence with no second clause at all — not "with no other rules", which reads like a
   * feature, and certainly not a clause borrowed from a market that has one.
   */
  it("adds no clause to a market that is only a rate", () => {
    const summary = engineSummary(config({}));

    expect(summary.headline).toBe("1% on every trade.");
    expect(summary.ruleCount).toBe(0);
    expect(summary.hasPhases).toBe(false);
  });

  it("mentions a trade-size cap, since a trader can hit it", () => {
    const summary = engineSummary(
      config({
        protections: [
          {
            kind: "MAX_TRADE_SIZE",
            side: "BOTH",
            amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2" },
          },
        ],
      }),
    );

    expect(summary.headline).toContain("cap on trade size");
  });

  /*
   * The trade card quotes `openingBuyPpm` as a number before a swap is quoted. It must be the
   * opening rate — what an ordinary trade pays — and not the worst case, or every card on the
   * site would advertise a fee almost nobody is charged. Held against the review's own first
   * card, which is where a creator reads the same figure.
   */
  it("quotes the opening rate as a number, not the worst case", () => {
    const built = config({
      baseRate: { buy: "0.5", sell: "0.5" },
      sizeTiers: [
        {
          side: "SELL",
          measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" },
          rate: "4",
        },
      ],
    });

    const summary = engineSummary(built);

    expect(summary.openingBuyPpm).toBe(5_000);
    expect(summary.openingSellPpm).toBe(5_000);

    // The worst case is a different, larger number, and lives in a different field.
    expect(summary.maximumFee).toBe("4%");

    // And it is the same figure the review's first card states, in the same market.
    const opening = review(built).cards[0]!.rows[0]!.then;
    expect(opening).toBe("0.5%");
  });

  it("keeps the two sides apart when they differ", () => {
    const summary = engineSummary(config({ baseRate: { buy: "0.25", sell: "3" } }));

    expect(summary.openingBuyPpm).toBe(2_500);
    expect(summary.openingSellPpm).toBe(30_000);
  });

  /*
   * The two screens must not disagree. Both numbers come from `maximumFeePpm`, and this holds
   * them together across shapes so that a later change to one path cannot quietly split them.
   */
  it("shows the same worst case the review screen shows", () => {
    for (const spec of [
      {},
      { baseRate: { buy: "0.5", sell: "3" } },
      {
        sizeTiers: [
          {
            side: "SELL" as const,
            measure: {
              kind: "PERCENT_REFERENCE_SUPPLY" as const,
              percent: "1",
              operator: "GTE" as const,
            },
            rate: "9",
          },
        ],
      },
      {
        ladder: {
          axis: "TIME" as const,
          stages: [{ afterSeconds: 3_600, rate: { buy: "7", sell: "7" } }],
        },
      },
    ]) {
      const built = config(spec as Partial<AgenMarketSpec>);

      expect(engineSummary(built).maximumFee).toBe(review(built).maximumFee);
    }
  });
});
