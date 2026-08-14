import { describe, expect, it } from "vitest";
import {
  decodeAbiParameters,
  encodeAbiParameters,
  parseAbiParameters,
  type Abi,
  type Address,
} from "viem";

import type { ContractArtifact } from "./artifacts.js";
import { HOOK_ADDRESS_MASK } from "./gates.js";
import {
  buildManifest,
  CURVE,
  deploymentSequence,
  DYNAMIC_FEE_FLAG,
  initialTickProblem,
  ManifestError,
  ROLE,
  saltFor,
  toFactoryArguments,
} from "./manifest.js";
import { permissionBits, permissionsOf } from "./mining.js";
import type { MarketImplementationPlan } from "./plan.js";

const CREATOR: Address = "0x1111111111111111111111111111111111111111";
const MARKET_SALT = `0x${"22".repeat(32)}` as const;
const POOL_MANAGER: Address = "0x3333333333333333333333333333333333333333";
/** Stands in for `AgenDeployer`, which runs every `create2` in a real bundle. */
const DEPLOYER: Address = "0x4444444444444444444444444444444444444444";
/** A billion tokens at roughly a hundred ether, and on `AgenCurve`'s grid. */
const INITIAL_TICK = 161_000;

/**
 * `AgenFactory.Manifest`, written out as the ABI sees it.
 *
 * A second copy of the struct, on purpose. `toFactoryArguments` produces an object and
 * an object cannot be wrong about field order; calldata can, and this is the shape the
 * chain reads. If the struct in `AgenFactory.sol` changes, this line has to change with
 * it, and the test below stops passing until it does.
 */
const [MANIFEST_PARAMETERS] = parseAbiParameters(
  "(bytes32 specificationHash, bytes32 implementationHash, string metadataURI, " +
    "address quoteAsset, uint24 lpFee, int24 initialTick, address feeReceiver, " +
    "uint128 devBuyAmount, uint128 devBuyMinTokens, uint16 hookIndex, uint16 tokenIndex, " +
    "(bytes32 salt, address expected, uint8 role, bytes initCode)[] components, " +
    "(uint16 componentIndex, bytes data)[] wiring)",
);

/** Distinct, non-empty creation codes; the bytes only have to differ from each other. */
function artifact(name: string, byte: string, abi: Abi = []): ContractArtifact {
  return {
    contractName: name,
    sourcePath: `contracts/${name}.sol`,
    abi,
    bytecode: `0x60${byte}6000${byte}`,
    deployedBytecode: `0x60${byte}`,
    compilerVersion: "0.8.26+commit.8a97fa7a",
    sourceHash: `0x${"00".repeat(32)}`,
    source: `contract ${name} {}`,
  };
}

const CONSTRUCTOR: Abi = [{ type: "constructor", inputs: [{ name: "manager", type: "address" }], stateMutability: "nonpayable" }];

function plan(): MarketImplementationPlan {
  return {
    version: 1,
    specificationVersion: 1,
    approach: "A hook crediting a vault",
    components: [
      {
        id: "rewardVault",
        contractName: "RewardVault",
        role: "vault",
        purpose: "Holds surcharge revenue",
        requiredBy: ["large-sell-surcharge"],
        dependsOn: [],
        custodial: true,
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
        purpose: "Observes swaps",
        requiredBy: ["large-sell-surcharge"],
        dependsOn: ["rewardVault"],
        hookPermissions: ["beforeSwap", "afterSwap"],
      },
    ],
    dependencies: [],
    adaptations: [],
  };
}

function build(overrides: Partial<Parameters<typeof buildManifest>[0]> = {}) {
  return buildManifest({
    plan: plan(),
    artifacts: [
      artifact("RewardVault", "aa"),
      artifact("MarketToken", "bb"),
      artifact("MarketHook", "cc", CONSTRUCTOR),
    ],
    deployments: [
      {
        componentId: "marketHook",
        argumentTypes: ["address"],
        argumentValues: [{ kind: "component", componentId: "rewardVault" }],
      },
    ],
    specificationHash: `0x${"11".repeat(32)}`,
    implementationHash: `0x${"22".repeat(32)}`,
    metadataURI: "ipfs://market",
    quoteAsset: "0x0000000000000000000000000000000000000000",
    lpFee: DYNAMIC_FEE_FLAG,
    initialTick: INITIAL_TICK,
    feeReceiver: CREATOR,
    creator: CREATOR,
    marketSalt: MARKET_SALT,
    deployerAddress: DEPLOYER,
    ...overrides,
  });
}

describe("building a deployable bundle", () => {
  it("orders components so each one's dependencies come first", () => {
    const manifest = build();

    const sequence = deploymentSequence(manifest);
    expect(sequence.indexOf("rewardVault")).toBeLessThan(sequence.indexOf("marketHook"));
    expect(manifest.components).toHaveLength(3);
  });

  it("mines the hook onto an address carrying exactly its declared permissions", () => {
    const manifest = build();
    const hook = manifest.components[manifest.hookIndex]!;

    expect(BigInt(hook.expected) & HOOK_ADDRESS_MASK).toBe(
      permissionBits(["beforeSwap", "afterSwap"]),
    );
    expect(permissionsOf(hook.expected)).toEqual(["beforeSwap", "afterSwap"]);
  });

  it("resolves a constructor argument to a component deployed before it", () => {
    const manifest = build();

    const vault = manifest.components.find((component) => component.componentId === "rewardVault")!;
    const hook = manifest.components[manifest.hookIndex]!;

    // The vault's address is inside the hook's creation code, which is why the hook's
    // address depends on it and why the order is not negotiable.
    expect(hook.initCode.toLowerCase()).toContain(vault.expected.slice(2).toLowerCase());
  });

  it("is reproducible: the same inputs give the same addresses", () => {
    const first = build();
    const second = build();

    expect(second.components.map((c) => c.expected)).toEqual(
      first.components.map((c) => c.expected),
    );
  });

  it("gives two creators different addresses for identical bytecode", () => {
    const mine = build();
    const theirs = build({ creator: "0x9999999999999999999999999999999999999999" });

    const token = (m: typeof mine) => m.components.find((c) => c.componentId === "marketToken")!;
    expect(token(theirs).expected).not.toBe(token(mine).expected);

    // Hook mining is explicitly namespaced by creator, market and component. It must
    // move even when two markets use byte-identical hook creation code; otherwise the
    // second deployment through the shared AgenDeployer would collide with the first.
    expect(mine.components[mine.hookIndex]!.expected).not.toBe(
      theirs.components[theirs.hookIndex]!.expected,
    );

    // Both are still valid hook addresses, which is the property mining exists for.
    for (const manifest of [mine, theirs]) {
      expect(BigInt(manifest.components[manifest.hookIndex]!.expected) & HOOK_ADDRESS_MASK).toBe(
        permissionBits(["beforeSwap", "afterSwap"]),
      );
    }
  });

  it("labels roles the way the registry does", () => {
    const manifest = build();

    expect(manifest.components[manifest.hookIndex]!.role).toBe(ROLE["hook"]);
    expect(manifest.components[manifest.tokenIndex]!.role).toBe(ROLE["token"]);
    expect(manifest.components.find((c) => c.componentId === "rewardVault")!.role).toBe(ROLE["vault"]);
  });

  it("opens the pool at the fee it was given, rather than one it chose", () => {
    // This used to be hardcoded to the dynamic flag, which is right for a hook that
    // sets its own fee and a reverted launch for one that refuses a dynamic pool. The
    // value comes from reading the hook now; the builder's job is to carry it.
    expect(build().lpFee).toBe(DYNAMIC_FEE_FLAG);
    expect(build({ lpFee: 0 }).lpFee).toBe(0);
    expect(build({ lpFee: 3_000 }).lpFee).toBe(3_000);
  });

  it("refuses a pool fee no pool could have", () => {
    expect(() => build({ lpFee: 2_000_000 })).toThrow(/not a pool fee/);
    expect(() => build({ lpFee: -1 })).toThrow(/not a pool fee/);
  });

  it("carries the launch the creator chose, in the struct's own order", () => {
    const manifest = build({
      initialTick: 161_000,
      feeReceiver: "0x7777777777777777777777777777777777777777",
      devBuyAmount: 5n * 10n ** 17n,
      devBuyMinTokens: 1_000n,
    });

    const [argument] = toFactoryArguments(manifest);

    // Decoded back out of the ABI encoding rather than compared field by field. The
    // struct is positional, so two same-typed fields transposed — devBuyAmount against
    // devBuyMinTokens is the pair that would hurt — produce an object that looks right
    // and calldata that is not. This is the only check that would notice.
    const encoded = encodeAbiParameters(
      [MANIFEST_PARAMETERS],
      [argument as never],
    );
    const [decoded] = decodeAbiParameters([MANIFEST_PARAMETERS], encoded) as [
      Record<string, unknown>,
    ];

    expect(decoded["initialTick"]).toBe(161_000);
    expect(decoded["feeReceiver"]).toBe("0x7777777777777777777777777777777777777777");
    expect(decoded["devBuyAmount"]).toBe(5n * 10n ** 17n);
    expect(decoded["devBuyMinTokens"]).toBe(1_000n);
    expect(decoded["lpFee"]).toBe(0x800000);
  });

  it("derives salts that differ per component and per market", () => {
    const one = saltFor({ creator: CREATOR, marketSalt: MARKET_SALT, componentId: "a" });
    const two = saltFor({ creator: CREATOR, marketSalt: MARKET_SALT, componentId: "b" });
    const other = saltFor({
      creator: CREATOR,
      marketSalt: `0x${"33".repeat(32)}`,
      componentId: "a",
    });

    expect(two).not.toBe(one);
    expect(other).not.toBe(one);
  });
});

describe("bundles that cannot be built", () => {
  it("refuses a plan naming a contract nothing compiled", () => {
    expect(() =>
      build({ artifacts: [artifact("RewardVault", "aa"), artifact("MarketToken", "bb")] }),
    ).toThrow(/no compiled artefact has that name/);
  });

  it("refuses an artefact with empty creation code", () => {
    expect(() =>
      build({
        artifacts: [
          artifact("RewardVault", "aa"),
          artifact("MarketToken", "bb"),
          { ...artifact("MarketHook", "cc", CONSTRUCTOR), bytecode: "0x" },
        ],
      }),
    ).toThrow(/empty creation code/);
  });

  it("refuses a constructor argument naming a component that comes later", () => {
    // The vault asking for the hook's address, which is mined after it: a cycle in
    // everything but name.
    const cyclic = plan();
    expect(() =>
      build({
        plan: cyclic,
        deployments: [
          {
            componentId: "rewardVault",
            argumentTypes: ["address"],
            argumentValues: [{ kind: "component", componentId: "marketHook" }],
          },
        ],
      }),
    ).toThrow(/not deployed before it/);
  });

  it("refuses a contract whose constructor was given no arguments", () => {
    expect(() => build({ deployments: [] })).toThrow(/has a constructor but no arguments/);
  });

  it("refuses a token that would not sort above the quote asset", () => {
    expect(() =>
      build({ quoteAsset: "0xffffffffffffffffffffffffffffffffffffffff" }),
    ).toThrow(/does not sort above the quote asset/);
  });

  it("refuses a bundle with no hook", () => {
    const hookless = plan();
    expect(() =>
      build({
        plan: { ...hookless, components: hookless.components.slice(0, 2) },
        deployments: [],
      }),
    ).toThrow(ManifestError);
  });

  it("refuses an opening tick off AgenCurve's grid, before a creator pays for it", () => {
    expect(() => build({ initialTick: 161_001 })).toThrow(/multiple of 200/);
    expect(() => build({ initialTick: 900_000 })).toThrow(/at most 887200/);
    // A tick so low that the middle band's floor would sit at or below the tail's.
    expect(() => build({ initialTick: -880_000 })).toThrow(/room below it/);
  });

  it("agrees with AgenCurve about which ticks are launchable", () => {
    expect(initialTickProblem(CURVE.maxUsableTick)).toBeNull();
    expect(initialTickProblem(CURVE.minUsableTick + CURVE.middleWidth)).not.toBeNull();
    expect(initialTickProblem(CURVE.minUsableTick + CURVE.middleWidth + CURVE.tickSpacing)).toBeNull();
    expect(initialTickProblem(0)).toBeNull();
  });

  it("refuses a launch buy on a market whose hook would reject it", () => {
    // EMBER's shape: the buy is not merely unwise here, it reverts the whole launch.
    // Refused while it is still an object rather than after it is a signature.
    expect(() =>
      build({ devBuyAmount: 10n ** 18n, atomicDevBuySupported: false }),
    ).toThrow(/does not come through its own route|refuses swaps/);

    // And the same market launches perfectly well without one.
    expect(build({ devBuyAmount: 0n, atomicDevBuySupported: false }).devBuyAmount).toBe(0n);
  });

  it("refuses a market with nowhere to pay its fees", () => {
    expect(() =>
      build({ feeReceiver: "0x0000000000000000000000000000000000000000" }),
    ).toThrow(/pay its trading fees/);
  });

  it("accepts an external address as a constructor argument", () => {
    const manifest = build({
      deployments: [
        {
          componentId: "marketHook",
          argumentTypes: ["address"],
          argumentValues: [{ kind: "external", address: POOL_MANAGER }],
        },
      ],
    });

    const hook = manifest.components[manifest.hookIndex]!;
    expect(hook.initCode.toLowerCase()).toContain(POOL_MANAGER.slice(2).toLowerCase());
  });
});
