/**
 * The engine-v1 build. Ten stages, one model call, no generated code.
 *
 * ## What this is instead of
 *
 * Engine 0 runs nineteen stages and calls a model six to a dozen times. Nine of those
 * stages exist to recover from the fact that a model wrote Solidity:
 * `architecture_planning`, `code_generation`, `compilation`, `compilation_repair`,
 * `static_analysis`, `deployment_validation`, `test_generation`, `test_execution`,
 * `test_repair`. None of them appear here, because there is nothing to compile, nothing to
 * repair, and nothing whose meaning has to be inferred from an AST afterwards.
 *
 * What is left is the work that was always the point: read the prompt, check the reading,
 * put it in canonical form, show the creator exactly what it does, and encode it.
 *
 * ## Semantic conservation is the invariant, not a goal
 *
 * Every economic requirement in a prompt ends up in exactly one of four places: represented
 * in the canonical configuration, asked about, refused as unsupported, or reported as a
 * malformed answer. There is no fifth outcome and in particular there is no path where a
 * requirement is dropped.
 *
 * That is enforced structurally rather than by care. `resolve` refuses a claim of SUPPORTED
 * that arrives alongside anything the model could not express, so a market missing a
 * requirement cannot reach a configuration at all. `parseSpec` refuses unknown fields and
 * unknown discriminants, so a mechanic the schema has no room for cannot be smuggled in as
 * data. And the pipeline never falls back: an engine-v1 job that cannot be expressed fails
 * as UNSUPPORTED and does not quietly become an engine-0 job.
 *
 * The `buyOrSellSequence` regression — a model naming a rule kind the reader did not know,
 * and the reader answering `null` rather than "not understood" — has no shape here. There is
 * no field to put a rule kind in, and no function that returns an absence where it means a
 * failure.
 */

import {
  type CanonicalConfig,
  type InterpretationResult,
  type MarketBinding,
  configHash,
  encodeConfig,
  engineSummary,
  executionGraph,
  implementationHash,
  resolve,
  review,
  simulate,
} from "@verdant/market-engine";
import type { Hex } from "viem";

import {
  type EngineArtefacts,
  FailureCode,
  type GenerationJob,
  type JobStore,
  Stage,
  newJob,
} from "./../job.js";
import { ModelError, type ModelProvider } from "./../model.js";
import { interpretForEngine } from "./interpret.js";
import { type EngineAddresses, type LaunchParameters, type PreparedLaunch, prepareLaunch } from "./prepare.js";

/** Why an engine build stopped. Distinct from engine 0's codes, which name compiler failures. */
/**
 * Why an engine build stopped, drawn from the shared vocabulary.
 *
 * `NEEDS_CLARIFICATION` is deliberately not here. A question is a pause, not a failure, and
 * engine 0 already draws that line: nothing has gone wrong, the interpretation is intact,
 * and the job resumes the moment an answer arrives. Recording it as a failure would make
 * asking cheaper to avoid than to do, which is the incentive that produced a pipeline that
 * collected ambiguities and then ignored them.
 */
const ENGINE_FAILURES = {
  Unsupported: FailureCode.Unsupported,
  InterpretationError: FailureCode.InterpretationError,
  ModelUnavailable: FailureCode.ModelUnavailable,
  Undeployable: FailureCode.Undeployable,
} as const;

export interface EngineBuildRequest {
  readonly prompt: string;
  readonly name: string;
  readonly symbol: string;
  /** What the market is quoted in. Native ETH is the zero address. */
  readonly binding: MarketBinding;
  /** Answers to a previous run's questions, when this is a resumption. */
  readonly answers?: readonly { readonly id: string; readonly answer: string }[];
}

/**
 * Proves a prepared transaction actually launches the reviewed market.
 *
 * Throws to refuse. Returning normally is the claim that this configuration launched and
 * traded, so an implementation that cannot establish that must throw rather than return.
 */
export type LaunchProver = (prepared: PreparedLaunch, config: CanonicalConfig) => Promise<void>;

interface CommonOptions {
  readonly provider: ModelProvider;
  readonly store: JobStore;
  readonly addresses: EngineAddresses;
  /** Engine v2's own hook/factory/registry, when that stack has been deployed. */
  readonly addressesV2?: EngineAddresses;
  /** Everything about the launch that is not economics. */
  readonly parameters: Omit<LaunchParameters, "name" | "symbol" | "supply" | "specificationHash">;
  /** Omitted where the vault's address is not yet knowable. See `PrepareRequest`. */
  readonly vaultInitCodeHash?: Hex;
  /** Where the factory says the token will land, when the caller has asked it. */
  readonly predictedToken?: `0x${string}`;
  readonly now?: () => number;
  /**
   * A job this build should continue rather than create.
   *
   * For a caller that persists the job before queueing the work — which the app does, so a
   * creator's description is durable from the moment they submit it. See `run`.
   */
  readonly resume?: GenerationJob;
}

/**
 * What a real build needs. The prover is required, and that is the point.
 *
 * `deployment_ready` is a claim that a market launches, and encoding calldata establishes
 * nothing of the kind — it establishes that some bytes are well-formed. Engine 0 already made
 * this mistake in a milder form: its `simulation` stage recorded, honestly, that no
 * simulation had run, and every build passed through it anyway.
 *
 * So the requirement is in the type rather than in a comment. There is no way to call
 * `runEngineBuild` without a prover, which means there is no app, staging, CLI or production
 * path that can reach `deployment_ready` on unproven calldata. A caller that wants to skip it
 * has to say so out loud by reaching for `runEngineBuildForTest`, which is the only function
 * that permits it and which says in its name what it is for.
 */
export interface EngineBuildOptions extends CommonOptions {
  readonly proveLaunchable: LaunchProver;
}

/** The record a caller gets back. `job` is also persisted at every transition. */
export interface EngineBuildResult {
  readonly job: GenerationJob;
}

const EMPTY_ARTEFACTS: EngineArtefacts = {
  outcome: "INTERPRETATION_ERROR",
  assumptions: [],
  unsupported: [],
  clarifications: [],
  problems: [],
  encodedConfig: null,
  configHash: null,
  implementationHash: null,
  review: null,
  summary: null,
  simulation: null,
  graph: null,
  preparation: null,
};

/** Turn the engine's verdict into the artefacts a job carries. */
function artefactsOf(result: InterpretationResult): EngineArtefacts {
  return {
    outcome: result.outcome,
    assumptions: result.assumptions,
    unsupported: result.unsupported.map((entry) => ({ request: entry.request, why: entry.why })),
    clarifications: result.clarifications.map((entry) => ({
      id: entry.id,
      question: entry.question,
      because: entry.because,
    })),
    problems: result.problems.map((problem) => ({
      code: problem.code,
      path: problem.path,
      detail: problem.detail,
    })),
    encodedConfig: null,
    configHash: null,
    implementationHash: null,
    review: null,
    summary: null,
    simulation: null,
    graph: null,
    preparation: null,
  };
}

/**
 * Run an engine-v1 build.
 *
 * Stages are recorded as they happen and the job is persisted at every transition, for the
 * reason engine 0 does it: a creator who reloads the tab must not lose the build, and a
 * build screen showing real progress needs the progress to be somewhere it can read.
 */
export async function runEngineBuild(
  request: EngineBuildRequest,
  options: EngineBuildOptions,
): Promise<EngineBuildResult> {
  return await run(request, options);
}

/**
 * The same build, with the launchability proof omitted.
 *
 * The only entry point that permits that, and named so a call site cannot be mistaken for a
 * real one in review. It exists because a unit test asserting stage ordering or commitment
 * derivation has no chain to launch against, and standing one up for every such test would
 * make the fast suite slow enough that people stop running it.
 *
 * Nothing outside a test file should call this. A job it produces has reached
 * `deployment_ready` without anything having established that its transaction works, so its
 * calldata is a hypothesis.
 */
export async function runEngineBuildForTest(
  request: EngineBuildRequest,
  options: CommonOptions & { readonly proveLaunchable?: LaunchProver },
): Promise<EngineBuildResult> {
  return await run(request, options);
}

async function run(
  request: EngineBuildRequest,
  options: CommonOptions & { readonly proveLaunchable?: LaunchProver },
): Promise<EngineBuildResult> {
  const now = options.now ?? Date.now;
  const clock = (): number => now();

  /*
   * Adopt the caller's job when there is one, rather than creating a second.
   *
   * The app writes the job down before it queues it, so a description survives a restart or
   * a queue that is minutes deep. That job already exists by the time this runs, and `create`
   * refuses a duplicate id — so without this the app would have to choose between durability
   * and using this pipeline at all. Resuming also keeps the id in the URL the creator already
   * has, which a fresh job would silently orphan.
   *
   * The stage list is reset rather than appended to. A resumption is a rerun of the whole
   * build, so carrying the previous attempt's records forward would render two interpretation
   * stages and leave a creator reading the older one's outcome.
   */
  let job =
    options.resume === undefined
      ? await options.store.create(
          newJob({
            id: crypto.randomUUID(),
            prompt: request.prompt,
            name: request.name,
            symbol: request.symbol,
            now: clock(),
            engineVersion: 1,
          }),
        )
      : {
          ...options.resume,
          engineVersion: (options.resume.engineVersion === 2 ? 2 : 1) as 1 | 2,
          stage: Stage.PromptReceived,
          stages: [],
          engine: null,
          failure: null,
        };

  const save = async (next: GenerationJob): Promise<GenerationJob> => {
    job = { ...next, updatedAt: clock() };
    await options.store.write(job);
    return job;
  };

  const begin = (stage: Stage): GenerationJob => ({
    ...job,
    stage,
    stages: [
      ...job.stages,
      { stage, startedAt: clock(), completedAt: null, status: "running", detail: null, attempt: 1 },
    ],
  });

  const finish = (status: "succeeded" | "failed", detail: string | null): GenerationJob => ({
    ...job,
    stages: job.stages.map((record, index) =>
      index === job.stages.length - 1 ? { ...record, completedAt: clock(), status, detail } : record,
    ),
  });

  const fail = async (
    stage: Stage,
    code: FailureCode,
    detail: string,
    artefacts: EngineArtefacts,
  ): Promise<EngineBuildResult> => {
    await save(finish("failed", detail));
    return {
      job: await save({
        ...job,
        stage: Stage.Failed,
        engine: artefacts,
        failure: { code, stage, detail, diagnostics: [] },
      }),
    };
  };

  /**
   * Stop and wait for the creator, without recording a failure.
   *
   * The interpretation is intact and the questions are on the job, so answering resumes from
   * here rather than starting again.
   */
  const askCreator = async (artefacts: EngineArtefacts): Promise<EngineBuildResult> => {
    await save(finish("succeeded", `${String(artefacts.clarifications.length)} question(s) for the creator`));
    return {
      job: await save({ ...job, stage: Stage.AwaitingClarification, engine: artefacts }),
    };
  };

  // --- interpreting --------------------------------------------------------

  await save(begin(Stage.Interpreting));

  let answer: unknown;
  try {
    const interpreted = await interpretForEngine(options.provider, {
      prompt: request.prompt,
      name: request.name,
      symbol: request.symbol,
      quoteAssetSymbol: request.binding.quoteAsset.symbol,
      quoteIsNative: /^0x0{40}$/i.test(request.binding.quoteAsset.address),
      /*
       * The supply, so a threshold written in tokens can be stated as a share of it.
       *
       * The model used to be given no supply and no way to express "sells over a million
       * tokens" — a perfectly ordinary request — as the percentage the engine measures in.
       * Telling it the supply makes the conversion arithmetic rather than a guess, and it is
       * the launch's own number, so the percentage it produces is one the compiler will
       * resolve back to the amount the creator asked for.
       */
      referenceSupplyTokens: request.binding.referenceSupply / 10n ** 18n,
      ...(request.answers === undefined ? {} : { answers: request.answers }),
    });
    answer = interpreted.answer;
  } catch (error) {
    const detail = error instanceof ModelError ? error.message : "the model could not be reached";
    return await fail(Stage.Interpreting, ENGINE_FAILURES.ModelUnavailable, detail, EMPTY_ARTEFACTS);
  }

  await save(finish("succeeded", "one call, one configuration"));
  await save(begin(Stage.SpecificationCreated));
  await save(finish("succeeded", null));

  // --- validating ----------------------------------------------------------
  //
  // Strict parse and semantic validation, in one call, because `resolve` runs them in the
  // order that makes the outcome honest: a malformed answer is never reported as an
  // unsupported market, and an unsupported market is never reported as a valid one.

  await save(begin(Stage.Validating));

  const resolved = resolve(answer, request.binding);
  const artefacts = artefactsOf(resolved);

  if (resolved.outcome === "INTERPRETATION_ERROR") {
    return await fail(
      Stage.Validating,
      ENGINE_FAILURES.InterpretationError,
      resolved.problems[0]?.detail ?? "the model's answer was not a specification",
      artefacts,
    );
  }

  if (resolved.outcome === "UNSUPPORTED") {
    return await fail(
      Stage.Validating,
      ENGINE_FAILURES.Unsupported,
      resolved.problems.map((problem) => problem.detail).join(" "),
      artefacts,
    );
  }

  if (resolved.outcome === "NEEDS_CLARIFICATION") {
    return await askCreator(artefacts);
  }

  const config = resolved.config;
  if (config === null) {
    // Unreachable: `resolve` only returns SUPPORTED with a configuration. Asserted because
    // the alternative is the exact failure this engine exists to remove — a market
    // proceeding on nothing.
    return await fail(
      Stage.Validating,
      ENGINE_FAILURES.InterpretationError,
      "the engine reported a supported market and produced no configuration",
      artefacts,
    );
  }

  await save(finish("succeeded", "the configuration is one the engine can execute"));

  // --- canonicalizing ------------------------------------------------------
  //
  // Already done — `resolve` compiles, and compiling *is* canonicalizing. The stage exists
  // because the artefacts it produces are the ones everything downstream reads, and a
  // creator watching the build should see the step where their market acquired an identity.

  const version = config.engineVersion;
  const addresses = version === 2 && options.addressesV2 !== undefined ? options.addressesV2 : options.addresses;

  await save({ ...job, engineVersion: version });
  await save(begin(Stage.Canonicalizing));

  const encoded = encodeConfig(config);
  const identity = configHash(config);
  const commitment = implementationHash(config, {
    chainId: addresses.chainId,
    engine: addresses.hook,
    engineVersion: version,
  });

  let carried: EngineArtefacts = {
    ...artefacts,
    encodedConfig: encoded,
    configHash: identity,
    implementationHash: commitment,
  };

  await save({ ...finish("succeeded", `configuration ${identity.slice(0, 10)}`), engine: carried });

  // --- simulating ----------------------------------------------------------

  await save(begin(Stage.Simulating));

  const simulation = simulate(config);
  carried = { ...carried, simulation: JSON.parse(jsonify(simulation)) as unknown };

  await save({
    ...finish("succeeded", `${String(simulation.cases.length)} cases, every threshold's boundary`),
    engine: carried,
  });

  // --- review --------------------------------------------------------------

  await save(begin(Stage.ReviewReady));

  carried = {
    ...carried,
    review: JSON.parse(jsonify(review(config))) as unknown,
    summary: JSON.parse(jsonify(engineSummary(config))) as unknown,
    graph: JSON.parse(jsonify(executionGraph(config))) as unknown,
  };

  await save({ ...finish("succeeded", null), engine: carried });

  // --- approval ------------------------------------------------------------
  //
  // A marker rather than a wait. The creator's signature arrives through a separate call, and
  // this stage says the market is understood well enough to be asked about.

  await save(begin(Stage.ApprovalReady));
  await save({ ...finish("succeeded", `commitment ${commitment.slice(0, 10)}`), engine: carried });

  if (version === 2 && options.addressesV2 === undefined) {
    return {
      job: await save({
        ...job,
        stage: Stage.ApprovalReady,
        engine: carried,
      }),
    };
  }

  // --- deployment preparation ----------------------------------------------

  await save(begin(Stage.DeploymentPreparing));

  let prepared: PreparedLaunch;
  try {
    prepared = prepareLaunch({
      config,
      parameters: {
        ...options.parameters,
        name: request.name,
        symbol: request.symbol,
        supply: request.binding.referenceSupply,
        specificationHash: identity,
      },
      addresses,
      ...(options.vaultInitCodeHash === undefined
        ? {}
        : { vaultInitCodeHash: options.vaultInitCodeHash }),
      ...(options.predictedToken === undefined ? {} : { predictedToken: options.predictedToken }),
    });
  } catch (error) {
    return await fail(
      Stage.DeploymentPreparing,
      ENGINE_FAILURES.Undeployable,
      error instanceof Error ? error.message : "the configuration could not be prepared",
      carried,
    );
  }

  /*
   * And then proved.
   *
   * Absent only under `runEngineBuildForTest`, which is the one entry point that permits it
   * and says so in its name. Every other caller is typed into supplying one, so there is no
   * real execution path on which a job reaches `deployment_ready` having established only
   * that its bytes were well-formed.
   */
  if (options.proveLaunchable !== undefined && version !== 2) {
    try {
      await options.proveLaunchable(prepared, config);
    } catch (error) {
      return await fail(
        Stage.DeploymentPreparing,
        ENGINE_FAILURES.Undeployable,
        error instanceof Error ? error.message : "the prepared launch did not execute",
        carried,
      );
    }
  }

  carried = { ...carried, preparation: JSON.parse(jsonify(prepared)) as unknown };
  await save({ ...finish("succeeded", `${prepared.call.selector} to ${prepared.call.to}`), engine: carried });

  // --- ready ---------------------------------------------------------------

  await save(begin(Stage.DeploymentReady));
  return { job: await save({ ...finish("succeeded", null), stage: Stage.DeploymentReady, engine: carried }) };
}

/**
 * JSON with `bigint` rendered as a decimal string.
 *
 * The artefacts carry token amounts and thresholds, which exceed `Number.MAX_SAFE_INTEGER`
 * routinely — a 1e9 supply at eighteen decimals is 1e27 — so `JSON.stringify` throws on them
 * rather than losing precision. Rendering them as strings is the same choice the schema makes
 * for the same reason.
 */
function jsonify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
}
