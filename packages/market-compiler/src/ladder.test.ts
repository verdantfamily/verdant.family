/**
 * What a repair is actually shown, rung by rung.
 *
 * The ladder is only worth having if a later attempt is a different attempt. These tests
 * read the prompt the model would receive and assert on what is in it, because the whole
 * mechanism lives in that difference: the same files with a larger attempt number is the
 * loop this was built to escape, and it is indistinguishable from a working ladder unless
 * something checks the prompt.
 */

import { describe, expect, it } from "vitest";

import { normalisePinnedV4Api, repairCompilation, repairTests } from "./engineer";
import type { Diagnostic, TestOutcome } from "./foundry";
import type { ModelProvider, StructuredRequest, StructuredResponse } from "./model";
import { Tactic } from "./recovery";
import type { MarketSpecification } from "./spec";
import type { GeneratedSource } from "./workspace";

/** A provider that answers nothing and keeps what it was asked. */
function recorder(): ModelProvider & { readonly seen: StructuredRequest[] } {
  const seen: StructuredRequest[] = [];

  return {
    name: "recorder",
    model: "recorder",
    seen,
    async generate<T>(request: StructuredRequest): Promise<StructuredResponse<T>> {
      seen.push(request);
      return {
        value: { diagnosis: "none", files: [], giveUp: false } as T,
        raw: "{}",
        model: "recorder",
        durationMs: 0,
      };
    },
  };
}

const SOURCES: readonly GeneratedSource[] = [
  { path: "src/contracts/RewardHook.sol", content: "contract RewardHook { /* HOOK_BODY */ }" },
  { path: "src/contracts/FeeLedger.sol", content: "contract FeeLedger { /* LEDGER_BODY */ }" },
];

const TESTS: readonly GeneratedSource[] = [
  {
    path: "test/RewardHook.t.sol",
    content: 'import "../contracts/RewardHook.sol";\ncontract RewardHookTest { /* HOOK_TEST */ }',
  },
  { path: "test/FeeLedger.t.sol", content: "contract FeeLedgerTest { /* LEDGER_TEST */ }" },
];

const FAILURES: readonly TestOutcome[] = [
  { suite: "RewardHookTest", name: "test_pays", passed: false, reason: "assertion failed" },
];

const SPECIFICATION = {
  name: "Reward",
  symbol: "RWD",
  baseFeePpm: 10_000,
  maxFeePpm: 30_000,
  rules: [],
  state: [],
  phases: [],
  invariants: [],
  externalDependencies: [],
} as unknown as MarketSpecification;

function diagnostic(file: string, message: string): Diagnostic {
  return {
    severity: "error",
    type: "TypeError",
    message,
    file,
    line: 12,
    column: 4,
    code: null,
    raw: message,
  } as Diagnostic;
}

describe("what a test repair is shown", () => {
  it("sends the failing suite and the contract it exercises, and nothing else", async () => {
    const provider = recorder();

    await repairTests(provider, {
      specification: SPECIFICATION,
      sources: SOURCES,
      tests: TESTS,
      failures: FAILURES,
      attempt: 1,
    });

    const { input } = provider.seen[0]!;
    expect(input).toContain("HOOK_TEST");
    expect(input).toContain("HOOK_BODY");
    // The ledger passed. Sending it invites a repair that rewrites something working.
    expect(input).not.toContain("LEDGER_TEST");
    expect(input).not.toContain("LEDGER_BODY");
  });

  it("sends the whole market once narrowing has already failed", async () => {
    const provider = recorder();

    await repairTests(provider, {
      specification: SPECIFICATION,
      sources: SOURCES,
      tests: TESTS,
      failures: FAILURES,
      attempt: 2,
      tactic: Tactic.ExpandedContext,
    });

    const { input, instructions } = provider.seen[0]!;
    expect(input).toContain("LEDGER_BODY");
    expect(input).toContain("LEDGER_TEST");
    expect(instructions).toContain("narrower attempt");
  });

  it("permits a different approach on the third rung, and only there", async () => {
    const targeted = recorder();
    const rethink = recorder();

    await repairTests(targeted, {
      specification: SPECIFICATION,
      sources: SOURCES,
      tests: TESTS,
      failures: FAILURES,
      attempt: 1,
    });
    await repairTests(rethink, {
      specification: SPECIFICATION,
      sources: SOURCES,
      tests: TESTS,
      failures: FAILURES,
      attempt: 3,
      tactic: Tactic.RethinkStrategy,
    });

    expect(targeted.seen[0]!.instructions).not.toContain("restructure");
    expect(rethink.seen[0]!.instructions).toContain("restructure");
    // Restructuring is licence to change the code, never the deal.
    expect(rethink.seen[0]!.instructions).toContain("What must not change is what the");
  });

  it("stops editing and asks for a rewrite at the top", async () => {
    const provider = recorder();

    await repairTests(provider, {
      specification: SPECIFICATION,
      sources: SOURCES,
      tests: TESTS,
      failures: FAILURES,
      attempt: 4,
      tactic: Tactic.RegenerateComponent,
    });

    expect(provider.seen[0]!.instructions).toContain("Do not edit it again");
  });
});

describe("pinned v4 API normalization", () => {
  it("turns the nonexistent delta library member into the free function", () => {
    const corrected = normalisePinnedV4Api({
      path: "contracts/FeeHook.sol",
      content: `import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
contract FeeHook {
    function delta() external pure returns (BeforeSwapDelta) {
        return BeforeSwapDeltaLibrary.toBeforeSwapDelta(1, 0);
    }
}`,
    });

    expect(corrected.content).toContain(
      'import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";',
    );
    expect(corrected.content).toContain("return toBeforeSwapDelta(1, 0);");
    expect(corrected.content).not.toContain("BeforeSwapDeltaLibrary.toBeforeSwapDelta");
  });
});

describe("what a compile repair is shown", () => {
  const DIAGNOSTICS = [diagnostic("src/contracts/RewardHook.sol", "Type mismatch")];

  it("sends the file the compiler named", async () => {
    const provider = recorder();

    await repairCompilation(provider, { sources: SOURCES, diagnostics: DIAGNOSTICS, attempt: 1 });

    const { input } = provider.seen[0]!;
    expect(input).toContain("HOOK_BODY");
    expect(input).not.toContain("LEDGER_BODY");
  });

  it("sends the rest of the market when the named file was not the cause", async () => {
    const provider = recorder();

    await repairCompilation(provider, {
      sources: SOURCES,
      diagnostics: DIAGNOSTICS,
      attempt: 2,
      tactic: Tactic.ExpandedContext,
    });

    expect(provider.seen[0]!.input).toContain("LEDGER_BODY");
  });

  it("still carries the known remedy, which outranks the rung", async () => {
    const provider = recorder();

    await repairCompilation(provider, {
      sources: SOURCES,
      diagnostics: DIAGNOSTICS,
      attempt: 2,
      remedy: "Known fix: wrap the address in Currency.",
      tactic: Tactic.ExpandedContext,
    });

    expect(provider.seen[0]!.input).toContain("Known fix: wrap the address in Currency.");
  });
});
