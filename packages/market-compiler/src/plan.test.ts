import { describe, expect, it } from "vitest";

import type { MarketImplementationPlan } from "./plan.js";
import { deploymentOrder, validatePlan } from "./plan.js";

/** A bundle rather than a single contract: hook, vault, and a claim contract. */
function bundle(): MarketImplementationPlan {
  return {
    version: 1,
    specificationVersion: 1,
    approach: "A hook that credits a vault, with rewards claimed rather than pushed.",
    components: [
      {
        id: "rewardVault",
        contractName: "RewardVault",
        role: "vault",
        purpose: "Holds surcharge revenue so the hook never carries a balance",
        requiredBy: ["large-sell-surcharge"],
        dependsOn: [],
        custodial: true,
      },
      {
        id: "claims",
        contractName: "RewardClaims",
        role: "claim",
        purpose: "Lets holders withdraw what they are owed",
        requiredBy: ["large-sell-surcharge"],
        dependsOn: ["rewardVault"],
      },
      {
        id: "marketToken",
        contractName: "MarketToken",
        role: "token",
        purpose: "The traded token",
        requiredBy: [],
        dependsOn: [],
      },
      {
        id: "marketHook",
        contractName: "MarketHook",
        role: "hook",
        purpose: "Observes swaps and credits the vault",
        requiredBy: ["large-sell-surcharge"],
        dependsOn: ["rewardVault", "claims"],
        hookPermissions: ["beforeSwap", "afterSwap"],
      },
    ],
    dependencies: [],
    adaptations: [
      {
        requested: "pay every holder on every sell",
        implemented: "a reward-per-share accumulator with pull-based claims",
        reason: "paying every holder inside a swap costs gas proportional to the holder count",
      },
    ],
  };
}

describe("a buildable plan", () => {
  it("accepts a market made of several contracts", () => {
    expect(validatePlan(bundle())).toEqual([]);
  });

  it("orders deployment so nothing is deployed before what it depends on", () => {
    const ordered = deploymentOrder(bundle()).map((component) => component.id);

    expect(ordered.indexOf("rewardVault")).toBeLessThan(ordered.indexOf("claims"));
    expect(ordered.indexOf("claims")).toBeLessThan(ordered.indexOf("marketHook"));
  });
});

describe("plans that cannot be built", () => {
  it("catches a dependency on a component that does not exist", () => {
    const plan = bundle();
    const problems = validatePlan({
      ...plan,
      components: [{ ...plan.components[0]!, dependsOn: ["ghostContract"] }, ...plan.components.slice(1)],
    });

    expect(problems.some((problem) => problem.detail.includes('no such component: "ghostContract"'))).toBe(
      true,
    );
  });

  it("catches a cycle and suggests the way out", () => {
    const plan = bundle();
    const problems = validatePlan({
      ...plan,
      components: plan.components.map((component) =>
        component.id === "rewardVault" ? { ...component, dependsOn: ["marketHook"] } : component,
      ),
    });

    const cycle = problems.find((problem) => problem.detail.includes("cycle"));
    expect(cycle).toBeDefined();
    // The advice must not be the one this file used to give: CREATE2 cannot untie a
    // mutual init-code dependency, and saying so sent people down a dead end.
    expect(cycle?.detail).toContain("one-time setter");
  });

  it("catches a hook that Uniswap would never call", () => {
    const plan = bundle();
    const problems = validatePlan({
      ...plan,
      components: plan.components.map((component) =>
        component.role === "hook" ? { ...component, hookPermissions: [] } : component,
      ),
    });

    expect(problems.some((problem) => problem.detail.includes("never called by Uniswap"))).toBe(true);
  });

  it("catches a market with no hook at all", () => {
    const plan = bundle();
    const problems = validatePlan({
      ...plan,
      components: plan.components.filter((component) => component.role !== "hook"),
    });

    expect(problems.some((problem) => problem.detail.includes("needs a hook"))).toBe(true);
  });

  it("catches a market with no token, at planning rather than at deployment", () => {
    // This was found by a bundle that validated, generated, compiled, tested and passed
    // the gates before failing at deployment for a mistake made in the plan.
    const plan = bundle();
    const problems = validatePlan({
      ...plan,
      components: plan.components.filter((component) => component.role !== "token"),
    });

    expect(problems.some((problem) => problem.detail.includes("needs a token component"))).toBe(true);
  });

  it("catches two components that would generate the same file", () => {
    const plan = bundle();
    const problems = validatePlan({
      ...plan,
      components: [
        plan.components[0]!,
        { ...plan.components[1]!, contractName: "RewardVault" },
        plan.components[2]!,
      ],
    });

    expect(problems.some((problem) => problem.detail.includes("RewardVault.sol"))).toBe(true);
  });

  it("refuses to order a cyclic plan rather than returning half of it", () => {
    const plan = bundle();
    const cyclic = {
      ...plan,
      components: plan.components.map((component) =>
        component.id === "rewardVault" ? { ...component, dependsOn: ["marketHook"] } : component,
      ),
    };

    // A caller that deployed a partial order would leave a market half-built on chain.
    expect(() => deploymentOrder(cyclic)).toThrow(/dependency cycle/);
  });
});
