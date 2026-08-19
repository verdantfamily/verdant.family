/**
 * What Agen is willing to assert about a market on its own authority.
 *
 * The interesting cases are all about restraint. A flat fee is worth asserting exactly; a
 * fee with a waiver, a threshold, a phase or a milestone behind it is not, and claiming one
 * anyway would produce a core test that fails on a market that is right — which is the exact
 * failure mode this module was written to remove.
 */

import { describe, expect, it } from "vitest";

import { coreTests, CORE_TEST_PATH, statedFee } from "./core-tests.js";
import type { MarketSpecification, Rule } from "./spec.js";

function market(rules: readonly Rule[], over: Partial<MarketSpecification> = {}): MarketSpecification {
  return {
    version: 1,
    name: "Simple",
    symbol: "SIMPLE",
    summary: "Sells pay half a percent",
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
    ...over,
  };
}

const SELL_FEE: Rule = {
  id: "sell-fee",
  title: "SELL FEE",
  when: { kind: "sell", description: "Somebody sells" },
  conditions: [],
  then: [
    { kind: "extraFee", description: "Charge 0.5%", parameters: { feePpm: 5_000 } },
    {
      kind: "routeFee",
      description: "Pay the fee receiver",
      parameters: { destination: "feeReceiver", share: 100 },
    },
  ],
};

describe("the fee a specification states outright", () => {
  it("reads a flat fee on the side it applies to", () => {
    expect(statedFee(market([SELL_FEE]), "sell")).toBe(5_000);
  });

  /**
   * The most common sentence in an Agen prompt, and the one nothing checked: a hook that
   * charges its sell fee on both sides passes every assertion about the sell.
   */
  it("reads silence about the other side as no fee at all", () => {
    expect(statedFee(market([SELL_FEE]), "buy")).toBe(0);
  });

  /**
   * DEGEN and TYPO, from the benchmark: the same half-percent sell fee written by a model that
   * used its own words for the effect and basis points for the rate. Neither the kind nor the
   * parameter was one this file recognised, so it read the sell side as charging nothing — and
   * generated a core test asserting sells are free, against a market whose whole purpose was
   * the sell fee. A wrong assertion Agen writes itself is the worst failure available here: it
   * cannot be quarantined and it blames the contract.
   */
  /**
   * POT, from the benchmark: "a 2% fee on every sell and no fee on buys", interpreted into one
   * rule that fires on any trade and states both halves at once. The first readable number won,
   * so the buy side read as two percent and the core suite demanded that buys pay it — against
   * the prompt, the rule and the market's own `buys-are-free` invariant.
   *
   * The repair could only report that a market cannot both charge buyers and promise not to,
   * and gave up. A correct market was refused because Agen misread it.
   */
  it("keeps the two sides apart when one effect states both", () => {
    const both = market([
      {
        id: "sell-fee-buy-free",
        title: "SELL FEE, BUYS FREE",
        when: { kind: "trade", description: "Anybody trades" },
        conditions: [],
        then: [
          {
            kind: "chargeTradeFee",
            description: "2% on sells, nothing on buys",
            parameters: { sellFeeBps: 200, buyFeeBps: 0, feeDestination: "jackpotPot" },
          },
        ],
      },
    ]);

    expect(statedFee(both, "sell")).toBe(20_000);
    expect(statedFee(both, "buy")).toBe(0);
  });

  /**
   * STORY: "buying should cost you nothing at all, selling costs half a percent". The rule fired on
   * any trade, the effect carried both rates, and the model also attached a condition of kind
   * `tradeSide` reading "apply the zero rate to buys and the 0.5% rate to sells". That is the
   * effect's own sidedness written twice, not a gate — but any condition abandoned the flat reading,
   * so nothing asserted the half percent, and the benchmark reported a correct market as charging
   * nothing on the side the whole prompt was about.
   */
  it("reads through a condition that only says which side of the trade it is", () => {
    const sided = market([
      {
        id: "asymmetric-trade-fee",
        title: "SELL FEE, BUYS FREE",
        when: { kind: "trade", description: "On each buy or sell" },
        conditions: [
          {
            kind: "tradeSide",
            description: "Apply the zero rate to buys and the 0.5% rate to sells.",
            parameters: { buySide: "buy", sellSide: "sell" },
          },
        ],
        then: [
          {
            kind: "chargeTradeFee",
            description: "half a percent on sells",
            parameters: { buyFeePpm: 0, sellFeePpm: 5_000 },
          },
        ],
      },
    ]);

    expect(statedFee(sided, "sell")).toBe(5_000);
    expect(statedFee(sided, "buy")).toBe(0);
  });

  /**
   * And not through anything that actually gates the fee. Reading a threshold as decoration would
   * assert a flat rate against a market that waives it — failing a market for being right, which is
   * the one mistake this file must never make.
   */
  it("still abandons the flat reading for a condition that gates on something", () => {
    const gated = (clause: {
      readonly kind: string;
      readonly description: string;
      readonly parameters?: Record<string, unknown>;
    }) =>
      market([
        {
          id: "sell-fee",
          title: "SELL FEE",
          when: { kind: "sell", description: "Somebody sells" },
          conditions: [clause],
          then: [
            {
              kind: "chargeFee",
              description: "half a percent",
              parameters: { feePpm: 5_000 },
            },
          ],
        },
      ]);

    // A side-named condition that counts something is a gate, whatever it is called.
    expect(
      statedFee(
        gated({ kind: "tradeSide", description: "sells above ten", parameters: { minimum: 10 } }),
        "sell",
      ),
    ).toBeNull();

    expect(
      statedFee(gated({ kind: "buyStreak", description: "after ten buys with no sell" }), "sell"),
    ).toBeNull();

    expect(
      statedFee(
        gated({ kind: "tradeSize", description: "more than one percent of liquidity" }),
        "sell",
      ),
    ).toBeNull();
  });

  /**
   * HOLD: 0.3% on every swap, paid out to holders when they claim. The payout rule mentions fees
   * because that is what it distributes, and it made the one number the market is built on
   * unreadable. A claim happens because somebody asked for it, never because somebody traded.
   */
  it("reads a flat fee past a rule a trade cannot trigger", () => {
    const distributing = market([
      {
        id: "swap-fee-collection",
        title: "SWAP FEE",
        when: { kind: "swap", description: "Anybody trades" },
        conditions: [],
        then: [
          { kind: "collectFee", description: "0.3% of the swap", parameters: { feePpm: 3_000 } },
        ],
      },
      {
        id: "holder-fee-distribution",
        title: "HOLDERS CLAIM",
        when: { kind: "claim", description: "A holder claims their share" },
        conditions: [{ kind: "minBalance", description: "holds at least a thousand" }],
        then: [{ kind: "distributeFees", description: "pay out what was collected" }],
      },
    ]);

    expect(statedFee(distributing, "sell")).toBe(3_000);
    expect(statedFee(distributing, "buy")).toBe(3_000);
  });

  /**
   * The other half of the same rule: an effect that names only the side you did not ask about
   * has not told you this side is free, it has told you its shape is not understood here.
   */
  it("says nothing about a side when only the other side is named", () => {
    const lopsided = market([
      {
        id: "sell-fee",
        title: "SELL FEE",
        when: { kind: "trade", description: "Anybody trades" },
        conditions: [],
        then: [
          {
            kind: "chargeTradeFee",
            description: "2% on sells",
            parameters: { sellFeeBps: 200 },
          },
        ],
      },
    ]);

    expect(statedFee(lopsided, "sell")).toBe(20_000);
    expect(statedFee(lopsided, "buy")).toBeNull();
  });

  it("reads a fee whatever the effect is called and whatever unit it used", () => {
    const bps = (parameters: Record<string, unknown>): Rule => ({
      ...SELL_FEE,
      then: [{ kind: "routeFee", description: "Take half a percent", parameters }],
    });

    expect(statedFee(market([bps({ basisPoints: 50, destination: "feeReceiver" })]), "sell")).toBe(5_000);
    expect(statedFee(market([bps({ feeBps: 50, destination: "feeReceiver" })]), "sell")).toBe(5_000);
    expect(statedFee(market([bps({ percent: 0.5 })]), "sell")).toBe(5_000);
    expect(statedFee(market([bps({ feePpm: 5_000 })]), "sell")).toBe(5_000);
  });

  /** A number whose name says no unit is fifty ppm or half a percent, and guessing is worse. */
  it("does not read a rate out of a number that names no unit", () => {
    const unnamed: Rule = {
      ...SELL_FEE,
      then: [{ kind: "takeFee", description: "Take the fee", parameters: { amount: 50 } }],
    };

    expect(statedFee(market([unnamed]), "sell")).toBeNull();
  });

  /** The trap the guard exists for: an effect this file cannot read is not proof of a free side. */
  it("refuses to call a side free when something on it carries a rate", () => {
    const unknown: Rule = {
      ...SELL_FEE,
      then: [{ kind: "adjustPricing", description: "Something else", parameters: { feeBps: 50 } }],
    };

    expect(statedFee(market([unknown]), "sell")).toBeNull();
  });

  it("refuses a fee that only applies under a condition", () => {
    const conditional: Rule = {
      ...SELL_FEE,
      conditions: [
        {
          kind: "tradeSizeVsLiquidity",
          description: "Only large sells",
          parameters: { percent: 2 },
        },
      ],
    };

    expect(statedFee(market([conditional]), "sell")).toBeNull();
  });

  /**
   * The PULSE shape, which is where an inferred flat rate would have gone wrong: the sell
   * rule is flat on its own and the waiver two rules later is the part that matters.
   */
  it("refuses a flat fee that another rule can waive", () => {
    const waiver: Rule = {
      id: "streak-waiver",
      title: "STREAK",
      when: { kind: "sell", description: "Somebody sells after five buys" },
      conditions: [
        { kind: "consecutiveCount", description: "Five buys in a row", parameters: { value: 5 } },
      ],
      then: [{ kind: "waiveFee", description: "This trade is free" }],
    };

    expect(statedFee(market([SELL_FEE, waiver]), "sell")).toBeNull();
  });

  it("refuses when a rule on no particular side changes the fee", () => {
    const milestone: Rule = {
      id: "volume-milestone",
      title: "MILESTONE",
      when: { kind: "volumeThreshold", description: "A million in volume", parameters: {} },
      conditions: [],
      onceOnly: true,
      then: [{ kind: "setFee", description: "Halve it", parameters: { feePpm: 2_500 } }],
    };

    expect(statedFee(market([SELL_FEE, milestone]), "sell")).toBeNull();
    expect(statedFee(market([SELL_FEE, milestone]), "buy")).toBeNull();
  });

  /**
   * EMBR, from the benchmark, and the plainest prompt in it: "charge a 3% fee on sells and a 1%
   * fee on buys, send every fee straight to the creator". The interpretation was exactly right
   * — 3% on the sell rule, 1% on the buy rule — and a third rule said where the money goes:
   * `transferFee` on `feeCollected`. That third rule mentions a fee and names no side, so it
   * was read as something that might change what a trade pays, and both sides came back
   * unreadable. The market Agen understood best got the fewest assertions.
   *
   * Where a fee goes cannot change what a trade pays, and the trigger says so: the fee has
   * already been collected by the time this rule fires.
   */
  it("reads both sides through a rule that only says where the fee goes", () => {
    const routing: Rule = {
      id: "direct-creator-fee-routing",
      title: "STRAIGHT TO THE CREATOR",
      when: { kind: "feeCollected", description: "Whenever a trade fee is collected" },
      conditions: [],
      then: [
        {
          kind: "transferFee",
          description: "Send it all to the creator",
          parameters: { creatorSharePercent: 100, accumulateFees: false, useRounds: false },
        },
      ],
    };

    const buyFee: Rule = {
      id: "buy-fee",
      title: "BUY FEE",
      when: { kind: "buy", description: "Somebody buys" },
      conditions: [],
      then: [{ kind: "chargeFee", description: "Charge 1%", parameters: { feePercent: 1 } }],
    };

    const embr = market([
      { ...SELL_FEE, then: [{ kind: "chargeFee", description: "Charge 3%", parameters: { feePercent: 3 } }] },
      buyFee,
      routing,
    ]);

    expect(statedFee(embr, "sell")).toBe(30_000);
    expect(statedFee(embr, "buy")).toBe(10_000);
  });

  /**
   * The same routing rule read as a rate would be a hundred percent — a share of a fee is not a
   * fee, and this is the largest misreading available: a market that charges three percent held
   * to charging everything.
   */
  it("does not read a share of a collected fee as what a trade pays", () => {
    const share: Rule = {
      ...SELL_FEE,
      then: [
        {
          kind: "chargeFee",
          description: "All of it to the creator",
          parameters: { creatorSharePercent: 100 },
        },
      ],
    };

    expect(statedFee(market([share]), "sell")).toBeNull();
  });

  /** A trigger that merely mentions a fee is not one that fires after the fee was taken. */
  it("still refuses when a rule about fees could fire on a trade", () => {
    const ambiguous: Rule = {
      id: "fee-review",
      title: "FEE REVIEW",
      when: { kind: "feeSchedule", description: "When the fee schedule is evaluated" },
      conditions: [],
      then: [{ kind: "setFee", description: "Change it", parameters: { feePpm: 1_000 } }],
    };

    expect(statedFee(market([SELL_FEE, ambiguous]), "sell")).toBeNull();
  });

  it("refuses a phase-limited fee, which is a fee that depends on the phase", () => {
    const phased: Rule = { ...SELL_FEE, activeInPhases: ["launch"] };
    expect(statedFee(market([phased]), "sell")).toBeNull();
  });

  it("refuses two flat fees on one side rather than adding them up", () => {
    const second: Rule = { ...SELL_FEE, id: "second-sell-fee" };
    expect(statedFee(market([SELL_FEE, second]), "sell")).toBeNull();
  });

  it("refuses a fee whose amount the specification does not state as a number", () => {
    const vague: Rule = {
      ...SELL_FEE,
      then: [{ kind: "extraFee", description: "Charge a bit" }],
    };

    expect(statedFee(market([vague]), "sell")).toBeNull();
  });

  /** A rule that fires on either side of a swap applies to both, and is read that way. */
  it("reads a swap-triggered fee as applying to both sides", () => {
    const both: Rule = {
      ...SELL_FEE,
      when: { kind: "swap", description: "Any trade" },
    };

    expect(statedFee(market([both]), "sell")).toBe(5_000);
    expect(statedFee(market([both]), "buy")).toBe(5_000);
  });
});

describe("the suite Agen writes for itself", () => {
  it("always proves the market trades, keeps nothing in the hook, and respects the ceiling", () => {
    const suite = coreTests(market([]), { collectsItsOwnFee: true });

    expect(suite.source.path).toBe(CORE_TEST_PATH);
    expect(suite.source.content).toContain("contract MarketCoreTest is MarketTestBase");
    expect(suite.source.content).toContain(
      "function test_core_market_trades_and_the_hook_keeps_nothing()",
    );
    expect(suite.source.content).toContain("the hook is holding tokens");
    expect(suite.source.content).toContain("function testFuzz_core_fee_never_exceeds_the_ceiling(");
  });

  it("asserts the exact fee where the specification states one", () => {
    const suite = coreTests(market([SELL_FEE]), { collectsItsOwnFee: true });

    expect(suite.source.content).toContain(
      "function test_core_fees_are_what_the_specification_says()",
    );
    expect(suite.source.content).toContain("sells pay 0.5%");
    expect(suite.source.content).toContain("* 5000 / 1_000_000");
    expect(suite.proves.some((claim) => claim.includes("0.5%"))).toBe(true);
  });

  it("asserts that a side the specification leaves alone pays nothing", () => {
    const suite = coreTests(market([SELL_FEE]), { collectsItsOwnFee: true });

    expect(suite.source.content).toContain("buys pay no hook fee");
    expect(suite.proves).toContain("buys pay no hook fee");
  });

  /**
   * A market with a mechanic gets the universal assertions and nothing more about the side
   * the mechanic touches. Anything mechanic-specific is the generated suite's job, where a
   * wrong assertion can be dropped instead of ending the build.
   *
   * The other side is still asserted, and should be: a conditional sell fee says nothing
   * about buys, so "buys are free" remains a promise the specification made.
   */
  it("claims nothing about a fee that depends on something", () => {
    const suite = coreTests(
      market([
        {
          ...SELL_FEE,
          conditions: [{ kind: "consecutiveCount", description: "After five buys" }],
        },
      ]),
      { collectsItsOwnFee: true },
    );

    expect(suite.source.content).not.toContain("sells pay");
    expect(suite.source.content).toContain("buys pay no hook fee");
    expect(suite.source.content).toContain(
      "function test_core_market_trades_and_the_hook_keeps_nothing()",
    );
  });

  /**
   * The market that nearly proved this file could fail a correct build: one percent on sells,
   * charged by overriding the pool's own fee, so Uniswap collects it for the liquidity
   * providers and no account of the market's ever holds it. Asserting that it lands somewhere
   * is asserting something untrue of a market doing exactly what it was asked to do.
   */
  it("says nothing about the money when the pool collects the fee, not the market", () => {
    const suite = coreTests(market([SELL_FEE]), { collectsItsOwnFee: false });

    expect(suite.source.content).not.toContain("test_core_fees_are_what_the_specification_says");
    expect(suite.source.content).not.toContain("accounts");
    expect(suite.proves.some((claim) => claim.includes("0.5%"))).toBe(false);

    // What is still true of it, and still worth failing a build over.
    expect(suite.source.content).toContain(
      "function test_core_market_trades_and_the_hook_keeps_nothing()",
    );
    expect(suite.source.content).toContain("function testFuzz_core_fee_never_exceeds_the_ceiling(");
  });

  /** No fixture code, no cheatcodes: everything a test needs is already on the base. */
  it("contains no fixture work of its own", () => {
    const suite = coreTests(market([SELL_FEE]), { collectsItsOwnFee: true });

    expect(suite.source.content).not.toContain("vm.");
    expect(suite.source.content).not.toContain("function setUp");
    expect(suite.source.content).not.toContain("new ");
  });
});
