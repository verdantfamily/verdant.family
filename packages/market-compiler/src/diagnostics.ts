/**
 * The record of how a build went, including the parts that went badly.
 *
 * The generation screen shows this, and so does anyone working out why a market could
 * not be built. It exists as its own document rather than as fields scattered through
 * the job because the interesting questions are comparative — did the second repair
 * make things better or merely different, how many errors were there each round, did
 * the model change the file it said it was changing — and those are unanswerable unless
 * each attempt is recorded whole.
 *
 * ## Failures are kept in full
 *
 * A build that fails keeps every compiler error and every failing test. The temptation
 * is to keep the last round only, since that is what the creator sees, but the last
 * round is frequently the least informative: a model that has been round three times is
 * often producing a different error each time, and the shape of that sequence is the
 * diagnosis.
 */

import type { Diagnostic, TestOutcome } from "./foundry.js";
import type { GateFinding } from "./gates.js";

/** One pass through the compiler. */
export interface CompileAttempt {
  readonly attempt: number;
  readonly at: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  /** Errors only; warnings are counted rather than kept. */
  readonly errors: readonly Diagnostic[];
}

/** One pass through the test suite. */
export interface TestAttempt {
  readonly attempt: number;
  readonly at: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly failures: readonly TestOutcome[];
  /** Set when the suite would not compile, which is a different problem. */
  readonly buildFailure: readonly Diagnostic[] | null;
}

/** One thing the model did about a failure. */
export interface RepairAttempt {
  readonly attempt: number;
  readonly at: number;
  readonly kind: "compilation" | "test" | "interpretation";
  /** The model's own account of the cause. */
  readonly diagnosis: string;
  /**
   * What it rewrote: source paths for a code repair, rule ids for an interpretation one.
   *
   * For interpretation this is also the effect-level provenance the record needs. A rule
   * is only repaired when it arrived with no effects at all, so every effect a listed
   * rule ends up with came from the repair, and every effect of a rule not listed came
   * from the original interpretation. Exactly, rather than by inference.
   */
  readonly files: readonly string[];
  readonly gaveUp: boolean;
}

export interface BuildDiagnostics {
  readonly jobId: string;
  readonly compileAttempts: readonly CompileAttempt[];
  readonly testAttempts: readonly TestAttempt[];
  readonly repairs: readonly RepairAttempt[];
  readonly gateFindings: readonly GateFinding[];
}

export function emptyDiagnostics(jobId: string): BuildDiagnostics {
  return { jobId, compileAttempts: [], testAttempts: [], repairs: [], gateFindings: [] };
}

export function withCompileAttempt(
  diagnostics: BuildDiagnostics,
  attempt: CompileAttempt,
): BuildDiagnostics {
  return { ...diagnostics, compileAttempts: [...diagnostics.compileAttempts, attempt] };
}

export function withTestAttempt(
  diagnostics: BuildDiagnostics,
  attempt: TestAttempt,
): BuildDiagnostics {
  return { ...diagnostics, testAttempts: [...diagnostics.testAttempts, attempt] };
}

export function withRepair(
  diagnostics: BuildDiagnostics,
  repair: RepairAttempt,
): BuildDiagnostics {
  return { ...diagnostics, repairs: [...diagnostics.repairs, repair] };
}

export function withGateFindings(
  diagnostics: BuildDiagnostics,
  findings: readonly GateFinding[],
): BuildDiagnostics {
  return { ...diagnostics, gateFindings: findings };
}

/**
 * Whether the errors are changing between rounds.
 *
 * A repair loop producing the same error signature twice is not converging, and knowing
 * that is worth more than the errors themselves — it is the difference between "this
 * needs one more attempt" and "this attempt and the next will both fail". Compared on
 * error codes and locations rather than messages, because solc's wording for the same
 * problem varies with the surrounding code.
 */
export function isConverging(diagnostics: BuildDiagnostics): boolean {
  const attempts = diagnostics.compileAttempts;
  if (attempts.length < 2) return true;

  const signature = (attempt: CompileAttempt): string =>
    attempt.errors
      .map((error) => `${error.code ?? error.type}@${error.file ?? "?"}:${String(error.line ?? 0)}`)
      .sort()
      .join("|");

  const last = attempts[attempts.length - 1]!;
  const previous = attempts[attempts.length - 2]!;

  return signature(last) !== signature(previous);
}

/** A one-line account of the build, for a log or an operator list. */
export function summariseDiagnostics(diagnostics: BuildDiagnostics): string {
  const compiles = diagnostics.compileAttempts.length;
  const tests = diagnostics.testAttempts.length;
  const repairs = diagnostics.repairs.length;
  const blockers = diagnostics.gateFindings.filter((finding) => finding.severity === "blocker").length;

  const parts = [
    `${String(compiles)} compile${compiles === 1 ? "" : "s"}`,
    `${String(tests)} test run${tests === 1 ? "" : "s"}`,
    `${String(repairs)} repair${repairs === 1 ? "" : "s"}`,
  ];

  if (blockers > 0) parts.push(`${String(blockers)} blocking finding${blockers === 1 ? "" : "s"}`);

  return parts.join(", ");
}
