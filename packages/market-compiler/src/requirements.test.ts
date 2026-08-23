/**
 * A rate the creator wrote down, and whether the market still contains it.
 *
 * SPEC is the reason this file exists. Its prompt states 0.5% in words, again in ppm, and a third
 * time as a ceiling; the specification locked it correctly; and it reached the launch button twice
 * with that rate asserted by nothing, because the reader that writes the fee assertions could not
 * see the shape the effect used. Both markets were correct — because the model behaved, not
 * because anything held it to the request.
 *
 * The tests below are in two halves, and the second half matters more. One half proves a lost rate
 * is caught. The other proves the things that merely look like rates are left alone, because a
 * build refused over a number misread out of a sentence is a worse failure than the one this
 * prevents, and it would show up as nothing but a lower score.
 */

import { describe, expect, it } from "vitest";

import {
  applyStatedEconomics,
  applyStatedThresholds,
  keepAdaptation,
  lockedRates,
  lockedThresholds,
  statedFreeSides,
  statedRates,
  statedThresholds,
  unmetRates,
  unmetSides,
  unmetThresholds,
} from "./requirements.js";
import { feeSchedule, thresholdIn } from "./threshold.js";
import type { MarketSpecification } from "./spec.js";

function specification(
  rules: MarketSpecification["rules"],
  fees?: { readonly baseFeePpm?: number; readonly maxFeePpm?: number },
): MarketSpecification {
  return {
    version: 1,
    name: "Precise",
    symbol: "SPEC",
    summary: "a market",
    baseFeePpm: fees?.baseFeePpm ?? 3_000,
    maxFeePpm: fees?.maxFeePpm ?? 8_000,
    phases: [],
    state: [],
    rules,
    invariants: [],
    assumptions: [],
    ambiguities: [],
    suggestions: [],
    unsupported: [],
  } as unknown as MarketSpecification;
}

const sellFee = (parameters: Record<string, unknown>): MarketSpecification["rules"] =>
  [
    {
      id: "sell-fee",
      title: "SELL FEE",
      when: { kind: "sell", description: "a sell" },
      conditions: [],
      then: [{ kind: "chargeInputFee", description: "take a fee", parameters, writes: [] }],
    },
  ] as unknown as MarketSpecification["rules"];

describe("a rate the creator wrote down", () => {
  it("is read from percent, ppm and basis points alike", () => {
    expect(statedRates("sells pay a 0.5% fee").map((rate) => rate.ppm)).toEqual([5_000]);
    expect(statedRates("the hook takes a fee of 5000 ppm").map((rate) => rate.ppm)).toEqual([5_000]);
    expect(statedRates("charge 50 basis points on sells").map((rate) => rate.ppm)).toEqual([5_000]);
    expect(statedRates("a fee of 2 percent on every sell").map((rate) => rate.ppm)).toEqual([20_000]);
  });

  /**
   * Never from the size of the number. A bare `50` is fifty ppm or half a percent depending
   * entirely on the word after it, and guessing between them is the difference between a market
   * that charges nothing and one that charges a hundred times too much.
   */
  it("reads the unit from the words, and says nothing without one", () => {
    expect(statedRates("charge a fee of 50 on sells")).toEqual([]);
    expect(statedRates("sells pay a fee")).toEqual([]);
  });

  /**
   * STORY, verbatim, which slipped through this check and launched charging nothing.
   *
   * Its rate is "half a percent" — no digit anywhere — so every numeric pattern found nothing,
   * `unmetRates` had nothing to compare, and the guard that exists to stop exactly this passed
   * without an opinion. A rate this function cannot see is not a rate it approved; it is a rate
   * nobody checked, and the market was immutable by the time that mattered.
   */
  it("is read when it is spelled out, because people describing a market do not write digits", () => {
    const story =
      "But if you're selling, you pay a small fee, half a percent, nothing crazy, and that " +
      "goes to the fee receiver so it's actually funding the project rather than disappearing.";

    expect(statedRates(story).map((rate) => rate.ppm)).toEqual([5_000]);
  });

  it("reads the forms a fraction is actually written in", () => {
    const ppm = (prompt: string): readonly number[] => statedRates(prompt).map((rate) => rate.ppm);

    expect(ppm("sells pay a fee of half of a percent")).toEqual([5_000]);
    expect(ppm("sells pay a half percent fee")).toEqual([5_000]);
    expect(ppm("the sell fee is three quarters of a percent")).toEqual([7_500]);
    expect(ppm("a quarter of a percent fee on sells")).toEqual([2_500]);
    expect(ppm("charge a one percent fee on sells")).toEqual([10_000]);
    expect(ppm("sell fee of one and a half percent")).toEqual([15_000]);
  });

  /** The filler belongs to the unit: "half a percent" is a half, not a whole. */
  it("does not read the article in front of the unit as the quantity", () => {
    expect(statedRates("sells pay a fee, half a percent").map((rate) => rate.ppm)).toEqual([5_000]);
  });

  /** A worded number is held to the same rules as a numeral: this one is a supply share. */
  it("still refuses a worded number that is not a fee on a trade", () => {
    expect(statedRates("burn half a percent of supply on every taxed sell")).toEqual([]);
  });

  it("says the same thing once when a prompt says it three ways", () => {
    const prompt =
      "the hook takes a fee of 0.5% (5000 ppm) of the input amount. " +
      "The fee is a constant of the market and cannot exceed 0.5%.";

    expect(statedRates(prompt).map((rate) => rate.ppm)).toEqual([5_000]);
  });
});

describe("numbers that only look like a rate", () => {
  /**
   * KING: "20% of all trading fees go into a reward pool". Read as a fee, that is a market taking
   * a fifth of every trade — a market nobody asked for, and the build refused for not being it.
   */
  it("leaves a share of a fee alone", () => {
    expect(statedRates("20% of all trading fees go into a reward pool")).toEqual([]);
    expect(statedRates("80% of the fee goes to the creator, the rest to the vault")).toEqual([]);
  });

  /**
   * CNPY: "If somebody sells more than 1% of current liquidity, charge an additional 2%". The 1%
   * is a threshold sitting one clause from the word "charge"; only the 2% is a fee.
   */
  it("leaves a threshold alone and keeps the fee beside it", () => {
    const prompt = "If somebody sells more than 1% of current liquidity, charge an additional 2%";

    expect(statedRates(prompt).map((rate) => rate.ppm)).toEqual([20_000]);
  });

  it("leaves supply, holders and slippage alone", () => {
    expect(statedRates("burn 1% of supply on every taxed sell")).toEqual([]);
    expect(statedRates("the top 5% of holders share the fee pool")).toEqual([]);
    expect(statedRates("allow up to 3% slippage on the taxed swap")).toEqual([]);
  });

  it("does not turn a restated boundary or an 80/20 distribution into trade fees", () => {
    const prompt =
      "Charge 0.5% on every buy and every sell. When a sell is at least 1% of the " +
      "token’s immutable total supply, charge 4% instead. A sell of exactly 1% must pay " +
      "4%, not 0.5%. Send 80% of every collected fee to the creator and 20% to the fee vault.";

    expect(statedRates(prompt).map((rate) => rate.ppm)).toEqual([5_000, 40_000]);
    expect(statedThresholds(prompt).map((threshold) => threshold.percent)).toEqual([1]);
  });

  it("does not read routing shares out of a fee effect as rates charged to traders", () => {
    const routed = specification([
      {
        id: "route",
        title: "ROUTE FEE",
        when: { kind: "swap", description: "a trade" },
        conditions: [],
        then: [
          {
            kind: "routeFee",
            description: "80% to creator, 20% to vault",
            parameters: { creatorSharePercent: 80, vaultSharePercent: 20 },
            writes: [],
          },
        ],
      },
    ] as unknown as MarketSpecification["rules"], { baseFeePpm: 5_000, maxFeePpm: 40_000 });

    expect([...lockedRates(routed)].sort((left, right) => left - right)).toEqual([5_000, 40_000]);
  });

  it("says nothing about a percentage with no fee anywhere near it", () => {
    expect(statedRates("unlock 10% of the treasury each month")).toEqual([]);
  });
});

describe("whether the locked market still contains what was asked", () => {
  const PROMPT = "on every sell the hook takes a fee of 0.5% (5000 ppm) of the input amount";

  it("is satisfied by the rate under any parameter name or unit", () => {
    for (const parameters of [
      { feePpm: 5_000 },
      { sellFeeBps: 50 },
      { feePercent: 0.5 },
      // The shape that started this: the neutral rate beside the other side's zero.
      { feePpm: 5_000, buyFeePpm: 0 },
    ]) {
      expect(unmetRates(PROMPT, specification(sellFee(parameters)))).toEqual([]);
    }
  });

  /**
   * TIDE, and the reason presence is checked rather than trusted: its prompt says buys pay 0.3%
   * and the locked effect said `buyFeeDuringFlood_percent: 0.003` — 0.003%, a hundredfold error.
   * A market charging a three-hundredth of what was asked, with nothing to say so.
   */
  it("catches a rate that survived interpretation with its unit mangled", () => {
    const locked = specification(sellFee({ feePercent: 0.005 }));

    expect(unmetRates(PROMPT, locked).map((rate) => rate.ppm)).toEqual([5_000]);
  });

  it("catches a rate that disappeared entirely", () => {
    const locked = specification(
      [
        {
          id: "sell-fee",
          title: "SELL FEE",
          when: { kind: "sell", description: "a sell" },
          conditions: [],
          then: [{ kind: "chargeInputFee", description: "take a fee", parameters: {}, writes: [] }],
        },
      ] as unknown as MarketSpecification["rules"],
      { baseFeePpm: 3_000, maxFeePpm: 8_000 },
    );

    expect(unmetRates(PROMPT, locked).map((rate) => rate.ppm)).toEqual([5_000]);
  });

  /**
   * A qualified rate is still the rate. "0.5% on sells, waived after three buys" is one market
   * with one rate and two rules, and a check that demanded an unconditional reading would refuse
   * it for being exactly what it says.
   */
  it("is satisfied by a rate that a later rule qualifies", () => {
    const rules = [
      ...sellFee({ feePpm: 5_000 }),
      {
        id: "waiver",
        title: "WAIVE AFTER THREE BUYS",
        when: { kind: "sell", description: "a sell after three buys" },
        conditions: [{ kind: "streak", description: "three buys", parameters: { buys: 3 } }],
        then: [{ kind: "chargeInputFee", description: "no fee", parameters: { feePpm: 0 }, writes: [] }],
      },
    ] as unknown as MarketSpecification["rules"];

    expect(unmetRates("sells pay a 0.5% fee, waived after three buys", specification(rules))).toEqual([]);
  });

  it("reads the market's own declared ceilings as rates it contains", () => {
    expect(lockedRates(specification([], { baseFeePpm: 3_000, maxFeePpm: 8_000 }))).toEqual(
      new Set([3_000, 8_000]),
    );
  });

  it("has nothing to say about a prompt that states no rate", () => {
    expect(unmetRates("make trading feel like a slot machine", specification([]))).toEqual([]);
  });
});

/**
 * The other half, and the half that had no guard at all.
 *
 * `statedRates` is careful to leave "2% of the total supply" alone, because reading a threshold
 * as a fee refuses markets for charging something nobody asked for. What went unexamined for a
 * long time is what happened to the number afterwards: nothing. Excluded here and covered
 * nowhere else, a threshold was the one figure in a prompt that nothing compared against the
 * market that got built.
 */
const PUSH_PROMPT =
  "Charge 2% on every buy and every sell. On any sell larger than 2% of the token's " +
  "immutable total supply, charge 5% instead.";

/** A sell rule gated on a share of something, as interpretation records one. */
const gatedSell = (parameters: Record<string, unknown>): MarketSpecification["rules"] =>
  [
    {
      id: "large-sell",
      title: "LARGE SELL",
      when: { kind: "sell", description: "a sell" },
      conditions: [{ kind: "tradeSizeVsSupply", description: "a large sell", parameters }],
      then: [{ kind: "setFee", description: "charge 5%", parameters: { feePpm: 50_000 }, writes: [] }],
    },
  ] as unknown as MarketSpecification["rules"];

describe("a threshold the creator wrote down", () => {
  it("is read as a percentage of something, with the comparison they used", () => {
    const [threshold, ...rest] = statedThresholds(PUSH_PROMPT);

    expect(rest).toEqual([]);
    expect(threshold!.percent).toBe(2);
    expect(threshold!.basis).toBe("supply");
    expect(threshold!.inclusive).toBe(false);
  });

  /**
   * CNPY, from the rate suite's own comment, read from the other side: its 1% is the threshold
   * and its 2% is the fee, and neither may be mistaken for the other.
   */
  it("takes the threshold and leaves the fee beside it", () => {
    const prompt = "If somebody sells more than 1% of current liquidity, charge an additional 2%";
    const [threshold, ...rest] = statedThresholds(prompt);

    expect(rest).toEqual([]);
    expect(threshold!.percent).toBe(1);
    expect(threshold!.basis).toBe("liquidity");
  });

  it("says nothing about a percentage of something no trade is measured against", () => {
    expect(statedThresholds("80% of the fee goes to the creator")).toEqual([]);
    expect(statedThresholds("unlock 10% of the treasury each month")).toEqual([]);
    expect(statedThresholds("the top 5% of holders share the fee pool")).toEqual([]);
    expect(statedThresholds("sells pay a 0.5% fee")).toEqual([]);
  });

  it("is read when it is spelled out, for the same reason a rate is", () => {
    const [threshold] = statedThresholds("a sell over half a percent of the total supply pays 5%");

    expect(threshold!.percent).toBe(0.5);
    expect(threshold!.basis).toBe("supply");
  });
});

describe("whether the locked market still measures what was asked", () => {
  it("is satisfied by the threshold the creator stated, in any unit", () => {
    for (const parameters of [
      { operator: ">", percent: 2 },
      { operator: ">", thresholdPpm: 20_000 },
      { operator: ">", thresholdBps: 200 },
    ]) {
      expect(
        unmetThresholds(PUSH_PROMPT, specification(gatedSell({ ...parameters, basis: "totalSupply" }))),
      ).toEqual([]);
    }
  });

  /**
   * PUSH, and the whole reason this exists.
   *
   * The prompt names two percent. The interpretation came back with one, which is not a
   * judgement call about an ambiguous request — the request named the number — and every
   * artefact downstream then agreed with each other about a market nobody asked for. No
   * default, convention or rounder figure may take a stated threshold's place, so this is a
   * build that stops rather than one that launches.
   */
  it("refuses a stated threshold that came back as a smaller default", () => {
    const locked = specification(
      gatedSell({ operator: ">", percent: 1, basis: "totalSupply" }),
    );

    const [unmet, ...rest] = unmetThresholds(PUSH_PROMPT, locked);

    expect(rest).toEqual([]);
    expect(unmet!.fault).toBe("moved");
    expect(unmet!.stated.percent).toBe(2);
    expect(unmet!.locked?.percent).toBe(1);
  });

  /** The same substitution is caught whichever unit it is dressed in. */
  it("catches a default that arrived in ppm rather than percent", () => {
    const locked = specification(gatedSell({ operator: ">", thresholdPpm: 10_000, basis: "totalSupply" }));

    expect(unmetThresholds(PUSH_PROMPT, locked).map((entry) => entry.fault)).toEqual(["moved"]);
  });

  /** 2% of the pool is not 2% of the supply: the figure survived and the mechanic did not. */
  it("catches a threshold measured against the wrong thing", () => {
    const rules = [
      {
        id: "large-sell",
        title: "LARGE SELL",
        when: { kind: "sell", description: "a sell" },
        conditions: [
          {
            kind: "tradeSizeVsLiquidity",
            description: "a large sell",
            parameters: { operator: ">", percent: 2 },
          },
        ],
        then: [{ kind: "setFee", description: "5%", parameters: { feePpm: 50_000 }, writes: [] }],
      },
    ] as unknown as MarketSpecification["rules"];

    expect(unmetThresholds(PUSH_PROMPT, specification(rules)).map((entry) => entry.fault)).toEqual([
      "missing",
    ]);
  });

  /**
   * A basis recorded as a parameter is the basis, whatever the rule is called. Reading the
   * identifier instead would call this a supply threshold on the strength of its name.
   */
  it("believes a recorded basis over the name of the condition", () => {
    const locked = specification(
      gatedSell({ operator: ">", percent: 2, basis: "poolLiquidity" }),
    );

    expect(unmetThresholds(PUSH_PROMPT, locked).map((entry) => entry.fault)).toEqual(["missing"]);
  });

  it("catches a threshold that disappeared entirely", () => {
    expect(unmetThresholds(PUSH_PROMPT, specification(sellFee({ feePpm: 50_000 }))).map((e) => e.fault))
      .toEqual(["missing"]);
  });

  /**
   * "Over 2%" and "at least 2%" differ by exactly one trade, and it is the trade a creator
   * checks by hand. A market that includes a boundary the creator excluded charges the higher
   * fee on a sale that was meant to be ordinary.
   */
  it("refuses a boundary the creator did not ask to be included", () => {
    const locked = specification(gatedSell({ operator: ">=", percent: 2, basis: "totalSupply" }));

    const [unmet] = unmetThresholds(PUSH_PROMPT, locked);

    expect(unmet!.fault).toBe("boundary");
  });

  /** Silence is not disagreement: a specification that records no operator has not contradicted one. */
  it("says nothing when the market records no comparison at all", () => {
    const locked = specification(gatedSell({ percent: 2, basis: "totalSupply" }));

    expect(unmetThresholds(PUSH_PROMPT, locked)).toEqual([]);
  });

  /** A threshold in the trigger is still a threshold the market has. */
  it("finds a threshold interpretation filed under the trigger", () => {
    const rules = [
      {
        id: "large-sell",
        title: "LARGE SELL",
        when: {
          kind: "sell",
          description: "a sell over 2% of total supply",
          parameters: { operator: ">", percent: 2 },
        },
        conditions: [],
        then: [{ kind: "setFee", description: "5%", parameters: { feePpm: 50_000 }, writes: [] }],
      },
    ] as unknown as MarketSpecification["rules"];

    expect(unmetThresholds(PUSH_PROMPT, specification(rules))).toEqual([]);
    expect(lockedThresholds(specification(rules)).map((entry) => entry.percent)).toEqual([2]);
  });

  it("has nothing to say about a prompt that states no threshold", () => {
    expect(unmetThresholds("sells pay a 0.5% fee", specification(sellFee({ feePpm: 5_000 })))).toEqual(
      [],
    );
  });
});

/**
 * Putting the number back, so a dropped threshold becomes the market that was asked
 * for rather than a decision note about a missing X.
 */
describe("restoring a threshold the creator already named", () => {
  it("rewrites a substituted 1% lock back to the stated 2% of supply", () => {
    const locked = specification(gatedSell({ operator: ">", percent: 1, basis: "totalSupply" }));
    const restored = applyStatedThresholds(PUSH_PROMPT, locked);

    expect(unmetThresholds(PUSH_PROMPT, restored)).toEqual([]);
    expect(lockedThresholds(restored).map((entry) => entry.percent)).toEqual([2]);
    expect(thresholdIn(restored.rules[0]!.conditions[0]!)!.inclusive).toBe(false);
  });

  /**
   * THLD: the 5% rule arrived as "on every sell", with no size condition, and the
   * architecture stage called the 2% "missing threshold X". The prompt had named it.
   */
  it("attaches a dropped supply gate to the large-sell rule", () => {
    const dropped = specification([
      {
        id: "base-fee",
        title: "BASE FEE",
        when: { kind: "swap", description: "any trade" },
        conditions: [],
        then: [{ kind: "setFee", description: "charge 2%", parameters: { feePpm: 20_000 }, writes: [] }],
      },
      {
        id: "large-sell",
        title: "5% LARGE SELL FEE",
        when: { kind: "sell", description: "on every sell" },
        conditions: [],
        then: [{ kind: "setFee", description: "charge 5%", parameters: { feePpm: 50_000 }, writes: [] }],
      },
    ] as unknown as MarketSpecification["rules"]);

    const restored = applyStatedThresholds(PUSH_PROMPT, dropped);
    const sell = feeSchedule(restored, "sell")!;

    expect(unmetThresholds(PUSH_PROMPT, restored)).toEqual([]);
    expect(sell.basePpm).toBe(20_000);
    expect(sell.tier?.ppm).toBe(50_000);
    expect(sell.tier?.threshold.percent).toBe(2);
    expect(sell.tier?.threshold.basis).toBe("supply");
    expect(sell.tier?.threshold.inclusive).toBe(false);
  });

  it("does not invent a threshold a prompt never stated", () => {
    const flat = specification(sellFee({ feePpm: 5_000 }));
    expect(applyStatedThresholds("sells pay a 0.5% fee", flat)).toBe(flat);
  });

  it("leaves a missing threshold alone when no sell rule can carry it", () => {
    const buys = specification([
      {
        id: "buy-fee",
        title: "BUY FEE",
        when: { kind: "buy", description: "a buy" },
        conditions: [],
        then: [{ kind: "setFee", description: "charge 2%", parameters: { feePpm: 20_000 }, writes: [] }],
      },
    ] as unknown as MarketSpecification["rules"]);

    expect(applyStatedThresholds(PUSH_PROMPT, buys)).toBe(buys);
    expect(unmetThresholds(PUSH_PROMPT, buys).map((entry) => entry.fault)).toEqual(["missing"]);
  });

  it("does not hang a sell gate on a buy rule that happens to charge the same 5%", () => {
    const buys = specification([
      {
        id: "buy-fee",
        title: "BUY FEE",
        when: { kind: "buy", description: "a buy" },
        conditions: [],
        then: [{ kind: "setFee", description: "charge 2%", parameters: { feePpm: 20_000 }, writes: [] }],
      },
      {
        id: "buy-surcharge",
        title: "LARGE BUY",
        when: { kind: "buy", description: "a large buy" },
        conditions: [],
        then: [{ kind: "setFee", description: "charge 5%", parameters: { feePpm: 50_000 }, writes: [] }],
      },
    ] as unknown as MarketSpecification["rules"]);

    expect(applyStatedThresholds(PUSH_PROMPT, buys)).toBe(buys);
    expect(unmetThresholds(PUSH_PROMPT, buys).map((entry) => entry.fault)).toEqual(["missing"]);
  });

  it("drops a planning note that pretends a named threshold was never given", () => {
    expect(
      keepAdaptation(
        {
          requested: "implement the threshold",
          implemented: "require the missing threshold X as a compile-time constant",
          reason: "choosing either omitted value would invent market economics",
        },
        PUSH_PROMPT,
      ),
    ).toBe(false);

    expect(
      keepAdaptation(
        {
          requested: "pay every holder on every sell",
          implemented: "a claimable reward-per-share accumulator",
          reason: "a loop over holders cannot run on every swap",
        },
        PUSH_PROMPT,
      ),
    ).toBe(true);
  });

  it("drops a planning note that pretends a named 1% / 4% were never given", () => {
    const flor =
      "Charge 0.5% on every buy and every sell. On any sell of at least 1% of the " +
      "token's immutable total supply, charge 4% instead.";

    expect(
      keepAdaptation(
        {
          requested: "apply a larger sell fee when a sell exceeds the unspecified large-sell threshold.",
          implemented:
            "A sell is large when its actual FLOR input is strictly greater than 1% of immutableTotalSupply, and its fee is 40000ppm.",
          reason:
            "The specification defines neither the threshold nor the large-sell rate; 1% and the stated hard ceiling are explicit implementation choices.",
        },
        flor,
      ),
    ).toBe(false);

    expect(
      keepAdaptation(
        {
          requested: "apply the small-sell fee without specifying a separate rate.",
          implemented: "Small sells use the exact base rate of 5000ppm, as do buys.",
          reason: "No distinct small-sell rate was supplied, while the invariants require the base fee to be exactly 5000ppm.",
        },
        flor,
      ),
    ).toBe(false);
  });

  it("drops the live Floor notes that pretend 1% and 4% were Agen's idea", () => {
    const flor =
      "Charge 0.5% on every buy and every sell. On any sell of at least 1% of the " +
      "token's immutable total supply, charge 4% instead.";

    expect(
      keepAdaptation(
        {
          requested: "a large-sell fee without specifying a threshold",
          implemented:
            "A sell qualifies when its FLOR input amount is at least 1% of immutableTotalSupply.",
          reason:
            "You requested a large-sell fee without specifying a threshold. Agen decided on a " +
            "deterministic on-chain qualification predicate using supply-relative sizing (1%).",
        },
        flor,
      ),
    ).toBe(false);

    expect(
      keepAdaptation(
        {
          requested: "a large-sell fee with a maximum cap",
          implemented: "The qualifying-sell fee is exactly 40000 ppm; the ordinary fee remains exactly 5000 ppm.",
          reason:
            "You wanted a large-sell fee with a maximum cap of 40,000 ppm but didn't specify the exact rate.",
        },
        flor,
      ),
    ).toBe(false);
  });

  it("drops a planning note that pretends a named rate was left open", () => {
    expect(
      keepAdaptation(
        {
          requested: "A large-sell fee subject to the stated 40000 ppm ceiling, without a separate large-sell rate.",
          implemented: "Use 40000 ppm as the defined large-sell fee.",
          reason: "The large-sell rate was left open; selecting the stated ceiling creates an explicit second defined fee.",
        },
        "Charge 0.5% on every buy and every sell. On any sell of at least 1% of supply, charge 4% instead.",
      ),
    ).toBe(false);
  });

  /**
   * FLOR, second live run: 0.5% and 4% were in the prompt, and Agen still added its
   * 0.3% default as a pool LP fee and hung the sell gate on buys.
   */
  it("strips the invented 0.3% and keeps the 1% gate on sells only", () => {
    const flor =
      "Charge 0.5% on every buy and every sell. On any sell of at least 1% of the " +
      "token's immutable total supply, charge 4% instead.";

    const invented = specification(
      [
        {
          id: "default",
          title: "CHARGE 0.5% ON BUYS AND SUB-1% SELLS",
          when: { kind: "buyOrSell", description: "On every trade" },
          conditions: [
            {
              kind: "tradeSizeVsSupply",
              description: "more than 1% of the total supply",
              parameters: { operator: ">", percent: 1, basis: "totalSupply" },
            },
          ],
          then: [{ kind: "chargeFee", description: "0.5%", parameters: { feePercent: 0.5 }, writes: [] }],
        },
        {
          id: "large-sell",
          title: "CHARGE 4% ON LARGE SELLS",
          when: { kind: "sell", description: "On every sell" },
          conditions: [
            {
              kind: "tradeSizeVsSupply",
              description: "at least 1% of the total supply",
              parameters: { operator: ">=", percent: 1, basis: "totalSupply" },
            },
          ],
          then: [{ kind: "chargeFee", description: "4%", parameters: { feePercent: 4 }, writes: [] }],
        },
      ] as unknown as MarketSpecification["rules"],
      { baseFeePpm: 3_000, maxFeePpm: 40_000 },
    );

    const restored = applyStatedEconomics(flor, {
      ...invented,
      assumptions: [
        {
          id: "ordinary-fee",
          term: "ordinary trading fee",
          interpretation: "The pool uses Agen's default 3,000 ppm (0.3%) LP fee beneath the hook surcharge.",
          why: "The creator did not name a pool fee.",
          importance: "medium",
        },
      ],
    });

    const sell = feeSchedule(restored, "sell")!;
    const buy = feeSchedule(restored, "buy")!;

    expect(restored.baseFeePpm).toBe(5_000);
    expect(restored.assumptions).toEqual([]);
    expect(buy.basePpm).toBe(5_000);
    expect(buy.tier).toBe(null);
    expect(sell.basePpm).toBe(5_000);
    expect(sell.tier?.ppm).toBe(40_000);
    expect(sell.tier?.threshold.percent).toBe(1);
    expect(sell.tier?.threshold.inclusive).toBe(true);
  });
});

describe("a side the creator named", () => {
  it("reads 'buys pay nothing' as a free buy, not as silence", () => {
    expect(statedFreeSides("Sells pay half a percent. Buys pay nothing.")).toEqual(["buy"]);
    expect(statedFreeSides("no fee on buys, sells pay 1%")).toEqual(["buy"]);
    expect(statedFreeSides("Charge 0.5% on every buy and every sell.")).toEqual([]);
  });

  it("does not take 'nothing crazy' as a free side", () => {
    expect(
      statedFreeSides("if you're selling you pay a small fee, half a percent, nothing crazy"),
    ).toEqual([]);
  });

  it("restores a one-sided fee that interpretation charged on both sides", () => {
    const prompt = "Sells pay half a percent. Buys pay nothing.";
    const both = specification([
      {
        id: "fee",
        title: "FEE",
        when: { kind: "buyOrSell", description: "any trade" },
        conditions: [],
        then: [{ kind: "setFee", description: "0.5%", parameters: { feePpm: 5_000 }, writes: [] }],
      },
    ] as unknown as MarketSpecification["rules"]);

    const restored = applyStatedEconomics(prompt, both);

    expect(feeSchedule(restored, "buy")?.basePpm).toBe(0);
    expect(feeSchedule(restored, "sell")?.basePpm).toBe(5_000);
    expect(unmetSides(prompt, restored)).toEqual([]);
  });

  it("refuses a reading that still charges a side the creator freed", () => {
    const charged = specification(sellFee({ feePpm: 5_000 }), { baseFeePpm: 5_000, maxFeePpm: 5_000 });
    // A sell-only rule leaves buys at baseFeePpm, which is still a charge.
    expect(unmetSides("Sells pay 0.5%. Buys pay nothing.", charged)).toEqual(["buy"]);
  });

  it("treats 'instead' as a replacement, not a stack on the base", () => {
    const flor =
      "Charge 0.5% on every buy and every sell. On any sell of at least 1% of the " +
      "token's immutable total supply, charge 4% instead.";

    const stacked = specification(
      [
        {
          id: "base",
          title: "BASE",
          when: { kind: "swap", description: "any trade" },
          conditions: [],
          then: [{ kind: "setFee", description: "0.5%", parameters: { feePpm: 5_000 }, writes: [] }],
        },
        {
          id: "large",
          title: "LARGE",
          when: { kind: "sell", description: "a sell" },
          conditions: [
            {
              kind: "tradeSizeVsSupply",
              description: "at least 1% of supply",
              parameters: { operator: ">=", percent: 1, basis: "totalSupply" },
            },
          ],
          then: [{ kind: "extraFee", description: "4% more", parameters: { feePpm: 40_000 }, writes: [] }],
        },
      ] as unknown as MarketSpecification["rules"],
      { baseFeePpm: 5_000, maxFeePpm: 45_000 },
    );

    const sell = feeSchedule(applyStatedEconomics(flor, stacked), "sell")!;
    expect(sell.basePpm).toBe(5_000);
    expect(sell.tier?.ppm).toBe(40_000);
  });
});
