/**
 * Materializing a declared deployment, and refusing to materialize a stale one.
 *
 * These tests used to be about inference: nineteen rules deciding what `owner_` meant from
 * its spelling, and a scraper deciding that a one-argument address setter must name a
 * sibling. Every one of them has been deleted along with the rules, because the question
 * they answered is no longer asked — the architecture stage declares the deployment and
 * this module executes it.
 *
 * What is left is the two things that can still go wrong. A symbol has to resolve to the
 * right address, and the compiled contract has to be the contract that was declared.
 */

import { describe, expect, it } from "vitest";

import { DYNAMIC_FEE_FLAG, TICK_SPACING } from "@verdant/config";

import type { ContractArtifact } from "./artifacts.js";
import type { DeployedComponent, DeploymentSpecification } from "./deployment-spec.js";
import {
  assembleManifest,
  deploymentParityProblems,
  encodeWiring,
  marketSaltFor,
  materializeDeployment,
  poolIdFor,
  type DeploymentEnvironment,
} from "./deployment.js";
import type { MarketImplementationPlan } from "./plan.js";

const ENVIRONMENT: DeploymentEnvironment = {
  poolManager: "0x1111111111111111111111111111111111111111",
  installer: "0x2222222222222222222222222222222222222222",
  creator: "0x3333333333333333333333333333333333333333",
  feeReceiver: "0x4444444444444444444444444444444444444444",
  agenRouter: "0x5555555555555555555555555555555555555555",
  treasury: "0x4444444444444444444444444444444444444444",
  beneficiary: "0x4444444444444444444444444444444444444444",
  name: "Pulse",
  symbol: "PULSE",
  supplyTokens: 1_000_000_000n,
};

/** The shape a real PULSE build produced: a token, a hook told about it, and a vault. */
function plan(): MarketImplementationPlan {
  return {
    version: 1,
    specificationVersion: 1,
    approach: "A hook that charges a fee into a vault.",
    components: [
      {
        id: "pulseToken",
        contractName: "PulseToken",
        role: "token",
        purpose: "The traded token",
        requiredBy: [],
        origin: "generate",
        reuses: [],
        dependsOn: [],
      },
      {
        id: "pulseHook",
        contractName: "PulseHook",
        role: "hook",
        purpose: "Charges the fee and tracks the streak",
        requiredBy: ["base-fee"],
        origin: "extend",
        reuses: [],
        dependsOn: ["pulseToken"],
        hookPermissions: ["beforeSwap"],
      },
      {
        id: "feeVault",
        contractName: "FeeVault",
        role: "vault",
        purpose: "Holds the fees",
        requiredBy: ["base-fee"],
        origin: "generate",
        reuses: [],
        dependsOn: [],
      },
    ],
    dependencies: [],
    adaptations: [],
  };
}

function deployed(
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

/** The declared deployment for the plan above. */
function deployment(over: Partial<DeploymentSpecification> = {}): DeploymentSpecification {
  return {
    version: 1,
    specificationVersion: 1,
    components: [
      deployed({
        componentId: "pulseToken",
        contractName: "PulseToken",
        role: "token",
        constructorArguments: [
          { name: "recipient", type: "address", source: "INFRA:INSTALLER" },
        ],
        immutable: ["recipient"],
      }),
      deployed({
        componentId: "pulseHook",
        contractName: "PulseHook",
        role: "hook",
        constructorArguments: [
          { name: "manager", type: "address", source: "INFRA:POOL_MANAGER" },
          { name: "installer", type: "address", source: "INFRA:INSTALLER" },
          { name: "pulseToken_", type: "address", source: "COMPONENT:pulseToken" },
        ],
      }),
      deployed({
        componentId: "feeVault",
        contractName: "FeeVault",
        role: "vault",
        constructorArguments: [
          { name: "owner_", type: "address", source: "ROLE:FEE_RECEIVER" },
        ],
        immutable: ["owner_"],
        controller: "ROLE:FEE_RECEIVER",
        custody: true,
      }),
    ],
    pool: { feeMode: "dynamic", lpFee: DYNAMIC_FEE_FLAG, tickSpacing: TICK_SPACING },
    hookPermissions: ["beforeSwap"],
    requiresPoolIdBeforeInitialize: false,
    requiresAgenRouter: false,
    custodyComponentId: "feeVault",
    feeClaimComponentId: null,
    oneTimeInitialization: [],
    ...over,
  };
}

function artifact(contractName: string, abi: unknown[]): ContractArtifact {
  return {
    contractName,
    sourcePath: `contracts/${contractName}.sol`,
    abi: abi as ContractArtifact["abi"],
    bytecode: "0x6080",
    deployedBytecode: "0x6080",
    compilerVersion: "0.8.26",
    sourceHash: "0x00",
    source: "",
  };
}

const constructorOf = (inputs: { name: string; type: string }[]) => ({ type: "constructor", inputs });

const setter = (name: string, argument: string, type = "address") => ({
  type: "function",
  name,
  inputs: [{ name: argument, type }],
  outputs: [],
  stateMutability: "nonpayable",
});

/** The compiled bundle matching `deployment()`. */
function artifacts(): ContractArtifact[] {
  return [
    artifact("PulseToken", [constructorOf([{ name: "recipient", type: "address" }])]),
    artifact("PulseHook", [
      constructorOf([
        { name: "manager", type: "address" },
        { name: "installer", type: "address" },
        { name: "pulseToken_", type: "address" },
      ]),
    ]),
    artifact("FeeVault", [constructorOf([{ name: "owner_", type: "address" }])]),
  ];
}

describe("materializing a declared deployment", () => {
  it("resolves every symbol against the launch it is given", () => {
    const { deployments } = materializeDeployment({
      spec: deployment(),
      artifacts: artifacts(),
      environment: ENVIRONMENT,
    });

    // The factory, not the creator, and this is the argument most worth a test. The
    // factory locks the whole supply into the launch positions before `deployMarket`
    // returns, so a token minted to the creator leaves it with nothing to lock and
    // reverts the launch after every component has already been deployed.
    expect(deployments.find((entry) => entry.componentId === "pulseToken")?.argumentValues).toEqual([
      { kind: "external", address: ENVIRONMENT.installer },
    ]);

    expect(deployments.find((entry) => entry.componentId === "pulseHook")?.argumentValues).toEqual([
      { kind: "external", address: ENVIRONMENT.poolManager },
      { kind: "external", address: ENVIRONMENT.installer },
      { kind: "component", componentId: "pulseToken" },
    ]);
  });

  it("gives a vault the owner the market declared, whichever one that is", () => {
    // The failure this replaces: one rule said every vault owner is the fee receiver, and
    // markets legitimately want three different answers. Both of these are ordinary now,
    // and neither is a guess.
    const toFeeReceiver = materializeDeployment({
      spec: deployment(),
      artifacts: artifacts(),
      environment: ENVIRONMENT,
    });

    expect(toFeeReceiver.deployments.find((entry) => entry.componentId === "feeVault")?.argumentValues).toEqual(
      [{ kind: "external", address: ENVIRONMENT.feeReceiver }],
    );

    const owned = deployment({
      components: deployment().components.map((component) =>
        component.componentId === "feeVault"
          ? {
              ...component,
              constructorArguments: [
                { name: "owner_", type: "address", source: "COMPONENT:pulseHook" as const },
              ],
              controller: "COMPONENT:pulseHook" as const,
            }
          : component,
      ),
    });

    const toSibling = materializeDeployment({
      spec: owned,
      artifacts: artifacts(),
      environment: ENVIRONMENT,
    });

    expect(toSibling.deployments.find((entry) => entry.componentId === "feeVault")?.argumentValues).toEqual([
      { kind: "component", componentId: "pulseHook" },
    ]);
  });

  it("deploys a component after whatever address it is handed", () => {
    // The vault takes the hook, so the hook has to exist first — and the order comes from
    // the arguments actually being passed rather than from the plan's statement of intent.
    const owned = deployment({
      components: deployment().components.map((component) =>
        component.componentId === "feeVault"
          ? {
              ...component,
              constructorArguments: [
                { name: "owner_", type: "address", source: "COMPONENT:pulseHook" as const },
              ],
            }
          : component,
      ),
    });

    const { deployments } = materializeDeployment({
      spec: owned,
      artifacts: artifacts(),
      environment: ENVIRONMENT,
    });

    const ids = deployments.map((entry) => entry.componentId);
    expect(ids.indexOf("pulseHook")).toBeLessThan(ids.indexOf("feeVault"));
  });

  it("refuses a market that needs a router on a chain without one", () => {
    const routed = deployment({
      components: deployment().components.map((component) =>
        component.componentId === "pulseHook"
          ? {
              ...component,
              constructorArguments: [
                { name: "manager", type: "address", source: "INFRA:POOL_MANAGER" as const },
                { name: "installer", type: "address", source: "INFRA:INSTALLER" as const },
                { name: "pulseToken_", type: "address", source: "INFRA:AGEN_ROUTER" as const },
              ],
            }
          : component,
      ),
      requiresAgenRouter: true,
    });

    // Refused rather than defaulted to zero. `AgenRouted` holds the router in an
    // immutable, so a market deployed with nothing there rejects every trade forever.
    expect(() =>
      materializeDeployment({
        spec: routed,
        artifacts: artifacts(),
        environment: { ...ENVIRONMENT, agenRouter: null },
      }),
    ).toThrow(/no router is deployed on this chain/);
  });

  it("carries a declared wiring call, including one that is not a sibling", () => {
    const wired = deployment({
      components: deployment().components.map((component) =>
        component.componentId === "pulseHook"
          ? {
              ...component,
              wiring: [
                {
                  functionName: "setFeeVault",
                  argument: "COMPONENT:feeVault" as const,
                  caller: "INSTALLER" as const,
                  phase: "before_pool_initialize" as const,
                  once: true,
                },
                {
                  functionName: "setFeeReceiver",
                  argument: "ROLE:FEE_RECEIVER" as const,
                  caller: "INSTALLER" as const,
                  phase: "before_pool_initialize" as const,
                  once: true,
                },
              ],
            }
          : component,
      ),
    });

    const { wiring } = materializeDeployment({
      spec: wired,
      artifacts: [
        artifact("PulseToken", [constructorOf([{ name: "recipient", type: "address" }])]),
        artifact("PulseHook", [
          constructorOf([
            { name: "manager", type: "address" },
            { name: "installer", type: "address" },
            { name: "pulseToken_", type: "address" },
          ]),
          setter("setFeeVault", "vault_"),
          setter("setFeeReceiver", "receiver_"),
        ]),
        artifact("FeeVault", [constructorOf([{ name: "owner_", type: "address" }])]),
      ],
      environment: ENVIRONMENT,
    });

    expect(wiring).toContainEqual({
      componentId: "pulseHook",
      functionName: "setFeeVault",
      targetComponentId: "feeVault",
      purpose: "tell PulseHook the address of FeeVault",
    });

    // A launch address rather than a sibling, which the ABI scraper could never express:
    // a one-argument address setter could only ever mean another component, because a
    // component was the only thing it was able to name.
    expect(wiring).toContainEqual({
      componentId: "pulseHook",
      functionName: "setFeeReceiver",
      address: ENVIRONMENT.feeReceiver,
      purpose: "tell PulseHook the address it was launched with",
    });
  });
});

describe("the contracts against the deployment they were written to", () => {
  it("passes a bundle that matches", () => {
    expect(deploymentParityProblems({ spec: deployment(), artifacts: artifacts() })).toEqual([]);
  });

  it("catches a constructor that grew an argument nobody declared", () => {
    const found = deploymentParityProblems({
      spec: deployment(),
      artifacts: [
        artifact("PulseToken", [constructorOf([{ name: "recipient", type: "address" }])]),
        artifact("PulseHook", [
          constructorOf([
            { name: "manager", type: "address" },
            { name: "installer", type: "address" },
            { name: "pulseToken_", type: "address" },
            { name: "feeReceiver_", type: "address" },
          ]),
        ]),
        artifact("FeeVault", [constructorOf([{ name: "owner_", type: "address" }])]),
      ],
    });

    // The whole class of failure this replaces: a contract whose creation code takes an
    // argument the launch has no value for. It used to be discovered by the launch.
    expect(found.join("\n")).toMatch(/PulseHook: the deployment declares a constructor taking/);
    expect(found.join("\n")).toContain("feeReceiver_");
  });

  it("catches an argument of the wrong type in the right position", () => {
    const found = deploymentParityProblems({
      spec: deployment(),
      artifacts: [
        artifact("PulseToken", [constructorOf([{ name: "recipient", type: "address" }])]),
        artifact("PulseHook", [
          constructorOf([
            { name: "manager", type: "address" },
            { name: "installer", type: "address" },
            { name: "pulseToken_", type: "bytes32" },
          ]),
        ]),
        artifact("FeeVault", [constructorOf([{ name: "owner_", type: "address" }])]),
      ],
    });

    expect(found.join("\n")).toMatch(/argument 3 is declared `address pulseToken_`/);
  });

  it("catches the same value under two names", () => {
    const found = deploymentParityProblems({
      spec: deployment(),
      artifacts: [
        artifact("PulseToken", [constructorOf([{ name: "mintTo", type: "address" }])]),
        ...artifacts().slice(1),
      ],
    });

    expect(found.join("\n")).toMatch(/declared `recipient` and the contract calls it `mintTo`/);
  });

  /**
   * The underscore is punctuation, not meaning.
   *
   * `recipient_` is the ordinary way to write a constructor parameter that would otherwise
   * shadow the state variable it initialises. CNPY was refused outright for exactly this — its
   * record said `token`, its constructor said `token_` — after every contract had compiled and
   * the deployment graph had been proven materializable.
   */
  it.each(["recipient_", "_recipient"])("accepts %s as the name the record calls recipient", (name) => {
    expect(
      deploymentParityProblems({
        spec: deployment(),
        artifacts: [
          artifact("PulseToken", [constructorOf([{ name, type: "address" }])]),
          ...artifacts().slice(1),
        ],
      }),
    ).toEqual([]);
  });

  it("catches a wiring call the contract does not have", () => {
    const wired = deployment({
      components: deployment().components.map((component) =>
        component.componentId === "pulseHook"
          ? {
              ...component,
              wiring: [
                {
                  functionName: "setFeeVault",
                  argument: "COMPONENT:feeVault" as const,
                  caller: "INSTALLER" as const,
                  phase: "before_pool_initialize" as const,
                  once: true,
                },
              ],
            }
          : component,
      ),
    });

    expect(deploymentParityProblems({ spec: wired, artifacts: artifacts() }).join("\n")).toMatch(
      /the launch calls setFeeVault and the contract has no such function/,
    );
  });

  it("catches a setter taking more than the launch can pass", () => {
    const wired = deployment({
      components: deployment().components.map((component) =>
        component.componentId === "pulseHook"
          ? {
              ...component,
              wiring: [
                {
                  functionName: "setLaunchConfig",
                  argument: "COMPONENT:feeVault" as const,
                  caller: "INSTALLER" as const,
                  phase: "before_pool_initialize" as const,
                  once: true,
                },
              ],
            }
          : component,
      ),
    });

    const found = deploymentParityProblems({
      spec: wired,
      artifacts: [
        artifact("PulseToken", [constructorOf([{ name: "recipient", type: "address" }])]),
        artifact("PulseHook", [
          constructorOf([
            { name: "manager", type: "address" },
            { name: "installer", type: "address" },
            { name: "pulseToken_", type: "address" },
          ]),
          {
            type: "function",
            name: "setLaunchConfig",
            inputs: [
              { name: "vault_", type: "address" },
              { name: "sellFeePpm_", type: "uint24" },
            ],
            outputs: [],
            stateMutability: "nonpayable",
          },
        ]),
        artifact("FeeVault", [constructorOf([{ name: "owner_", type: "address" }])]),
      ],
    });

    // ORBIT's failure, caught before a single behaviour test runs: the market expected its
    // fee installed at launch, the launch had no value to pass, and it opened at zero.
    expect(found.join("\n")).toMatch(/takes 2 arguments and a wiring call carries exactly one/);
    expect(found.join("\n")).toMatch(/belongs in the contract as a constant/);
  });

  it("refuses to materialize a bundle that does not match", () => {
    // The materializer repeats the parity check and throws, because producing a bundle
    // from a declaration the contracts no longer satisfy would be the original bug with
    // extra steps.
    expect(() =>
      materializeDeployment({
        spec: deployment(),
        artifacts: [
          artifact("PulseToken", [constructorOf([{ name: "recipient", type: "address" }])]),
          artifact("PulseHook", [constructorOf([{ name: "manager", type: "address" }])]),
          artifact("FeeVault", [constructorOf([{ name: "owner_", type: "address" }])]),
        ],
        environment: ENVIRONMENT,
      }),
    ).toThrow(/do not match the deployment this market declared/);
  });
});

describe("assembling a launch", () => {
  const wiredDeployment = () =>
    deployment({
      components: deployment().components.map((component) =>
        component.componentId === "pulseHook"
          ? {
              ...component,
              wiring: [
                {
                  functionName: "setFeeVault",
                  argument: "COMPONENT:feeVault" as const,
                  caller: "INSTALLER" as const,
                  phase: "before_pool_initialize" as const,
                  once: true,
                },
              ],
            }
          : component,
      ),
    });

  const wiredArtifacts = () => [
    artifact("PulseToken", [constructorOf([{ name: "recipient", type: "address" }])]),
    artifact("PulseHook", [
      constructorOf([
        { name: "manager", type: "address" },
        { name: "installer", type: "address" },
        { name: "pulseToken_", type: "address" },
      ]),
      setter("setFeeVault", "vault_"),
    ]),
    artifact("FeeVault", [constructorOf([{ name: "owner_", type: "address" }])]),
  ];

  it("derives and wires the exact PoolId before initialization", () => {
    const poolBound = deployment({
      components: deployment().components.map((component) =>
        component.componentId === "pulseHook"
          ? {
              ...component,
              wiring: [
                {
                  functionName: "bindPoolId",
                  argument: "POOL_ID" as const,
                  caller: "INSTALLER" as const,
                  phase: "before_pool_initialize" as const,
                  once: true,
                },
              ],
            }
          : component,
      ),
      requiresPoolIdBeforeInitialize: true,
    });

    const manifest = assembleManifest({
      plan: plan(),
      deployment: poolBound,
      artifacts: [
        artifact("PulseToken", [constructorOf([{ name: "recipient", type: "address" }])]),
        artifact("PulseHook", [
          constructorOf([
            { name: "manager", type: "address" },
            { name: "installer", type: "address" },
            { name: "pulseToken_", type: "address" },
          ]),
          setter("bindPoolId", "poolId_", "bytes32"),
        ]),
        artifact("FeeVault", [constructorOf([{ name: "owner_", type: "address" }])]),
      ],
      environment: ENVIRONMENT,
      specificationHash: `0x${"11".repeat(32)}`,
      implementationHash: `0x${"22".repeat(32)}`,
      quoteAsset: "0x0000000000000000000000000000000000000000",
      lpFee: DYNAMIC_FEE_FLAG,
      initialTick: 161_000,
      feeReceiver: ENVIRONMENT.feeReceiver,
      marketSalt: marketSaltFor("pool-wiring"),
      deployerAddress: "0x5555555555555555555555555555555555555555",
    });

    const token = manifest.components.find((component) => component.componentId === "pulseToken")!;
    const hook = manifest.components.find((component) => component.componentId === "pulseHook")!;
    const expectedPoolId = poolIdFor({
      quoteAsset: "0x0000000000000000000000000000000000000000",
      token: token.expected,
      lpFee: DYNAMIC_FEE_FLAG,
      hook: hook.expected,
    });

    expect(manifest.wiring).toHaveLength(1);
    expect(manifest.wiring[0]?.data.toLowerCase()).toContain(expectedPoolId.slice(2).toLowerCase());
  });

  it("encodes wiring against the addresses the manifest predicted", () => {
    const vault = "0x4444444444444444444444444444444444444444" as const;

    const calls = encodeWiring({
      intents: [
        {
          componentId: "pulseHook",
          functionName: "setFeeVault",
          targetComponentId: "feeVault",
          purpose: "tell PulseHook the address of FeeVault",
        },
      ],
      components: [
        { componentId: "pulseHook", contractName: "PulseHook", expected: "0x5555555555555555555555555555555555555555" },
        { componentId: "feeVault", contractName: "FeeVault", expected: vault },
      ],
      artifacts: [artifact("PulseHook", [setter("setFeeVault", "vault_")])],
    });

    expect(calls[0]?.data.startsWith("0x")).toBe(true);
    expect(calls[0]?.data.toLowerCase()).toContain(vault.slice(2).toLowerCase());
  });

  it("assembles a whole launch, wiring included, without moving an address", () => {
    const manifest = assembleManifest({
      plan: plan(),
      deployment: wiredDeployment(),
      artifacts: wiredArtifacts(),
      environment: ENVIRONMENT,
      specificationHash: `0x${"11".repeat(32)}`,
      implementationHash: `0x${"22".repeat(32)}`,
      quoteAsset: "0x0000000000000000000000000000000000000000",
      lpFee: DYNAMIC_FEE_FLAG,
      initialTick: 161_000,
      feeReceiver: ENVIRONMENT.creator,
      marketSalt: marketSaltFor("a-job"),
      deployerAddress: "0x5555555555555555555555555555555555555555",
    });

    const vault = manifest.components.find((component) => component.componentId === "feeVault")!;
    expect(manifest.wiring).toHaveLength(1);
    expect(manifest.wiring[0]?.data.toLowerCase()).toContain(vault.expected.slice(2).toLowerCase());
    expect(manifest.wiring[0]?.componentIndex).toBe(
      manifest.components.findIndex((component) => component.componentId === "pulseHook"),
    );

    // Same build, same creator, same addresses. This is what makes a launch that was
    // rejected by a wallet safe to sign again.
    const again = assembleManifest({
      plan: plan(),
      deployment: wiredDeployment(),
      artifacts: wiredArtifacts(),
      environment: ENVIRONMENT,
      specificationHash: `0x${"11".repeat(32)}`,
      implementationHash: `0x${"22".repeat(32)}`,
      quoteAsset: "0x0000000000000000000000000000000000000000",
      // A different valuation, fee and fee receiver: none of the three is in any
      // component's creation code, so none of them may move anything.
      lpFee: 0,
      initialTick: 120_000,
      feeReceiver: "0x8888888888888888888888888888888888888888",
      marketSalt: marketSaltFor("a-job"),
      deployerAddress: "0x5555555555555555555555555555555555555555",
    });

    expect(again.components.map((component) => component.expected)).toEqual(
      manifest.components.map((component) => component.expected),
    );
  });

  it("deploys in the order the deployment graph requires, not the order the plan listed", () => {
    // The plan says the vault depends on nothing, so its own ordering would place it
    // wherever it likes. The deployment says the vault takes the hook's address, and that
    // is what CREATE2 has to respect — a fixture and a launch disagreeing about this is a
    // market that deploys in Foundry and reverts on a chain.
    const owned = deployment({
      components: deployment().components.map((component) =>
        component.componentId === "feeVault"
          ? {
              ...component,
              constructorArguments: [
                { name: "owner_", type: "address", source: "COMPONENT:pulseHook" as const },
              ],
              controller: "COMPONENT:pulseHook" as const,
            }
          : component,
      ),
    });

    const manifest = assembleManifest({
      plan: plan(),
      deployment: owned,
      artifacts: artifacts(),
      environment: ENVIRONMENT,
      specificationHash: `0x${"11".repeat(32)}`,
      implementationHash: `0x${"22".repeat(32)}`,
      quoteAsset: "0x0000000000000000000000000000000000000000",
      lpFee: DYNAMIC_FEE_FLAG,
      initialTick: 161_000,
      feeReceiver: ENVIRONMENT.feeReceiver,
      marketSalt: marketSaltFor("ordered"),
      deployerAddress: "0x5555555555555555555555555555555555555555",
    });

    const ids = manifest.components.map((component) => component.componentId);
    expect(ids.indexOf("pulseHook")).toBeLessThan(ids.indexOf("feeVault"));
  });

  it("says which component is missing rather than encoding a call to nowhere", () => {
    const orphaned = encodeWiring.bind(null, {
      intents: [
        {
          componentId: "pulseHook",
          functionName: "setFeeVault",
          targetComponentId: "feeVault",
          purpose: "tell PulseHook the address of FeeVault",
        },
      ],
      components: [
        { componentId: "pulseHook", contractName: "PulseHook", expected: "0x5555555555555555555555555555555555555555" },
      ],
      artifacts: [artifact("PulseHook", [setter("setFeeVault", "vault_")])],
    });

    expect(orphaned).toThrow(/feeVault is not in the manifest/);
  });
});
