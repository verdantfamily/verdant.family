import { describe, expect, it } from "vitest";
import { parseEther } from "viem";

import { readObjective } from "./objective";
import { clampPolicy, PLATFORM_LIMITS, profilePolicy, revisePolicy } from "./policy";

describe("reading an instruction about money", () => {
  it("compiles a risk word and a liquidity floor into limits", () => {
    const objective = readObjective("@useagen keep this conservative and keep at least 30% liquid");

    expect(objective.proposal.riskProfile).toBe("conservative");
    expect(objective.proposal.minCashPct).toBe(30);
    // Limits, with no verb asking anything to start. Reading it as "begin managing" would be the module
    // guessing that an ambiguous sentence about money was consent, which is the one guess worth refusing.
    expect(objective.command).toBe("policy");
  });

  it("starts managing when the sentence actually asks it to", () => {
    const objective = readObjective("@useagen put my money to work, keep it conservative");

    expect(objective.command).toBe("manage");
    expect(objective.proposal.riskProfile).toBe("conservative");
  });

  it("reads an amount in ether", () => {
    expect(readObjective("@useagen put 0.25 ETH to work").amountWei).toBe(parseEther("0.25"));
  });

  it("keeps a dollar amount as unpriceable rather than converting it", () => {
    const objective = readObjective("@useagen put my $100 to work");

    expect(objective.command).toBe("manage");
    expect(objective.amountWei, "there is no oracle on this chain to price it with").toBeNull();
    expect(objective.unpriceableAmount).toBe(true);
  });

  it("hears 'stop managing my money' as stopping, not as managing", () => {
    // The failure this guards is the expensive one: the sentence contains "managing", and a naive
    // ordering would read an instruction to stop as an instruction to begin.
    expect(readObjective("@useagen stop managing my money").command).toBe("pause");
  });

  it("hears a withdrawal even when it is phrased as an instruction to stop", () => {
    expect(readObjective("@useagen withdraw everything and stop").command).toBe("withdraw");
  });

  it("treats a bare limit as a policy change rather than a request to start", () => {
    const objective = readObjective("@useagen only use ETH");

    expect(objective.command).toBe("policy");
    expect(objective.proposal.allowedAssets).toEqual(["ETH"]);
  });

  it("asks nothing of a sentence that said nothing", () => {
    const objective = readObjective("@useagen thoughts on this chart?");

    expect(objective.command).toBeNull();
    expect(objective.proposal).toEqual({});
  });

  it("reads the standing instruction to move capital when something better appears", () => {
    const objective = readObjective(
      "@useagen keep this low risk and move it if you find something better",
    );

    expect(objective.proposal.riskProfile).toBe("conservative");
    expect(objective.proposal.autoRebalance).toBe(true);
  });

  it("reads 'leave it alone' as switching optimisation off", () => {
    expect(readObjective("@useagen manage this but leave it where it is").proposal.autoRebalance).toBe(
      false,
    );
  });

  it("takes the cautious side of a contradiction", () => {
    expect(
      readObjective("@useagen manage this aggressively but keep it safe").proposal.riskProfile,
    ).toBe("conservative");
  });
});

describe("the clamp", () => {
  it("cuts a proposal down to the platform ceilings", () => {
    const policy = clampPolicy({
      riskProfile: "aggressive",
      maxPositionPct: 100,
      maxHighRiskPct: 100,
      minCashPct: 0,
      maxSlippageBps: 5_000,
      maxDailyRebalances: 500,
    });

    expect(policy.maxPositionPct).toBeLessThanOrEqual(PLATFORM_LIMITS.maxPositionPct);
    expect(policy.maxHighRiskPct).toBeLessThanOrEqual(PLATFORM_LIMITS.maxHighRiskPct);
    expect(policy.minCashPct).toBeGreaterThanOrEqual(PLATFORM_LIMITS.minCashPct);
    expect(policy.maxSlippageBps).toBeLessThanOrEqual(PLATFORM_LIMITS.maxSlippageBps);
    expect(policy.maxDailyRebalances).toBeLessThanOrEqual(PLATFORM_LIMITS.maxDailyRebalances);
  });

  it("refuses leverage however insistently it is asked for", () => {
    expect(clampPolicy({ allowLeverage: true }).allowLeverage).toBe(false);
    expect(clampPolicy({ riskProfile: "aggressive", allowLeverage: true }).allowLeverage).toBe(false);
  });

  it("keeps the per-position ceiling inside what the cash floor leaves", () => {
    // 70% in one position and 60% held liquid is not a pair of limits, it is arithmetic nobody can
    // satisfy, and a field-by-field clamp would pass it.
    const policy = clampPolicy({ minCashPct: 60, maxPositionPct: 70 });

    expect(policy.maxPositionPct).toBeLessThanOrEqual(100 - policy.minCashPct);
  });

  it("keeps the high-risk allowance inside the per-position ceiling", () => {
    const policy = clampPolicy({ riskProfile: "aggressive", maxPositionPct: 5, maxHighRiskPct: 20 });

    expect(policy.maxHighRiskPct).toBeLessThanOrEqual(policy.maxPositionPct);
  });

  it("drops assets this chain does not have", () => {
    expect(clampPolicy({ allowedAssets: ["ETH", "USDC"] }).allowedAssets).toEqual(["ETH"]);
  });

  it("falls back to the supported set rather than to an empty allowlist", () => {
    // An empty allowlist means "deploy nothing" while reporting itself as a working policy, which is a
    // worse answer than ignoring an instruction naming assets that do not exist here.
    expect(clampPolicy({ allowedAssets: ["USDC"] }).allowedAssets).toEqual(["ETH"]);
  });

  it("refuses unverified venues unless the mandate is aggressive", () => {
    expect(clampPolicy({ riskProfile: "conservative", allowedProtocols: ["unverified"] }).allowedProtocols)
      .not.toContain("unverified");
    expect(clampPolicy({ riskProfile: "aggressive", allowedProtocols: ["unverified"] }).allowedProtocols)
      .toContain("unverified");
  });

  it("ignores nonsense instead of producing a policy full of NaN", () => {
    const policy = clampPolicy({ minCashPct: Number.NaN, maxPositionPct: Number.POSITIVE_INFINITY });

    expect(Number.isFinite(policy.minCashPct)).toBe(true);
    expect(Number.isFinite(policy.maxPositionPct)).toBe(true);
  });

  it("gives a conservative mandate no high-risk allowance at all", () => {
    expect(profilePolicy("conservative").maxHighRiskPct).toBe(0);
  });
});

describe("revising a policy", () => {
  it("carries the whole profile when the risk label changes", () => {
    const conservative = profilePolicy("conservative");
    const aggressive = revisePolicy(conservative, { riskProfile: "aggressive" });

    // "go more aggressive" that raised the label and kept a 25% cash floor would have honoured the word
    // and none of the request.
    expect(aggressive.minCashPct).toBeLessThan(conservative.minCashPct);
    expect(aggressive.maxPositionPct).toBeGreaterThan(conservative.maxPositionPct);
  });

  it("keeps customised limits when only one field changes", () => {
    const base = revisePolicy(profilePolicy("balanced"), { minCashPct: 40 });
    const after = revisePolicy(base, { maxSlippageBps: 25 });

    expect(after.minCashPct).toBe(40);
    expect(after.maxSlippageBps).toBe(25);
  });

  it("still clamps a revision", () => {
    expect(revisePolicy(profilePolicy("balanced"), { maxPositionPct: 99 }).maxPositionPct).toBeLessThanOrEqual(
      PLATFORM_LIMITS.maxPositionPct,
    );
  });
});
