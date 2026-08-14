/**
 * Proving a market can be launched, before anything expensive depends on it.
 *
 * A build used to discover it was undeployable at the very end. The contracts compiled, the
 * gates cleared, a model wrote a behaviour suite, three repair rounds went into making that
 * suite pass — and then the manifest could not be assembled, because a constructor took an
 * argument nothing could supply or a hook's address could not be mined for the permissions
 * it declared. Every one of those minutes was spent on a market that was never launchable,
 * and the creator was told so at the point where they were expecting a launch screen.
 *
 * So the whole deployment is materialized here instead, immediately after the contracts
 * compile and before a single model-authored test exists. It answers one question — can
 * this bundle actually be placed on a chain — and it answers it against the same code
 * production runs: the declared deployment, the real CREATE2 arithmetic, the real hook
 * miner. Nothing is simulated and nothing is approximated.
 *
 * ## Why it is separate from the canonical launch
 *
 * The fixture proves the bundle *works*: it deploys, wires and trades in Foundry. This
 * proves the bundle can be *described* — every symbol resolves, every address can be
 * predicted, the hook's salt exists. Those fail differently and are worth telling apart. A
 * market that cannot be described has an architecture problem; a market that is described
 * perfectly and reverts on its own wiring call has a contract problem.
 *
 * Describing is also thousands of times cheaper, so it goes first.
 */

import type { Address, Hex } from "viem";

import type { ContractArtifact } from "./artifacts.js";
import type { DeploymentSpecification } from "./deployment-spec.js";
import { deploymentSpecOrder, parseRef, POOL_ID_REF } from "./deployment-spec.js";
import type { DeploymentEnvironment } from "./deployment.js";
import { assembleManifest, deploymentParityProblems, poolIdFor } from "./deployment.js";
import { ManifestError } from "./manifest.js";
import type { MarketImplementationPlan } from "./plan.js";

export interface PreflightInput {
  readonly plan: MarketImplementationPlan;
  readonly deployment: DeploymentSpecification;
  readonly artifacts: readonly ContractArtifact[];
  /** Probe addresses. The answer must not depend on which creator is asking. */
  readonly environment: DeploymentEnvironment;
  readonly specificationHash: Hex;
  readonly implementationHash: Hex;
  readonly quoteAsset: Address;
  readonly lpFee: number;
  readonly initialTick: number;
  readonly marketSalt: Hex;
  readonly deployerAddress: Address;
}

export interface PreflightResult {
  readonly ok: boolean;
  /**
   * Everything standing between this market and a launch, in one list.
   *
   * All of them rather than the first, because they are answered by one edit to the
   * architecture and a build should not need three runs to collect them.
   */
  readonly problems: readonly string[];
}

/**
 * Materialize the whole deployment and report anything that stops it.
 *
 * Ordered from the cheapest and most specific to the most general, because the specific
 * messages are the ones worth reading: "this constructor does not match what was declared"
 * is actionable, and the `ManifestError` that follows from the same cause is not.
 */
export function preflight(input: PreflightInput): PreflightResult {
  const problems: string[] = [
    ...referenceProblems(input.deployment, input.plan),
    ...deploymentParityProblems({ spec: input.deployment, artifacts: input.artifacts }),
  ];

  // Assembling the bundle proves the rest at once: every argument resolves, CREATE2 can
  // predict every address, the hook's salt can be mined for the permissions it declared,
  // the token sorts above the quote asset, and every wiring call can be encoded against a
  // predicted address. Reimplementing those checks here would be a second opinion that can
  // drift from the one production holds.
  if (problems.length === 0) {
    try {
      const manifest = assembleManifest({
        plan: input.plan,
        deployment: input.deployment,
        artifacts: input.artifacts,
        environment: input.environment,
        specificationHash: input.specificationHash,
        implementationHash: input.implementationHash,
        quoteAsset: input.quoteAsset,
        lpFee: input.lpFee,
        initialTick: input.initialTick,
        feeReceiver: input.environment.feeReceiver,
        marketSalt: input.marketSalt,
        deployerAddress: input.deployerAddress,
      });

      problems.push(...poolProblems({ manifest, input }));
    } catch (error) {
      problems.push(
        error instanceof ManifestError
          ? error.message
          : error instanceof Error
            ? error.message.slice(0, 300)
            : "an unexpected failure while assembling the launch",
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * References that cannot be resolved, and an order that cannot be walked.
 *
 * `validateDeploymentSpec` already rejects both during design, so reaching one here means
 * the specification was written by hand or the plan changed underneath it. Checked anyway,
 * because the alternative is a thrown error from inside a topological sort.
 */
function referenceProblems(
  spec: DeploymentSpecification,
  plan: MarketImplementationPlan,
): readonly string[] {
  const problems: string[] = [];
  const known = new Set(plan.components.map((component) => component.id));

  for (const component of spec.components) {
    const references = [
      ...component.constructorArguments.map((argument) => argument.source),
      ...component.wiring.map((call) => call.argument),
      ...(component.controller === null ? [] : [component.controller]),
    ];

    for (const reference of references) {
      if (reference === POOL_ID_REF) continue;

      const parsed = parseRef(reference);
      if (parsed === null) {
        problems.push(`${component.contractName}: "${reference}" is not a reference Agen can resolve`);
        continue;
      }

      if (parsed.kind === "component" && !known.has(parsed.componentId)) {
        problems.push(
          `${component.contractName}: COMPONENT:${parsed.componentId} is not a component of this market`,
        );
      }
    }
  }

  if (problems.length > 0) return problems;

  try {
    deploymentSpecOrder(spec);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "the deployment order cannot be walked");
  }

  return problems;
}

/**
 * Whether the pool the manifest opens is the pool the deployment described.
 *
 * The fee is read from the hook and carried through several hands before it reaches a
 * `PoolKey`, and a market opened at a fee its own hook refuses reverts inside `initialize`
 * — after every component has been deployed and paid for. Cheap to confirm here.
 */
function poolProblems({
  manifest,
  input,
}: {
  readonly manifest: ReturnType<typeof assembleManifest>;
  readonly input: PreflightInput;
}): readonly string[] {
  const problems: string[] = [];

  if (manifest.lpFee !== input.deployment.pool.lpFee) {
    problems.push(
      `the deployment declares a pool fee of ${String(input.deployment.pool.lpFee)} and this ` +
        `launch would open the pool at ${String(manifest.lpFee)}`,
    );
  }

  // A component told the pool's id before the pool exists has to be told the id of the
  // exact key the factory opens. Recomputed from the manifest's own predicted addresses,
  // so a drift between the two would be caught rather than deployed.
  if (input.deployment.requiresPoolIdBeforeInitialize) {
    const token = manifest.components[manifest.tokenIndex]?.expected;
    const hook = manifest.components[manifest.hookIndex]?.expected;

    if (token === undefined || hook === undefined) {
      problems.push("this market binds its pool id and the manifest has no token or hook to derive it from");
    } else {
      const expected = poolIdFor({
        quoteAsset: input.quoteAsset,
        token,
        lpFee: manifest.lpFee,
        hook,
      }).slice(2).toLowerCase();

      const bound = manifest.wiring.some((call) => call.data.toLowerCase().includes(expected));
      if (!bound) {
        problems.push(
          "this market binds its pool id before initialization, and no wiring call carries the " +
            "id of the pool this launch opens",
        );
      }
    }
  }

  return problems;
}
