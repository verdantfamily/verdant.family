/**
 * Turning compiled contracts into something the factory can deploy.
 *
 * `buildManifest` knows how to lay a bundle out — salts, predicted addresses, ordering —
 * but it has to be told what each constructor wants, and it cannot know that. This works
 * it out from the compiled ABI: the constructor's parameter names and types, matched
 * against the things a market deployment actually has to hand.
 *
 * ## Why this is a guard rather than a convenience
 *
 * A constructor argument that nobody supplies is not a compile error. Solidity is happy
 * to build a contract whose immutables are all zero, and the result deploys, has an
 * address, passes a smoke test that never touches the wrong field, and is broken in a
 * way that cannot be seen from the outside. Every earlier stage of the pipeline is
 * incapable of noticing: the compiler is satisfied, the tests construct the contract
 * themselves with arguments they chose, and the gates read source rather than
 * deployment. This is the first and only point where the question "can this actually be
 * deployed?" gets asked.
 *
 * So it refuses rather than guesses. An argument this cannot place by name and type is
 * reported with the contract and parameter that caused it, and no manifest is produced.
 * The first real market it was run against — a generated PULSE hook — turned out to take
 * a `bytes32 designatedPoolId_`, which is unsatisfiable in principle: a pool id is
 * derived from the pool key, the pool key names the hook, and the hook is the contract
 * being constructed. That market had passed every gate. Guessing a value would have
 * deployed it broken.
 *
 * ## The vocabulary is deliberately small
 *
 * Only what a launch genuinely knows: the pool manager, the factory doing the
 * installing, the creator, where the fees are to be paid, the token's name, symbol and
 * supply, and the addresses of the bundle's own components. Matching is on parameter
 * name, because that is what a generated constructor gives us to go on, and the
 * alternative — positional guessing by type — is confidently wrong the first time two
 * addresses appear in a row.
 */

import { encodeFunctionData, keccak256, toHex, type Abi, type Address, type Hex } from "viem";

import type { ContractArtifact } from "./artifacts.js";
import {
  buildManifest,
  ManifestError,
  type ComponentDeployment,
  type ConstructorArgument,
  type DeployableManifest,
  type WiringCall,
} from "./manifest.js";
import { deploymentOrder, type MarketComponent, type MarketImplementationPlan } from "./plan.js";

/** What a deployment knows before any contract exists. */
export interface DeploymentEnvironment {
  /** The v4 PoolManager for this chain. */
  readonly poolManager: Address;
  /** The factory, which is the only address permitted to complete wiring. */
  readonly installer: Address;
  /** Whose market this is. Receives the supply and owns anything ownable. */
  readonly creator: Address;
  /**
   * Where the market's fees are paid, for its whole life.
   *
   * The creator's choice at launch, defaulting to their own wallet, and separate from
   * `creator` because it is genuinely a different decision — a multisig, a splitter, a
   * team address. It is here rather than only in the manifest because generated
   * mechanics take it as a constructor argument constantly: "the fees go to the fee
   * receiver" is the most common sentence in a specification, and a component holding
   * it in an immutable is how a market keeps that promise.
   */
  readonly feeReceiver: Address;
  readonly name: string;
  readonly symbol: string;
  /** Whole tokens, before decimals. */
  readonly supplyTokens: bigint;
}

/**
 * A setter that has to be called once the bundle exists, before its argument is known.
 *
 * Kept as an intention rather than as calldata because the address it passes is
 * predicted by `buildManifest`, which has not run yet. `encodeWiring` turns these into
 * real calls once it has.
 */
export interface WiringIntent {
  /** The component whose setter is called. */
  readonly componentId: string;
  readonly functionName: string;
  /** The component whose address is the argument. */
  readonly targetComponentId: string;
  readonly purpose: string;
}

export interface ResolvedDeployment {
  readonly deployments: readonly ComponentDeployment[];
  readonly wiring: readonly WiringIntent[];
}

interface AbiParameter {
  readonly name?: string;
  readonly type?: string;
}

/**
 * Work out how every component in the plan is constructed and wired.
 *
 * Throws `ManifestError` listing every parameter it could not place, rather than the
 * first — a market with three unresolvable arguments should take one run to diagnose.
 */
export function resolveDeployment({
  plan,
  artifacts,
  environment,
}: {
  readonly plan: MarketImplementationPlan;
  readonly artifacts: readonly ContractArtifact[];
  readonly environment: DeploymentEnvironment;
}): ResolvedDeployment {
  const byName = new Map(artifacts.map((artifact) => [artifact.contractName, artifact]));
  const ordered = deploymentOrder(plan);

  const deployments: ComponentDeployment[] = [];
  const problems: string[] = [];

  // Components already placed by the time each constructor runs. A reference to a
  // component deployed later cannot be a constructor argument — that is the cycle
  // CREATE2 does not untie — and has to become a wiring call instead.
  const placed = new Set<string>();

  for (const component of ordered) {
    const artifact = byName.get(component.contractName);
    if (artifact === undefined) {
      problems.push(`${component.contractName}: the plan names it but nothing compiled under that name`);
      continue;
    }

    const constructor = (artifact.abi as readonly { type?: string; inputs?: AbiParameter[] }[]).find(
      (entry) => entry.type === "constructor",
    );

    const inputs = constructor?.inputs ?? [];
    const types: string[] = [];
    const values: ConstructorArgument[] = [];

    for (const input of inputs) {
      const resolved = resolveArgument({ input, plan, placed, environment, component });

      if (resolved === null) {
        problems.push(
          `${component.contractName}: nothing known about the constructor argument ` +
            `\`${input.type ?? "?"} ${input.name ?? "(unnamed)"}\`. A deployment can supply the ` +
            `pool manager, the installer, the creator, the fee receiver, the token name, symbol ` +
            `and supply, and the address of another component in this market — nothing else ` +
            `exists yet.`,
        );
        continue;
      }

      types.push(input.type!);
      values.push(resolved);
    }

    placed.add(component.id);
    if (types.length > 0) {
      deployments.push({ componentId: component.id, argumentTypes: types, argumentValues: values });
    }
  }

  if (problems.length > 0) {
    throw new ManifestError(
      `this market cannot be deployed as generated:\n  ${problems.join("\n  ")}`,
    );
  }

  return { deployments, wiring: wiringFor({ plan, artifacts, placedOrder: ordered }) };
}

/**
 * Place one constructor argument, or null if nothing known fits it.
 *
 * Name first, then type. A generated constructor names its parameters after what they
 * are, which is more signal than the type carries — `address` alone could be any of five
 * things.
 */
function resolveArgument({
  input,
  plan,
  placed,
  environment,
  component,
}: {
  readonly input: AbiParameter;
  readonly plan: MarketImplementationPlan;
  readonly placed: ReadonlySet<string>;
  readonly environment: DeploymentEnvironment;
  /** The component being constructed. The token's recipient depends on it. */
  readonly component: MarketComponent;
}): ConstructorArgument | null {
  const type = input.type ?? "";
  // Trailing underscores are the Solidity convention for "same name as the state
  // variable this sets", and carry no meaning of their own.
  const name = (input.name ?? "").replace(/_+$/, "").toLowerCase();

  if (type === "string") {
    if (name.includes("name")) return { kind: "value", value: environment.name };
    if (name.includes("symbol")) return { kind: "value", value: environment.symbol };
    return null;
  }

  if (/^uint\d*$/.test(type)) {
    // The only quantity a launch knows. Anything else — a threshold, a duration, a fee —
    // belongs to the market's own configuration and should be a constant in the
    // contract, not something the deployment is expected to invent.
    if (name.includes("supply")) {
      return { kind: "value", value: environment.supplyTokens * 10n ** 18n };
    }
    return null;
  }

  if (type !== "address") return null;

  if (name.includes("poolmanager") || name === "manager") {
    return { kind: "external", address: environment.poolManager };
  }
  if (name.includes("installer") || name.includes("factory")) {
    return { kind: "external", address: environment.installer };
  }

  // The launch token's supply goes to the factory, and this is the one argument in a
  // bundle where the obvious answer is the wrong one. `AgenFactory` locks the entire
  // supply into the three launch positions before `deployMarket` returns, and it can
  // only do that with tokens it holds — a token minted to the creator instead leaves
  // the factory with nothing to lock and reverts the launch with `NoSupplyToLock`,
  // after every component has been deployed. The recipient is baked into the token's
  // creation code, so this cannot be corrected later: it is decided here or the market
  // is undeployable.
  //
  // The creator is not short-changed by it. They receive their position the way every
  // other holder does, by buying from the launch liquidity — with the launch buy if the
  // market's hook permits one, and otherwise in the next block.
  const holdsTheSupply =
    name.includes("recipient") || name.includes("owner") || name.includes("treasury") || name.includes("mintto");

  if (component.role === "token" && holdsTheSupply) {
    return { kind: "external", address: environment.installer };
  }

  /**
   * Where the fees go, which is a different address from who owns the market.
   *
   * Checked before the general case below, because a `feeReceiver_` matches "receiver"
   * and would otherwise resolve to the creator — which is right by default and wrong
   * the moment somebody points their fees at a splitter or a multisig, silently, in an
   * immutable, forever.
   *
   * The name has to mention fees for this to fire. A bare `receiver_` on some other
   * component is not necessarily about money, and guessing that it is would bake the
   * fee receiver into a contract that meant something else by it.
   */
  const aboutFees = name.includes("fee") || name.includes("revenue") || name.includes("royalt");
  const isDestination =
    name.includes("receiver") ||
    name.includes("recipient") ||
    name.includes("collector") ||
    name.includes("sink") ||
    name.includes("treasury") ||
    name.includes("beneficiary");

  if (aboutFees && isDestination) {
    return { kind: "external", address: environment.feeReceiver };
  }

  if (
    name.includes("owner") ||
    name.includes("recipient") ||
    name.includes("receiver") ||
    name.includes("beneficiary") ||
    name.includes("treasury")
  ) {
    return { kind: "external", address: environment.creator };
  }

  // A reference to another contract in this bundle, but only one that already exists at
  // the moment this constructor runs.
  const referenced = componentNamed(plan, name);
  if (referenced !== null && placed.has(referenced.id)) {
    return { kind: "component", componentId: referenced.id };
  }

  return null;
}

/**
 * The component a parameter name refers to, if any.
 *
 * Matched on the component's role and on its contract name, both ways round, because a
 * hook's reference to the market token is called `token` in one generated market and
 * `pulseToken` in the next.
 */
function componentNamed(plan: MarketImplementationPlan, name: string): MarketComponent | null {
  if (name.length === 0) return null;

  for (const component of plan.components) {
    const contract = component.contractName.toLowerCase();
    if (name === contract || name.includes(contract) || contract.includes(name)) return component;
  }

  for (const component of plan.components) {
    const role = component.role.toLowerCase();
    if (name === role || name.includes(role)) return component;
  }

  return null;
}

/**
 * The setter calls that finish the bundle once every address exists.
 *
 * Found in the ABI rather than declared in the plan: the contract that needs telling is
 * the one with a one-argument address setter named after another component, and it knows
 * that about itself more reliably than the planner remembers to write it down.
 *
 * Only components deployed before the one being referenced are skipped — those got the
 * address in their constructor and do not need telling twice.
 */
function wiringFor({
  plan,
  artifacts,
  placedOrder,
}: {
  readonly plan: MarketImplementationPlan;
  readonly artifacts: readonly ContractArtifact[];
  readonly placedOrder: readonly MarketComponent[];
}): readonly WiringIntent[] {
  const byName = new Map(artifacts.map((artifact) => [artifact.contractName, artifact]));
  const position = new Map(placedOrder.map((component, index) => [component.id, index]));

  const calls: WiringIntent[] = [];

  for (const component of placedOrder) {
    const artifact = byName.get(component.contractName);
    if (artifact === undefined) continue;

    for (const entry of artifact.abi as readonly {
      type?: string;
      name?: string;
      inputs?: AbiParameter[];
    }[]) {
      if (entry.type !== "function") continue;
      if (!/^set[A-Z]/.test(entry.name ?? "")) continue;

      const inputs = entry.inputs ?? [];
      if (inputs.length !== 1 || inputs[0]?.type !== "address") continue;

      // `setFeeVault` refers to the fee vault. The parameter name is often just
      // `vault_`, so the function name is the better signal.
      const target = componentNamed(plan, (entry.name ?? "").slice(3).toLowerCase());
      if (target === null || target.id === component.id) continue;

      // Already known at construction time, so this setter is for something else.
      const mine = position.get(component.id) ?? 0;
      const theirs = position.get(target.id) ?? 0;
      if (theirs < mine) continue;

      calls.push({
        componentId: component.id,
        functionName: entry.name!,
        targetComponentId: target.id,
        purpose: `tell ${component.contractName} the address of ${target.contractName}`,
      });
    }
  }

  return calls;
}

/**
 * Turn wiring intentions into calls, now that the addresses are known.
 *
 * Run after `buildManifest`, which is what predicts them. Kept separate rather than
 * folded into the manifest builder because the builder's job is placement and it should
 * not also need an opinion about which setters a market has.
 */
export function encodeWiring({
  intents,
  components,
  artifacts,
}: {
  readonly intents: readonly WiringIntent[];
  /** As produced by `buildManifest`: component ids against predicted addresses. */
  readonly components: readonly { readonly componentId: string; readonly contractName: string; readonly expected: Address }[];
  readonly artifacts: readonly ContractArtifact[];
}): readonly WiringCall[] {
  const address = new Map(components.map((component) => [component.componentId, component.expected]));
  const contract = new Map(components.map((component) => [component.componentId, component.contractName]));
  const byName = new Map(artifacts.map((artifact) => [artifact.contractName, artifact]));

  return intents.map((intent) => {
    const target = address.get(intent.targetComponentId);
    const name = contract.get(intent.componentId);
    const artifact = name === undefined ? undefined : byName.get(name);

    if (target === undefined || artifact === undefined) {
      throw new ManifestError(
        `cannot encode the call to ${intent.functionName}: ` +
          `${target === undefined ? intent.targetComponentId : intent.componentId} is not in the manifest`,
      );
    }

    return {
      componentId: intent.componentId,
      data: encodeFunctionData({
        abi: artifact.abi as Abi,
        functionName: intent.functionName,
        args: [target],
      }),
      purpose: intent.purpose,
    };
  });
}

// --- the whole assembly ------------------------------------------------------

/**
 * What a creator chooses at the moment they launch, as opposed to when they built.
 *
 * None of these change a single predicted address: the components' creation code is
 * already fixed by the time any of this is asked for, which is why the launch screen can
 * be a short form rather than another build.
 */
export interface LaunchChoices {
  /**
   * `PoolKey.fee`, as the market's own hook requires it. Not a creator's choice and not
   * a default: see `requiredFeeMode`.
   */
  readonly lpFee: number;
  /** Where the pool opens, on `AgenCurve`'s grid. Sets the launch valuation. */
  readonly initialTick: number;
  /** Where trading fees are paid, for the life of the market. */
  readonly feeReceiver: Address;
  readonly devBuyAmount?: bigint;
  readonly devBuyMinTokens?: bigint;
  /** See `supportsAtomicDevBuy`. A dev buy is refused here when this is false. */
  readonly atomicDevBuySupported?: boolean;
  readonly metadataURI?: string;
}

export interface AssembleManifestInput extends LaunchChoices {
  readonly plan: MarketImplementationPlan;
  readonly artifacts: readonly ContractArtifact[];
  readonly environment: DeploymentEnvironment;
  readonly specificationHash: Hex;
  readonly implementationHash: Hex;
  readonly quoteAsset: Address;
  /** Distinguishes two launches by the same creator of the same market. */
  readonly marketSalt: Hex;
  /** `AgenDeployer`. Every predicted address is derived from it. */
  readonly deployerAddress: Address;
}

/**
 * A build and a creator's choices, as bytes a wallet can sign.
 *
 * Two passes over the bundle, and the second one is not redundant. A wiring call carries
 * the address of a component that CREATE2 has not placed yet, so the addresses have to
 * be predicted before the calls can be encoded — and the calls then have to be carried
 * by a manifest. Nothing in the first pass changes: wiring is not part of any
 * component's creation code, so the addresses the second pass predicts are the ones the
 * first pass did. `assembleManifest.test.ts` holds that to be true rather than assuming
 * it.
 *
 * Every failure is a `ManifestError` naming what could not be placed. There is no
 * partial result: half a bundle is not something to hand a wallet.
 */
export function assembleManifest(input: AssembleManifestInput): DeployableManifest {
  const resolved = resolveDeployment({
    plan: input.plan,
    artifacts: input.artifacts,
    environment: input.environment,
  });

  const common = {
    plan: input.plan,
    artifacts: input.artifacts,
    deployments: resolved.deployments,
    specificationHash: input.specificationHash,
    implementationHash: input.implementationHash,
    metadataURI: input.metadataURI ?? "",
    quoteAsset: input.quoteAsset,
    lpFee: input.lpFee,
    initialTick: input.initialTick,
    feeReceiver: input.feeReceiver,
    devBuyAmount: input.devBuyAmount ?? 0n,
    devBuyMinTokens: input.devBuyMinTokens ?? 0n,
    ...(input.atomicDevBuySupported === undefined
      ? {}
      : { atomicDevBuySupported: input.atomicDevBuySupported }),
    creator: input.environment.creator,
    marketSalt: input.marketSalt,
    deployerAddress: input.deployerAddress,
  } as const;

  const placed = buildManifest(common);

  if (resolved.wiring.length === 0) return placed;

  const wiring = encodeWiring({
    intents: resolved.wiring,
    components: placed.components,
    artifacts: input.artifacts,
  });

  const manifest = buildManifest({ ...common, wiring });

  // The claim the two passes rest on, checked rather than reasoned about: adding wiring
  // to a manifest must not move anything. If it ever does, every address in the bundle
  // is wrong and the factory would reject the first component.
  const moved = manifest.components.find(
    (component, index) => component.expected !== placed.components[index]?.expected,
  );
  if (moved !== undefined) {
    throw new ManifestError(
      `encoding the wiring moved ${moved.componentId} from ` +
        `${String(placed.components[manifest.components.indexOf(moved)]?.expected)} to ${moved.expected}`,
    );
  }

  return manifest;
}

/**
 * The salt that makes a launch reproducible.
 *
 * Derived from the build rather than random, so a launch that failed — a wallet
 * rejected, a chain reorganised, a page closed — can be signed again and land on exactly
 * the addresses the creator was shown. Combined with the creator's own address inside
 * `saltFor`, so two people launching the same build do not collide.
 */
export function marketSaltFor(jobId: string): Hex {
  return keccak256(toHex(`agen.market.${jobId}`));
}
