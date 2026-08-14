/**
 * The validator's job is to reject a deployment nobody could execute, during design, with
 * a complaint precise enough to fix in one retry. Every case here is a mistake a real build
 * made, or one the vocabulary makes possible.
 */

import { describe, expect, it } from "vitest";

import { DYNAMIC_FEE_FLAG, TICK_SPACING } from "@verdant/config";

import {
  deploymentSpecOrder,
  parseRef,
  validateDeploymentSpec,
  type DeployedComponent,
  type DeploymentSpecification,
} from "./deployment-spec.js";
import type { MarketComponent, MarketImplementationPlan } from "./plan.js";

function planComponent(
  over: Partial<MarketComponent> & Pick<MarketComponent, "id" | "contractName" | "role">,
): MarketComponent {
  return {
    purpose: "for the test",
    requiredBy: [],
    origin: "generate",
    reuses: [],
    dependsOn: [],
    ...over,
  };
}

const PLAN: MarketImplementationPlan = {
  version: 1,
  specificationVersion: 1,
  approach: "a vault owned by the contract that accounts for what it holds",
  components: [
    planComponent({ id: "marketToken", contractName: "MarketToken", role: "token" }),
    planComponent({ id: "feeAccounting", contractName: "FeeAccounting", role: "accounting" }),
    planComponent({ id: "feeVault", contractName: "FeeVault", role: "vault", custodial: true }),
    planComponent({
      id: "marketHook",
      contractName: "MarketHook",
      role: "hook",
      hookPermissions: ["beforeSwap"],
    }),
  ],
  dependencies: [],
  adaptations: [],
};

function component(
  over: Partial<DeployedComponent> & Pick<DeployedComponent, "componentId" | "contractName" | "role">,
): DeployedComponent {
  return {
    constructorArguments: [],
    immutable: [],
    wiring: [],
    controller: null,
    custody: false,
    claimsFees: false,
    ...over,
  };
}

function spec(over: Partial<DeploymentSpecification> = {}): DeploymentSpecification {
  return {
    version: 1,
    specificationVersion: 1,
    components: [
      component({
        componentId: "marketToken",
        contractName: "MarketToken",
        role: "token",
        constructorArguments: [
          { name: "recipient", type: "address", source: "INFRA:INSTALLER" },
        ],
      }),
      component({
        componentId: "feeAccounting",
        contractName: "FeeAccounting",
        role: "accounting",
        constructorArguments: [
          { name: "installer_", type: "address", source: "INFRA:INSTALLER" },
        ],
        wiring: [
          {
            functionName: "setFeeVault",
            argument: "COMPONENT:feeVault",
            caller: "INSTALLER",
            phase: "before_pool_initialize",
            once: true,
          },
        ],
      }),
      component({
        componentId: "feeVault",
        contractName: "FeeVault",
        role: "vault",
        constructorArguments: [
          { name: "owner_", type: "address", source: "COMPONENT:feeAccounting" },
        ],
        immutable: ["owner_"],
        controller: "COMPONENT:feeAccounting",
        custody: true,
      }),
      component({
        componentId: "marketHook",
        contractName: "MarketHook",
        role: "hook",
        constructorArguments: [
          { name: "manager_", type: "address", source: "INFRA:POOL_MANAGER" },
        ],
      }),
    ],
    pool: { feeMode: "dynamic", lpFee: DYNAMIC_FEE_FLAG, tickSpacing: TICK_SPACING },
    hookPermissions: ["beforeSwap"],
    requiresPoolIdBeforeInitialize: false,
    requiresAgenRouter: false,
    custodyComponentId: "feeVault",
    feeClaimComponentId: null,
    oneTimeInitialization: [
      {
        componentId: "feeAccounting",
        functionName: "setFeeVault",
        why: "the vault it accounts for is permanent; a second one would orphan the balances",
      },
    ],
    ...over,
  };
}

function complaints(over: Partial<DeploymentSpecification> = {}): readonly string[] {
  return validateDeploymentSpec(spec(over), PLAN).map(
    (problem) => `${problem.path}: ${problem.detail}`,
  );
}

describe("a deployment specification that can be executed", () => {
  it("accepts the vault owned by its accounting contract", () => {
    // The architecture a live TEST001 build asked for and was refused, because the
    // launcher's rule said every vault owner is the fee receiver.
    expect(complaints()).toEqual([]);
  });

  it("orders components by the addresses they are handed", () => {
    const ordered = deploymentSpecOrder(spec()).map((entry) => entry.componentId);

    // The vault takes the accounting contract's address, so the accounting contract has
    // to exist first. Nothing else constrains the order.
    expect(ordered.indexOf("feeAccounting")).toBeLessThan(ordered.indexOf("feeVault"));
    expect(ordered).toHaveLength(4);
  });
});

describe("references", () => {
  it("reads every shape in the vocabulary", () => {
    expect(parseRef("COMPONENT:feeVault")).toEqual({ kind: "component", componentId: "feeVault" });
    expect(parseRef("ROLE:FEE_RECEIVER")).toEqual({ kind: "role", role: "FEE_RECEIVER" });
    expect(parseRef("INFRA:POOL_MANAGER")).toEqual({ kind: "infra", infra: "POOL_MANAGER" });
    expect(parseRef("LITERAL:SUPPLY")).toEqual({ kind: "literal", literal: "SUPPLY" });
  });

  it("refuses anything outside it", () => {
    // A reference the materializer cannot resolve is the whole class of failure this
    // document exists to remove, so it is rejected here rather than at a launch.
    expect(parseRef("ROLE:MARKETING_WALLET")).toBeNull();
    expect(parseRef("INFRA:CHAINLINK")).toBeNull();
    expect(parseRef("feeVault")).toBeNull();
    expect(parseRef("COMPONENT:")).toBeNull();
  });

  it("names the whole vocabulary when one is wrong", () => {
    const found = complaints({
      components: spec().components.map((entry) =>
        entry.componentId === "marketHook"
          ? {
              ...entry,
              constructorArguments: [
                { name: "oracle_", type: "address", source: "INFRA:CHAINLINK" as never },
              ],
            }
          : entry,
      ),
    });

    // A validator that says only "invalid" costs a retry spent guessing. The message
    // carries the valid options for the same reason the specification validator's does.
    expect(found.join("\n")).toContain("INFRA:CHAINLINK");
    expect(found.join("\n")).toContain("ROLE:FEE_RECEIVER");
    expect(found.join("\n")).toContain("COMPONENT:feeVault");
  });
});

describe("what cannot be deployed", () => {
  it("refuses a constructor cycle", () => {
    const found = complaints({
      components: spec().components.map((entry) =>
        entry.componentId === "feeAccounting"
          ? {
              ...entry,
              constructorArguments: [
                { name: "vault_", type: "address", source: "COMPONENT:feeVault" },
              ],
            }
          : entry,
      ),
    });

    // CREATE2 derives each address from creation code containing the other, so neither
    // can be placed. The message has to say what to do instead, because "cycle" alone
    // does not tell a model that the answer is a setter.
    expect(found.join("\n")).toMatch(/take each other's addresses/);
    expect(found.join("\n")).toMatch(/wiring call/);
  });

  it("refuses a contract handed its own address", () => {
    const found = complaints({
      components: spec().components.map((entry) =>
        entry.componentId === "feeVault"
          ? {
              ...entry,
              constructorArguments: [
                { name: "self_", type: "address", source: "COMPONENT:feeVault" },
              ],
              immutable: [],
            }
          : entry,
      ),
    });

    expect(found.join("\n")).toMatch(/cannot be handed its own address/);
  });

  it("refuses wiring after the pool is opened", () => {
    const found = complaints({
      components: spec().components.map((entry) =>
        entry.componentId === "feeAccounting"
          ? {
              ...entry,
              wiring: [{ ...entry.wiring[0]!, phase: "after_pool_initialize" as const }],
            }
          : entry,
      ),
    });

    // The factory deploys, wires and then opens the pool; there is no later phase. An
    // architecture that needs one has to be told to take the pool's id instead.
    expect(found.join("\n")).toMatch(/no phase after initialization/);
    expect(found.join("\n")).toContain("POOL_ID");
  });

  it("refuses a wiring call anybody could make", () => {
    const found = complaints({
      components: spec().components.map((entry) =>
        entry.componentId === "feeAccounting"
          ? { ...entry, wiring: [{ ...entry.wiring[0]!, caller: "ROLE:CREATOR" as never }] }
          : entry,
      ),
    });

    expect(found.join("\n")).toMatch(/front-runnable/);
  });
});

describe("what the two documents must agree about", () => {
  it("notices a component the plan has and the deployment does not", () => {
    const found = complaints({
      components: spec().components.filter((entry) => entry.componentId !== "feeVault"),
      custodyComponentId: null,
    });

    expect(found.join("\n")).toMatch(/feeVault.*FeeVault.*does not declare how to deploy it/s);
  });

  it("notices a deployment naming a component that does not exist", () => {
    const found = complaints({
      components: [
        ...spec().components,
        component({ componentId: "ghost", contractName: "Ghost", role: "component" }),
      ],
    });

    expect(found.join("\n")).toMatch(/no component with id "ghost"/);
  });

  it("refuses an immutable that is not a constructor argument", () => {
    const found = complaints({
      components: spec().components.map((entry) =>
        entry.componentId === "feeVault" ? { ...entry, immutable: ["treasury_"] } : entry,
      ),
    });

    expect(found.join("\n")).toMatch(/"treasury_" is named as immutable/);
  });
});

describe("types the launch can actually supply", () => {
  it("refuses a fee taken as a constructor argument", () => {
    const found = complaints({
      components: spec().components.map((entry) =>
        entry.componentId === "marketHook"
          ? {
              ...entry,
              constructorArguments: [
                { name: "manager_", type: "address", source: "INFRA:POOL_MANAGER" },
                { name: "sellFeePpm_", type: "uint24", source: "LITERAL:SUPPLY" },
              ],
            }
          : entry,
      ),
    });

    // A market's own configuration cannot arrive from a launch. This is the declarative
    // form of the ORBIT failure: a fee the launcher had no value for, and a market that
    // opened charging nothing. The type alone does not catch it — a fee in hundredths of a
    // basis point is a uint and so is the supply — so the rule is about which component.
    expect(found.join("\n")).toMatch(/Hold `sellFeePpm_` as a constant/);
    expect(found.join("\n")).toMatch(/market's own configuration/);
  });

  it("refuses an address argument given the token's name", () => {
    const found = complaints({
      components: spec().components.map((entry) =>
        entry.componentId === "marketHook"
          ? {
              ...entry,
              constructorArguments: [
                { name: "manager_", type: "address", source: "LITERAL:NAME" },
              ],
            }
          : entry,
      ),
    });

    expect(found.join("\n")).toMatch(/cannot be passed as `address`/);
  });
});

describe("the pool", () => {
  it("refuses a dynamic market opened at a real fee", () => {
    const found = complaints({
      pool: { feeMode: "dynamic", lpFee: 3_000, tickSpacing: TICK_SPACING },
    });

    expect(found.join("\n")).toMatch(/must be the dynamic sentinel/);
  });

  it("refuses a zero-fee market opened at anything else", () => {
    const found = complaints({ pool: { feeMode: "zero", lpFee: 3_000, tickSpacing: TICK_SPACING } });

    expect(found.join("\n")).toMatch(/lpFee must be 0/);
  });

  it("accepts an ordinary fixed pool fee", () => {
    expect(complaints({ pool: { feeMode: "fixed", lpFee: 3_000, tickSpacing: TICK_SPACING } })).toEqual([]);
  });

  it("refuses a market off Agen's grid", () => {
    // Derived from the real spacing rather than written as the old literal 60, so the
    // meaning is "not the configured grid" rather than "this particular number" — and so
    // ADR-001's scan for stray tick values in `packages/sdk/src/config.test.ts` stays
    // satisfied, which it is not when a second copy of a spacing appears anywhere.
    const found = complaints({
      pool: { feeMode: "dynamic", lpFee: DYNAMIC_FEE_FLAG, tickSpacing: TICK_SPACING / 2 },
    });

    // AgenCurve reverts off the grid, so a hook requiring a different spacing is a market
    // that cannot be launched — and it is cheaper to say so here than at initialize.
    expect(found.join("\n")).toMatch(/opens on the same grid/);
  });
});

describe("flags that have to match the components", () => {
  it("refuses a router requirement nothing asked for", () => {
    expect(complaints({ requiresAgenRouter: true }).join("\n")).toMatch(
      /no component takes INFRA:AGEN_ROUTER/,
    );
  });

  it("refuses a pool-id requirement no wiring call carries", () => {
    expect(complaints({ requiresPoolIdBeforeInitialize: true }).join("\n")).toMatch(
      /no wiring call carries POOL_ID/,
    );
  });

  it("refuses one-time initialization naming a call that is not wiring", () => {
    const found = complaints({
      oneTimeInitialization: [
        { componentId: "feeAccounting", functionName: "setSomethingElse", why: "because" },
      ],
    });

    expect(found.join("\n")).toMatch(/is not one of this component's declared wiring calls/);
  });

  it("refuses custody named on a component that says it holds nothing", () => {
    const found = complaints({ custodyComponentId: "marketHook" });

    expect(found.join("\n")).toMatch(/its own entry says custody is false/);
  });
});
