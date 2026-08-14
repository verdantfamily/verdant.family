/**
 * Turning compiled artefacts into something `AgenFactory` can execute.
 *
 * The factory deploys a list and asserts each entry landed where it was told. Deciding
 * *where* is this file's job, and it has to be done entirely off-chain because a
 * component's constructor arguments are baked into its creation code: by the time the
 * bytes exist, every address they mention is already fixed. So the addresses are
 * computed first, in dependency order, and the bundle is only assembled once all of
 * them are known.
 *
 * ## The hook is mined, everything else is derived
 *
 * Uniswap reads a hook's permissions out of the low fourteen bits of its address, so
 * the hook's salt is searched until the address carries exactly the bits the contract
 * implements. Every other component's salt is derived from the creator and the market,
 * because there is nothing to satisfy and a derived salt keeps the whole bundle
 * reproducible from the manifest.
 *
 * ## The cycle this cannot resolve, stated plainly
 *
 * If a vault's constructor needs the hook's address and the hook's constructor needs
 * the vault's, no ordering exists. Mining makes it worse: the hook's address depends on
 * its own creation code, which would depend on the vault, which depends on the hook.
 * `buildManifest` refuses that rather than looping, and the way out belongs in the
 * plan — one side takes the other's address after deployment through a one-time setter,
 * or the pair is merged. Pretending to resolve it would produce a bundle whose
 * addresses are wrong in a way that only appears at deployment.
 */

import {
  AGEN_BAND_WIDTHS,
  DYNAMIC_FEE_FLAG,
  MAX_LP_FEE_PPM,
  MAX_USABLE_TICK,
  MIN_USABLE_TICK,
  TICK_SPACING,
} from "@verdant/config";
import type { Abi, Address, Hex } from "viem";
import { concatHex, encodeAbiParameters, keccak256, toHex } from "viem";

import type { ContractArtifact } from "./artifacts.js";
import type { DeploymentSpecification } from "./deployment-spec.js";
import type { FeeMode } from "./feemode.js";
import type { HookPermission } from "./gates.js";
import { mineHookAddress, permissionBits } from "./mining.js";
import type { MarketComponent, MarketImplementationPlan } from "./plan.js";
import { deploymentOrder } from "./plan.js";

/** Native ether, as v4 spells it: the quote asset of every Agen market so far. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** How a component's constructor arguments are described before addresses exist. */
export type ConstructorArgument =
  /** A literal, already in the right ABI type. */
  | { readonly kind: "value"; readonly value: string | bigint | boolean }
  /** The address of another component in this bundle, resolved during planning. */
  | { readonly kind: "component"; readonly componentId: string }
  /** The address of something already deployed: the PoolManager, a quote asset. */
  | { readonly kind: "external"; readonly address: Address };

export interface ComponentDeployment {
  readonly componentId: string;
  /** ABI types for the constructor, in order. Empty when there is no constructor. */
  readonly argumentTypes: readonly string[];
  readonly argumentValues: readonly ConstructorArgument[];
}

/** What the on-chain `AgenFactory.Component` needs. */
export interface ManifestComponent {
  readonly componentId: string;
  readonly contractName: string;
  readonly salt: Hex;
  readonly expected: Address;
  /** Matches `AgenMarketRegistry`'s role constants. */
  readonly role: number;
  readonly initCode: Hex;
}

/**
 * A call made after every component exists.
 *
 * The escape from a mutual construction dependency. Two contracts that each need the
 * other's address cannot both be placed by prediction — the cycle is in the init code,
 * and CREATE2 does not untie it — so one is deployed without the other's address and
 * told afterwards, inside the same transaction, before the pool opens.
 */
export interface WiringCall {
  readonly componentId: string;
  /** Encoded calldata for the setter. Built by the caller against the component's ABI. */
  readonly data: Hex;
  /** For the review screen: "tell the accounting contract which hook may credit it". */
  readonly purpose: string;
}

/**
 * The bundle as `AgenFactory.Manifest`.
 *
 * Field for field, in the struct's own order. That order is load-bearing: the struct is
 * ABI-encoded positionally, so two same-typed fields transposed here — `devBuyAmount`
 * and `devBuyMinTokens`, say — encode without complaint and launch a market nobody
 * asked for.
 */
export interface DeployableManifest {
  readonly specificationHash: Hex;
  readonly implementationHash: Hex;
  readonly metadataURI: string;
  readonly quoteAsset: Address;
  readonly lpFee: number;
  /**
   * The tick the pool opens at, and the top of the first locked band.
   *
   * Replaces the `sqrtPriceX96` this manifest used to carry, following the same change
   * in `AgenFactory`: the bands are one-sided only because the pool opens at the top of
   * the first one, so a price and a tick that had to agree exactly were a pair of
   * fields that would eventually not.
   */
  readonly initialTick: number;
  readonly feeReceiver: Address;
  readonly devBuyAmount: bigint;
  readonly devBuyMinTokens: bigint;
  readonly hookIndex: number;
  readonly tokenIndex: number;
  readonly components: readonly ManifestComponent[];
  readonly wiring: readonly (WiringCall & { readonly componentIndex: number })[];
}

/** The registry's role constants, mirrored so the manifest can be built without a chain. */
export const ROLE: Readonly<Record<string, number>> = {
  token: 0,
  hook: 1,
  vault: 2,
  accounting: 3,
  claim: 4,
  adapter: 5,
  oracleAdapter: 5,
  other: 255,
};

/**
 * Uniswap's dynamic-fee flag, which a market whose hook sets its own fee must use.
 *
 * Re-exported from `@verdant/config` rather than restated, for the reason `CURVE` above
 * reads from there too: one definition per language.
 */
export { DYNAMIC_FEE_FLAG };

/**
 * `AgenCurve`'s geometry, so a launch can be refused before it is signed.
 *
 * Read from `@verdant/config` rather than written out here. Every tick constant in this
 * repository has one TypeScript definition and one Solidity definition and no others —
 * ADR-001, enforced by a lint in the SDK's own tests — and a third copy in the manifest
 * builder would be the copy that goes stale, in the one place where being stale means
 * telling a creator their launch is fine and watching it revert.
 */
export const CURVE = {
  tickSpacing: TICK_SPACING,
  minUsableTick: MIN_USABLE_TICK,
  maxUsableTick: MAX_USABLE_TICK,
  /** The floor of the middle band, which must stay strictly above the tail's. */
  middleWidth: AGEN_BAND_WIDTHS.middle,
} as const;

/**
 * Whether a launch can open at this tick, by `AgenCurve.validate`'s three conditions.
 *
 * Returns the reason rather than a boolean, because every caller of this either
 * refuses with it or shows it.
 */
export function initialTickProblem(initialTick: number): string | null {
  if (!Number.isInteger(initialTick)) return "the opening tick must be a whole number";
  if (initialTick % CURVE.tickSpacing !== 0) {
    return `the opening tick must be a multiple of ${String(CURVE.tickSpacing)}, and ${String(initialTick)} is not`;
  }
  if (initialTick > CURVE.maxUsableTick) {
    return `the opening tick must be at most ${String(CURVE.maxUsableTick)}`;
  }
  if (initialTick - CURVE.middleWidth <= CURVE.minUsableTick) {
    return (
      `the opening tick must leave room below it for the launch's three bands, so it has ` +
      `to be above ${String(CURVE.minUsableTick + CURVE.middleWidth)}`
    );
  }
  return null;
}

export interface BuildManifestInput {
  readonly plan: MarketImplementationPlan;
  readonly artifacts: readonly ContractArtifact[];
  /**
   * The order to deploy in, as component ids, from the declared deployment graph.
   *
   * Absent only where there is no deployment to take it from, which is a hand-written
   * manifest in a test. See `orderFor`.
   */
  readonly order?: readonly string[];
  /** Constructor wiring per component. Absent means no constructor arguments. */
  readonly deployments?: readonly ComponentDeployment[];
  /** Setter calls made after every component is deployed. See `WiringCall`. */
  readonly wiring?: readonly WiringCall[];
  readonly specificationHash: Hex;
  readonly implementationHash: Hex;
  readonly metadataURI: string;
  readonly quoteAsset: Address;
  /**
   * What goes in `PoolKey.fee`.
   *
   * Required rather than defaulted, and that is the point of it being here at all. This
   * used to be the dynamic-fee flag for every market, which is correct for a hook that
   * sets its own fee and a launch that reverts inside `initialize` for one that refuses
   * a dynamic pool. The value comes from reading the hook — see `requiredFeeMode` — and
   * a caller that has not asked the hook has no business choosing it.
   */
  readonly lpFee: number;
  /** Where the pool opens. Must sit on `AgenCurve`'s grid. */
  readonly initialTick: number;
  /** Where this market's trading fees are paid, for the life of the market. */
  readonly feeReceiver: Address;
  /** Quote asset spent on the market inside the launch. Zero buys nothing. */
  readonly devBuyAmount?: bigint;
  readonly devBuyMinTokens?: bigint;
  /**
   * Whether this market's hook will accept the factory's own swap.
   *
   * See `supportsAtomicDevBuy`. Passed in rather than recomputed because the answer
   * comes from the compiled AST, which this module does not read — and refused here as
   * well as in the interface, because the cost of getting it wrong is a creator signing
   * a launch that reverts in whole.
   */
  readonly atomicDevBuySupported?: boolean;
  /** Whose market this is. Mixed into every derived salt. */
  readonly creator: Address;
  /** Distinguishes two launches by the same creator with identical bytecode. */
  readonly marketSalt: Hex;
  /**
   * The contract that will run every `create2` in this bundle — `AgenDeployer` in
   * production. Every predicted address in the manifest is derived from it, so it is
   * required rather than defaulted: the wrong one does not produce a slightly wrong
   * manifest, it produces one where nothing lands where it was promised.
   */
  readonly deployerAddress: Address;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/**
 * A salt nobody had to choose.
 *
 * Derived from the creator, the market and the component, so two creators launching
 * byte-identical bundles land on different addresses and one creator relaunching the
 * same market lands on the same ones. Both matter: the first stops a launch from
 * colliding with a stranger's, the second is what makes a failed deployment safe to
 * retry.
 */
export function saltFor({
  creator,
  marketSalt,
  componentId,
}: {
  readonly creator: Address;
  readonly marketSalt: Hex;
  readonly componentId: string;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "string" }],
      [creator, marketSalt, componentId],
    ),
  );
}

function create2(deployer: Address, salt: Hex, initCodeHash: Hex): Address {
  const packed = concatHex(["0xff", deployer, salt, initCodeHash]);
  return `0x${keccak256(packed).slice(-40)}` as Address;
}

function encodeArguments(
  types: readonly string[],
  values: readonly ConstructorArgument[],
  placed: ReadonlyMap<string, Address>,
  componentId: string,
): Hex {
  if (types.length === 0) return "0x";

  if (types.length !== values.length) {
    throw new ManifestError(
      `${componentId} declares ${String(types.length)} constructor types and ` +
        `${String(values.length)} values`,
    );
  }

  const resolved = values.map((value) => {
    if (value.kind === "value") return value.value;
    if (value.kind === "external") return value.address;

    const address = placed.get(value.componentId);
    if (address === undefined) {
      // Either the plan's dependency edges are missing this one, or it is a cycle.
      // Both are the plan's problem, and both would otherwise produce a bundle whose
      // addresses are silently wrong.
      throw new ManifestError(
        `${componentId} needs the address of "${value.componentId}", which is not deployed ` +
          `before it. Add it to dependsOn, or break the cycle with a post-deployment setter.`,
      );
    }
    return address;
  });

  return encodeAbiParameters(
    types.map((type) => ({ type })),
    resolved as never[],
  );
}

function abiHasConstructorArguments(abi: Abi): boolean {
  return abi.some((entry) => entry.type === "constructor" && (entry.inputs?.length ?? 0) > 0);
}

/**
 * Compute every address, mine the hook, and assemble the bundle.
 *
 * Order matters twice over: components are visited in the plan's topological order so
 * each one's arguments can name the addresses already fixed, and the hook is mined at
 * the point it is reached, which means anything it depends on must precede it.
 */
/**
 * Deployment order: the declared graph where one was given, the plan's intent otherwise.
 *
 * The fallback exists for hand-written manifests in tests, which have a plan and no
 * deployment specification. Every real build supplies the order.
 */
function orderFor(input: BuildManifestInput): readonly MarketComponent[] {
  if (input.order === undefined) return deploymentOrder(input.plan);

  const byId = new Map(input.plan.components.map((component) => [component.id, component]));
  const ordered = input.order.map((id) => {
    const component = byId.get(id);
    if (component === undefined) {
      throw new ManifestError(`the deployment order names "${id}", which is not in the plan`);
    }
    return component;
  });

  if (ordered.length !== input.plan.components.length) {
    throw new ManifestError(
      `the deployment order covers ${String(ordered.length)} components and the plan has ` +
        `${String(input.plan.components.length)}`,
    );
  }

  return ordered;
}

export function buildManifest(input: BuildManifestInput): DeployableManifest {
  const deployer = input.deployerAddress;

  /**
   * The order components are deployed in, taken from the deployment when there is one.
   *
   * It has to be the same order the canonical fixture used. A constructor handed a
   * sibling's address needs that sibling deployed already, and the two orders are derived
   * from different things: the plan's `dependsOn` is what the planner intended, and the
   * deployment's graph is which addresses are actually passed. When they disagree the
   * fixture proves a launch that production would not perform.
   */
  const ordered = orderFor(input);

  const tickProblem = initialTickProblem(input.initialTick);
  if (tickProblem !== null) throw new ManifestError(tickProblem);

  const devBuyAmount = input.devBuyAmount ?? 0n;
  const devBuyMinTokens = input.devBuyMinTokens ?? 0n;

  if (devBuyAmount === 0n && devBuyMinTokens !== 0n) {
    throw new ManifestError(
      "a launch that buys nothing cannot also name a floor on what the buy delivers",
    );
  }
  if (devBuyAmount > 0n && input.atomicDevBuySupported === false) {
    throw new ManifestError(
      "this market's hook refuses swaps that do not come through its own route, so the " +
        "factory's launch buy would revert the whole launch. Launch without one.",
    );
  }
  if (input.feeReceiver === ZERO_ADDRESS) {
    throw new ManifestError("a market needs somewhere to pay its trading fees");
  }
  if (
    !Number.isInteger(input.lpFee) ||
    input.lpFee < 0 ||
    (input.lpFee !== DYNAMIC_FEE_FLAG && input.lpFee > MAX_LP_FEE_PPM)
  ) {
    throw new ManifestError(
      `${String(input.lpFee)} is not a pool fee: it must be the dynamic-fee flag or at most ` +
        `${String(MAX_LP_FEE_PPM)}`,
    );
  }

  const byName = new Map(input.artifacts.map((artifact) => [artifact.contractName, artifact]));
  const wiring = new Map(
    (input.deployments ?? []).map((deployment) => [deployment.componentId, deployment]),
  );

  const placed = new Map<string, Address>();
  const components: ManifestComponent[] = [];

  for (const component of ordered) {
    const artifact = byName.get(component.contractName);
    if (artifact === undefined) {
      throw new ManifestError(
        `the plan names ${component.contractName} but no compiled artefact has that name`,
      );
    }
    if (artifact.bytecode === "0x" || artifact.bytecode.length <= 2) {
      throw new ManifestError(
        `${component.contractName} compiled to empty creation code, which usually means it ` +
          `is an interface or an abstract contract rather than something deployable`,
      );
    }

    const deployment = wiring.get(component.id);
    const args = encodeArguments(
      deployment?.argumentTypes ?? [],
      deployment?.argumentValues ?? [],
      placed,
      component.id,
    );

    // A constructor that takes arguments but was given none produces a contract whose
    // immutables are zero — deployable, silently broken, and impossible to spot from
    // the address. Worth catching here rather than in a trace.
    if (abiHasConstructorArguments(artifact.abi) && args === "0x" && deployment === undefined) {
      throw new ManifestError(
        `${component.contractName} has a constructor but no arguments were planned for it`,
      );
    }

    const initCode = concatHex([artifact.bytecode, args]);
    const initCodeHash = keccak256(initCode);

    const isHook = component.role === "hook";
    const componentNamespace = saltFor({
      creator: input.creator,
      marketSalt: input.marketSalt,
      componentId: component.id,
    });
    const salt = isHook
      ? mineHookAddress({
          initCodeHash,
          permissions: (component.hookPermissions ?? []) as readonly HookPermission[],
          deployer,
          namespace: componentNamespace,
        }).salt
      : componentNamespace;

    const expected = create2(deployer, salt, initCodeHash);

    placed.set(component.id, expected);
    components.push({
      componentId: component.id,
      contractName: component.contractName,
      salt,
      expected,
      role: ROLE[component.role] ?? ROLE["other"]!,
      initCode,
    });
  }

  const hookIndex = components.findIndex((component) => component.role === ROLE["hook"]);
  const tokenIndex = components.findIndex((component) => component.role === ROLE["token"]);

  if (hookIndex < 0) throw new ManifestError("the bundle has no hook");
  if (tokenIndex < 0) throw new ManifestError("the bundle has no token");

  const hook = components[hookIndex]!;
  const declared = permissionBits(
    (input.plan.components.find((component) => component.role === "hook")?.hookPermissions ??
      []) as readonly HookPermission[],
  );

  // Belt and braces over the miner: the factory checks this too, and a mismatch here
  // means the bundle would be rejected on chain after the creator had signed it.
  if ((BigInt(hook.expected) & 0x3fffn) !== declared) {
    throw new ManifestError(
      `the mined hook address ${hook.expected} does not carry the declared permissions ` +
        `0x${declared.toString(16)}`,
    );
  }

  // v4 sorts a pool's currencies and Agen requires the token to be currency1, so that
  // `zeroForOne` means "buy" in every generated market. A hook reasons about direction
  // constantly; letting it flip per market would make every rule's meaning depend on an
  // address comparison nobody sees.
  const token = components[tokenIndex]!;
  if (BigInt(token.expected) <= BigInt(input.quoteAsset)) {
    throw new ManifestError(
      `the token would deploy to ${token.expected}, which does not sort above the quote asset ` +
        `${input.quoteAsset}. Change the market salt and rebuild.`,
    );
  }

  const wiringCalls = (input.wiring ?? []).map((call) => {
    const componentIndex = components.findIndex(
      (component) => component.componentId === call.componentId,
    );

    if (componentIndex < 0) {
      throw new ManifestError(
        `wiring targets "${call.componentId}", which is not a component of this bundle`,
      );
    }

    return { ...call, componentIndex };
  });

  return {
    specificationHash: input.specificationHash,
    implementationHash: input.implementationHash,
    metadataURI: input.metadataURI,
    quoteAsset: input.quoteAsset,
    lpFee: input.lpFee,
    initialTick: input.initialTick,
    feeReceiver: input.feeReceiver,
    devBuyAmount,
    devBuyMinTokens,
    hookIndex,
    tokenIndex,
    components,
    wiring: wiringCalls,
  };
}

/** One argument of `AgenFactory.deployMarket`, with nothing off-chain left in it. */
export interface FactoryManifest {
  readonly specificationHash: Hex;
  readonly implementationHash: Hex;
  readonly metadataURI: string;
  readonly quoteAsset: Address;
  readonly lpFee: number;
  readonly initialTick: number;
  readonly feeReceiver: Address;
  readonly devBuyAmount: bigint;
  readonly devBuyMinTokens: bigint;
  readonly hookIndex: number;
  readonly tokenIndex: number;
  readonly components: readonly {
    readonly salt: Hex;
    readonly expected: Address;
    readonly role: number;
    readonly initCode: Hex;
  }[];
  readonly wiring: readonly { readonly componentIndex: number; readonly data: Hex }[];
}

/** The manifest as `AgenFactory.deployMarket` takes it. */
export function toFactoryArguments(manifest: DeployableManifest): readonly [FactoryManifest] {
  return [
    {
      specificationHash: manifest.specificationHash,
      implementationHash: manifest.implementationHash,
      metadataURI: manifest.metadataURI,
      quoteAsset: manifest.quoteAsset,
      lpFee: manifest.lpFee,
      initialTick: manifest.initialTick,
      feeReceiver: manifest.feeReceiver,
      devBuyAmount: manifest.devBuyAmount,
      devBuyMinTokens: manifest.devBuyMinTokens,
      hookIndex: manifest.hookIndex,
      tokenIndex: manifest.tokenIndex,
      components: manifest.components.map((component) => ({
        salt: component.salt,
        expected: component.expected,
        role: component.role,
        initCode: component.initCode,
      })),
      wiring: manifest.wiring.map((call) => ({
        componentIndex: call.componentIndex,
        data: call.data,
      })),
    },
  ];
}

/**
 * What a cleared build carries into the launch screen.
 *
 * Deliberately *not* a `DeployableManifest`. Every address in that one is derived from
 * the creator's own address — their salt is mixed into each component's, and the hook
 * is mined from creation code containing the addresses that produces — so the bytes a
 * wallet signs cannot exist until a wallet is connected. Freezing a bundle for a
 * creator who has not arrived would mean either handing every launch the same addresses
 * or pinning them to whoever happened to be looking at the page.
 *
 * What is fixed at build time is everything that decides *whether* a launch is possible
 * and what it will cost to describe: the compiled bundle, the supply, the quote asset,
 * and whether the hook will tolerate the factory buying from it. The pipeline earns this
 * record by building a real manifest for a probe address and throwing the bytes away, so
 * a build reaching `deployment_ready` has had its constructor arguments resolved, its
 * hook mined and its wiring encoded at least once. See `runBuild`.
 */
export interface LaunchManifest {
  readonly version: number;
  readonly jobId: string;
  readonly name: string;
  readonly symbol: string;
  readonly specificationHash: Hex;
  readonly implementationHash: Hex;
  readonly quoteAsset: Address;
  /**
   * What this market's pool must be opened with, read from its hook rather than assumed.
   *
   * A build whose hook's requirement could not be established does not get one of these
   * at all: it fails as `UNDEPLOYABLE`. So a launch screen holding a `LaunchManifest` is
   * holding a market whose fee configuration its own hook will accept.
   */
  readonly lpFee: number;
  readonly feeMode: FeeMode;
  /** Why the pool opens at that fee, for the build record. */
  readonly feeModeReason: string;
  /**
   * The deployment this build cleared, which the launch materializes.
   *
   * Carried for the same reason as `lpFee`, and more strongly: the launch screen turns
   * this into bytes a wallet signs, and it must be the document the canonical fixture
   * actually executed in Foundry. Recomputing a deployment at launch time — from the plan,
   * from the compiled ABIs, from anything — would mean the bundle a creator signs was
   * arranged by a reading nothing ever ran.
   */
  readonly deployment: DeploymentSpecification;
  /** Whole tokens, before decimals. The launch screen turns this into a valuation. */
  readonly supplyTokens: bigint;
  readonly hookComponentId: string;
  readonly tokenComponentId: string;
  readonly components: readonly {
    readonly id: string;
    readonly contractName: string;
    readonly role: string;
    readonly custodial: boolean;
  }[];
  /**
   * Whether this market's hook will accept a swap made by the factory itself.
   *
   * False is a legitimate and permanent property of a market rather than a defect: a
   * hook that requires trades to arrive through its own router — EMBER is the market
   * that taught us this — is doing something its specification says it does, and
   * weakening it so that the launch screen can offer one more field would be changing
   * the market to suit the form.
   */
  readonly supportsAtomicDevBuy: boolean;
  /** Why not, in a creator's terms. Null when it is supported. */
  readonly devBuyUnavailableReason: string | null;
  readonly toolchain: {
    readonly solcVersion: string;
    readonly evmVersion: string;
    readonly optimizer: boolean;
    readonly optimizerRuns: number;
  };
  readonly builtAt: number;
}

/** Component ids in the order they will be deployed, for a progress view. */
export function deploymentSequence(manifest: DeployableManifest): readonly string[] {
  return manifest.components.map((component) => component.componentId);
}

/** A stable fingerprint of the bundle, so two plans can be compared. */
export function manifestHash(manifest: DeployableManifest): Hex {
  return keccak256(
    toHex(
      manifest.components
        .map((component) => `${component.componentId}:${component.expected}:${component.salt}`)
        .join("|"),
    ),
  );
}

export type { MarketComponent };
