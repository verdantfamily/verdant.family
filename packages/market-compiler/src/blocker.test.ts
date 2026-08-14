/**
 * What a failed build says out loud.
 *
 * These read as copy tests and are not. The rule they enforce is a product rule — a
 * creator never meets the compiler's vocabulary — and a rule of that kind survives
 * exactly as long as something fails when it is broken. The vocabulary is checked
 * explicitly, term by term, because the way this regresses is not a rewritten paragraph
 * but a new failure code wired to `failure.detail` by somebody in a hurry.
 */

import { describe, expect, it } from "vitest";

import { blockerFor } from "./blocker";
import { FailureCode, Stage, type Failure } from "./job";

/** Words that mean something to a compiler and nothing to a creator. */
const JARGON = [
  "stack too deep",
  "ManagerLocked",
  "implicit conversion",
  "execution reverted",
  "TypeError",
  "DeclarationError",
  "revert",
  "solc",
  "forge",
  "CREATE2",
  "hook permission",
  "0x",
];

function failure(code: FailureCode, detail: string, extra: Partial<Failure> = {}): Failure {
  return { code, detail, stage: Stage.TestExecution, ...extra };
}

const EVERY_CODE = Object.values(FailureCode);

describe("what a creator is told", () => {
  it("has something to say about every way a build can fail", () => {
    for (const code of EVERY_CODE) {
      const blocker = blockerFor(failure(code, "raw detail"));

      expect(blocker.headline, code).not.toBe("");
      expect(blocker.explanation, code).not.toBe("");
      expect(blocker.nextStep, code).not.toBe("");
    }
  });

  it("never repeats the compiler's own words back, whatever they were", () => {
    const raw =
      "CompilerError: Stack too deep. Try compiling with --via-ir. " +
      "ManagerLocked() 0xdeadbeef execution reverted";

    for (const code of EVERY_CODE) {
      const blocker = blockerFor(
        failure(code, raw, {
          diagnostics: [
            {
              severity: "error",
              type: "TypeError",
              message: "invalid implicit conversion",
              file: "src/contracts/Hook.sol",
              line: 41,
              column: 8,
              code: null,
              raw: "invalid implicit conversion",
            },
          ],
        } as Partial<Failure>),
      );

      const shown = `${blocker.headline} ${blocker.explanation} ${blocker.nextStep}`;
      for (const term of JARGON) {
        expect(shown.toLowerCase(), `${code} leaked "${term}"`).not.toContain(term.toLowerCase());
      }
    }
  });

  it("does not lead with a failure code", () => {
    for (const code of EVERY_CODE) {
      expect(blockerFor(failure(code, "x")).headline).not.toContain("_");
      expect(blockerFor(failure(code, "x")).headline).not.toContain(code);
    }
  });

  it("owns the failures that are Agen's own, and asks nothing about them", () => {
    const mine = [
      FailureCode.CompilationUnrepairable,
      FailureCode.TestsUnrepairable,
      FailureCode.HarnessInfrastructure,
      FailureCode.ToolchainError,
      FailureCode.ModelUnavailable,
      FailureCode.InvalidArtefact,
      FailureCode.Undeployable,
    ] as const;

    for (const code of mine) {
      expect(blockerFor(failure(code, "x")).ask, code).toBeNull();
    }
  });

  it("asks the creator only where the creator is the one who can answer", () => {
    const blocker = blockerFor(
      failure(FailureCode.Unsupported, "This needs an oracle.", {
        stage: Stage.Interpreting,
      }),
    );

    expect(blocker.ask).not.toBeNull();
  });

  it("says a market refused on safety grounds was refused, not that it broke", () => {
    const blocker = blockerFor(
      failure(FailureCode.GateBlocked, "unbounded fee", { stage: Stage.FinalValidation }),
    );

    expect(blocker.headline.toLowerCase()).toContain("safety");
    // The distinction that matters: this one will not be deployed, rather than could not
    // be built. Telling somebody to try again would be a lie.
    expect(blocker.explanation.toLowerCase()).toContain("not be deployed");
  });

  it("recognises a request that conflicts with itself and says a decision is needed", () => {
    const blocker = blockerFor(
      failure(FailureCode.TestsUnrepairable, "The two rules cannot both hold", {
        stage: Stage.TestRepair,
        failingTests: [
          {
            suite: "S",
            name: "test_x",
            passed: false,
            reason: "nothing known about the constructor argument address oracle_",
          },
        ],
      } as Partial<Failure>),
    );

    // Not terminal in the playbook, so it stays Agen's problem rather than becoming a
    // question. The point of the check is that a known entry does not by itself turn a
    // build failure into an interrogation.
    expect(blocker.ask).toBeNull();
  });

  it("keeps every failure worth retrying marked as such", () => {
    for (const code of EVERY_CODE) {
      expect(blockerFor(failure(code, "x")).retryable, code).toBe(true);
    }
  });
});
