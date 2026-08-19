/**
 * Whether two readings of one prompt describe the same market.
 *
 * The tests come in pairs, and the pairing is the point. For every "these are the same market
 * however differently they are worded" there is a "and these are not, however similar they look",
 * because a comparison that only ever says "equivalent" would have reported the interpretation
 * stage as stable while a 0.5% fee turned into 0.3%.
 */

import { describe, expect, it } from "vitest";

import { behaviour, claimDifferences, divergences, equivalent, meaningOf } from "./semantics.js";
import type { MarketSpecification } from "./spec.js";

function market(rules: unknown[], extra: Partial<MarketSpecification> = {}): MarketSpecification {
  return {
    version: 1,
    name: "Market",
    symbol: "MKT",
    summary: "",
    baseFeePpm: 3_000,
    maxFeePpm: 8_000,
    phases: [],
    state: [],
    rules,
    invariants: [],
    externalDependencies: [],
    assumptions: [],
    ambiguities: [],
    suggestions: [],
    unsupported: [],
    ...extra,
  } as unknown as MarketSpecification;
}

const sellFee = (id: string, kind: string, parameters: Record<string, unknown>, description = ""): unknown => ({
  id,
  title: id.toUpperCase(),
  when: { kind: "sell", description },
  conditions: [],
  then: [{ kind, description: "credit it to the fee receiver's vault", parameters, writes: [] }],
});

describe("wording that changes nothing", () => {
  it("is the same market under different rule and effect names", () => {
    const left = market([sellFee("sell-fee", "chargeInputFee", { feePpm: 5_000 })]);
    const right = market([sellFee("launch-token-sell-tax", "applySellTax", { sellFeePpm: 5_000 })]);

    expect(equivalent(left, right)).toBe(true);
  });

  it("is the same market when one run says basis points and the other ppm", () => {
    const left = market([sellFee("f", "chargeFee", { feeBps: 50 })]);
    const right = market([sellFee("f", "chargeFee", { feePpm: 5_000 })]);

    expect(equivalent(left, right)).toBe(true);
  });

  /**
   * SPEC's two runs: one fired on `sell`, the other on `swap` with "the launch token is the input
   * token". One market, two vocabularies, and a comparison that called them different would have
   * pointed the investigation at interpretation instead of at test generation.
   */
  it("is the same market when a sell is described as a swap whose input is the launch token", () => {
    const left = market([sellFee("f", "chargeFee", { feePpm: 5_000 })]);
    const right = market([
      {
        id: "f",
        title: "F",
        when: { kind: "swap", description: "A swap uses the launch token as its input token" },
        conditions: [],
        then: [
          {
            kind: "chargeFee",
            description: "credit it to the fee receiver's vault",
            parameters: { feePpm: 5_000 },
            writes: [],
          },
        ],
      },
    ]);

    expect(equivalent(left, right)).toBe(true);
  });

  /**
   * EMBR: one run wrote a sell rule at 3% and a buy rule at 1%, the next wrote one rule on any
   * trade carrying both rates. Two structures, one market — a buyer pays 1% and a seller 3% either
   * way — and the first version of this comparison called them divergent, which pointed the
   * investigation at interpretation when the instability was in test generation.
   */
  it("is the same market whether the two sides are one rule or two", () => {
    const separate = market([
      {
        id: "sell-fee",
        title: "SELL",
        when: { kind: "sell", description: "" },
        conditions: [],
        then: [{ kind: "chargeFee", description: "to the creator", parameters: { feePpm: 30_000 }, writes: [] }],
      },
      {
        id: "buy-fee",
        title: "BUY",
        when: { kind: "buy", description: "" },
        conditions: [],
        then: [{ kind: "chargeFee", description: "to the creator", parameters: { feePpm: 10_000 }, writes: [] }],
      },
    ]);

    const combined = market([
      {
        id: "trade-fee",
        title: "TRADE",
        when: { kind: "trade", description: "any swap" },
        conditions: [],
        then: [
          {
            kind: "chargeFee",
            description: "to the creator",
            parameters: { sellFeePpm: 30_000, buyFeePpm: 10_000 },
            writes: [],
          },
        ],
      },
    ]);

    expect(equivalent(separate, combined)).toBe(true);
  });

  /** But not when the sides are the same rule at a rate one of them was not asked to pay. */
  it("is a different market when the combined rule charges both sides the same", () => {
    const combined = (parameters: Record<string, number>): MarketSpecification =>
      market([
        {
          id: "trade-fee",
          title: "TRADE",
          when: { kind: "trade", description: "any swap" },
          conditions: [],
          then: [{ kind: "chargeFee", description: "to the creator", parameters, writes: [] }],
        },
      ]);

    expect(
      equivalent(combined({ sellFeePpm: 30_000, buyFeePpm: 10_000 }), combined({ feePpm: 30_000 })),
    ).toBe(false);
  });

  it("is the same market when one run states the rate twice and the other once", () => {
    const left = market([sellFee("f", "chargeFee", { feePpm: 5_000, maximumFeePpm: 5_000 })]);
    const right = market([sellFee("f", "chargeFee", { feePpm: 5_000 })]);

    expect(equivalent(left, right)).toBe(true);
  });

  it("is the same market when only one run wrote its events down", () => {
    const withEvent = market([
      {
        id: "f",
        title: "F",
        when: { kind: "sell", description: "" },
        conditions: [],
        then: [
          { kind: "chargeFee", description: "to the vault", parameters: { feePpm: 5_000 }, writes: [] },
          { kind: "emitEvent", description: "FeeTaken", parameters: {}, writes: [] },
        ],
      },
    ]);

    expect(equivalent(withEvent, market([sellFee("f", "chargeFee", { feePpm: 5_000 })]))).toBe(true);
  });

  it("is the same market when state is named differently", () => {
    const counter = (name: string): unknown => ({
      id: "count-buys",
      title: "COUNT",
      when: { kind: "buy", description: "" },
      conditions: [],
      then: [{ kind: "incrementCounter", description: "count it", parameters: {}, writes: [name] }],
    });

    expect(equivalent(market([counter("buyStreak")]), market([counter("consecutiveBuys")]))).toBe(true);
  });

  it("is the same market when invariants are stated in different words", () => {
    const left = market([], {
      invariants: [{ id: "a", statement: "The fee can never exceed 0.5%.", expression: "" }],
    } as Partial<MarketSpecification>);
    const right = market([], {
      invariants: [{ id: "ceiling", statement: "No swap is charged more than 5000 ppm.", expression: "" }],
    } as Partial<MarketSpecification>);

    expect(equivalent(left, right)).toBe(true);
  });
});

describe("differences that are the market", () => {
  it("is a different market when the fee moves", () => {
    const left = market([sellFee("f", "chargeFee", { feePpm: 5_000 })]);
    const right = market([sellFee("f", "chargeFee", { feePpm: 3_000 })]);

    expect(equivalent(left, right)).toBe(false);
    expect(divergences(behaviour(left), behaviour(right))[0]?.what).toBe("what a trade does");
  });

  /** TIDE: 0.3% locked as 0.003%, which is the same rule and a hundredth of the market. */
  it("is a different market when a rate is off by a factor of a hundred", () => {
    const left = market([sellFee("f", "chargeFee", { feePercent: 0.3 })]);
    const right = market([sellFee("f", "chargeFee", { feePercent: 0.003 })]);

    expect(equivalent(left, right)).toBe(false);
  });

  it("is a different market when the ceiling moves", () => {
    const rules = [sellFee("f", "chargeFee", { feePpm: 5_000 })];

    expect(
      divergences(behaviour(market(rules)), behaviour(market(rules, { maxFeePpm: 33_000 }))).map(
        (entry) => entry.what,
      ),
    ).toEqual(["fee ceiling"]);
  });

  it("is a different market when the fee goes somewhere else", () => {
    const left = market([sellFee("f", "chargeFee", { feePpm: 5_000 })]);
    const right = market([
      {
        id: "f",
        title: "F",
        when: { kind: "sell", description: "" },
        conditions: [],
        then: [
          {
            kind: "chargeFee",
            description: "send it straight to the creator's wallet",
            parameters: { feePpm: 5_000 },
            writes: [],
          },
        ],
      },
    ]);

    expect(equivalent(left, right)).toBe(false);
  });

  it("is a different market when a threshold moves", () => {
    const waiver = (buys: number): unknown => ({
      id: "waive",
      title: "WAIVE",
      when: { kind: "sell", description: "" },
      conditions: [{ kind: "buyStreak", description: "after consecutive buys", parameters: { buys } }],
      then: [{ kind: "waiveFee", description: "no fee", parameters: {}, writes: [] }],
    });

    expect(equivalent(market([waiver(10)]), market([waiver(5)]))).toBe(false);
  });

  it("is a different market when a rule appears in one reading and not the other", () => {
    const left = market([sellFee("f", "chargeFee", { feePpm: 5_000 })]);
    const right = market([
      sellFee("f", "chargeFee", { feePpm: 5_000 }),
      {
        id: "buy-fee",
        title: "BUY FEE",
        when: { kind: "buy", description: "" },
        conditions: [],
        then: [{ kind: "chargeFee", description: "to the vault", parameters: { feePpm: 1_000 }, writes: [] }],
      },
    ]);

    expect(divergences(behaviour(left), behaviour(right))[0]?.detail).toContain("only in the second");
  });

  /**
   * An invariant fewer is a market held to less, and it is reported — but as a weaker build of the
   * same market rather than a different one. The market a trader meets is the same; what changed is
   * how much the suite has to prove about it, which is worth seeing on its own terms.
   */
  it("reports a dropped invariant as a difference in what is promised, not in the market", () => {
    const kept = { id: "a", statement: "The fee never exceeds 0.5%.", expression: "" };
    const dropped = { id: "b", statement: "Accrued fees never decrease.", expression: "" };

    const both = market([], { invariants: [kept, dropped] } as Partial<MarketSpecification>);
    const one = market([], { invariants: [kept] } as Partial<MarketSpecification>);

    expect(equivalent(both, one)).toBe(true);
    expect(claimDifferences(behaviour(both), behaviour(one))[0]?.detail).toContain("2 vs 1");
  });
});

describe("what an invariant claims", () => {
  it("reads the same claim out of three different sentences", () => {
    const claims = [
      "The fee can never exceed 0.5%.",
      "fee <= 5000 ppm at all times",
      "No swap is ever charged more than 50 bps.",
    ].map((statement) => meaningOf(statement));

    expect(new Set(claims).size).toBe(1);
  });

  it("tells a ceiling apart from a floor", () => {
    expect(meaningOf("the fee never exceeds 3%")).not.toBe(meaningOf("accrued fees never decrease"));
  });

  /**
   * Numbers in a statement are not the claim. A statement mentions every rate in the market —
   * "0.5% and never above the 0.8% ceiling on a 0.3% pool" — and which of them a run happened to
   * write down was reported as a difference in the invariant. The rate is compared where it is
   * authoritative, in the rule that charges it, and this test says so rather than leaving the
   * omission looking like an oversight.
   */
  it("does not turn the rates a statement mentions into part of the claim", () => {
    expect(meaningOf("the fee never exceeds the 0.8% ceiling")).toBe(
      meaningOf("the fee never exceeds the ceiling"),
    );
  });

  it("leaves the rate itself to the rule that charges it", () => {
    const at = (ppm: number): MarketSpecification =>
      market([sellFee("f", "chargeFee", { feePpm: ppm })], {
        invariants: [{ id: "a", statement: "the fee never exceeds the ceiling", expression: "" }],
      } as Partial<MarketSpecification>);

    expect(equivalent(at(5_000), at(3_000))).toBe(false);
  });
});
