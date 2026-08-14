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

import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";

import { TICK_SPACING } from "@verdant/config";

import type { ContractArtifact } from "./artifacts.js";
import {
  buildManifest,
  ManifestError,
  type ComponentDeployment,
  type ConstructorArgument,
  type DeployableManifest,
  type WiringCall,
} from "./manifest.js";
import type {
  DeclaredWiringCall,
  DeployedComponent,
  DeploymentSpecification,
  SymbolicRef,
} from "./deployment-spec.js";
import { deploymentSpecOrder, parseRef, POOL_ID_REF } from "./deployment-spec.js";
import type { MarketComponent, MarketImplementationPlan } from "./plan.js";

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
  /**
   * The canonical trading route, where this chain has one.
   *
   * A hook that needs to know which wallet is trading takes this in its constructor and
   * holds it in an immutable — see `AgenRouted`. It is `null` on a chain with no router
   * deployed, and a market that asks for it there cannot be built: the alternative is a
   * hook authenticating against the zero address, which rejects every trade forever and
   * looks like a broken mechanic.
   */
  readonly agenRouter: Address | null;
  /**
   * The other two destinations a market can name, as `ROLE:TREASURY` and `ROLE:BENEFICIARY`.
   *
   * Separate fields rather than aliases of `feeReceiver` because a market that names two
   * destinations means two, and resolving both to one address is how a vault with a
   * `DuplicateRecipient` guard reverts its own constructor. Agen's launch screen collects
   * one destination today, so both are set to the fee receiver by every caller — but they
   * are resolved here rather than substituted in the deployment, so the day a creator can
   * name a treasury the change is to this environment and to nothing else.
   */
  readonly treasury: Address;
  readonly beneficiary: Address;
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
export interface ComponentWiringIntent {
  /** The component whose setter is called. */
  readonly componentId: string;
  readonly functionName: string;
  /** The component whose address is the argument. */
  readonly targetComponentId: string;
  readonly purpose: string;
}

/** A component that must know the canonical pool before `initialize` calls its hook. */
export interface PoolIdWiringIntent {
  readonly componentId: string;
  readonly functionName: string;
  readonly poolId: true;
  readonly purpose: string;
}

/**
 * A setter told an address that is not a component of this bundle.
 *
 * A market whose accounting is told where fees go at launch rather than in its constructor
 * is doing something ordinary, and there was no way to express it while wiring was scraped
 * from the ABI: a one-argument address setter could only ever mean a sibling component,
 * because a sibling was the only thing the scraper could name.
 */
export interface ExternalWiringIntent {
  readonly componentId: string;
  readonly functionName: string;
  readonly address: Address;
  readonly purpose: string;
}

export type WiringIntent = ComponentWiringIntent | PoolIdWiringIntent | ExternalWiringIntent;

export interface ResolvedDeployment {
  readonly deployments: readonly ComponentDeployment[];
  readonly wiring: readonly WiringIntent[];
}

interface AbiParameter {
  readonly name?: string;
  readonly type?: string;
}

/**
 * Turn a declared deployment into a placeable bundle.
 *
 * This replaced an inference engine, and the difference is the whole point of the module.
 * The old resolver was handed compiled contracts and asked what their constructors meant:
 * nineteen ordered rules over lowercased parameter names, a synonym list for "somewhere
 * value goes", and a setter scraper that decided a one-argument address setter must name a
 * sibling because a sibling was the only thing it could name. It was right most of the
 * time, which is worse than being wrong reliably — the failures arrived inside a wiring
 * call, after every component had been deployed and paid for, with an immutable already
 * set to an address no later repair could change.
 *
 * Nothing is inferred here. Every argument has a declared source, every wiring call was
 * declared, and this function's only jobs are resolving symbols against an environment and
 * refusing to proceed when the compiled contract does not match what was declared.
 *
 * ## Why it checks parity rather than trusting the declaration
 *
 * The specification is written before the Solidity, so the Solidity can still disagree with
 * it — a generator that wrote `constructor(address manager_, address feeReceiver_)` against
 * a declaration of one argument produces a bundle whose creation code takes an argument
 * nobody supplied. `deploymentValidation` reports that as an architecture inconsistency and
 * a component is regenerated. This function checks the same thing and throws, because a
 * materializer that silently produced a bundle from a stale declaration would be the
 * original bug with extra steps.
 */
export function materializeDeployment({
  spec,
  artifacts,
  environment,
}: {
  readonly spec: DeploymentSpecification;
  readonly artifacts: readonly ContractArtifact[];
  readonly environment: DeploymentEnvironment;
}): ResolvedDeployment {
  const parity = deploymentParityProblems({ spec, artifacts });
  if (parity.length > 0) {
    throw new ManifestError(
      `the contracts do not match the deployment this market declared:\n  ${parity.join("\n  ")}`,
    );
  }

  const ordered = deploymentSpecOrder(spec);
  const placed = new Set<string>();
  const deployments: ComponentDeployment[] = [];
  const wiring: WiringIntent[] = [];

  for (const component of ordered) {
    const types: string[] = [];
    const values: ConstructorArgument[] = [];

    for (const argument of component.constructorArguments) {
      types.push(argument.type);
      values.push(resolveSymbol({ reference: argument.source, environment, placed, component }));
    }

    placed.add(component.componentId);
    if (types.length > 0) {
      deployments.push({
        componentId: component.componentId,
        argumentTypes: types,
        argumentValues: values,
      });
    }
  }

  // Wiring runs after every component exists, so it is collected in a second pass and in
  // declaration order. The factory makes the calls in exactly this order.
  for (const component of ordered) {
    for (const call of component.wiring) {
      wiring.push(
        wiringIntentFor({
          component,
          call,
          environment,
          named: new Map(spec.components.map((entry) => [entry.componentId, entry.contractName])),
        }),
      );
    }
  }

  return { deployments, wiring };
}

/**
 * Where the declared deployment and the compiled contracts disagree.
 *
 * Positional and exact: same number of constructor arguments, same ABI types in the same
 * order, same parameter names. The names matter because they are the one part a person
 * reads — a market whose declaration says `owner_` and whose contract says `treasury_` has
 * two people describing different things — and because the declaration is what the
 * generator was told to write, so a mismatch means the generator went its own way.
 *
 * Wiring is checked the same way: a declared call must exist, take one argument, and take
 * it in the type the reference resolves to.
 */
export function deploymentParityProblems({
  spec,
  artifacts,
}: {
  readonly spec: DeploymentSpecification;
  readonly artifacts: readonly ContractArtifact[];
}): readonly string[] {
  const byName = new Map(artifacts.map((artifact) => [artifact.contractName, artifact]));
  const problems: string[] = [];

  for (const component of spec.components) {
    const artifact = byName.get(component.contractName);
    if (artifact === undefined) {
      problems.push(
        `${component.contractName}: the deployment names it but nothing compiled under that name`,
      );
      continue;
    }

    const abi = artifact.abi as readonly {
      type?: string;
      name?: string;
      inputs?: AbiParameter[];
    }[];

    const declaredArguments = component.constructorArguments;
    const actual = abi.find((entry) => entry.type === "constructor")?.inputs ?? [];

    if (actual.length !== declaredArguments.length) {
      problems.push(
        `${component.contractName}: the deployment declares a constructor taking ` +
          `${describeSignature(declaredArguments.map((argument) => `${argument.type} ${argument.name}`))} ` +
          `and the contract takes ` +
          `${describeSignature(actual.map((input) => `${input.type ?? "?"} ${input.name ?? "?"}`))}. ` +
          `The launch can only pass the arguments that were declared.`,
      );
      continue;
    }

    for (const [position, declared] of declaredArguments.entries()) {
      const input = actual[position]!;

      if (input.type !== declared.type) {
        problems.push(
          `${component.contractName}: argument ${String(position + 1)} is declared ` +
            `\`${declared.type} ${declared.name}\` and the contract takes ` +
            `\`${input.type ?? "?"} ${input.name ?? "?"}\``,
        );
        continue;
      }

      if (input.name !== declared.name) {
        problems.push(
          `${component.contractName}: argument ${String(position + 1)} is declared ` +
            `\`${declared.name}\` and the contract calls it \`${input.name ?? "(unnamed)"}\`. ` +
            `They are the same value under two names, and the deployment record is what a ` +
            `person reads.`,
        );
      }
    }

    for (const call of component.wiring) {
      const entries = abi.filter((entry) => entry.type === "function" && entry.name === call.functionName);

      if (entries.length === 0) {
        problems.push(
          `${component.contractName}: the deployment says the launch calls ` +
            `${call.functionName} and the contract has no such function`,
        );
        continue;
      }

      if (entries.length > 1) {
        problems.push(
          `${component.contractName}.${call.functionName} is overloaded, so the launch cannot ` +
            `tell which one it is meant to call. Give the wiring setter a name of its own.`,
        );
        continue;
      }

      const inputs = entries[0]!.inputs ?? [];
      if (inputs.length !== 1) {
        problems.push(
          `${component.contractName}.${call.functionName} takes ` +
            `${String(inputs.length)} arguments and a wiring call carries exactly one. A value ` +
            `the launch cannot supply belongs in the contract as a constant.`,
        );
        continue;
      }

      const expected = call.argument === POOL_ID_REF ? "bytes32" : "address";
      if (inputs[0]!.type !== expected) {
        problems.push(
          `${component.contractName}.${call.functionName} takes ` +
            `\`${inputs[0]!.type ?? "?"}\` and the launch passes ${call.argument}, which is a ` +
            `\`${expected}\``,
        );
      }
    }
  }

  return problems;
}

function describeSignature(parts: readonly string[]): string {
  return parts.length === 0 ? "no arguments" : `(${parts.join(", ")})`;
}

/** One declared reference, against the addresses this launch actually has. */
function resolveSymbol({
  reference,
  environment,
  placed,
  component,
}: {
  readonly reference: SymbolicRef;
  readonly environment: DeploymentEnvironment;
  readonly placed: ReadonlySet<string>;
  readonly component: DeployedComponent;
}): ConstructorArgument {
  const parsed = parseRef(reference);
  if (parsed === null) {
    throw new ManifestError(
      `${component.contractName}: "${reference}" is not a reference Agen can resolve`,
    );
  }

  switch (parsed.kind) {
    case "component":
      // Unreachable after `deploymentSpecOrder`, which places dependencies first, and
      // after the cycle check that refuses a bundle where it would not be.
      if (!placed.has(parsed.componentId)) {
        throw new ManifestError(
          `${component.contractName} is handed the address of ${parsed.componentId}, which is ` +
            `deployed after it`,
        );
      }
      return { kind: "component", componentId: parsed.componentId };

    case "role":
      switch (parsed.role) {
        case "CREATOR":
          return { kind: "external", address: environment.creator };
        case "FEE_RECEIVER":
          return { kind: "external", address: environment.feeReceiver };
        case "TREASURY":
          return { kind: "external", address: environment.treasury };
        case "BENEFICIARY":
          return { kind: "external", address: environment.beneficiary };
      }

    case "infra":
      switch (parsed.infra) {
        case "POOL_MANAGER":
          return { kind: "external", address: environment.poolManager };
        case "INSTALLER":
          return { kind: "external", address: environment.installer };
        case "AGEN_ROUTER":
          // Refused rather than defaulted. `AgenRouted` holds this in an immutable, so a
          // zero here is a market that can never authenticate a trade, deployed and
          // permanently broken.
          if (environment.agenRouter === null) {
            throw new ManifestError(
              `${component.contractName} takes the Agen router as \`${reference}\`, and no ` +
                `router is deployed on this chain. A market that authenticates its trades ` +
                `cannot be launched here.`,
            );
          }
          return { kind: "external", address: environment.agenRouter };
      }

    case "literal":
      switch (parsed.literal) {
        case "NAME":
          return { kind: "value", value: environment.name };
        case "SYMBOL":
          return { kind: "value", value: environment.symbol };
        case "SUPPLY":
          return { kind: "value", value: environment.supplyTokens * 10n ** 18n };
      }
  }
}

function wiringIntentFor({
  component,
  call,
  environment,
  named,
}: {
  readonly component: DeployedComponent;
  readonly call: DeclaredWiringCall;
  readonly environment: DeploymentEnvironment;
  readonly named: ReadonlyMap<string, string>;
}): WiringIntent {
  if (call.argument === POOL_ID_REF) {
    return {
      componentId: component.componentId,
      functionName: call.functionName,
      poolId: true,
      purpose: `tell ${component.contractName} the id of its Agen pool`,
    };
  }

  const parsed = parseRef(call.argument);
  if (parsed === null) {
    throw new ManifestError(
      `${component.contractName}.${call.functionName}: "${call.argument}" is not a reference ` +
        `Agen can resolve`,
    );
  }

  if (parsed.kind === "component") {
    return {
      componentId: component.componentId,
      functionName: call.functionName,
      targetComponentId: parsed.componentId,
      purpose: `tell ${component.contractName} the address of ${named.get(parsed.componentId) ?? parsed.componentId}`,
    };
  }

  const resolved = resolveSymbol({
    reference: call.argument,
    environment,
    // Wiring runs after everything is deployed, so nothing about placement constrains it.
    placed: new Set(named.keys()),
    component,
  });

  if (resolved.kind !== "external") {
    throw new ManifestError(
      `${component.contractName}.${call.functionName} is passed ${call.argument}, which is not ` +
        `an address`,
    );
  }

  return {
    componentId: component.componentId,
    functionName: call.functionName,
    address: resolved.address,
    purpose: `tell ${component.contractName} the address it was launched with`,
  };
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
  poolId,
}: {
  readonly intents: readonly WiringIntent[];
  /** As produced by `buildManifest`: component ids against predicted addresses. */
  readonly components: readonly { readonly componentId: string; readonly contractName: string; readonly expected: Address }[];
  readonly artifacts: readonly ContractArtifact[];
  /** The id of the manifest's exact key, when a component binds itself before initialize. */
  readonly poolId?: Hex;
}): readonly WiringCall[] {
  const address = new Map(components.map((component) => [component.componentId, component.expected]));
  const contract = new Map(components.map((component) => [component.componentId, component.contractName]));
  const byName = new Map(artifacts.map((artifact) => [artifact.contractName, artifact]));

  return intents.map((intent) => {
    const name = contract.get(intent.componentId);
    const artifact = name === undefined ? undefined : byName.get(name);

    if (artifact === undefined) {
      throw new ManifestError(
        `cannot encode the call to ${intent.functionName}: ${intent.componentId} is not in the manifest`,
      );
    }

    let argument: Address | Hex;
    if ("poolId" in intent) {
      if (poolId === undefined) {
        throw new ManifestError(
          `cannot encode the call to ${intent.functionName}: the canonical pool id was not supplied`,
        );
      }
      argument = poolId;
    } else if ("address" in intent) {
      argument = intent.address;
    } else {
      const target = address.get(intent.targetComponentId);
      if (target === undefined) {
        throw new ManifestError(
          `cannot encode the call to ${intent.functionName}: ${intent.targetComponentId} is not in the manifest`,
        );
      }
      argument = target;
    }

    return {
      componentId: intent.componentId,
      data: encodeFunctionData({
        abi: artifact.abi as Abi,
        functionName: intent.functionName,
        args: [argument],
      }),
      purpose: intent.purpose,
    };
  });
}

/** The same `PoolIdLibrary.toId` calculation the factory performs on-chain. */
export function poolIdFor({
  quoteAsset,
  token,
  lpFee,
  hook,
}: {
  readonly quoteAsset: Address;
  readonly token: Address;
  readonly lpFee: number;
  readonly hook: Address;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [quoteAsset, token, lpFee, TICK_SPACING, hook],
    ),
  );
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
  /**
   * The plan, for identity: which component is the hook, what each contract is called,
   * which permissions the hook's address is mined for.
   */
  readonly plan: MarketImplementationPlan;
  /**
   * The deployment, for everything else.
   *
   * The same document the canonical fixture ran, so a production launch places every
   * argument exactly where the launch that was tested placed it. A manifest assembled from
   * anything else would be bytes a wallet signs for a bundle nothing has ever executed.
   */
  readonly deployment: DeploymentSpecification;
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
  const resolved = materializeDeployment({
    spec: input.deployment,
    artifacts: input.artifacts,
    environment: input.environment,
  });

  const common = {
    plan: input.plan,
    artifacts: input.artifacts,
    order: deploymentSpecOrder(input.deployment).map((component) => component.componentId),
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

  const tokenId = input.plan.components.find(
    (component: MarketComponent) => component.role === "token",
  )?.id;
  const hookId = input.plan.components.find(
    (component: MarketComponent) => component.role === "hook",
  )?.id;
  const token = placed.components.find((component) => component.componentId === tokenId)?.expected;
  const hook = placed.components.find((component) => component.componentId === hookId)?.expected;
  if (token === undefined || hook === undefined) {
    throw new ManifestError("cannot encode wiring without the manifest's token and hook");
  }

  const wiring = encodeWiring({
    intents: resolved.wiring,
    components: placed.components,
    artifacts: input.artifacts,
    poolId: poolIdFor({
      quoteAsset: input.quoteAsset,
      token,
      lpFee: input.lpFee,
      hook,
    }),
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
