import { describe, expect, it } from "vitest";

import type { Diagnostic, TestOutcome } from "./foundry";
import { Stage } from "./job";
import { Blame, recognise, remedyBrief } from "./playbook";
import {
  classify,
  deadline,
  FailureCategory,
  remediesFor,
  Tactic,
  tacticFor,
} from "./recovery";

function diagnostic(partial: Partial<Diagnostic> & { message: string }): Diagnostic {
  return {
    severity: "error",
    type: "TypeError",
    code: "9322",
    file: "test/MarketTest.sol",
    line: 42,
    column: 15,
    excerpt: null,
    ...partial,
  };
}

function failing(reason: string, name = "setUp()"): TestOutcome {
  return { suite: "test/MarketTest.sol:MarketTest", name, passed: false, reason };
}

/**
 * The four builds that failed on production in one evening, each one a market that was
 * correct and a suite that was not. They are here as cases rather than as history: the
 * point of the playbook is that none of them costs three attempts a second time.
 */
describe("failures this project has already paid for", () => {
  it("knows a stacked prank from the message Foundry gives it", () => {
    const entry = recognise([], [failing("vm.prank: cannot overwrite a prank until it is applied at least once")]);

    expect(entry?.id).toBe("prank_overwrite");
    expect(entry?.blame).toBe(Blame.Test);
    expect(entry?.remedy).toContain("vm.startPrank");
  });

  it("knows a pool opened at a fee its hook refuses, and says not to weaken the hook", () => {
    const entry = recognise([], [failing("InvalidBaseFee(8388608)")]);

    expect(entry?.id).toBe("fee_mode_rejected");
    expect(entry?.remedy).toContain("agenPoolKey(quote, token, hook, tickSpacing, fee)");
    expect(entry?.remedy).toContain("Do not relax the hook's check");
  });

  it("knows a harness helper called with a bare address", () => {
    const entry = recognise([
      diagnostic({ message: "No matching declaration found after argument-dependent lookup." }),
    ]);

    expect(entry?.id).toBe("overload_lookup");
    expect(entry?.blame).toBe(Blame.HarnessMisuse);
    expect(entry?.remedy).toContain("Currency.wrap");
  });

  it("knows an unapproved router, and blames the test rather than the token", () => {
    const entry = recognise([], [failing("InsufficientAllowance(0, 10000000000000000000)")]);

    expect(entry?.id).toBe("missing_allowance");
    expect(entry?.remedy).toContain("approveSwapRouter");
    expect(entry?.remedy).toContain("Do not weaken");
  });

  it("answers stack-too-deep with a compiler backend rather than a rewrite", () => {
    const entry = recognise([diagnostic({ message: "Stack too deep. Try compiling with `--via-ir`" })]);

    expect(entry?.id).toBe("stack_too_deep");
    expect(entry?.automatic).toBe("ir_backend");
  });

  it("does not claim a failure it has never met", () => {
    expect(recognise([diagnostic({ message: "Something nobody has written a rule for" })])).toBeNull();
    expect(recognise([], [])).toBeNull();
  });

  it("collects every remedy at once, because one suite makes several mistakes", () => {
    const entries = remediesFor(
      [],
      [
        failing("vm.prank: cannot overwrite a prank until it is applied at least once", "test_a()"),
        failing("InsufficientAllowance(0, 1)", "test_b()"),
      ],
    );

    expect(entries.map((entry) => entry.id).sort()).toEqual(["missing_allowance", "prank_overwrite"]);

    const brief = remedyBrief(entries);
    expect(brief).toContain("approveSwapRouter");
    expect(brief).toContain("vm.startPrank");
  });
});

describe("naming a failure", () => {
  it("calls a misused harness a type mismatch, not a broken market", () => {
    const result = classify({
      stage: Stage.TestExecution,
      diagnostics: [diagnostic({ message: "No matching declaration found after argument-dependent lookup." })],
    });

    expect(result.category).toBe(FailureCategory.TypeApiMismatch);
    expect(result.blame).toBe(Blame.HarnessMisuse);
    expect(result.playbook).toBe("overload_lookup");
  });

  it("separates a market that misbehaves from a test that is wrong about it", () => {
    const wrongTest = classify({
      stage: Stage.TestExecution,
      failingTests: [failing("ManagerLocked")],
    });
    expect(wrongTest.category).toBe(FailureCategory.TestFailure);
    expect(wrongTest.blame).toBe(Blame.Test);

    const wrongMarket = classify({
      stage: Stage.TestExecution,
      failingTests: [failing("CurrencyNotSettled")],
    });
    expect(wrongMarket.category).toBe(FailureCategory.SemanticFailure);
    expect(wrongMarket.blame).toBe(Blame.Contract);
  });

  it("treats a suite that will not build as a compile problem, not a behaviour question", () => {
    const result = classify({
      stage: Stage.TestExecution,
      diagnostics: [diagnostic({ type: "DeclarationError", message: "Undeclared identifier." })],
      failingTests: [],
    });

    expect(result.category).toBe(FailureCategory.TypeApiMismatch);
  });

  it("blames the provider wherever it fails, rather than the request it was reading", () => {
    const result = classify({
      stage: Stage.Interpreting,
      error: new Error("429 rate limit exceeded"),
    });

    expect(result.category).toBe(FailureCategory.ModelProvider);
  });

  it("marks a request nobody can build as terminal, so nothing tries to repair it", () => {
    expect(classify({ stage: Stage.Interpreting }).terminal).toBe(true);
    expect(classify({ stage: Stage.TestExecution, failingTests: [failing("ManagerLocked")] }).terminal).toBe(
      false,
    );
  });
});

describe("knowing whether the last attempt achieved anything", () => {
  it("gives one signature to the same error found at a different line", () => {
    const before = classify({
      stage: Stage.Compilation,
      diagnostics: [diagnostic({ message: "Undeclared identifier.", line: 42 })],
    });
    const after = classify({
      stage: Stage.Compilation,
      diagnostics: [diagnostic({ message: "Undeclared identifier.", line: 108 })],
    });

    expect(after.signature).toBe(before.signature);
  });

  it("gives different signatures to different errors", () => {
    const one = classify({ stage: Stage.Compilation, diagnostics: [diagnostic({ message: "Undeclared identifier." })] });
    const two = classify({ stage: Stage.Compilation, diagnostics: [diagnostic({ message: "Stack too deep." })] });

    expect(two.signature).not.toBe(one.signature);
  });

  it("ignores warnings, which are not why anything failed", () => {
    const withWarning = classify({
      stage: Stage.Compilation,
      diagnostics: [
        diagnostic({ message: "Undeclared identifier." }),
        diagnostic({ severity: "warning", message: "Unused local variable." }),
      ],
    });
    const without = classify({
      stage: Stage.Compilation,
      diagnostics: [diagnostic({ message: "Undeclared identifier." })],
    });

    expect(withWarning.signature).toBe(without.signature);
  });
});

describe("choosing what to try next", () => {
  it("starts cheap and climbs", () => {
    const rungs = [0, 1, 2, 3].map((attempt) =>
      tacticFor({ attempt, previousSignature: null, signature: "a" }),
    );

    expect(rungs).toEqual([
      Tactic.TargetedRepair,
      Tactic.ExpandedContext,
      Tactic.RethinkStrategy,
      Tactic.RegenerateComponent,
    ]);
  });

  it("skips a rung when the last attempt changed nothing", () => {
    expect(tacticFor({ attempt: 0, previousSignature: "a", signature: "a" })).toBe(Tactic.ExpandedContext);
    expect(tacticFor({ attempt: 1, previousSignature: "a", signature: "a" })).toBe(Tactic.RethinkStrategy);
  });

  it("does not skip when the failure has moved on, since progress deserves the cheap rung", () => {
    expect(tacticFor({ attempt: 1, previousSignature: "a", signature: "b" })).toBe(Tactic.ExpandedContext);
  });

  it("never climbs past the top", () => {
    expect(tacticFor({ attempt: 9, previousSignature: "a", signature: "a" })).toBe(
      Tactic.RegenerateComponent,
    );
  });
});

describe("a stage that has run out of time", () => {
  it("is live until its budget is spent and not afterwards", () => {
    let clock = 1_000;
    const limit = deadline(5_000, () => clock);

    expect(limit.live()).toBe(true);
    expect(limit.remainingMs()).toBe(5_000);

    clock += 4_999;
    expect(limit.live()).toBe(true);

    clock += 1;
    expect(limit.live()).toBe(false);
    expect(limit.remainingMs()).toBe(0);
  });

  it("never reports negative time left", () => {
    let clock = 0;
    const limit = deadline(10, () => clock);
    clock = 1_000;

    expect(limit.remainingMs()).toBe(0);
  });
});
