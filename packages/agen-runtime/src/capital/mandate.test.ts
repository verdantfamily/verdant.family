import { describe, expect, it } from "vitest";
import { parseEther } from "viem";

import { compileMandate, mandateHonoursPolicy } from "./mandate";
import { clampPolicy, profilePolicy, type RiskProfile } from "./policy";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const OPERATOR = "0x2222222222222222222222222222222222222222" as const;
const GUARDIAN = "0x3333333333333333333333333333333333333333" as const;
const VENUES = ["0x4444444444444444444444444444444444444444"] as const;

const AUTHORISED = parseEther("0.05");

function compile(policy = profilePolicy("balanced"), authorisedWei = AUTHORISED) {
  return compileMandate({
    owner: OWNER,
    operator: OPERATOR,
    guardian: GUARDIAN,
    venues: VENUES,
    authorisedWei,
    policy,
  });
}

describe("compiling a policy into a signed mandate", () => {
  it("caps deployment at what the liquid floor leaves", () => {
    const policy = clampPolicy({ minCashPct: 20 });
    const terms = compile(policy);

    expect(terms.maxDeployedWei).toBe((AUTHORISED * 80n) / 100n);
  });

  it("caps a single venue at the policy's position ceiling", () => {
    const policy = clampPolicy({ minCashPct: 10, maxPositionPct: 30 });

    expect(compile(policy).maxPerVenueWei).toBe((AUTHORISED * 30n) / 100n);
  });

  it("keeps the per-venue cap inside the total, which the contract requires", () => {
    // A position ceiling above what the cash floor leaves would otherwise produce constructor arguments
    // CapitalMandate rejects outright.
    const policy = clampPolicy({ minCashPct: 60, maxPositionPct: 70 });
    const terms = compile(policy);

    expect(terms.maxPerVenueWei).toBeLessThanOrEqual(terms.maxDeployedWei);
  });

  it("allows one deployment plus the day's permitted moves, and no more", () => {
    const policy = clampPolicy({ minCashPct: 10, maxPositionPct: 30, maxDailyRebalances: 4 });
    const terms = compile(policy);

    expect(terms.periodDeployLimitWei).toBe(terms.maxDeployedWei + terms.maxPerVenueWei * 4n);
  });

  it("gives an account that never rebalances no churn budget at all", () => {
    const policy = clampPolicy({ maxDailyRebalances: 0 });
    const terms = compile(policy);

    expect(terms.periodDeployLimitWei).toBe(terms.maxDeployedWei);
  });

  it("does not let the action interval exceed the period", () => {
    const terms = compile();

    expect(terms.minActionInterval).toBeLessThan(terms.periodLength);
  });

  it("keeps the interval short enough to deploy across several venues promptly", () => {
    // Deliberately not derived from the rebalance allowance: spreading an initial allocation over three
    // venues takes three transactions, and an interval sized for rebalancing would make that take hours.
    expect(compile().minActionInterval).toBeLessThanOrEqual(60);
  });

  it("refuses to authorise nothing", () => {
    expect(() => compile(profilePolicy("balanced"), 0n)).toThrow(/above zero/);
  });

  it("refuses a mandate naming no venue", () => {
    expect(() =>
      compileMandate({
        owner: OWNER,
        operator: OPERATOR,
        guardian: GUARDIAN,
        venues: [],
        authorisedWei: AUTHORISED,
        policy: profilePolicy("balanced"),
      }),
    ).toThrow(/at least one venue/);
  });

  it("refuses when the liquid floor leaves nothing to deploy", () => {
    expect(() => compile(clampPolicy({ minCashPct: 100 }))).toThrow(/nothing to deploy/);
  });

  it("caps the duration at what the contract accepts", () => {
    const terms = compileMandate({
      owner: OWNER,
      operator: OPERATOR,
      guardian: GUARDIAN,
      venues: VENUES,
      authorisedWei: AUTHORISED,
      policy: profilePolicy("balanced"),
      durationSeconds: 10 * 365 * 24 * 60 * 60,
    });

    expect(terms.duration).toBeLessThanOrEqual(365 * 24 * 60 * 60);
  });

  it("authorises less than the vault may hold, so a top-up does not widen it", () => {
    // "allocate up to 0.05 ETH" is a statement about Agen's authority, not about the balance. Somebody who
    // later deposits a further ether has not thereby authorised anything more.
    const terms = compile(profilePolicy("aggressive"), parseEther("0.05"));

    expect(terms.maxDeployedWei).toBeLessThanOrEqual(parseEther("0.05"));
  });
});

describe("the compiled mandate is never looser than the policy", () => {
  it("holds across every profile and a range of amounts", () => {
    const profiles: readonly RiskProfile[] = ["conservative", "balanced", "aggressive"];
    const amounts = [parseEther("0.01"), parseEther("0.05"), parseEther("1"), parseEther("100")];

    for (const profile of profiles) {
      for (const authorised of amounts) {
        const policy = profilePolicy(profile);
        const terms = compile(policy, authorised);

        expect(
          mandateHonoursPolicy(terms, policy, authorised),
          `${profile} at ${String(authorised)} produced terms looser than its policy`,
        ).toEqual([]);
      }
    }
  });

  it("holds for customised policies too", () => {
    const policy = clampPolicy({
      riskProfile: "aggressive",
      minCashPct: 25,
      maxPositionPct: 35,
      maxDailyRebalances: 6,
    });
    const terms = compile(policy);

    expect(mandateHonoursPolicy(terms, policy, AUTHORISED)).toEqual([]);
  });

  it("reports a problem when terms are tampered with after compiling", () => {
    const policy = profilePolicy("conservative");
    const terms = compile(policy);
    const widened = { ...terms, maxDeployedWei: AUTHORISED * 2n };

    expect(mandateHonoursPolicy(widened, policy, AUTHORISED).length).toBeGreaterThan(0);
  });
});
