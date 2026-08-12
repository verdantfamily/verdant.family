/**
 * A build, as a thing that survives a page refresh.
 *
 * Generating a market takes minutes and involves a model, a compiler and a test runner,
 * none of which are fast and any of which can fail. A creator who reloads the tab
 * during that must not lose the build, and the build screen showing real progress means
 * the progress has to be somewhere the screen can read it. So the job is persisted at
 * every stage transition rather than held in a worker's memory.
 *
 * ## Why the stage list is explicit and finite
 *
 * A pipeline whose progress is "a number between 0 and 1" cannot tell a creator that
 * their market failed to compile twice and then passed. The stages here are the ones
 * the interface names, in the order they happen, and the record keeps every transition
 * with its timing. That is what makes the build screen honest: it reports what actually
 * happened rather than animating a bar.
 *
 * ## Raw model output is kept apart from validated artefacts
 *
 * Each stage stores what the model said and, separately, what survived validation. They
 * are different objects for a reason that shows up during incident review: when a market
 * is wrong, the question is whether the model proposed something bad or whether good
 * output was mangled downstream, and that is unanswerable if only the merged result was
 * kept. Raw output is also never read back into the pipeline — only the validated
 * artefact is — so keeping it costs nothing in safety.
 */

import type { Hex } from "viem";

import type { Diagnostic, TestOutcome } from "./foundry.js";
import type { GateFinding } from "./gates.js";
import type { LaunchManifest } from "./manifest.js";
import type { MarketImplementationPlan } from "./plan.js";
import type { MarketSpecification } from "./spec.js";
import type { GeneratedSource } from "./workspace.js";

/**
 * Where a build has got to.
 *
 * `compilationRepair` and `testRepair` are stages rather than hidden retries because
 * they are the interesting part of the product. A creator watching "repairing the
 * contract, attempt 2" is watching Agen do the thing it claims to do; the same work
 * hidden behind "compiling…" looks like a slow compiler.
 */
export const Stage = {
  PromptReceived: "prompt_received",
  Interpreting: "interpreting",
  SpecificationCreated: "specification_created",
  /**
   * Agen has a reading of the market and one or more questions it cannot answer for the
   * creator.
   *
   * A pause, not a failure, and the distinction is the whole point: nothing has gone
   * wrong, the interpretation is intact, and the job resumes from here the moment an
   * answer arrives. Treating it as a failure would throw away the interpretation and
   * make asking a question more expensive than guessing — which is exactly the incentive
   * that produced a build pipeline that collected ambiguities and then ignored them.
   *
   * Only reached for ambiguity that would change the market. See `assess`.
   */
  AwaitingClarification: "awaiting_clarification",
  ArchitecturePlanning: "architecture_planning",
  CodeGeneration: "code_generation",
  Compilation: "compilation",
  CompilationRepair: "compilation_repair",
  /**
   * The deployment gates, run early enough that a finding can still be fixed.
   *
   * A detour rather than a step, like the repair stages: it only appears when something
   * was found. The gates run again at the end and remain the authority — this is the
   * same verdict delivered while the market is still being built, so a missing caller
   * check becomes a repair round instead of ending a build seven minutes in.
   */
  StaticAnalysis: "static_analysis",
  TestGeneration: "test_generation",
  TestExecution: "test_execution",
  TestRepair: "test_repair",
  /**
   * The market is built, compiles, and passes the tests that say it does what was asked.
   *
   * The point of the whole pipeline as far as a creator is concerned: everything before
   * it is a progress bar, and everything after it happens while they read. Deployment is
   * still blocked — deep validation has not run — but the market can be shown, and the
   * difference between showing it at ninety seconds and at ten minutes is the difference
   * between a product and a batch job.
   */
  ReviewReady: "review_ready",
  /** Fuzzing, invariants and the gates. Runs while the creator reviews. */
  DeepValidation: "deep_validation",
  Simulation: "simulation",
  FinalValidation: "final_validation",
  DeploymentReady: "deployment_ready",
  Failed: "failed",
} as const;

export type Stage = (typeof Stage)[keyof typeof Stage];

/** The happy path, in order. Repair stages are detours off it, not steps along it. */
export const STAGE_SEQUENCE: readonly Stage[] = [
  Stage.PromptReceived,
  Stage.Interpreting,
  Stage.SpecificationCreated,
  Stage.ArchitecturePlanning,
  Stage.CodeGeneration,
  Stage.Compilation,
  Stage.TestGeneration,
  Stage.TestExecution,
  Stage.ReviewReady,
  Stage.DeepValidation,
  Stage.Simulation,
  Stage.FinalValidation,
  Stage.DeploymentReady,
];

export const TERMINAL_STAGES: readonly Stage[] = [Stage.DeploymentReady, Stage.Failed];

export function isTerminal(stage: Stage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/**
 * Stopped, but waiting on a person rather than finished.
 *
 * Polling clients need this separately from `isTerminal`: a job here will never advance
 * on its own, so continuing to poll is pointless, but it is not over and must not be
 * rendered as a failure.
 */
export function isAwaitingCreator(stage: Stage): boolean {
  return stage === Stage.AwaitingClarification;
}

/** What the build screen renders for one stage. */
export interface StageRecord {
  readonly stage: Stage;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly status: "running" | "succeeded" | "failed";
  /** One line, safe to show a creator. Never a stack trace. */
  readonly detail: string | null;
  /** Which attempt this is, for stages that repeat. */
  readonly attempt: number;
}

/**
 * What a model said, before anything checked it.
 *
 * Stored for review and never read back into the pipeline. `promptHash` rather than the
 * prompt: enough to prove two stages saw the same input without keeping a copy of every
 * creator's text in a second place.
 */
export interface ModelExchange {
  /**
   * Which call within the stage, when a stage makes more than one.
   *
   * Interpretation is three or more calls and code generation is one per component.
   * Recorded per call rather than per stage because "interpretation took 349 seconds"
   * does not say whether to fix the rules call, the repairs or the frame, and the
   * aggregate is what the first profiling attempt produced.
   */
  readonly call?: string;
  /**
   * How many times this call was made again before it produced something usable.
   *
   * Zero on a first-time success. Non-zero is the interesting case: a stage whose
   * latency is mostly retries is a schema or prompt problem, and one that is slow on a
   * single attempt is a reasoning-effort or output-size problem. The two want opposite
   * fixes and the aggregate cannot tell them apart.
   */
  readonly retries?: number;
  readonly stage: Stage;
  readonly at: number;
  readonly provider: string;
  readonly model: string;
  readonly promptHash: Hex;
  readonly raw: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Wall-clock for the call. Latency is a product requirement, so it is measured. */
  readonly durationMs: number | null;
  /** Set when the output failed validation, with what was wrong. */
  readonly rejected: string | null;
}

/** Why a build stopped, in a form worth alerting on. */
export const FailureCode = {
  ModelUnavailable: "MODEL_UNAVAILABLE",
  /** The model's output did not satisfy the schema or the validator. */
  InvalidArtefact: "INVALID_ARTEFACT",
  /** The request asks for something this pipeline will not build. */
  Unsupported: "UNSUPPORTED",
  CompilationUnrepairable: "COMPILATION_UNREPAIRABLE",
  TestsUnrepairable: "TESTS_UNREPAIRABLE",
  GateBlocked: "GATE_BLOCKED",
  /**
   * The market is correct and cannot be put on a chain.
   *
   * Its own category because it says something different from every other failure here:
   * the contracts compiled, the tests passed and the gates cleared, and the bundle still
   * cannot be assembled — a constructor argument nothing can supply, a dependency cycle
   * CREATE2 cannot untie, a token that will not sort above the quote asset. A market
   * that fails this way needs a different plan, not a repair.
   */
  Undeployable: "UNDEPLOYABLE",
  SimulationFailed: "SIMULATION_FAILED",
  /** The build ran out of its time or iteration budget. */
  BudgetExhausted: "BUDGET_EXHAUSTED",
  /** The compiler or the runner itself broke. Not the market's fault. */
  ToolchainError: "TOOLCHAIN_ERROR",
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export interface Failure {
  readonly code: FailureCode;
  /** What went wrong, in the creator's terms. */
  readonly detail: string;
  /** The stage it happened in. */
  readonly stage: Stage;
  /** Kept so a failed build is diagnosable rather than merely red. */
  readonly diagnostics?: readonly Diagnostic[];
  readonly failingTests?: readonly TestOutcome[];
  readonly gateFindings?: readonly GateFinding[];
}

export interface SimulationSummary {
  readonly swaps: number;
  readonly maxObservedFeePpm: number;
  readonly stateTransitions: number;
  readonly invariantFailures: number;
  /** Present only when a real run produced it. Never a placeholder. */
  readonly notes?: readonly string[];
}

export interface GenerationJob {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly stage: Stage;

  /** Exactly what the creator typed. Untrusted, quoted, never executed. */
  readonly prompt: string;
  readonly name: string;
  readonly symbol: string;

  readonly stages: readonly StageRecord[];
  readonly exchanges: readonly ModelExchange[];

  /** Validated artefacts, each present once its stage has succeeded. */
  readonly specification: MarketSpecification | null;
  /** Every specification version, so an edit can be reviewed against its predecessor. */
  readonly specificationHistory: readonly MarketSpecification[];
  readonly plan: MarketImplementationPlan | null;
  readonly sources: readonly GeneratedSource[];
  readonly tests: readonly GeneratedSource[];
  readonly testOutcomes: readonly TestOutcome[];
  readonly gateFindings: readonly GateFinding[];
  readonly simulation: SimulationSummary | null;
  /**
   * Present exactly when the build reached `deployment_ready`.
   *
   * Null everywhere else and never null there: a build that could not produce one does
   * not become deployable with a missing manifest, it fails. See `runBuild`.
   */
  readonly manifest: LaunchManifest | null;

  /** How many repair rounds each loop has used. */
  readonly compilationAttempts: number;
  readonly testAttempts: number;

  readonly failure: Failure | null;
}

export interface JobStore {
  create(job: GenerationJob): Promise<GenerationJob>;
  read(id: string): Promise<GenerationJob | null>;
  /**
   * Replace a job.
   *
   * Whole-record writes rather than patches. The pipeline holds the job in memory for
   * the length of a stage and writes it back at each transition; a patch API would
   * invite two stages writing different fields from stale copies.
   */
  write(job: GenerationJob): Promise<GenerationJob>;
  /** Most recent first. For an operator view, not a creator's. */
  list(limit: number): Promise<readonly GenerationJob[]>;
}

export function newJob({
  id,
  prompt,
  name,
  symbol,
  now,
}: {
  readonly id: string;
  readonly prompt: string;
  readonly name: string;
  readonly symbol: string;
  readonly now: number;
}): GenerationJob {
  return {
    id,
    createdAt: now,
    updatedAt: now,
    stage: Stage.PromptReceived,
    prompt,
    name,
    symbol,
    stages: [
      { stage: Stage.PromptReceived, startedAt: now, completedAt: now, status: "succeeded", detail: null, attempt: 1 },
    ],
    exchanges: [],
    specification: null,
    specificationHistory: [],
    plan: null,
    sources: [],
    tests: [],
    testOutcomes: [],
    gateFindings: [],
    simulation: null,
    manifest: null,
    compilationAttempts: 0,
    testAttempts: 0,
    failure: null,
  };
}

/**
 * Put a finished or abandoned job back in motion, keeping everything it established.
 *
 * A build fails for reasons that have nothing to do with the market: a provider going
 * down, an account running out of credit, a machine being closed. Starting again from
 * the prompt then re-asks for a specification and a plan that were already produced and
 * already validated, which is minutes of model time and, worse, a different market —
 * interpretation is not deterministic, so the creator who reviewed the first one is
 * shown a second.
 *
 * So the artefacts stay and the history stays. `stages` is not cleared either: the
 * record of an attempt that failed at test repair is the most useful thing to have when
 * the resumed attempt fails there too.
 */
export function restartJob(job: GenerationJob, now: number): GenerationJob {
  return {
    ...job,
    stage: Stage.PromptReceived,
    updatedAt: now,
    failure: null,
    // A stage left running when the process died is closed as failed rather than left
    // open, so the timeline reads as what happened rather than as a stage still going.
    stages: job.stages.map((record) =>
      record.status === "running"
        ? { ...record, status: "failed" as const, completedAt: now, detail: "interrupted" }
        : record,
    ),
  };
}

/** Begin a stage, closing off any attempt of it that was already running. */
export function beginStage(
  job: GenerationJob,
  stage: Stage,
  now: number,
  /** For a stage that says something the moment it opens, rather than when it closes. */
  detail?: string,
): GenerationJob {
  const previous = job.stages.filter((record) => record.stage === stage).length;

  return {
    ...job,
    stage,
    updatedAt: now,
    stages: [
      ...job.stages.map((record) =>
        record.status === "running"
          ? { ...record, status: "succeeded" as const, completedAt: now }
          : record,
      ),
      {
        stage,
        startedAt: now,
        completedAt: null,
        status: "running",
        detail: detail ?? null,
        attempt: previous + 1,
      },
    ],
  };
}

/** Close the running attempt of the current stage. */
export function endStage(
  job: GenerationJob,
  { status, detail, now }: { status: "succeeded" | "failed"; detail?: string; now: number },
): GenerationJob {
  let closed = false;

  // Only the last running record is closed: a repair stage can legitimately appear
  // several times, and rewriting all of them would lose the attempt history.
  const stages = [...job.stages].reverse().map((record) => {
    if (closed || record.status !== "running") return record;
    closed = true;
    return { ...record, status, completedAt: now, detail: detail ?? null };
  });

  return { ...job, updatedAt: now, stages: stages.reverse() };
}

/** Move a job to `failed`, preserving everything that led there. */
export function failJob(job: GenerationJob, failure: Failure, now: number): GenerationJob {
  const ended = endStage(job, { status: "failed", detail: failure.detail, now });

  return {
    ...ended,
    stage: Stage.Failed,
    updatedAt: now,
    failure,
    stages: [
      ...ended.stages,
      { stage: Stage.Failed, startedAt: now, completedAt: now, status: "failed", detail: failure.detail, attempt: 1 },
    ],
  };
}

/**
 * How far along a build is, for a progress indicator that is not a lie.
 *
 * Measured against the happy path, so a build in its third compilation repair sits at
 * the compilation stage's fraction rather than sliding backwards — which is accurate:
 * it has not lost ground, it is taking longer.
 */
export function progressOf(job: GenerationJob): number {
  if (job.stage === Stage.DeploymentReady) return 1;
  if (job.stage === Stage.Failed) {
    const reached = job.stages
      .map((record) => STAGE_SEQUENCE.indexOf(record.stage))
      .filter((index) => index >= 0);
    const furthest = reached.length === 0 ? 0 : Math.max(...reached);
    return furthest / (STAGE_SEQUENCE.length - 1);
  }

  const anchor =
    job.stage === Stage.CompilationRepair
      ? Stage.Compilation
      : job.stage === Stage.TestRepair
        ? Stage.TestExecution
        : job.stage;

  const index = STAGE_SEQUENCE.indexOf(anchor);
  return index < 0 ? 0 : index / (STAGE_SEQUENCE.length - 1);
}
