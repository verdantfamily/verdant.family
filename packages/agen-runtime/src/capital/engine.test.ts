import { describe, expect, it } from "vitest";
import { parseEther } from "viem";

import { planAllocation } from "./allocation";
import { DUST_WEI, eventKindFor, notifiable } from "./events";
import { actionKey, automationGate, mayAttempt, mayWithdraw } from "./guard";
import {
  CASH_ID,
  cashOpportunity,
  discoverOpportunities,
  type Opportunity,
  type OpportunityMetrics,
  type OpportunitySource,
} from "./opportunity";
import { clampPolicy, profilePolicy, type Policy } from "./policy";
import { DEFAULT_EXITS, decideCash, decidePosition, performance, type Position } from "./rebalance";
import { DEFAULT_SCORING, rankOpportunities, riskBand, scoreOpportunity } from "./scoring";
import { validatePlan } from "./validate";

const BALANCE = parseEther("10");

/** A deep, calm, reviewed venue. The baseline everything else is a variation on. */
const SOUND: OpportunityMetrics = {
  grossApr: 0.12,
  liquidityWei: parseEther("10000"),
  volume24hWei: parseEther("500"),
  volatility: 0.05,
  ilExposure: 0,
  concentration: 0.1,
  incentiveDependence: 0,
  protocolTier: "verified",
  entryCostWei: parseEther("0.001"),
  exitCostWei: parseEther("0.001"),
};

function venue(id: string, metrics: Partial<OpportunityMetrics> = {}): Opportunity {
  return {
    id,
    kind: "lp",
    label: id,
    asset: "ETH",
    metrics: { ...SOUND, ...metrics },
  };
}

function scored(opportunities: readonly Opportunity[], amountWei: bigint) {
  return opportunities.map((opportunity) => ({
    opportunity,
    score: scoreOpportunity(opportunity, amountWei, DEFAULT_SCORING),
  }));
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    opportunityId: "good",
    costBasisWei: parseEther("5"),
    valueWei: parseEther("5"),
    feesEarnedWei: 0n,
    enteredAt: 1_700_000_000,
    ...overrides,
  };
}

describe("scoring", () => {
  it("will not let a headline rate outrank a sound venue", () => {
    // The whole reason this layer exists. A 400% rate that is all incentives, in an unreviewed venue with
    // no depth and full divergence exposure, must lose to 12% that is real.
    const trap = venue("trap", {
      grossApr: 4,
      incentiveDependence: 1,
      protocolTier: "unverified",
      volatility: 1.5,
      ilExposure: 1,
      concentration: 0.9,
      liquidityWei: parseEther("2"),
    });

    const ranked = rankOpportunities([trap, venue("sound")], parseEther("5"));

    expect(ranked[0]?.opportunityId).toBe("sound");
    expect(scoreOpportunity(trap, parseEther("5")).score).toBeLessThan(0);
  });

  it("charges a position for being large relative to the venue", () => {
    const thin = venue("thin", { liquidityWei: parseEther("5") });

    const small = scoreOpportunity(thin, parseEther("0.1"));
    const large = scoreOpportunity(thin, parseEther("5"));

    expect(large.penalties.liquidity).toBeGreaterThan(small.penalties.liquidity);
    expect(large.score).toBeLessThan(small.score);
  });

  it("annualises entry and exit costs, so a small position can fail to clear them", () => {
    const costly = venue("costly", { entryCostWei: parseEther("0.05"), exitCostWei: parseEther("0.05") });

    expect(scoreOpportunity(costly, parseEther("0.2")).score).toBeLessThan(0);
    expect(scoreOpportunity(costly, parseEther("50")).score).toBeGreaterThan(0);
  });

  it("discounts yield that depends on incentives", () => {
    const real = scoreOpportunity(venue("real"), BALANCE);
    const farmed = scoreOpportunity(venue("farmed", { incentiveDependence: 1 }), BALANCE);

    expect(farmed.expectedGrossApr).toBeLessThan(real.expectedGrossApr);
  });

  it("explains itself in terms a holder could check", () => {
    const explanation = scoreOpportunity(venue("sound"), BALANCE).explanation;

    expect(explanation.length).toBeGreaterThan(1);
    expect(explanation[explanation.length - 1]).toMatch(/risk-adjusted|lose/);
  });

  it("bands an unreviewed venue as high risk whatever it pays", () => {
    expect(riskBand(venue("x", { protocolTier: "unverified", grossApr: 10 }))).toBe("high");
    expect(riskBand(venue("y", { volatility: 0.8 }))).toBe("high");
    expect(riskBand(cashOpportunity())).toBe("low");
  });

  it("does not let wei-scale amounts destroy the arithmetic", () => {
    // Number(10n ** 18n) is already inexact, so a ratio taken by converting each side first is wrong for
    // exactly the magnitudes this system deals in.
    const score = scoreOpportunity(venue("sound"), parseEther("1234.567891234567891"));

    expect(Number.isFinite(score.score)).toBe(true);
    expect(Number.isNaN(score.penalties.liquidity)).toBe(false);
  });
});

describe("allocation", () => {
  it("respects the liquid floor", () => {
    const policy = clampPolicy({ minCashPct: 40 });
    const plan = planAllocation({ balanceWei: BALANCE, policy, opportunities: [venue("sound")] });

    expect(plan.cashWei).toBeGreaterThanOrEqual((BALANCE * 40n) / 100n);
    expect(validatePlan({ plan, balanceWei: BALANCE, policy, opportunities: [venue("sound")] }).ok).toBe(
      true,
    );
  });

  it("respects the per-position ceiling", () => {
    const policy = clampPolicy({ maxPositionPct: 20, minCashPct: 5 });
    const plan = planAllocation({ balanceWei: BALANCE, policy, opportunities: [venue("sound")] });

    for (const entry of plan.positions) {
      expect(entry.amountWei).toBeLessThanOrEqual((BALANCE * 20n) / 100n);
    }
  });

  it("respects the high-risk allowance across several venues", () => {
    const policy = clampPolicy({ riskProfile: "aggressive", maxHighRiskPct: 10, maxPositionPct: 70 });
    const risky = [
      venue("risky-a", { protocolTier: "unverified", grossApr: 1.5 }),
      venue("risky-b", { protocolTier: "unverified", grossApr: 1.4 }),
      venue("risky-c", { protocolTier: "unverified", grossApr: 1.3 }),
    ];

    const plan = planAllocation({ balanceWei: BALANCE, policy, opportunities: risky });
    const deployed = plan.positions.reduce((total, entry) => total + entry.amountWei, 0n);

    expect(deployed).toBeLessThanOrEqual((BALANCE * 10n) / 100n);
    expect(validatePlan({ plan, balanceWei: BALANCE, policy, opportunities: risky }).ok).toBe(true);
  });

  it("deploys nothing at all under a conservative mandate offered only risky venues", () => {
    const policy = profilePolicy("conservative");
    const plan = planAllocation({
      balanceWei: BALANCE,
      policy,
      opportunities: [venue("risky", { protocolTier: "unverified", grossApr: 2 })],
    });

    expect(plan.positions).toEqual([]);
    expect(plan.cashWei).toBe(BALANCE);
  });

  it("holds everything liquid rather than entering a venue that loses money", () => {
    const plan = planAllocation({
      balanceWei: BALANCE,
      policy: profilePolicy("balanced"),
      opportunities: [venue("losing", { grossApr: 0.001, exitCostWei: parseEther("1") })],
    });

    expect(plan.positions).toEqual([]);
    expect(plan.notes.join(" ")).toMatch(/liquid/);
  });

  it("never allocates to cash as though it were a venue", () => {
    const plan = planAllocation({
      balanceWei: BALANCE,
      policy: profilePolicy("balanced"),
      opportunities: [cashOpportunity(), venue("sound")],
    });

    expect(plan.positions.map((entry) => entry.opportunityId)).not.toContain(CASH_ID);
  });

  it("leaves an existing position out of a fresh allocation", () => {
    const plan = planAllocation({
      balanceWei: BALANCE,
      policy: profilePolicy("balanced"),
      opportunities: [venue("held")],
      existing: ["held"],
    });

    expect(plan.positions).toEqual([]);
  });

  it("says so rather than dividing by zero on an empty account", () => {
    const plan = planAllocation({
      balanceWei: 0n,
      policy: profilePolicy("balanced"),
      opportunities: [venue("sound")],
    });

    expect(plan.positions).toEqual([]);
    expect(plan.notes.join(" ")).toMatch(/nothing/);
  });

  it("records why it entered each position", () => {
    const plan = planAllocation({
      balanceWei: BALANCE,
      policy: profilePolicy("balanced"),
      opportunities: [venue("sound")],
    });

    expect(plan.positions[0]?.reason).toContain("sound");
  });
});

describe("the validator", () => {
  const policy = clampPolicy({ minCashPct: 20, maxPositionPct: 50, maxHighRiskPct: 10 });
  const opportunities = [venue("sound")];

  it("refuses a plan that breaches the cash floor", () => {
    const result = validatePlan({
      plan: { cashWei: 0n, positions: [{ opportunityId: "sound", amountWei: BALANCE, reason: "" }], notes: [] },
      balanceWei: BALANCE,
      policy,
      opportunities,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((violation) => violation.code)).toContain("CASH_FLOOR_BREACHED");
    }
  });

  it("cannot be fooled by a plan that misreports its own cash", () => {
    // `cashWei` is the plan's claim. The check is against the balance minus what is deployed, so a plan
    // asserting a compliant figure it does not actually leave is still refused.
    const result = validatePlan({
      plan: {
        cashWei: (BALANCE * 20n) / 100n,
        positions: [{ opportunityId: "sound", amountWei: BALANCE, reason: "" }],
        notes: [],
      },
      balanceWei: BALANCE,
      policy,
      opportunities,
    });

    expect(result.ok).toBe(false);
  });

  it("refuses a position over the ceiling instead of trimming it", () => {
    const result = validatePlan({
      plan: {
        cashWei: (BALANCE * 30n) / 100n,
        positions: [{ opportunityId: "sound", amountWei: (BALANCE * 70n) / 100n, reason: "" }],
        notes: [],
      },
      balanceWei: BALANCE,
      policy,
      opportunities,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((violation) => violation.code)).toContain("POSITION_CAP_EXCEEDED");
    }
  });

  it("refuses a destination that was never discovered", () => {
    // This is what "no arbitrary recipient" reduces to here: a plan can only name an opportunity id, and
    // an id that no source produced is refused. There is no field in which an address could be smuggled.
    const result = validatePlan({
      plan: {
        cashWei: (BALANCE * 50n) / 100n,
        positions: [
          { opportunityId: "0x000000000000000000000000000000000000dead", amountWei: parseEther("1"), reason: "" },
        ],
        notes: [],
      },
      balanceWei: BALANCE,
      policy,
      opportunities,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((violation) => violation.code)).toContain("UNKNOWN_OPPORTUNITY");
    }
  });

  it("refuses a venue the policy does not allow, even when it was discovered", () => {
    const unverified = [venue("wild", { protocolTier: "unverified" })];
    const result = validatePlan({
      plan: {
        cashWei: (BALANCE * 80n) / 100n,
        positions: [{ opportunityId: "wild", amountWei: parseEther("2"), reason: "" }],
        notes: [],
      },
      balanceWei: BALANCE,
      policy,
      opportunities: unverified,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((violation) => violation.code)).toContain("INELIGIBLE_OPPORTUNITY");
    }
  });

  it("refuses leverage under every policy this system produces", () => {
    const result = validatePlan({
      plan: { cashWei: BALANCE, positions: [], notes: [] },
      balanceWei: BALANCE,
      policy,
      opportunities,
      leveraged: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((violation) => violation.code)).toContain("LEVERAGE_FORBIDDEN");
    }
  });

  it("refuses the same venue twice", () => {
    const result = validatePlan({
      plan: {
        cashWei: 0n,
        positions: [
          { opportunityId: "sound", amountWei: parseEther("2"), reason: "" },
          { opportunityId: "sound", amountWei: parseEther("2"), reason: "" },
        ],
        notes: [],
      },
      balanceWei: BALANCE,
      policy,
      opportunities,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((violation) => violation.code)).toContain("DUPLICATE_POSITION");
    }
  });

  it("refuses a plan that spends more than the account holds", () => {
    const result = validatePlan({
      plan: {
        cashWei: 0n,
        positions: [{ opportunityId: "sound", amountWei: BALANCE * 2n, reason: "" }],
        notes: [],
      },
      balanceWei: BALANCE,
      policy,
      opportunities,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((violation) => violation.code)).toContain("TOTAL_EXCEEDS_BALANCE");
    }
  });

  it("passes every plan the planner produces, across profiles", () => {
    for (const profile of ["conservative", "balanced", "aggressive"] as const) {
      const active: Policy = profilePolicy(profile);
      const options = [venue("a"), venue("b", { grossApr: 0.2 }), venue("c", { grossApr: 0.08 })];
      const plan = planAllocation({ balanceWei: BALANCE, policy: active, opportunities: options });

      expect(
        validatePlan({ plan, balanceWei: BALANCE, policy: active, opportunities: options }).ok,
        `${profile} produced a plan its own policy refuses`,
      ).toBe(true);
    }
  });
});

describe("deciding what to do with a position", () => {
  const policy = profilePolicy("balanced");

  it("exits when liquidity collapses", () => {
    const decision = decidePosition({
      position: position(),
      current: venue("good", { liquidityWei: 1n }),
      alternatives: [],
      policy,
      balanceWei: BALANCE,
    });

    expect(decision.action).toBe("exit");
    expect(decision.reason).toMatch(/liquidity/);
  });

  it("exits when a fee-earning venue stops trading", () => {
    const decision = decidePosition({
      position: position(),
      current: venue("good", { volume24hWei: 0n }),
      alternatives: [],
      policy,
      balanceWei: BALANCE,
    });

    expect(decision.action).toBe("exit");
  });

  it("exits on the configured drawdown stop", () => {
    const decision = decidePosition({
      position: position({ costBasisWei: parseEther("5"), valueWei: parseEther("3.5") }),
      current: venue("good"),
      alternatives: [],
      policy,
      balanceWei: BALANCE,
    });

    expect(decision.action).toBe("exit");
    expect(decision.reason).toMatch(/stop/);
  });

  it("counts fees earned before calling it a drawdown", () => {
    // Down on price and up overall. A stop that ignored the fees would exit a position that is working.
    const decision = decidePosition({
      position: position({
        costBasisWei: parseEther("5"),
        valueWei: parseEther("4.1"),
        feesEarnedWei: parseEther("0.9"),
      }),
      current: venue("good"),
      alternatives: [],
      policy,
      balanceWei: BALANCE,
    });

    expect(decision.action).not.toBe("exit");
  });

  it("exits when a venue can no longer be read at all", () => {
    const decision = decidePosition({
      position: position(),
      current: null,
      alternatives: [],
      policy,
      balanceWei: BALANCE,
    });

    expect(decision.action).toBe("exit");
  });

  it("exits when a policy change made the held venue ineligible", () => {
    const decision = decidePosition({
      position: position(),
      current: venue("good", { protocolTier: "unverified" }),
      alternatives: [],
      policy: profilePolicy("conservative"),
      balanceWei: BALANCE,
    });

    expect(decision.action).toBe("exit");
    expect(decision.reason).toMatch(/no longer allowed/);
  });

  it("stays when a better venue does not cover the cost of moving", () => {
    const current = venue("good", { grossApr: 0.12 });
    const marginal = venue("marginal", { grossApr: 0.125, entryCostWei: parseEther("0.5") });

    const decision = decidePosition({
      position: position(),
      current,
      alternatives: [marginal],
      policy,
      balanceWei: BALANCE,
    });

    expect(decision.action).toBe("stay");
    expect(decision.reason).toMatch(/cost of moving/);
  });

  it("moves when a venue is materially better", () => {
    const decision = decidePosition({
      position: position(),
      current: venue("good", { grossApr: 0.05 }),
      alternatives: [venue("better", { grossApr: 0.4 })],
      policy,
      balanceWei: BALANCE,
    });

    expect(decision.action).toBe("rebalance");
    expect(decision.targetOpportunityId).toBe("better");
  });

  it("counts the cost of leaving, not only the cost of arriving", () => {
    // The same pair of venues, differing only in what it costs to get out of the one being held. Cheap to
    // leave and the move is worth making; expensive to leave and the identical improvement no longer pays
    // for itself. If the exit leg were left out of the migration cost, both would rebalance.
    const target = venue("better", { grossApr: 0.45 });
    const of = (exitCostWei: bigint) =>
      decidePosition({
        position: position({ opportunityId: "held" }),
        current: venue("held", { grossApr: 0.4, exitCostWei }),
        alternatives: [target],
        policy,
        balanceWei: BALANCE,
      }).action;

    expect(of(parseEther("0.001"))).toBe("rebalance");
    expect(of(parseEther("1.5"))).toBe("stay");
  });

  it("does not treat an expensive exit as a reason to leave", () => {
    // A held position is not charged its own exit cost when deciding whether to continue holding: the exit
    // will be paid whenever it happens, so charging it here would make "hard to get out of" argue for
    // getting out.
    const decision = decidePosition({
      position: position({ opportunityId: "held" }),
      current: venue("held", { grossApr: 0.12, exitCostWei: parseEther("2") }),
      alternatives: [],
      policy,
      balanceWei: BALANCE,
    });

    expect(decision.action).toBe("stay");
  });

  it("will not optimise when the holder said to leave it alone, but will still exit on risk", () => {
    const standing = clampPolicy({ autoRebalance: false });

    expect(
      decidePosition({
        position: position(),
        current: venue("good", { grossApr: 0.05 }),
        alternatives: [venue("better", { grossApr: 0.9 })],
        policy: standing,
        balanceWei: BALANCE,
      }).action,
    ).toBe("stay");

    expect(
      decidePosition({
        position: position(),
        current: venue("good", { liquidityWei: 1n }),
        alternatives: [],
        policy: standing,
        balanceWei: BALANCE,
      }).action,
      "an instruction not to chase yield is not a waiver of the risk stop",
    ).toBe("exit");
  });

  it("stops optimising once the daily rebalance limit is reached, and still exits on risk", () => {
    const limited = clampPolicy({ maxDailyRebalances: 2 });

    expect(
      decidePosition({
        position: position(),
        current: venue("good", { grossApr: 0.05 }),
        alternatives: [venue("better", { grossApr: 0.9 })],
        policy: limited,
        balanceWei: BALANCE,
        rebalancesToday: 2,
      }).action,
    ).toBe("stay");

    expect(
      decidePosition({
        position: position(),
        current: venue("good", { volume24hWei: 0n }),
        alternatives: [],
        policy: limited,
        balanceWei: BALANCE,
        rebalancesToday: 99,
      }).action,
    ).toBe("exit");
  });

  it("trims a position that grew past its ceiling", () => {
    const decision = decidePosition({
      position: position({ valueWei: parseEther("9") }),
      current: venue("good"),
      alternatives: [],
      policy: clampPolicy({ maxPositionPct: 50 }),
      balanceWei: BALANCE,
    });

    expect(decision.action).toBe("reduce");
    expect(decision.amountWei).toBe(parseEther("9") - (BALANCE * 50n) / 100n);
  });

  it("never names a destination outside the alternatives it was given", () => {
    const decision = decidePosition({
      position: position(),
      current: venue("good", { grossApr: 0.01 }),
      alternatives: [venue("only-option", { grossApr: 0.5 })],
      policy,
      balanceWei: BALANCE,
    });

    expect([null, "only-option"]).toContain(decision.targetOpportunityId);
  });

  it("reports performance including fees", () => {
    expect(
      performance({
        opportunityId: "x",
        costBasisWei: parseEther("10"),
        valueWei: parseEther("9"),
        feesEarnedWei: parseEther("2"),
        enteredAt: 0,
      }),
    ).toBeCloseTo(0.1, 6);
  });

  it("uses the configured stop rather than an invented one", () => {
    const tight = { ...DEFAULT_EXITS, maxDrawdownPct: 2 };
    const barely = position({ costBasisWei: parseEther("5"), valueWei: parseEther("4.8") });

    expect(
      decidePosition({ position: barely, current: venue("good"), alternatives: [], policy, balanceWei: BALANCE })
        .action,
    ).not.toBe("exit");

    expect(
      decidePosition({
        position: barely,
        current: venue("good"),
        alternatives: [],
        policy,
        balanceWei: BALANCE,
        exits: tight,
      }).action,
    ).toBe("exit");
  });
});

describe("deciding what to do with liquid capital", () => {
  it("holds cash when nothing clears its costs", () => {
    const decision = decideCash({
      cashWei: BALANCE,
      balanceWei: BALANCE,
      policy: profilePolicy("balanced"),
      alternatives: scored([venue("bad", { grossApr: 0, exitCostWei: parseEther("1") })], BALANCE),
    });

    expect(decision.action).toBe("hold_cash");
  });

  it("holds cash when the only liquid balance is the floor the holder asked for", () => {
    const policy = clampPolicy({ minCashPct: 25 });
    const decision = decideCash({
      cashWei: (BALANCE * 25n) / 100n,
      balanceWei: BALANCE,
      policy,
      alternatives: scored([venue("sound")], BALANCE),
    });

    expect(decision.action).toBe("hold_cash");
    expect(decision.reason).toMatch(/25%/);
  });

  it("deploys spare liquid balance into the best venue", () => {
    const decision = decideCash({
      cashWei: BALANCE,
      balanceWei: BALANCE,
      policy: profilePolicy("balanced"),
      alternatives: scored([venue("sound"), venue("worse", { grossApr: 0.02 })], BALANCE),
    });

    expect(decision.action).toBe("increase");
    expect(decision.opportunityId).toBe("sound");
  });
});

describe("the stops", () => {
  it("stops automation when the account is paused", () => {
    const gate = automationGate({ state: "paused" });

    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/paused/);
  });

  it("stops automation platform-wide before anything else is considered", () => {
    const gate = automationGate({ state: "active", killSwitch: true });

    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/platform-wide/);
  });

  it("stops automation when authority has been revoked", () => {
    expect(automationGate({ state: "revoked" }).allowed).toBe(false);
  });

  it("lets an active account be managed", () => {
    expect(automationGate({ state: "active" }).allowed).toBe(true);
  });

  it("lets a holder withdraw whatever automation is doing", () => {
    // The point of the test: withdrawal takes no policy, no plan and nothing a model could influence, so
    // getting your money back cannot depend on the automation being healthy or on anything agreeing.
    for (const state of ["active", "paused", "revoked"] as const) {
      expect(mayWithdraw(state)).toBe(true);
    }
    expect(mayWithdraw("closed")).toBe(false);
  });
});

describe("attempting an action twice", () => {
  it("never retries anything holding a transaction hash", () => {
    const gate = mayAttempt({ state: "failed", txHash: "0xabc" });

    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/reconciled/);
  });

  it("refuses an indeterminate action rather than resending it", () => {
    expect(mayAttempt({ state: "indeterminate", txHash: null }).allowed).toBe(false);
  });

  it("refuses one that already completed", () => {
    expect(mayAttempt({ state: "confirmed", txHash: "0xabc" }).allowed).toBe(false);
  });

  it("allows a fresh action, and one that failed before it was ever sent", () => {
    expect(mayAttempt({ state: "planned", txHash: null }).allowed).toBe(true);
    expect(mayAttempt({ state: "failed", txHash: null }).allowed).toBe(true);
  });

  it("derives the same key for the same decision in the same slot", () => {
    // Which is what makes a duplicated scheduler run harmless: both runs produce this key, the uniqueness
    // constraint rejects the second, and only one trade exists.
    const of = () =>
      actionKey({ accountId: "acct-1", slot: 42, action: "rebalance", opportunityId: "a", targetOpportunityId: "b" });

    expect(of()).toBe(of());
    expect(of()).not.toBe(
      actionKey({ accountId: "acct-1", slot: 43, action: "rebalance", opportunityId: "a", targetOpportunityId: "b" }),
    );
  });

  it("distinguishes two different accounts in the same slot", () => {
    expect(actionKey({ accountId: "a", slot: 1, action: "exit", opportunityId: "x" })).not.toBe(
      actionKey({ accountId: "b", slot: 1, action: "exit", opportunityId: "x" }),
    );
  });
});

describe("what the holder is told", () => {
  it("messages about money moving", () => {
    expect(notifiable({ kind: "deployed", amountWei: parseEther("1"), reason: "" })).toBe(true);
    expect(notifiable({ kind: "exited", amountWei: parseEther("1"), reason: "" })).toBe(true);
    expect(notifiable({ kind: "rebalanced", amountWei: parseEther("1"), reason: "" })).toBe(true);
  });

  it("stays quiet about an evaluation that changed nothing", () => {
    expect(notifiable({ kind: "evaluated", amountWei: null, reason: "" })).toBe(false);
    expect(notifiable({ kind: "observed", amountWei: null, reason: "" })).toBe(false);
  });

  it("stays quiet about dust", () => {
    expect(notifiable({ kind: "rebalanced", amountWei: DUST_WEI - 1n, reason: "" })).toBe(false);
  });

  it("always messages about risk and about the holder's own instructions taking effect", () => {
    for (const kind of ["risk_detected", "paused", "withdrawn", "policy_changed"] as const) {
      expect(notifiable({ kind, amountWei: null, reason: "" })).toBe(true);
    }
  });

  it("produces no event for the decisions that make up most evaluations", () => {
    expect(eventKindFor("stay")).toBeNull();
    expect(eventKindFor("hold_cash")).toBeNull();
    expect(eventKindFor("rebalance")).toBe("rebalanced");
  });
});

describe("discovering opportunities", () => {
  it("keeps going when one source fails", () => {
    const broken: OpportunitySource = {
      id: "broken",
      discover: () => Promise.reject(new Error("indexer down")),
    };
    const working: OpportunitySource = { id: "working", discover: async () => [venue("sound")] };

    return expect(discoverOpportunities([broken, working])).resolves.toHaveLength(1);
  });

  it("does not let two sources report the same venue twice", async () => {
    const one: OpportunitySource = { id: "one", discover: async () => [venue("same")] };
    const two: OpportunitySource = { id: "two", discover: async () => [venue("same")] };

    expect(await discoverOpportunities([one, two])).toHaveLength(1);
  });
});
