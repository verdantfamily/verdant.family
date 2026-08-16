/**
 * What went wrong, whose fault it is, and what to try next.
 *
 * The pipeline already repairs: three attempts at the compiler, three at the tests, each
 * one handing the same kind of prompt back to the same model. What it does not do is
 * notice that it is failing the same way each time. An attempt that changes nothing but
 * the attempt number is not a second opinion, and three of them are not a recovery
 * strategy — they are the same idea, billed three times, ending in a failure message
 * about a market that was never the problem.
 *
 * This module supplies the two things that turn retrying into recovering: a name for the
 * failure, and a different thing to try.
 *
 * ## A category is not the same as a code
 *
 * `FailureCode` says which part of the pipeline gave up. `FailureCategory` says what kind
 * of problem it met, which is what decides who can fix it: a TYPE_API_MISMATCH is a
 * repairer's job and almost always a one-line one, a SEMANTIC_FAILURE means the market
 * does not do what was asked and needs the specification in front of it, and a
 * SPECIFICATION-blamed failure cannot be repaired at all because the request itself does
 * not describe something buildable. The codes stay: they are what the store already
 * holds and what the interface already renders. The category is what the recovery ladder
 * reads.
 *
 * ## Signatures, and why sameness is the signal
 *
 * Every classification carries a signature: a normalised fingerprint of the diagnostics
 * that produced it, with line numbers and paths removed so that the same mistake in a
 * rewritten file still matches itself. Two consecutive attempts with one signature mean
 * the last attempt achieved nothing, and the ladder skips a rung rather than spending
 * another on it. This is the difference between a budget of three attempts and three
 * chances: three chances are only worth having if they are not the same chance.
 */

import type { Diagnostic, TestOutcome } from "./foundry";
import type { GateFinding } from "./gates";
import { Stage } from "./job.js";
import { Blame, recognise, recogniseAll, type PlaybookEntry } from "./playbook.js";

/**
 * The kinds of problem a build can meet.
 *
 * Deliberately about the nature of the problem rather than the stage that found it, so
 * that a type error is the same kind of thing whether the compiler caught it in a
 * contract or in a test.
 */
export const FailureCategory = {
  /** The request could not be read as a market. */
  Interpretation: "INTERPRETATION",
  /** The model produced something that is not a usable artefact at all. */
  Generation: "GENERATION",
  /** It does not compile, for a reason with no cheaper name. */
  Compilation: "COMPILATION",
  /** It does not compile because something was called wrongly. Usually one line. */
  TypeApiMismatch: "TYPE_API_MISMATCH",
  /** A test fails because the test is wrong. */
  TestFailure: "TEST_FAILURE",
  /** The canonical market never reached a behavior test. */
  HarnessInfrastructure: "HARNESS_INFRASTRUCTURE",
  /** A test fails because the market does not do what was asked. */
  SemanticFailure: "SEMANTIC_FAILURE",
  /** The review refuses it: unsafe, or unproven where proof was claimed. */
  SecurityGate: "SECURITY_GATE",
  /** The pieces are fine and cannot be assembled into a deployment. */
  Manifest: "MANIFEST",
  /**
   * The contracts and the deployment they were designed for do not describe one market.
   *
   * Neither artefact is wrong on its own, which is what makes this its own category. The
   * repair is not to reshape a contract until the launcher copes — that is the loop the
   * declared deployment exists to remove — but to regenerate the one component that
   * disagreed, against the declaration it was supposed to satisfy.
   */
  ArchitectureConsistency: "ARCHITECTURE_CONSISTENCY",
  /** It would deploy and could not then be launched or traded as intended. */
  DeploymentCompatibility: "DEPLOYMENT_COMPATIBILITY",
  /** A chain could not be reached or answered wrongly. */
  Rpc: "RPC",
  /** The model provider refused, rate-limited, timed out or returned nothing. */
  ModelProvider: "MODEL_PROVIDER",
  /** The compiler, the filesystem, the machine. Nothing about this market. */
  Infrastructure: "INFRASTRUCTURE",
} as const;

export type FailureCategory = (typeof FailureCategory)[keyof typeof FailureCategory];

export interface Classification {
  readonly category: FailureCategory;
  /** Which artefact has to change for this to stop happening. */
  readonly blame: Blame;
  /** The playbook entry that recognised it, if any. */
  readonly playbook: string | null;
  /**
   * A fingerprint of the failure, stable across attempts that change only line numbers
   * and file paths. Two attempts sharing one signature made no progress between them.
   */
  readonly signature: string;
  /** True where repairing cannot help and a person has to decide something. */
  readonly terminal: boolean;
}

export interface ClassifyInput {
  readonly stage: Stage;
  readonly diagnostics?: readonly Diagnostic[];
  readonly failingTests?: readonly TestOutcome[];
  readonly gateFindings?: readonly GateFinding[];
  /** For failures that arrive as exceptions rather than as diagnostics. */
  readonly error?: unknown;
}

/** Stages whose failures are about the request rather than about any code. */
const INTERPRETATION_STAGES: ReadonlySet<Stage> = new Set([
  Stage.Interpreting,
  Stage.SpecificationCreated,
  Stage.AwaitingClarification,
]);

const GENERATION_STAGES: ReadonlySet<Stage> = new Set([
  Stage.ArchitecturePlanning,
  Stage.CodeGeneration,
  Stage.TestGeneration,
]);

const COMPILATION_STAGES: ReadonlySet<Stage> = new Set([
  Stage.Compilation,
  Stage.CompilationRepair,
]);

const TEST_STAGES: ReadonlySet<Stage> = new Set([
  Stage.TestEnvironment,
  Stage.TestExecution,
  Stage.TestRepair,
  Stage.DeepValidation,
]);

const GATE_STAGES: ReadonlySet<Stage> = new Set([Stage.StaticAnalysis, Stage.FinalValidation]);

/** The categories a playbook blame implies when the stage alone is ambiguous. */
function categoryForBlame(blame: Blame, stage: Stage): FailureCategory | null {
  if (blame === Blame.HarnessInfrastructure) return FailureCategory.HarnessInfrastructure;
  if (blame === Blame.HarnessMisuse) return FailureCategory.TypeApiMismatch;
  if (blame === Blame.Toolchain) return FailureCategory.Infrastructure;
  if (blame === Blame.Specification) return FailureCategory.Interpretation;
  if (blame === Blame.Test && TEST_STAGES.has(stage)) return FailureCategory.TestFailure;
  if (blame === Blame.Contract && TEST_STAGES.has(stage)) return FailureCategory.SemanticFailure;
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  return "";
}

/**
 * The failure, named.
 *
 * The playbook is consulted first and its answer wins, because a recognised failure is
 * one somebody has already understood — the stage it happened in is a weaker signal than
 * a message that has been read before.
 */
export function classify(input: ClassifyInput): Classification {
  const { stage, diagnostics = [], failingTests = [], gateFindings = [], error } = input;

  const errorText = messageOf(error);
  const entry = recognise(diagnostics, failingTests, errorText === "" ? [] : [errorText]);

  const category = categoryOf(stage, entry, diagnostics, failingTests, gateFindings, errorText);
  const blame =
    category === FailureCategory.HarnessInfrastructure
      ? Blame.HarnessInfrastructure
      : (entry?.blame ?? blameOf(stage, category));

  return {
    category,
    blame,
    playbook: entry?.id ?? null,
    signature: signatureOf(diagnostics, failingTests, gateFindings, errorText),
    terminal: entry?.terminal === true || category === FailureCategory.Interpretation,
  };
}

function categoryOf(
  stage: Stage,
  entry: PlaybookEntry | null,
  diagnostics: readonly Diagnostic[],
  failingTests: readonly TestOutcome[],
  gateFindings: readonly GateFinding[],
  errorText: string,
): FailureCategory {
  // The two blames that mean the same thing wherever they are found. A stack-too-deep
  // is the compiler's limit whether it stopped a contract or a test, and a request that
  // cannot be built is not a code problem at any stage.
  if (entry?.blame === Blame.Toolchain) return FailureCategory.Infrastructure;
  if (entry?.blame === Blame.Specification) return FailureCategory.Interpretation;

  // A provider failure is about the provider wherever it happens, so it is checked
  // before the stage: an interpretation that 429s is not a request nobody can read.
  if (/rate.?limit|429|insufficient_quota|model|provider/i.test(errorText)) {
    return FailureCategory.ModelProvider;
  }

  if (INTERPRETATION_STAGES.has(stage)) return FailureCategory.Interpretation;
  if (GATE_STAGES.has(stage) && gateFindings.length > 0) return FailureCategory.SecurityGate;
  if (stage === Stage.DeploymentReady) return FailureCategory.Manifest;

  // The stage exists to compare two artefacts, so a failure in it is a disagreement between
  // them by construction. Kept ahead of the compile checks below because the contracts did
  // build — that is the precondition for asking the question at all.
  if (stage === Stage.DeploymentValidation) return FailureCategory.ArchitectureConsistency;

  // Forge reports a fixture failure as one synthetic outcome named setUp(); none of the
  // child test functions run. Whatever the nested revert says, it is evidence that the
  // canonical deployment did not produce a usable market, not evidence that a token
  // behavior assertion failed.
  if (
    TEST_STAGES.has(stage) &&
    failingTests.length > 0 &&
    failingTests.every((test) => test.name === "setUp()")
  ) {
    return FailureCategory.HarnessInfrastructure;
  }

  // Whether it built is structural and is checked before anything a playbook entry
  // implies, because "did not compile" and "compiled and behaved wrongly" are repaired
  // from different evidence — and the same entry can describe either. Undeclared
  // identifier blames the test in both cases; only one of them is a question about
  // behaviour.
  const wouldNotBuild = diagnostics.some((d) => d.severity === "error");
  const canonicalFixtureWouldNotBuild =
    TEST_STAGES.has(stage) &&
    diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" &&
        (diagnostic.file?.endsWith("test/MarketTestBase.sol") === true ||
          diagnostic.file?.endsWith("test/MarketTestEnvironment.t.sol") === true ||
          diagnostic.file?.endsWith("test/AgenTest.sol") === true ||
          // Agen's own core suite. A model may not edit it, so a compile error in it is
          // Agen's bug to fix and there is no repair round that could help.
          diagnostic.file?.endsWith("test/MarketCore.t.sol") === true),
    );

  if (canonicalFixtureWouldNotBuild) return FailureCategory.HarnessInfrastructure;

  if (COMPILATION_STAGES.has(stage) || (TEST_STAGES.has(stage) && wouldNotBuild)) {
    return diagnostics.some((d) => /TypeError|DeclarationError/.test(d.type))
      ? FailureCategory.TypeApiMismatch
      : FailureCategory.Compilation;
  }

  if (TEST_STAGES.has(stage)) {
    const implied = categoryForBlame(entry?.blame ?? Blame.Unknown, stage);
    return implied ?? FailureCategory.TestFailure;
  }

  if (GENERATION_STAGES.has(stage)) return FailureCategory.Generation;

  return FailureCategory.Infrastructure;
}

function blameOf(stage: Stage, category: FailureCategory): Blame {
  switch (category) {
    case FailureCategory.Interpretation:
      return Blame.Specification;
    case FailureCategory.SemanticFailure:
      return Blame.Contract;
    case FailureCategory.TestFailure:
      return Blame.Test;
    case FailureCategory.HarnessInfrastructure:
      return Blame.HarnessInfrastructure;
    case FailureCategory.SecurityGate:
      return Blame.Contract;
    // The declaration was checked when it was written, so the artefact that moved is the
    // contract. A repair aimed at the deployment would be asking the launcher to accommodate
    // code that was told what to write.
    case FailureCategory.ArchitectureConsistency:
      return Blame.Contract;
    case FailureCategory.ModelProvider:
    case FailureCategory.Infrastructure:
    case FailureCategory.Rpc:
      return Blame.Toolchain;
    case FailureCategory.Compilation:
    case FailureCategory.TypeApiMismatch:
      return TEST_STAGES.has(stage) ? Blame.Test : Blame.Contract;
    default:
      return Blame.Unknown;
  }
}

/**
 * A fingerprint that survives a rewrite.
 *
 * Numbers and quoted names go, because "Undeclared identifier" at line 42 and the same
 * error at line 51 after an edit are the same failure and the ladder must be able to say
 * so. Paths go for the same reason. What remains is the shape of the complaint.
 */
function signatureOf(
  diagnostics: readonly Diagnostic[],
  failingTests: readonly TestOutcome[],
  gateFindings: readonly GateFinding[],
  errorText: string,
): string {
  const parts = [
    ...diagnostics.filter((d) => d.severity === "error").map((d) => `${d.type}:${d.message}`),
    ...failingTests.map((t) => `${t.name}:${t.reason ?? ""}`),
    ...gateFindings.map((f) => f.code),
    errorText,
  ];

  const normalised = parts
    .map((part) =>
      part
        .replace(/0x[0-9a-fA-F]+/g, "0x")
        .replace(/\b\d+\b/g, "N")
        .replace(/"[^"]*"/g, '"_"')
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((part) => part !== "");

  return [...new Set(normalised)].sort().join(" | ").slice(0, 600);
}

// --- The ladder ---------------------------------------------------------------------

/**
 * What to try, in order.
 *
 * Each rung is a genuinely different move rather than a longer version of the last one.
 * The first is cheap and usually right; the last throws away the artefact and builds it
 * again from the specification, which is expensive and is the only thing that reliably
 * escapes a model's own bad idea.
 */
export const Tactic = {
  /** Fix the failing file, given the diagnostics and the file. */
  TargetedRepair: "targeted_repair",
  /** The same, with everything the failing file depends on in front of it. */
  ExpandedContext: "expanded_context",
  /** Keep the specification, change how it is implemented. */
  RethinkStrategy: "rethink_strategy",
  /** Discard the artefact and generate it again from the specification. */
  RegenerateComponent: "regenerate_component",
} as const;

export type Tactic = (typeof Tactic)[keyof typeof Tactic];

const LADDER: readonly Tactic[] = [
  Tactic.TargetedRepair,
  Tactic.ExpandedContext,
  Tactic.RethinkStrategy,
  Tactic.RegenerateComponent,
];

export interface LadderState {
  /** Zero-based: how many attempts have already been made. */
  readonly attempt: number;
  /** The signature of the previous attempt's failure, if there was one. */
  readonly previousSignature: string | null;
  /** The signature of the failure now being repaired. */
  readonly signature: string;
}

/**
 * The tactic for this attempt.
 *
 * An unchanged signature costs a rung. The last attempt produced a build that fails in
 * exactly the way it failed before, so whatever it changed was not the thing that
 * matters, and doing it once more is the definition of the loop this ladder exists to
 * prevent. Climbing instead means a budget of three attempts can reach the third rung on
 * a build that is not converging, and still spends all three at the bottom of the ladder
 * on one that is.
 */
export function tacticFor(state: LadderState): Tactic {
  const stalled = state.previousSignature !== null && state.previousSignature === state.signature;
  const rung = Math.min(state.attempt + (stalled ? 1 : 0), LADDER.length - 1);
  return LADDER[rung]!;
}

/** The remedies for a failure, where it has been seen before. */
export function remediesFor(
  diagnostics: readonly Diagnostic[] = [],
  failingTests: readonly TestOutcome[] = [],
): readonly PlaybookEntry[] {
  return recogniseAll(diagnostics, failingTests);
}

// --- Budgets ------------------------------------------------------------------------

/**
 * A wall clock for a stage.
 *
 * Attempt budgets bound how many times something is tried and say nothing about how long
 * that takes. A build whose every attempt times out at the model rather than failing
 * fast can spend twenty minutes on three attempts, hold a queue slot the whole time, and
 * arrive at the same answer it would have given at minute four. Time is the bound that
 * matters to somebody watching a progress bar.
 */
export interface Deadline {
  /** Whether there is still time to start another attempt. */
  readonly live: () => boolean;
  /** Milliseconds remaining, never negative. */
  readonly remainingMs: () => number;
}

export function deadline(budgetMs: number, now: () => number = Date.now): Deadline {
  const started = now();
  const remaining = (): number => Math.max(0, budgetMs - (now() - started));
  return { live: () => remaining() > 0, remainingMs: remaining };
}
