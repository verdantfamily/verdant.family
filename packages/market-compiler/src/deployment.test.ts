import { describe, expect, it } from "vitest";

import { DYNAMIC_FEE_FLAG } from "@verdant/config";

import type { ContractArtifact } from "./artifacts.js";
import {
  assembleManifest,
  encodeWiring,
  marketSaltFor,
  resolveDeployment,
  type DeploymentEnvironment,
} from "./deployment.js";
import type { MarketImplementationPlan } from "./plan.js";

const ENVIRONMENT: DeploymentEnvironment = {
  poolManager: "0x1111111111111111111111111111111111111111",
  installer: "0x2222222222222222222222222222222222222222",
  creator: "0x3333333333333333333333333333333333333333",
  feeReceiver: "0x4444444444444444444444444444444444444444",
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
        dependsOn: [],
      },
      {
        id: "pulseHook",
        contractName: "PulseHook",
        role: "hook",
        purpose: "Charges the fee and tracks the streak",
        requiredBy: ["base-fee"],
        dependsOn: ["pulseToken"],
        hookPermissions: ["beforeSwap"],
      },
      {
        id: "feeVault",
        contractName: "FeeVault",
        role: "vault",
        purpose: "Holds the fees",
        requiredBy: ["base-fee"],
        dependsOn: [],
      },
    ],
    dependencies: [],
    adaptations: [],
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

const setter = (name: string, argument: string) => ({
  type: "function",
  name,
  inputs: [{ name: argument, type: "address" }],
  outputs: [],
  stateMutability: "nonpayable",
});

describe("working out how a generated market is deployed", () => {
  it("places the arguments a launch actually knows", () => {
    const { deployments } = resolveDeployment({
      plan: plan(),
      artifacts: [
        artifact("PulseToken", [
          constructorOf([
            { name: "name_", type: "string" },
            { name: "symbol_", type: "string" },
            { name: "totalSupply_", type: "uint256" },
            { name: "recipient", type: "address" },
          ]),
        ]),
        artifact("PulseHook", [
          constructorOf([
            { name: "manager", type: "address" },
            { name: "installer", type: "address" },
            { name: "pulseToken_", type: "address" },
          ]),
        ]),
        artifact("FeeVault", [constructorOf([{ name: "owner_", type: "address" }])]),
      ],
      environment: ENVIRONMENT,
    });

    const token = deployments.find((entry) => entry.componentId === "pulseToken");
    expect(token?.argumentValues).toEqual([
      { kind: "value", value: "Pulse" },
      { kind: "value", value: "PULSE" },
      // Whole tokens become base units here, once, rather than in each generated token.
      { kind: "value", value: 1_000_000_000n * 10n ** 18n },
      // The factory, not the creator, and this is the argument most worth a test. The
      // factory locks the whole supply into the launch positions before `deployMarket`
      // returns, so a token minted to the creator leaves it with nothing to lock and
      // reverts the launch after every component has already been deployed. The
      // recipient is baked into the token's creation code, so nothing downstream can
      // correct it.
      { kind: "external", address: ENVIRONMENT.installer },
    ]);

    const hook = deployments.find((entry) => entry.componentId === "pulseHook");
    expect(hook?.argumentValues).toEqual([
      { kind: "external", address: ENVIRONMENT.poolManager },
      { kind: "external", address: ENVIRONMENT.installer },
      // The token is deployed before the hook, so its address is a constructor argument
      // rather than something to wire afterwards.
      { kind: "component", componentId: "pulseToken" },
    ]);

    // Everything else keeps the creator. Only the token's recipient is special, because
    // only the token's supply has to pass through the factory on its way to the pool.
    const vault = deployments.find((entry) => entry.componentId === "feeVault");
    expect(vault?.argumentValues).toEqual([{ kind: "external", address: ENVIRONMENT.creator }]);
  });

  it("pays a fee receiver to the fee receiver, not to the creator", () => {
    // The real one, and it cost a live build to find. A generated EMBER accounting
    // contract took `address feeReceiver_`, which nothing in the vocabulary answered —
    // the market compiled, passed its tests and its gates, and was refused as
    // undeployable at the last stage. "The fees go to the fee receiver" is the most
    // common sentence in a specification, so this was not an unusual market.
    //
    // The distinction from the creator matters and is not cosmetic. A component holding
    // this takes it in an immutable, so a creator who points their fees at a splitter or
    // a multisig and silently gets their own wallet baked in has a market that pays the
    // wrong address for as long as it trades, with no way to correct it.
    const { deployments } = resolveDeployment({
      plan: plan(),
      artifacts: [
        artifact("PulseToken", [constructorOf([{ name: "recipient", type: "address" }])]),
        artifact("PulseHook", [constructorOf([{ name: "manager", type: "address" }])]),
        artifact("FeeVault", [
          constructorOf([
            { name: "feeReceiver_", type: "address" },
            // Not about fees, so it stays with the creator: a bare receiver on some
            // other component is not necessarily about money.
            { name: "receiver_", type: "address" },
          ]),
        ]),
      ],
      environment: ENVIRONMENT,
    });

    const vault = deployments.find((entry) => entry.componentId === "feeVault");
    expect(vault?.argumentValues).toEqual([
      { kind: "external", address: ENVIRONMENT.feeReceiver },
      { kind: "external", address: ENVIRONMENT.creator },
    ]);
  });

  it("refuses an argument nothing can supply, naming it", () => {
    // The real one. A generated PULSE hook asked for the id of the pool it would be the
    // hook for — which is derived from the pool key, which names the hook, which is the
    // contract being constructed. It had passed every gate; a manifest built by guessing
    // would have deployed a market whose immutable pool id was zero.
    const broken = resolveDeployment.bind(null, {
      plan: plan(),
      artifacts: [
        artifact("PulseToken", [constructorOf([{ name: "recipient", type: "address" }])]),
        artifact("PulseHook", [
          constructorOf([
            { name: "manager", type: "address" },
            { name: "designatedPoolId_", type: "bytes32" },
          ]),
        ]),
        artifact("FeeVault", [constructorOf([{ name: "owner_", type: "address" }])]),
      ],
      environment: ENVIRONMENT,
    });

    expect(broken).toThrow(/designatedPoolId/);
    expect(broken).toThrow(/PulseHook/);
  });

  it("reports every unresolvable argument at once, not just the first", () => {
    const broken = resolveDeployment.bind(null, {
      plan: plan(),
      artifacts: [
        artifact("PulseToken", [constructorOf([{ name: "oracle", type: "address" }])]),
        artifact("PulseHook", [constructorOf([{ name: "threshold", type: "uint256" }])]),
        artifact("FeeVault", [constructorOf([{ name: "owner_", type: "address" }])]),
      ],
      environment: ENVIRONMENT,
    });

    expect(broken).toThrow(/oracle[\s\S]*threshold|threshold[\s\S]*oracle/);
  });

  it("turns a setter for a later component into wiring rather than an argument", () => {
    // The vault is deployed after the hook, so the hook cannot take its address in the
    // constructor. That is the cycle CREATE2 does not untie.
    const { wiring } = resolveDeployment({
      plan: plan(),
      artifacts: [
        artifact("PulseToken", [constructorOf([{ name: "recipient", type: "address" }])]),
        artifact("PulseHook", [
          constructorOf([{ name: "manager", type: "address" }]),
          setter("setFeeVault", "feeVault_"),
        ]),
        artifact("FeeVault", [constructorOf([{ name: "owner_", type: "address" }])]),
      ],
      environment: ENVIRONMENT,
    });

    expect(wiring).toEqual([
      {
        componentId: "pulseHook",
        functionName: "setFeeVault",
        targetComponentId: "feeVault",
        purpose: "tell PulseHook the address of FeeVault",
      },
    ]);
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
      artifacts: [artifact("PulseHook", [setter("setFeeVault", "feeVault_")])],
    });

    // setFeeVault(address) against the predicted vault, and nothing left to fill in.
    expect(calls[0]?.data.startsWith("0x")).toBe(true);
    expect(calls[0]?.data.toLowerCase()).toContain(vault.slice(2).toLowerCase());
  });

  it("assembles a whole launch, wiring included, without moving an address", () => {
    const artifacts = [
      artifact("PulseToken", [constructorOf([{ name: "recipient", type: "address" }])]),
      artifact("PulseHook", [
        constructorOf([{ name: "manager", type: "address" }]),
        setter("setFeeVault", "feeVault_"),
      ]),
      artifact("FeeVault", [constructorOf([{ name: "owner_", type: "address" }])]),
    ];

    const manifest = assembleManifest({
      plan: plan(),
      artifacts,
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

    // The setter the vault's lateness forced, now carrying an address that did not
    // exist when the intent was recorded.
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
      artifacts,
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
      artifacts: [artifact("PulseHook", [setter("setFeeVault", "feeVault_")])],
    });

    expect(orphaned).toThrow(/feeVault is not in the manifest/);
  });
});
