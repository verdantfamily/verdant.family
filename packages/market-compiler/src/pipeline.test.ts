/**
 * The control flow, driven by a script rather than a model.
 *
 * These tests compile real Solidity and run real forge — the point is to prove the loop
 * behaves when compilation genuinely fails — but the model's answers are scripted. A
 * live model would make "the second repair attempt succeeds" a coin flip, and the thing
 * being tested is the loop, not the model's Solidity.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CORE_TEST_PATH } from "./core-tests.js";
import { FailureCode, Stage, progressOf } from "./job.js";
import { ModelError, scriptedProvider } from "./model.js";
import {
  answerBuild,
  DEFAULT_BUDGET,
  DEFAULT_SUPPLY_TOKENS,
  NATIVE_QUOTE,
  decideBuild,
  resumeBuild,
  runBuild,
} from "./pipeline.js";
import { acceptedSuggestions, rulesAreStale } from "./spec.js";
import { memoryJobStore } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = resolve(here, "../../contracts/vendor");

beforeAll(async () => {
  await promisify(execFile)("forge", ["--version"]).catch(() => {
    throw new Error("forge is not on the PATH; the pipeline cannot build without it");
  });
});

let clock = 1_000;
const now = (): number => (clock += 10);
let ids = 0;
const newId = (): string => `job-${String(++ids)}`;

let generatedRoot: string | null = null;

beforeEach(async () => {
  generatedRoot = await mkdtemp(join(tmpdir(), "agen-pipeline-"));
});

afterEach(async () => {
  clock = 1_000;
  if (generatedRoot !== null) await rm(generatedRoot, { recursive: true, force: true });
  generatedRoot = null;
});

const PROMPT = "Charge 0.5% base. Track consecutive buys; after 10, the next trade is free.";

/**
 * Interpretation is four model calls, so it takes four scripted answers: what the market
 * does, the rules formalising it, the frame around them, and the critique that runs
 * beside the frame. They are split from one fixture rather than written out four times
 * so the parts cannot drift apart, and the behaviours are derived from the rules so a
 * fixture that grows a rule does not silently start failing the one-rule-per-behaviour
 * check.
 *
 * The critique comes last because the frame is asked for first, even though the two are
 * in flight together.
 */
function interpretationAnswers(
  specification: ReturnType<typeof specificationAnswer> = specificationAnswer(),
  suggestions: readonly unknown[] = [],
): readonly unknown[] {
  const { summary, rules, ...frame } = specification;
  return [
    { behaviours: rules.map((rule) => rule.title.toLowerCase()) },
    { summary, rules },
    frame,
    { suggestions },
  ];
}

/** A specification the validator accepts, as the model would return it. */
function specificationAnswer() {
  return {
    summary: "Every tenth consecutive buy trades free",
    baseFeePpm: 5_000,
    maxFeePpm: 5_000,
    phases: [],
    state: [
      { name: "consecutiveBuys", type: "counter", description: "Buys since the last sell", writeOnce: false },
    ],
    rules: [
      {
        id: "buy-streak",
        title: "BUY STREAK",
        when: { kind: "buy", description: "Somebody buys", parameters: null },
        conditions: [
          {
            kind: "consecutiveCount",
            description: "Ten buys with no sell between them",
            parameters: [{ key: "value", value: 10 }],
            combinator: null,
          },
        ],
        then: [
          {
            kind: "waiveFee",
            description: "The trade pays no hook fee",
            parameters: null,
            writes: ["consecutiveBuys"],
          },
        ],
        activeInPhases: [],
        onceOnly: false,
      },
    ],
    invariants: [{ id: "fee-ceiling", statement: "The hook fee never exceeds 3%", expression: null }],
    externalDependencies: [],
    assumptions: [],
    ambiguities: [],
    unsupported: [],
  };
}

/**
 * The mechanic as it stands after the creator decided something, as `revise` returns it.
 *
 * The same rules with one visible addition, so a test can tell whether the revision
 * actually reached the specification the later stages read.
 */
function revisionAnswer(change: string) {
  const { summary, rules } = specificationAnswer();

  return {
    summary,
    rules: rules.map((rule) => ({
      ...rule,
      then: [
        ...rule.then,
        { kind: "setFlag", description: change, parameters: null, writes: ["consecutiveBuys"] },
      ],
    })),
  };
}

/** Planning is two calls: what is already solved, then what to build. */
function matchAnswer() {
  return {
    reuse: [{ catalogueId: "base-hook", why: "it needs a hook at all" }],
    novel: [{ concern: "counting consecutive buys", why: "nothing in the catalogue counts streaks" }],
  };
}

/**
 * The architecture call answers the plan and the deployment together.
 *
 * The deployment half is what the launcher executes, so a scripted build has to state it
 * for the same reason a real one does: nothing downstream infers a constructor any more.
 * `deploymentOver` exists for the suites that need a different pool, which is the only
 * part of it these markets vary.
 */
function planAnswer(
  hookPermissions: readonly string[] = ["beforeSwap"],
  deploymentOver: Record<string, unknown> = {},
) {
  return {
    plan: rawPlan(hookPermissions),
    deployment: { ...rawDeployment(), ...deploymentOver },
  };
}

function rawDeployment() {
  return {
    components: [
      {
        componentId: "streakToken",
        constructorArguments: [
          { name: "recipient", type: "address", source: "INFRA:INSTALLER" },
        ],
        immutable: ["recipient"],
        wiring: [],
        controller: null,
      },
      {
        componentId: "streakHook",
        constructorArguments: [
          { name: "manager_", type: "address", source: "INFRA:POOL_MANAGER" },
        ],
        immutable: ["manager_"],
        wiring: [],
        controller: null,
      },
    ],
    pool: { feeMode: "dynamic", lpFee: "8388608" },
    custodyComponentId: null,
    feeClaimComponentId: null,
    oneTimeInitialization: [],
  };
}

function rawPlan(hookPermissions: readonly string[] = ["beforeSwap"]) {
  return {
    approach: "One hook tracking a streak counter in storage.",
    components: [
      {
        id: "streakToken",
        contractName: "StreakToken",
        role: "token",
        origin: "generate",
        purpose: "The traded token",
        requiredBy: [],
        reuses: [],
        dependsOn: [],
        hookPermissions: [],
        custodial: false,
        implementationNotes: [],
      },
      {
        id: "streakHook",
        contractName: "StreakHook",
        role: "hook",
        origin: "extend",
        purpose: "Counts consecutive buys and waives the fee on the tenth",
        requiredBy: ["buy-streak"],
        reuses: ["base-hook"],
        dependsOn: [],
        hookPermissions,
        custodial: false,
        implementationNotes: [],
      },
    ],
    dependencies: [],
    adaptations: [],
  };
}

/** Compiles, and behaves the way the tests below assert. */
const GOOD_HOOK = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {AgenBaseHook} from "./AgenBaseHook.sol";

contract StreakHook is AgenBaseHook {
    uint256 public consecutiveBuys;

    constructor(IPoolManager manager_) AgenBaseHook(manager_) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function _beforeSwap(address, PoolKey calldata, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
        uint24 feePpm;
        if (!isBuy(params)) {
            consecutiveBuys = 0;
            feePpm = 5_000;
        } else {
            consecutiveBuys += 1;
            if (consecutiveBuys >= 10) {
                consecutiveBuys = 0;
                feePpm = 0;
            } else {
                feePpm = 5_000;
            }
        }
        return (
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            feePpm | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }
}
`;

function withHookFunction(source: string): string {
  return GOOD_HOOK.replace("    function _beforeSwap(", `${source}\n\n    function _beforeSwap(`);
}

const BROKEN_HOOK = GOOD_HOOK.replace("consecutiveBuys += 1;", "consecutiveBuys += undeclaredThing;");

const GOOD_TESTS = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MarketTestBase} from "./MarketTestBase.sol";

contract StreakHookTest is MarketTestBase {
    function test_feeCeiling_isNeverExceeded(uint8 trades) public {
        trades = uint8(bound(trades, 1, 12));
        for (uint256 i = 0; i < trades; i++) {
            assertGt(buy(0.000001 ether), 0);
            assertLe(hook.consecutiveBuys(), 9);
        }
    }

    function test_theTenthBuyIsFree() public {
        for (uint256 i = 0; i < 10; i++) {
            buy(0.000001 ether);
        }
        assertEq(hook.consecutiveBuys(), 0);
    }
}
`;

const MANUAL_CONSTRUCTOR_TESTS = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MarketTestBase} from "./MarketTestBase.sol";

contract ConstructorTest is MarketTestBase {
    function test_constructor_reverts_on_zero_fee_receiver() public {
        new StreakHook(manager, address(0));
    }
}
`;

const FAILING_TESTS = GOOD_TESTS.replace(
  "assertEq(hook.consecutiveBuys(), 0);",
  "assertEq(hook.consecutiveBuys(), 12345);",
);

const UNCOMPILABLE_TESTS = GOOD_TESTS.replace(
  "assertEq(hook.consecutiveBuys(), 0);",
  "uint256 impossible = ;",
);

/**
 * Correct, tested, and impossible to deploy.
 *
 * The constructor asks for the id of the pool this hook is the hook of. A pool id is
 * derived from the pool key, the pool key names the hook, and the hook is the contract
 * being constructed — so no deployment can supply it, and no amount of repair changes
 * that. A real PULSE build shipped this shape to the review screen.
 */
const UNDEPLOYABLE_HOOK = GOOD_HOOK.replace(
  "    uint256 public consecutiveBuys;",
  `    uint256 public consecutiveBuys;
    bytes32 public immutable designatedPoolId;`,
).replace(
  "    constructor(IPoolManager manager_) AgenBaseHook(manager_) {}",
  `    constructor(IPoolManager manager_, bytes32 designatedPoolId_) AgenBaseHook(manager_) {
        designatedPoolId = designatedPoolId_;
    }`,
);

/**
 * The same market, plus an opinion about the pool it is opened in.
 *
 * `PoolKey.fee` is fixed forever by `initialize`, and a hook that refuses the value the
 * manifest chose reverts the launch from inside it. These two fixtures are the shapes
 * that matter: one whose requirement can be read, and one whose cannot.
 */
function withInitialize(declarations: string): string {
  return GOOD_HOOK.replace("            afterInitialize: false,", "            afterInitialize: true,").replace(
    "    function _beforeSwap(address, PoolKey calldata, SwapParams calldata params, bytes calldata)",
    `    error InvalidPool();

${declarations}

    function _beforeSwap(address, PoolKey calldata, SwapParams calldata params, bytes calldata)`,
  );
}

/** EMBER's shape: buys are meant to cost nothing, so a pool-level fee is refused. */
const ZERO_FEE_HOOK = withInitialize(`    function _afterInitialize(address, PoolKey calldata key, uint160, int24) internal pure override {
        if (key.fee != 0) revert InvalidPool();
    }`);

const SETUP_REVERT_HOOK = withInitialize(`    function _afterInitialize(address, PoolKey calldata, uint160, int24) internal pure override {
        revert InvalidPool();
    }`);

/** A requirement that exists and cannot be established without running the contract. */
const UNREADABLE_FEE_HOOK = withInitialize(`    uint24 public immutable requiredFee = 500;

    function _afterInitialize(address, PoolKey calldata key, uint160, int24) internal view override {
        if (key.fee != requiredFee) revert InvalidPool();
    }`);

// One answer per generated component. The plan above has two, but the token is written
// by Agen rather than by a model, so the hook is the only thing scripted here.
const sources = (content: string) => ({ content, notes: [] });
const tests = (content: string) => ({ files: [{ path: "test/StreakHook.t.sol", content }], notes: [] });

function pipeline(script: readonly unknown[]) {
  const provider = scriptedProvider(script);
  const store = memoryJobStore();
  return {
    provider,
    store,
    options: {
      provider,
      store,
      vendorRoot: VENDOR,
      generatedRoot: generatedRoot!,
      now,
      newId,
      // These builds are about control flow, not artefacts; the directories would
      // otherwise accumulate one per test.
      disposeOnSuccess: true,
    },
  };
}

describe("a build that goes well", () => {
  it("reaches deployment_ready and records every stage", async () => {
    const { options, store } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.stage).toBe(Stage.DeploymentReady);
    expect(progressOf(job)).toBe(1);

    const reached = job.stages.map((record) => record.stage);
    expect(reached).toContain(Stage.Interpreting);
    expect(reached).toContain(Stage.SpecificationCreated);
    expect(reached).toContain(Stage.ArchitecturePlanning);
    expect(reached).toContain(Stage.CodeGeneration);
    expect(reached).toContain(Stage.Compilation);
    expect(reached).toContain(Stage.TestGeneration);
    expect(reached).toContain(Stage.TestExecution);
    expect(reached).toContain(Stage.FinalValidation);
    // Nothing needed repairing, so no repair stage should have been entered.
    expect(reached).not.toContain(Stage.CompilationRepair);
    expect(reached).not.toContain(Stage.TestRepair);

    expect(job.specification?.summary).toBe("Every tenth consecutive buy trades free");
    // A token and a hook: the minimum a market can be made of.
    expect(job.plan?.components).toHaveLength(2);
    expect(job.testOutcomes.every((outcome) => outcome.passed)).toBe(true);

    // Agen's own suite ran against this market, beside the generated one. It is the half of
    // the evidence that does not depend on a model having written a correct test.
    const own = job.testOutcomes.filter((outcome) => outcome.suite.includes(CORE_TEST_PATH));
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((outcome) => outcome.passed)).toBe(true);

    // The job is readable from the store, which is what lets a refreshed tab recover.
    const reloaded = await store.read(job.id);
    expect(reloaded?.stage).toBe(Stage.DeploymentReady);
    // And it survives the round trip through JSON, bigint supply and all.
    expect(reloaded?.manifest?.supplyTokens).toBe(DEFAULT_SUPPLY_TOKENS);
  });

  it("cannot be ready without a manifest", async () => {
    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    // The whole point of assembling the bundle during the build: reaching this stage
    // means every constructor argument was placed, the hook was mined onto an address
    // carrying its permissions, and the token sorts above the quote asset. A ready
    // build with `manifest: null` would be a launch button over an unanswered question.
    expect(job.stage).toBe(Stage.DeploymentReady);
    expect(job.manifest).not.toBeNull();
    expect(job.manifest?.jobId).toBe(job.id);
    expect(job.manifest?.tokenComponentId).toBe("streakToken");
    expect(job.manifest?.hookComponentId).toBe("streakHook");
    expect(job.manifest?.quoteAsset).toBe(NATIVE_QUOTE);

    // This market's hook ignores who is swapping, so the creator may buy in the launch.
    expect(job.manifest?.supportsAtomicDevBuy).toBe(true);
    expect(job.manifest?.devBuyUnavailableReason).toBeNull();
  });

  it("stops a contract that did not write the constructor it was told to write", async () => {
    // A hook asking for the id of the pool it is the hook of: derived from the pool key,
    // which names the hook, which is the contract being constructed. No launch can supply
    // it, and no deployment can declare it — there is no reference for a pool id in a
    // constructor, because the id does not exist until the address does.
    //
    // It used to compile, pass its tests, and be discovered at the very end. Now the
    // declaration says one argument and the contract takes two, which is a disagreement
    // between the two documents rather than a mystery about what a parameter meant. The
    // component is written again against its declaration — twice, since that is the budget —
    // and this one keeps writing the same thing.
    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(UNDEPLOYABLE_HOOK),
      { content: UNDEPLOYABLE_HOOK, notes: [] },
      { content: UNDEPLOYABLE_HOOK, notes: [] },
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.Failed);
    expect(job.failure?.code).toBe(FailureCode.ArchitectureInconsistent);
    expect(job.failure?.stage).toBe(Stage.DeploymentValidation);
    expect(job.failure?.detail).toMatch(/designatedPoolId/);
    expect(job.manifest).toBeNull();

    // And it stopped before a model wrote a behaviour suite for a market that could never
    // have been launched, which is what the whole stage is for.
    expect(job.tests).toHaveLength(0);
  });

  it("opens the pool at the fee the hook requires rather than the usual one", async () => {
    // An EMBER-shaped hook: it refuses any pool whose fee is not zero, and the manifest
    // used to say dynamic for every market. That combination is a launch that reverts
    // inside `initialize`, after every contract has been deployed and paid for.
    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(["afterInitialize", "beforeSwap"], { pool: { feeMode: "zero", lpFee: "0" } }),
      sources(ZERO_FEE_HOOK),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.DeploymentReady);
    expect(job.manifest?.feeMode).toBe("zero");
    expect(job.manifest?.lpFee).toBe(0);
    expect(job.manifest?.feeModeReason).toMatch(/requires no pool fee/);
  });

  it("answers a fee requirement it cannot read by running the launch, not by refusing", async () => {
    // Compared against an immutable, so the required fee is genuinely unknowable without
    // running the contract. Refusing here used to end the build on the reader's
    // vocabulary; the launch is now run in Foundry with the fee the manifest would use,
    // so the market is judged on what its pool actually does. This hook rejects that
    // pool, so it still cannot be ready — but the creator is told the hook reverted with
    // InvalidPool, which is a fact about their market, rather than that Agen could not
    // parse it. A hook whose guard is merely unusual now launches instead of dying here.
    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(["afterInitialize", "beforeSwap"]),
      sources(UNREADABLE_FEE_HOOK),
      { diagnosis: "the required fee is genuinely not knowable statically", files: [], giveUp: true },
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.Failed);
    expect(job.failure?.code).toBe(FailureCode.Undeployable);
    expect(job.failure?.detail).toMatch(/production-faithful test deployment/);
    expect(job.failure?.detail).toMatch(/InvalidPool/);
    expect(job.manifest).toBeNull();
  });

  it("rewrites a fee requirement it cannot read, rather than discarding the market", async () => {
    // The failure that ended a real EMBR build after eleven minutes of correct work: a
    // hook requiring a fixed fee, which Agen supports, stating the requirement in a form
    // Agen cannot read before it opens the pool. Nothing about the market was wrong, and
    // the stage had no repair, so it was thrown away.
    //
    // The repair returns the same market with the requirement stated plainly. Agen then
    // builds and smoke-tests the production-faithful environment before it generates a
    // single behavior test, so the repaired deployment description cannot bypass launch.
    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(["afterInitialize", "beforeSwap"]),
      sources(UNREADABLE_FEE_HOOK),
      {
        diagnosis: "stated the fee requirement as a plain guard",
        files: [{ path: "contracts/StreakHook.sol", content: ZERO_FEE_HOOK }],
        giveUp: false,
      },
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.DeploymentReady);
    expect(job.failure).toBeNull();
    expect(job.manifest?.feeMode).toBe("zero");
    expect(job.manifest?.lpFee).toBe(0);
    expect(job.harnessAttempts).toBe(1);
  });

  it("never claims a simulation it did not run", async () => {
    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);
    const simulation = job.stages.find((record) => record.stage === Stage.Simulation);

    expect(simulation?.detail).toMatch(/No economic simulation was run/);
    expect(job.simulation).toBeNull();
  });

  it("keeps the raw model output separately from the validated artefact", async () => {
    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    // Every call, named. A stage that makes several is recorded as several, because
    // "interpretation took 349 seconds" does not say which call to go and fix.
    expect(job.exchanges.map((exchange) => exchange.call ?? exchange.stage)).toEqual([
      "behaviours",
      "rules",
      "frame",
      "critique",
      "match",
      "design",
      "StreakHook",
      Stage.TestGeneration,
    ]);
    expect([...new Set(job.exchanges.map((exchange) => exchange.stage))]).toEqual([
      Stage.Interpreting,
      Stage.ArchitecturePlanning,
      Stage.CodeGeneration,
      Stage.TestGeneration,
    ]);
    // The prompt itself is not stored a second time, only its hash.
    for (const exchange of job.exchanges) {
      expect(exchange.promptHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(exchange.raw.length).toBeGreaterThan(0);
      expect(exchange.durationMs).not.toBeUndefined();
    }
  });
});

describe("the compilation repair loop", () => {
  it("repairs a contract that did not compile and carries on", async () => {
    const { options, provider } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(BROKEN_HOOK),
      { diagnosis: "undeclaredThing was never declared", files: [{ path: "contracts/StreakHook.sol", content: GOOD_HOOK }], giveUp: false },
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.stage).toBe(Stage.DeploymentReady);
    expect(job.compilationAttempts).toBe(1);

    // The model was shown the real compiler error, located.
    const repairCall = provider.calls.find((call) => call.stage === "compilation_repair");
    expect(repairCall?.input).toContain("DeclarationError");
    expect(repairCall?.input).toContain("undeclaredThing");
  });

  it("fails cleanly when the budget runs out, keeping the diagnostics", async () => {
    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(BROKEN_HOOK),
      { diagnosis: "trying again", files: [{ path: "contracts/StreakHook.sol", content: BROKEN_HOOK }], giveUp: false },
      { diagnosis: "trying again", files: [{ path: "contracts/StreakHook.sol", content: BROKEN_HOOK }], giveUp: false },
      { diagnosis: "trying again", files: [{ path: "contracts/StreakHook.sol", content: BROKEN_HOOK }], giveUp: false },
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.Failed);
    expect(job.failure?.code).toBe(FailureCode.CompilationUnrepairable);
    expect(job.compilationAttempts).toBe(DEFAULT_BUDGET.compilationRepairs);
    expect(job.failure?.diagnostics?.length).toBeGreaterThan(0);
    // Preserved, so a human can read what actually went wrong.
    expect(job.failure?.diagnostics?.[0]?.message).toMatch(/Undeclared identifier/);
  });

  it("stops immediately when the model says it cannot be fixed", async () => {
    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(BROKEN_HOOK),
      { diagnosis: "This mechanic needs transient storage the EVM version lacks.", files: [], giveUp: true },
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure?.code).toBe(FailureCode.CompilationUnrepairable);
    expect(job.failure?.detail).toContain("transient storage");
    // One attempt, not three: a model that has diagnosed a dead end should not be
    // asked to guess twice more.
    expect(job.compilationAttempts).toBe(1);
  });
});

describe("the test repair loop", () => {
  it("rejects model-authored constructor tests before they reach Forge", async () => {
    const { options, provider } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(MANUAL_CONSTRUCTOR_TESTS),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.DeploymentReady);
    expect(job.failure).toBeNull();
    expect(job.testAttempts).toBe(0);
    expect(provider.calls.filter((call) => call.stage === "test_generation")).toHaveLength(2);
    expect(provider.calls.filter((call) => call.stage === "test_repair")).toHaveLength(0);
    expect(
      provider.calls.filter((call) => call.stage === "test_generation")[1]?.instructions,
    ).toContain("deploys a contract manually");
  });

  it("never accepts a contract rewrite for a generated-test compile error", async () => {
    const changedHook = GOOD_HOOK.replace("consecutiveBuys += 1;", "consecutiveBuys += 99;");
    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(UNCOMPILABLE_TESTS),
      {
        diagnosis: "fixed the malformed test expression",
        files: [
          { path: "contracts/StreakHook.sol", content: changedHook },
          { path: "test/StreakHook.t.sol", content: GOOD_TESTS },
        ],
        giveUp: false,
      },
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.DeploymentReady);
    expect(job.testAttempts).toBe(1);
    expect(job.sources.find((source) => source.path.endsWith("StreakHook.sol"))?.content).toBe(
      GOOD_HOOK,
    );
  });

  it("repairs a launch its own contracts revert, without spending a behavior-test round", async () => {
    // A launch that reverts is a fact about this market's contracts, not about Agen's
    // fixture, and it used to be reported as an Agen infrastructure failure and stopped
    // there — telling the creator Agen had broken while the repair budget sat unspent.
    // It is a repair now. What must stay true is the ownership: the behavior suite is
    // never written or rewritten to accommodate a market that cannot be launched.
    const { options, provider } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(["afterInitialize", "beforeSwap"]),
      sources(SETUP_REVERT_HOOK),
      { diagnosis: "the hook refuses every pool this launch can open", files: [], giveUp: true },
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure?.code).toBe(FailureCode.Undeployable);
    expect(job.failure?.failingTests?.map((outcome) => outcome.name)).toEqual(["setUp()"]);
    expect(job.failure?.detail).toContain("InvalidPool");
    expect(job.failure?.stage).toBe(Stage.TestEnvironment);
    expect(job.harnessAttempts).toBe(1);
    expect(job.testAttempts).toBe(0);
    expect(provider.calls.some((call) => call.stage === "test_generation")).toBe(false);
    expect(provider.calls.some((call) => call.stage === "test_repair")).toBe(false);
    expect(job.sources.find((source) => source.path.endsWith("StreakHook.sol"))?.content).toBe(
      SETUP_REVERT_HOOK,
    );
  });

  it("repairs a failing test and carries on", async () => {
    const { options, provider } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(FAILING_TESTS),
      { diagnosis: "the test asserted a number the specification never mentions", files: [{ path: "test/StreakHook.t.sol", content: GOOD_TESTS }], giveUp: false },
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.testAttempts).toBe(1);

    const repairCall = provider.calls.find((call) => call.stage === "test_repair");
    expect(repairCall?.input).toContain("test_theTenthBuyIsFree");

    // What the market is supposed to do is still there, because it decides which side is
    // wrong — but as the rules and invariants rather than the whole document. The prose
    // written for a review screen was most of a seven-thousand-token prompt and none of
    // what this call reasons about.
    expect(repairCall?.input).toContain("buy-streak");
    expect(repairCall?.input).toContain("consecutiveBuys");
    expect(repairCall?.input).not.toContain("Buys since the last sell");
  });

  /**
   * SIMPLE: interpreted, planned, compiled, deployed and ran its suite, and then three rounds of
   * repair rewrote its hook and the last one left the file not compiling. The build was reported
   * unrepairable — a market lost eight minutes after the version that compiled was on the record.
   *
   * A repair is allowed to edit contracts, because a failing test is often a real bug in the
   * market. What it is not allowed to do is have the last word: a market that does not compile has
   * not been tested, so nothing can be concluded from it while a version that did compile exists.
   */
  it("puts back the contracts that compiled rather than losing the market to a repair", async () => {
    const brokenHook = GOOD_HOOK.replace("consecutiveBuys += 1;", "consecutiveBuys += 1");

    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(FAILING_TESTS),
      // Every round edits the hook, and the edit does not compile. The tests are corrected on the
      // way, so a market restored to its compiling contracts has a green suite waiting for it.
      {
        diagnosis: "the hook miscounts the streak",
        files: [
          { path: "contracts/StreakHook.sol", content: brokenHook },
          { path: "test/StreakHook.t.sol", content: GOOD_TESTS },
        ],
        giveUp: false,
      },
      {
        diagnosis: "the hook still miscounts the streak",
        files: [{ path: "contracts/StreakHook.sol", content: brokenHook }],
        giveUp: false,
      },
      {
        diagnosis: "the hook still miscounts the streak",
        files: [{ path: "contracts/StreakHook.sol", content: brokenHook }],
        giveUp: false,
      },
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    // The market that compiled is the market that launched.
    expect(job.sources.find((source) => source.path.endsWith("StreakHook.sol"))?.content).toBe(
      GOOD_HOOK,
    );
    expect(job.stage).toBe(Stage.DeploymentReady);
    expect(job.stages.some((record) => (record.detail ?? "").includes("restored to the version"))).toBe(
      true,
    );
  });

  it("cannot pass by deleting the failing test", async () => {
    // The repair returns only a trimmed test file. Because merging never removes
    // files, the original still exists — a model cannot make a red suite green by
    // omission.
    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(FAILING_TESTS),
      { diagnosis: "removing the awkward test", files: [{ path: "test/Other.t.sol", content: "// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\ncontract OtherTest {}\n" }], giveUp: false },
      { diagnosis: "removing the awkward test", files: [{ path: "test/Other.t.sol", content: "// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\ncontract OtherTest {}\n" }], giveUp: false },
      { diagnosis: "removing the awkward test", files: [{ path: "test/Other.t.sol", content: "// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\ncontract OtherTest {}\n" }], giveUp: false },
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.Failed);
    expect(job.failure?.code).toBe(FailureCode.TestsUnrepairable);
    expect(job.failure?.failingTests?.length).toBeGreaterThan(0);
  });

  it("stops asking once two repairs have left the failure unchanged", async () => {
    // Running the suite costs seconds; a repair round costs a model call. Every test
    // failure in this repository's history that exhausted the budget spent all three
    // rounds on the same failure, so the cost of a doomed build was almost entirely
    // rounds that were never going to work.
    //
    // One repetition is not a stall — the ladder answers it by widening the prompt. Two
    // is: the escalation happened and the outcome did not move.
    const noop = {
      diagnosis: "no change",
      files: [
        {
          // A real repair's shape, so this exercises the stall ladder rather than the
          // structural check: a test file that inherits the canonical base and changes
          // nothing about why the suite is failing.
          path: "test/Other.t.sol",
          content:
            "// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\n\n" +
            'import {MarketTestBase} from "./MarketTestBase.sol";\n\n' +
            "contract OtherTest is MarketTestBase {\n" +
            "    function test_marketExists() public view {\n" +
            "        assertTrue(address(token).code.length > 0);\n" +
            "    }\n}\n",
        },
      ],
      giveUp: false,
    };

    const { options, provider } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(FAILING_TESTS),
      noop,
      noop,
      noop,
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure?.code).toBe(FailureCode.TestsUnrepairable);

    // Two rounds, not the budget's three: the third would have asked the same question.
    const rounds = provider.calls.filter((call) => call.stage === "test_repair").length;
    expect(rounds).toBe(2);
    expect(job.testAttempts).toBe(2);
  });

  /**
   * The largest single cause of lost markets, and it was never about the market.
   *
   * Six of one day's programmable launches ended with "the generated test suite could not be
   * made to compile" after three rounds of patching the same broken file. A suite that will
   * not compile is usually wrong from its first line, and repairing it line by line is the
   * expensive way to find that out — so the suite is written again, once, knowing what went
   * wrong with the last one.
   */
  it("writes the suite again rather than losing a market to tests that never compiled", async () => {
    const noop = {
      diagnosis: "tried again",
      files: [{ path: "test/StreakHook.t.sol", content: UNCOMPILABLE_TESTS }],
      giveUp: false,
    };

    const { options, provider } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(UNCOMPILABLE_TESTS),
      noop,
      noop,
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.stage).toBe(Stage.DeploymentReady);

    // The second generation call was told what happened to the first suite, so it is not
    // the same question asked twice.
    const generations = provider.calls.filter((call) => call.stage === "test_generation");
    expect(generations).toHaveLength(2);
    expect(generations[1]?.instructions).toContain("discarded");
  });

  /**
   * A reserved keyword must not cost the same as a defect.
   *
   * TESTC had four rounds and spent two of them on nothing: a local variable named `after`,
   * then a helper called with two arguments instead of three. The third round reached the real
   * problem — a hook accruing a fee it never credited to the vault — diagnosed it correctly,
   * mistyped the fix, and the market ended holding a compiler error, reported as a test suite
   * that would not compile about a file that is not a test.
   *
   * A suite that does not compile has not run, so a round spent on it has said nothing about
   * the market and cannot be charged to the budget for what the market does. Here two compile
   * rounds and two behaviour rounds are five answers in total, which the old single budget cut
   * off one short of the fix.
   */
  it("does not spend the behaviour budget on a suite that never compiled", async () => {
    const otherwiseUncompilable = GOOD_TESTS.replace(
      "assertEq(hook.consecutiveBuys(), 0);",
      "assertEq(hook.noSuchAccessor(), 0);",
    );
    const failingDifferently = GOOD_TESTS.replace(
      "assertEq(hook.consecutiveBuys(), 0);",
      'assertEq(uint256(1), uint256(2), "the second wrong answer");',
    );

    const repair = (content: string) => ({
      diagnosis: "tried again",
      files: [{ path: "test/StreakHook.t.sol", content }],
      giveUp: false,
    });

    const { options, provider } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(UNCOMPILABLE_TESTS),
      // Two rounds that only get it to compile, each failing in its own way so the stall
      // check has nothing to recognise.
      repair(otherwiseUncompilable),
      repair(FAILING_TESTS),
      // Two rounds on what the market does, the second of which fixes it.
      repair(failingDifferently),
      repair(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.stage).toBe(Stage.DeploymentReady);

    // Four rounds where a single budget of three would have stopped one short of the fix,
    // and the two kinds are visible apart: getting it to compile is not the same work as
    // deciding what the market does.
    const gettingItToCompile = provider.calls.filter((call) => call.stage === "compilation_repair");
    const whatTheMarketDoes = provider.calls.filter((call) => call.stage === "test_repair");
    expect(gettingItToCompile).toHaveLength(2);
    expect(whatTheMarketDoes).toHaveLength(2);
  }, 360_000);

  /**
   * A generated test broken in a way Agen has seen before is dropped, not argued with.
   *
   * Only with evidence: the playbook has to recognise the failure and attribute it to the
   * test, and the market must still be left with a test for every invariant it claims. Both
   * halves matter — a market that ships because the test proving its promise was deleted is
   * worse than a market that does not ship.
   */
  it("drops a generated test whose failure is its own fault", async () => {
    // The Agen Smoke failure, exactly: a test opening its own prank and then calling a
    // trade helper, which opens one of its own. Foundry refuses the second, the market is
    // never reached, and this used to end the build.
    const stackedPrank = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MarketTestBase} from "./MarketTestBase.sol";

contract StackedPrankTest is MarketTestBase {
    function test_a_trade_from_another_wallet() public {
        vm.prank(OTHER_TRADER);
        buy(0.001 ether);
    }
}
`;
    const noop = { diagnosis: "no change", files: [], giveUp: false };

    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      {
        files: [
          { path: "test/StreakHook.t.sol", content: GOOD_TESTS },
          { path: "test/StackedPrank.t.sol", content: stackedPrank },
        ],
        notes: [],
      },
      noop,
      noop,
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.stage).toBe(Stage.DeploymentReady);
    expect(job.tests.map((file) => file.path)).not.toContain("test/StackedPrank.t.sol");
    // The suite that proves this market's declared invariant is untouched.
    expect(job.tests.map((file) => file.path)).toContain("test/StreakHook.t.sol");
  });
});

describe("failing closed", () => {
  it("waits out a dropped connection rather than losing the build", async () => {
    // A live build lost eleven minutes when the planning call died on a network fault:
    // the model was fine, the socket was not, and a good specification was thrown away.
    const { options, provider } = pipeline([
      new ModelError("scripted", "interpreting", "connection reset", { retryable: true }),
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.stage).toBe(Stage.DeploymentReady);
    // Five: the call that died, then the four the stage is made of.
    expect(provider.calls.filter((call) => call.stage === "interpreting")).toHaveLength(5);
  }, 120_000);

  it("gives up on a provider that keeps refusing", async () => {
    const { options } = pipeline([
      new ModelError("scripted", "interpreting", "bad request", { retryable: false }),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.Failed);
    expect(job.failure?.code).toBe(FailureCode.ModelUnavailable);
    expect(job.failure?.stage).toBe(Stage.Interpreting);
  });

  it("refuses a specification that does not validate", async () => {
    const { options } = pipeline([
      // A rule that can charge more than the market told traders it ever would. Unlike
      // a loose annotation, this is a disclosure that is wrong.
      ...interpretationAnswers({
        ...specificationAnswer(),
        maxFeePpm: 5_000,
        rules: [
          {
            ...specificationAnswer().rules[0]!,
            then: [
              {
                kind: "extraFee",
                description: "charge forty percent",
                parameters: [{ key: "feePpm", value: 400_000 }],
                writes: [],
              },
            ],
          },
        ],
      }),
    ]);

    const job = await runBuild(
      { prompt: PROMPT, name: "Canopy", symbol: "CNPY" },
      { ...options, budget: { ...DEFAULT_BUDGET, artefactRetries: 1 } },
    );

    expect(job.failure?.code).toBe(FailureCode.InvalidArtefact);
    expect(job.failure?.detail).toContain("declared maximum fee");
  });

  /**
   * A size threshold the creator named is not a suggestion, and a default must not
   * take its place.
   *
   * The prompt says "over 2% of the token's immutable total supply". Interpretation
   * coming back with one percent is the failure that launched a market nobody asked
   * for: every artefact downstream then agreed with each other about the wrong
   * number. The build stops here, before any Solidity is written.
   */
  it("refuses a stated supply threshold that interpretation replaced with a smaller default", async () => {
    const prompt =
      "Charge 2% on every buy and every sell. On any sell larger than 2% of the token's " +
      "immutable total supply, charge 5% instead.";

    const { options } = pipeline([
      ...interpretationAnswers({
        summary: "Two percent on every trade, five on a large sell",
        baseFeePpm: 20_000,
        maxFeePpm: 50_000,
        phases: [],
        state: [],
        rules: [
          {
            id: "base-fee",
            title: "BASE FEE",
            when: { kind: "swap", description: "Any trade", parameters: null },
            conditions: [],
            then: [
              {
                kind: "setFee",
                description: "Charge 2%",
                parameters: [{ key: "feePpm", value: 20_000 }],
                writes: [],
              },
            ],
            activeInPhases: [],
            onceOnly: false,
          },
          {
            id: "large-sell",
            title: "LARGE SELL",
            when: { kind: "sell", description: "Somebody sells", parameters: null },
            conditions: [
              {
                kind: "tradeSizeVsSupply",
                description: "The sell is large",
                parameters: [
                  { key: "operator", value: ">" },
                  { key: "percent", value: 1 },
                  { key: "basis", value: "totalSupply" },
                ],
                combinator: null,
              },
            ],
            then: [
              {
                kind: "setFee",
                description: "Charge 5%",
                parameters: [{ key: "feePpm", value: 50_000 }],
                writes: [],
              },
            ],
            activeInPhases: [],
            onceOnly: false,
          },
        ],
        invariants: [{ id: "fee-ceiling", statement: "The hook fee never exceeds 5%", expression: null }],
        externalDependencies: [],
        assumptions: [],
        ambiguities: [],
        unsupported: [],
      }),
    ]);

    const job = await runBuild({ prompt, name: "Push", symbol: "PUSH" }, options);

    expect(job.failure?.code).toBe(FailureCode.Unsupported);
    expect(job.failure?.stage).toBe(Stage.Interpreting);
    expect(job.failure?.detail).toContain("2%");
    expect(job.failure?.detail).toMatch(/1%|one percent|different figure|more than 1%/i);
    expect(job.stage).toBe(Stage.Failed);
  });

  it("asks the model to correct an artefact before giving up on it", async () => {
    // The first live run died on a formatting habit — `writes: ["none"]` — that one
    // pointed complaint fixes. Giving up on the first rejection wasted the build.
    const broken = {
      ...specificationAnswer(),
      maxFeePpm: 5_000,
      rules: [
        {
          ...specificationAnswer().rules[0]!,
          then: [
            {
              kind: "extraFee",
              description: "charge forty percent",
              parameters: [{ key: "feePpm", value: 400_000 }],
              writes: [],
            },
          ],
        },
      ],
    };

    const { options, provider } = pipeline([
      ...interpretationAnswers(broken),
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.stage).toBe(Stage.DeploymentReady);

    // The second attempt was told exactly what the validator objected to. Its rules call
    // is the sixth of the stage: four calls for the first attempt, then behaviours and
    // rules again.
    const second = provider.calls.filter((call) => call.stage === "interpreting")[5];
    expect(second?.input).toContain("rejected by the validator");
    expect(second?.input).toContain("declared maximum fee");
  });

  it("refuses a plan whose hook declares no permissions", async () => {
    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      {
        ...planAnswer(),
        plan: {
          ...rawPlan(),
          components: rawPlan().components.map((component) =>
            component.role === "hook" ? { ...component, hookPermissions: [] } : component,
          ),
        },
      },
    ]);

    const job = await runBuild(
      { prompt: PROMPT, name: "Canopy", symbol: "CNPY" },
      { ...options, budget: { ...DEFAULT_BUDGET, artefactRetries: 1 } },
    );

    expect(job.failure?.code).toBe(FailureCode.InvalidArtefact);
    expect(job.failure?.detail).toMatch(/never called by Uniswap/);
  });

  it("blocks a market whose contract can delete itself", async () => {
    // selfdestruct stays a hard blocker: it breaks the one promise a launchpad makes
    // that cannot be renegotiated afterwards.
    const withSelfdestruct = withHookFunction(
      `    function rugPull(address payable to) external {
        selfdestruct(to);
    }`,
    );

    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(withSelfdestruct),
      // The gates now speak once while the market can still be fixed, so a blocker is
      // offered a repair before it is fatal. This one declines, which is the honest
      // answer for a contract that can delete itself.
      { diagnosis: "the market is built around being destroyable", files: [], giveUp: true },
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.Failed);
    expect(job.failure?.code).toBe(FailureCode.GateBlocked);
    expect(job.gateFindings.some((finding) => finding.code === "GATE_SELFDESTRUCT")).toBe(true);

    // Declining a fix does not end the build early: the final gate is still the one that
    // refuses it, with the finding attached.
    expect(job.failure?.stage).toBe(Stage.FinalValidation);
  });

  it("fixes a blocker while the market is still being built, rather than failing at the end", async () => {
    // The failure this replaces: six live PULSE builds from one prompt, some of which
    // guarded their wiring setter and some of which did not, the unguarded ones dying at
    // the last gate after seven minutes of work that was otherwise correct.
    const unguarded = withHookFunction(
      `    address public feeVault;

    function setFeeVault(address vault) external {
        feeVault = vault;
    }`,
    );

    const { options, provider } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(unguarded),
      // The fix: the same market with a caller check, which is all the finding asked for.
      {
        diagnosis: "restricted setFeeVault to the installer",
        files: [
          {
            path: "contracts/StreakHook.sol",
            content: unguarded.replace(
              "function setFeeVault(address vault) external {",
              `error NotInstaller();

    function setFeeVault(address vault) external {
        if (msg.sender != address(0xA9E1)) revert NotInstaller();`,
            ),
          },
        ],
        giveUp: false,
      },
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.stage).toBe(Stage.DeploymentReady);

    // It was asked about the finding, not about a compiler error.
    expect(provider.calls.some((call) => call.stage === "static_analysis")).toBe(true);
    expect(job.stages.some((record) => record.stage === Stage.StaticAnalysis)).toBe(true);
  }, 360_000);

  it("allows low-level code that has been fuzzed, and discloses it", async () => {
    // The policy this replaced rejected delegatecall outright, which meant refusing a
    // legitimate architecture because of how it was implemented.
    const withDelegatecall = withHookFunction(
      `    function forward(bytes calldata data) external {
        (bool ok,) = address(this).delegatecall(data);
        require(ok);
    }`,
    );

    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(withDelegatecall),
      // GOOD_TESTS contains a fuzz test, which is what buys the elevated construct its
      // way past the stricter bar.
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.stage).toBe(Stage.DeploymentReady);

    const finding = job.gateFindings.find((entry) => entry.code === "GATE_DELEGATECALL");
    expect(finding?.severity).toBe("elevated");
    expect(finding?.line).toBeGreaterThan(0);
  });

  it("blocks low-level code that nothing fuzzed", async () => {
    const withDelegatecall = withHookFunction(
      `    function forward(bytes calldata data) external {
        (bool ok,) = address(this).delegatecall(data);
        require(ok);
    }`,
    );

    // Same contract, tests with no fuzzing behind them.
    const unfuzzed = GOOD_TESTS.replace(
      "function test_feeCeiling_isNeverExceeded(uint8 trades) public {",
      "function test_feeCeiling_isNeverExceeded() public { uint8 trades = 3;",
    );

    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(withDelegatecall),
      tests(unfuzzed),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure?.code).toBe(FailureCode.GateBlocked);
    expect(
      job.gateFindings.some((finding) => finding.code === "GATE_ELEVATED_RISK_UNTESTED"),
    ).toBe(true);
  });

  it("refuses a suite that does not test an invariant, at the stage that wrote it", async () => {
    // The deployment gate refuses this too and remains the authority — see
    // invariantsWereProven — but it speaks after compilation, execution, repair and
    // deep validation. A live PULSE build tested its accounting contract exhaustively,
    // gave the hook holding the whole mechanic a file it called a sanity check, and
    // learned that two of its three invariants had no test some six minutes later.
    const withoutInvariantTest = GOOD_TESTS.replace(
      "function test_feeCeiling_isNeverExceeded(uint8 trades) public {",
      "function test_somethingElseEntirely(uint8 trades) public {",
    );

    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(withoutInvariantTest),
    ]);

    const job = await runBuild(
      { prompt: PROMPT, name: "Canopy", symbol: "CNPY" },
      { ...options, budget: { ...DEFAULT_BUDGET, artefactRetries: 1 } },
    );

    expect(job.failure?.code).toBe(FailureCode.InvalidArtefact);
    expect(job.failure?.stage).toBe(Stage.TestGeneration);
    // It names the invariant that went untested, not merely that one did.
    expect(job.failure?.detail).toContain("fee-ceiling");
  });

  it("records a failed build's furthest progress rather than resetting it", async () => {
    // Blocked at the last gate rather than earlier: low-level code with nothing fuzzing
    // it, which only the deployment gates can know about.
    const withDelegatecall = withHookFunction(
      `    function forward(bytes calldata data) external {
        (bool ok,) = address(this).delegatecall(data);
        require(ok);
    }`,
    );

    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(withDelegatecall),
      tests(
        GOOD_TESTS.replace(
          "function test_feeCeiling_isNeverExceeded(uint8 trades) public {",
          "function test_feeCeiling_isNeverExceeded() public { uint8 trades = 3;",
        ),
      ),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.Failed);
    // It got as far as final validation, and the progress reflects that.
    expect(progressOf(job)).toBeGreaterThan(0.8);
    expect(progressOf(job)).toBeLessThan(1);
  });
});

describe("a rule that came back doing nothing", () => {
  /** The behaviours call, which now precedes the rules in every interpretation. */
  function behavioursAnswer() {
    return { behaviours: specificationAnswer().rules.map((rule) => rule.title.toLowerCase()) };
  }

  /** The same rules answer, with the effects stripped out of the first rule. */
  function rulesMissingEffects() {
    const { summary, rules } = specificationAnswer();
    return { summary, rules: rules.map((rule, index) => (index === 0 ? { ...rule, then: [] } : rule)) };
  }

  it("is asked about on its own rather than by re-running interpretation", async () => {
    const { summary: _summary, rules: _rules, ...frame } = specificationAnswer();
    const effects = specificationAnswer().rules[0]!.then;

    const { options, provider } = pipeline([
      behavioursAnswer(),
      rulesMissingEffects(),
      { then: effects },
      frame,
      { suggestions: [] },
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.stage).toBe(Stage.DeploymentReady);

    // The effects are back in the specification, indistinguishable from original ones.
    expect(job.specification?.rules[0]?.then).toHaveLength(effects.length);

    // Interpretation itself ran once: behaviours, rules, the one repair, the frame, the
    // critique. Had the stage been re-run instead, this would be fifteen.
    const asked = provider.calls.filter((call) => call.stage === "interpreting");
    expect(asked).toHaveLength(5);

    // The repair saw one rule, not the market.
    expect(asked[2]?.input).toContain("streak");
    expect(asked[2]?.input).not.toContain("Implementation plan");

    // The job says the repair happened, so a reader can tell which effects came from it.
    const interpreting = job.stages.filter((record) => record.stage === Stage.Interpreting);
    expect(interpreting.at(-1)?.detail).toContain("filled in the effects of 1 rule");
  }, 120_000);

  /**
   * EMBR — "charge a 3% fee on sells and a 1% fee on buys", about as plain as a prompt gets — came
   * back with both rates in English and neither in data: `tradeFee` described as "charge a buy fee
   * of 1% (100 basis points)", with no parameters at all. Everything downstream reads the
   * parameters, so the market's own fees were invisible to the assertions written to hold it to
   * them, and to the gate that compares the market against the request. Effects were present, so
   * the repair that exists for an empty rule never ran.
   */
  it("asks again when a rule's numbers are in its prose and not in its parameters", async () => {
    const { summary: _summary, rules: _rules, ...frame } = specificationAnswer();
    const effects = specificationAnswer().rules[0]!.then;

    const inProseOnly = () => {
      const { summary, rules } = specificationAnswer();
      return {
        summary,
        rules: rules.map((rule, index) =>
          index === 0
            ? {
                ...rule,
                then: rule.then.map((effect) => ({
                  ...effect,
                  description: "Charge a fee of 1% (100 basis points) of the input amount.",
                  parameters: [],
                })),
              }
            : rule,
        ),
      };
    };

    // What a good answer looks like: the same effects, with the rate recorded as data.
    const withNumbers = effects.map((effect) => ({
      ...effect,
      parameters: [{ key: "feeBps", value: 100 }],
    }));

    const { options, provider } = pipeline([
      behavioursAnswer(),
      inProseOnly(),
      { then: withNumbers },
      frame,
      { suggestions: [] },
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.DeploymentReady);

    // The rate is in the specification as a number, where everything downstream can read it.
    expect(job.specification?.rules[0]?.then[0]?.parameters).toEqual({ feeBps: 100 });

    // Asked at the scale of one rule, and told what was actually wrong with it.
    const asked = provider.calls.filter((call) => call.stage === "interpreting");
    expect(asked).toHaveLength(5);
    expect(asked[2]?.input).toContain("missing its numbers");
  }, 120_000);

  it("gives up on that rule after a bounded number of asks, and says which one", async () => {
    const { options, provider } = pipeline([
      behavioursAnswer(),
      rulesMissingEffects(),
      { then: [] },
      { then: [] },
    ]);

    const job = await runBuild(
      { prompt: PROMPT, name: "Canopy", symbol: "CNPY" },
      { ...options, budget: { ...DEFAULT_BUDGET, artefactRetries: 1 } },
    );

    expect(job.failure?.code).toBe(FailureCode.InvalidArtefact);
    expect(job.failure?.detail).toContain("streak");
    expect(job.failure?.detail).toContain("does nothing");

    // Two asks about the rule, not an unbounded loop: behaviours, rules, then those two.
    expect(provider.calls.filter((call) => call.stage === "interpreting")).toHaveLength(4);
  }, 120_000);
});

describe("a plan that builds more than the market asked for", () => {
  it("is refused when a component cannot name what requires it", async () => {
    // The failure this guards is a real one: a planner spent ten minutes designing a
    // buyback executor and a keeper for a market whose rules mentioned neither.
    const speculative = {
      ...planAnswer(),
      plan: {
      ...rawPlan(),
      components: [
        ...rawPlan().components,
        {
          id: "keeper",
          contractName: "StreakKeeper",
          role: "keeper",
          origin: "generate",
          purpose: "Automates upkeep the market might want later",
          requiredBy: ["hourly-settlement"],
          reuses: [],
          dependsOn: [],
          hookPermissions: [],
          custodial: false,
          implementationNotes: [],
        },
      ],
      },
    };

    const { options } = pipeline([...interpretationAnswers(), matchAnswer(), speculative]);

    const job = await runBuild(
      { prompt: PROMPT, name: "Canopy", symbol: "CNPY" },
      { ...options, budget: { ...DEFAULT_BUDGET, artefactRetries: 1 } },
    );

    expect(job.failure?.code).toBe(FailureCode.InvalidArtefact);
    expect(job.failure?.detail).toContain("StreakKeeper");
  }, 120_000);

  it("accepts a component that names a rule the specification actually has", async () => {
    const justified = {
      ...planAnswer(),
      plan: {
        ...rawPlan(),
        components: rawPlan().components.map((component) =>
          component.role === "hook" ? { ...component, requiredBy: ["buy-streak", "fee-ceiling"] } : component,
        ),
      },
    };

    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      justified,
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.stage).toBe(Stage.DeploymentReady);
  }, 120_000);
});

describe("showing the creator their market before the slow checks finish", () => {
  it("reaches review before deep validation, and does not call it deployable", async () => {
    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const seen: { stage: Stage; deployable: boolean }[] = [];

    const job = await runBuild(
      { prompt: PROMPT, name: "Canopy", symbol: "CNPY" },
      {
        ...options,
        onReviewReady: (current) => {
          seen.push({ stage: current.stage, deployable: current.stage === Stage.DeploymentReady });
        },
      },
    );

    // Called once, at review, while the build still had work to do.
    expect(seen).toEqual([{ stage: Stage.ReviewReady, deployable: false }]);
    expect(job.stage).toBe(Stage.DeploymentReady);

    const order = job.stages.map((record) => record.stage);
    expect(order.indexOf(Stage.ReviewReady)).toBeLessThan(order.indexOf(Stage.DeepValidation));
    expect(order.indexOf(Stage.DeepValidation)).toBeLessThan(order.indexOf(Stage.DeploymentReady));
  }, 360_000);

  it("refuses to deploy a market that only fails under fuzzing", async () => {
    // The trade the split makes: this market is shown to its creator and then blocked.
    // What protects them is the launch button, not the wait.
    //
    // The bug is keyed to the depth of the run rather than to the input, because keying it to
    // the input cannot be made reliable in both directions at once. The critical pass draws a
    // single input and has to get past it, the deep pass has to find it, and any failing set
    // sparse enough to survive one draw is one a search of 256 can also miss: `trades > 200`
    // failed the critical pass a fifth of the time, `trades % 64 == 7` about one run in
    // sixty-four, and both flaked in a suite where adding a file reseeds the fuzzer. The
    // shallow pass is the one that sets the fuzz-run count explicitly — see SHALLOW in
    // foundry.ts — so its absence is exactly "this is the deep search", and the fixture fails
    // then and only then.
    const FUZZ_FINDS_IT = GOOD_TESTS.replace(
      "        trades = uint8(bound(trades, 1, 12));",
      `        if (vm.envOr("FOUNDRY_FUZZ_RUNS", uint256(0)) == 0) assertEq(uint256(1), uint256(0));
        trades = uint8(bound(trades, 1, 12));`,
    );

    const { options } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(FUZZ_FINDS_IT),
      { diagnosis: "cannot", files: [], giveUp: true },
    ]);

    let reviewed = false;
    const job = await runBuild(
      { prompt: PROMPT, name: "Canopy", symbol: "CNPY" },
      { ...options, onReviewReady: () => void (reviewed = true) },
    );

    expect(reviewed).toBe(true);
    expect(job.stage).toBe(Stage.Failed);
    expect(job.failure?.stage).toBe(Stage.DeepValidation);
  }, 360_000);

  it("lets the search be answered once, and ships when the answer holds", async () => {
    // The other half of the round above. PULSE was refused on one model-authored invariant
    // asserting its streak equalled the number of buys, which is not what its specification
    // says happens after ten — a wrong assertion, not a broken market, and no round existed in
    // which anyone could say so. Same keying as the test above: the fixture fails only in the
    // deep pass, so what reaches deployment is a market that was searched after the repair
    // rather than one that inherited a pass from the shallower run before it.
    const FUZZ_FINDS_IT = GOOD_TESTS.replace(
      "        trades = uint8(bound(trades, 1, 12));",
      `        if (vm.envOr("FOUNDRY_FUZZ_RUNS", uint256(0)) == 0) assertEq(uint256(1), uint256(0));
        trades = uint8(bound(trades, 1, 12));`,
    );

    const { options, provider } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(FUZZ_FINDS_IT),
      {
        diagnosis: "the invariant asserted a ceiling the market never promised",
        files: [{ path: "test/StreakHook.t.sol", content: GOOD_TESTS }],
        giveUp: false,
      },
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.stage).toBe(Stage.DeploymentReady);

    // Narrow on purpose: the creator has already been shown this market, so the round may
    // correct an assertion about it and may not quietly rewrite the market itself.
    const repair = provider.calls.find((call) => call.stage === "test_repair");
    expect(repair).toBeDefined();
    expect(job.sources.find((file) => file.path.endsWith("StreakHook.sol"))?.content).toBe(GOOD_HOOK);
  }, 360_000);
});

describe("a market with more behaviours than one answer holds", () => {
  it("formalises them in batches, at once, rather than in one long answer", async () => {
    // Why this exists: a ten-rule EMBER build came back with all ten rules empty and
    // then paid for ten repair calls to put the effects back. It is the same failure the
    // schema was split for — the deepest required array is what gets dropped when an
    // answer runs long — and splitting in half only moved the threshold.
    // The first keeps the fixture plan's rule id, since components must cite a rule
    // the market actually has.
    const behaviours = ["buy-streak", "two", "three", "four", "five", "six", "seven"];

    const ruleFor = (id: string) => ({
      ...specificationAnswer().rules[0]!,
      id,
      title: id.toUpperCase(),
    });

    const { summary, rules: _rules, ...frame } = specificationAnswer();

    const { options, provider } = pipeline([
      { behaviours },
      // Seven behaviours at four per call is two batches.
      { summary, rules: [ruleFor("buy-streak"), ruleFor("two"), ruleFor("three"), ruleFor("four")] },
      { summary: "", rules: [ruleFor("five"), ruleFor("six"), ruleFor("seven")] },
      frame,
      { suggestions: [] },
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.failure).toBeNull();
    expect(job.specification?.rules).toHaveLength(7);

    // In the order the market was described in, not the order the answers came back.
    expect(job.specification?.rules.map((rule) => rule.id)).toEqual([
      "buy-streak",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
    ]);

    // Recorded as the separate calls they were, so a profile shows two short calls
    // running together rather than one long one that never happened.
    const labels = job.exchanges.map((exchange) => exchange.call).filter((call) => call !== undefined);
    expect(labels).toContain("rules:1");
    expect(labels).toContain("rules:2");

    // And nothing needed repairing, which is the point of the smaller answers.
    expect(provider.calls.filter((call) => call.schemaName === "rule_effects")).toHaveLength(0);
  }, 360_000);
});

describe("carrying on a build that stopped", () => {
  /** A build that dies at test generation, holding a specification, a plan and contracts. */
  async function interrupted() {
    const { options, store, provider } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      new ModelError("scripted", "test_generation", "connection reset", { retryable: true }),
      new ModelError("scripted", "test_generation", "connection reset", { retryable: true }),
      new ModelError("scripted", "test_generation", "connection reset", { retryable: true }),
      new ModelError("scripted", "test_generation", "connection reset", { retryable: true }),
    ]);

    const job = await runBuild(
      { prompt: PROMPT, name: "Canopy", symbol: "CNPY" },
      { ...options, disposeOnSuccess: false },
    );

    expect(job.stage).toBe(Stage.Failed);
    expect(job.specification).not.toBeNull();
    expect(job.plan).not.toBeNull();

    return { job, store, options, provider };
  }

  it("finishes without asking the model to interpret or plan again", async () => {
    const { job, store, options } = await interrupted();

    // Only the work that was never done: the tests. Had resumption re-run the earlier
    // stages, this script would run out and the provider would say so.
    const second = scriptedProvider([tests(GOOD_TESTS)]);
    const resumed = await resumeBuild(job.id, {
      ...options,
      provider: second,
      store,
      disposeOnSuccess: true,
    });

    expect(resumed.failure).toBeNull();
    expect(resumed.stage).toBe(Stage.DeploymentReady);
    expect(second.calls.map((call) => call.stage)).toEqual(["test_generation"]);
  }, 360_000);

  it("keeps the very same market, rather than interpreting the prompt afresh", async () => {
    // The point of resuming rather than restarting. A creator who was reading a market
    // when the build died must not come back to a different one.
    const { job, store, options } = await interrupted();

    const resumed = await resumeBuild(job.id, {
      ...options,
      provider: scriptedProvider([tests(GOOD_TESTS)]),
      store,
      disposeOnSuccess: true,
    });

    expect(resumed.id).toBe(job.id);
    expect(resumed.specification).toEqual(job.specification);
    expect(resumed.plan).toEqual(job.plan);
    expect(resumed.sources).toEqual(job.sources);
  }, 360_000);

  it("runs the tests again rather than inheriting the last run's evidence", async () => {
    // A resumed build must never be able to reach deployment on a test suite it did not
    // just run: the outcomes are what the gates read.
    const { job, store, options } = await interrupted();

    const resumed = await resumeBuild(job.id, {
      ...options,
      provider: scriptedProvider([tests(GOOD_TESTS)]),
      store,
      disposeOnSuccess: true,
    });

    const stages = resumed.stages.map((record) => record.stage);
    expect(stages).toContain(Stage.Compilation);
    expect(stages).toContain(Stage.TestExecution);
    expect(resumed.testOutcomes.length).toBeGreaterThan(0);
  }, 360_000);

  it("says which stages it carried over rather than appearing to skip them", async () => {
    const { job, store, options } = await interrupted();

    const resumed = await resumeBuild(job.id, {
      ...options,
      provider: scriptedProvider([tests(GOOD_TESTS)]),
      store,
      disposeOnSuccess: true,
    });

    const carried = resumed.stages.filter((record) => record.detail?.startsWith("Kept ") === true);
    expect(carried.map((record) => record.stage)).toEqual([
      Stage.Interpreting,
      Stage.ArchitecturePlanning,
      Stage.CodeGeneration,
    ]);
  }, 360_000);

  it("refuses to resume a job that was never started", async () => {
    const { options, store } = pipeline([]);
    await expect(resumeBuild("no-such-job", { ...options, store })).rejects.toThrow(/no job/);
  });
});

describe("asking the creator instead of guessing", () => {
  /** The same specification, but with the one question that changes the market. */
  function withQuestion() {
    return {
      ...specificationAnswer(),
      ambiguities: [
        {
          id: "buyback-timing",
          question: "When should the accumulated buyback actually execute?",
          why: "It decides when value leaves the reserve and how large each buy is.",
          otherwise: "On the first buy after each ten-minute interval.",
          options: ["immediately on the sell", "on the first buy after ten minutes"],
          blocking: true,
        },
      ],
    };
  }

  it("stops before designing anything and says what it needs to know", async () => {
    // Only interpretation is scripted. If the gate leaked, planning would ask the
    // provider for an answer that is not there and the build would fail instead of
    // pausing — so the short script is itself part of the assertion.
    const { options, store } = pipeline(interpretationAnswers(withQuestion()));

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.AwaitingClarification);
    expect(job.failure).toBeNull();
    expect(job.plan).toBeNull();
    expect(job.sources).toHaveLength(0);

    // The question reached the creator with the interpretation intact behind it.
    expect(job.specification?.ambiguities[0]?.question).toMatch(/buyback/i);
    expect(job.stages.at(-1)?.detail).toMatch(/buyback/i);

    // And it is durable: a reload has to find the same question.
    const stored = await store.read(job.id);
    expect(stored?.stage).toBe(Stage.AwaitingClarification);
  }, 360_000);

  it("does not ask when the question has a defensible default", async () => {
    const soft = {
      ...withQuestion(),
      ambiguities: [{ ...withQuestion().ambiguities[0]!, blocking: false }],
    };

    const { options } = pipeline([
      ...interpretationAnswers(soft),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    // Built, not interviewed.
    expect(job.stage).toBe(Stage.DeploymentReady);
  }, 360_000);

  it("folds the answer into the same specification and carries on building", async () => {
    const { options, store } = pipeline(interpretationAnswers(withQuestion()));

    const paused = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);
    expect(paused.stage).toBe(Stage.AwaitingClarification);

    // A second script, because answering continues the build the first one paused: the
    // stages it already finished are carried over rather than asked for again. The
    // revision is not one of those — an answer that never reached the rules would be a
    // question asked for nothing.
    const { options: second } = pipeline([
      revisionAnswer("Execute the buyback on the first buy after ten minutes"),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const built = await answerBuild(
      paused.id,
      [{ id: "buyback-timing", answer: "on the first buy after each ten-minute interval" }],
      { ...second, store },
    );

    expect(built.stage).toBe(Stage.DeploymentReady);

    // The conversation is not the source of truth. The answer is in the specification,
    // in the same shape as every other resolved decision.
    const recorded = built.specification?.assumptions.find(
      (assumption) => assumption.id === "answered-buyback-timing",
    );
    expect(recorded?.interpretation).toBe("on the first buy after each ten-minute interval");
    expect(built.specification?.ambiguities).toHaveLength(0);

    // One market, two versions of its specification — not two markets.
    expect(built.specification?.version).toBeGreaterThan(paused.specification!.version);
    expect(built.specificationHistory.length).toBeGreaterThan(0);

    // The market that got built is the one the creator was reading when asked.
    expect(built.specification?.rules.map((rule) => rule.id)).toEqual(
      paused.specification?.rules.map((rule) => rule.id),
    );
  }, 360_000);

  it("offers an improvement without waiting for an answer about it", async () => {
    // The difference between a suggestion and a question, at the level that matters: the
    // market is built, and the observation is attached to it for the creator to find on
    // the review screen rather than standing in front of the build.
    const suggestion = {
      id: "roll-forward",
      title: "Roll part of the pot forward",
      reason: "Paying the whole pot out leaves nothing to play for in the next round.",
      proposedChange: "Carry 20% of the pot into the round that follows.",
      category: "economics",
    };

    const { options } = pipeline([
      ...interpretationAnswers(specificationAnswer(), [suggestion]),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const job = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(job.stage).toBe(Stage.DeploymentReady);
    expect(job.specification?.suggestions.map((entry) => entry.id)).toEqual(["roll-forward"]);

    // And it is still only an offer: nothing was applied on the creator's behalf.
    expect(acceptedSuggestions(job.specification!)).toEqual([]);
  }, 360_000);

  it("builds the market again when an improvement is accepted", async () => {
    const suggestion = {
      id: "roll-forward",
      title: "Roll part of the pot forward",
      reason: "Paying the whole pot out leaves nothing to play for in the next round.",
      proposedChange: "Carry 20% of the pot into the round that follows.",
      category: "economics",
    };

    const { options, store } = pipeline([
      ...interpretationAnswers(specificationAnswer(), [suggestion]),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const first = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);
    expect(first.stage).toBe(Stage.DeploymentReady);

    // The architecture and the contracts of the first build are answers to a market the
    // creator has just changed, so they are designed and written again — after a revision
    // that puts what they accepted into the rules. Keeping any of it would ship a market
    // that ignores what was accepted while appearing to have taken it into account.
    const { options: second } = pipeline([
      revisionAnswer("Carry 20% of the pot into the next round"),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const rebuilt = await decideBuild(first.id, [{ kind: "accept", id: "roll-forward" }], {
      ...second,
      store,
    });

    expect(rebuilt.stage).toBe(Stage.DeploymentReady);
    expect(acceptedSuggestions(rebuilt.specification!)).toEqual([
      "Carry 20% of the pot into the round that follows.",
    ]);
    expect(rebuilt.specification!.version).toBeGreaterThan(first.specification!.version);
  }, 360_000);

  it("carries one specification through several turns, forgetting nothing", async () => {
    // The claim being tested is that the specification is the memory. Three turns, each
    // deciding something different, and at the end the market has to hold all three —
    // not the last one, and not a fresh reading of the original prompt with the earlier
    // agreements quietly dropped.
    const suggestion = {
      id: "roll-forward",
      title: "Roll part of the pot forward",
      reason: "Paying the whole pot out leaves nothing to play for in the next round.",
      proposedChange: "Carry 20% of the pot into the round that follows.",
      category: "economics",
    };

    const opening = {
      ...specificationAnswer(),
      assumptions: [
        {
          id: "streak-scope",
          term: "consecutive buys",
          interpretation: "The streak is counted across the whole market, not per wallet",
          why: "You described one streak rather than one for each trader.",
          parameters: null,
          importance: "medium",
          requiresConfirmation: false,
        },
      ],
    };

    const { options, store } = pipeline([
      ...interpretationAnswers(opening, [suggestion]),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    // Turn one: the market as first read.
    const first = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    expect(first.stage).toBe(Stage.DeploymentReady);
    expect(first.specification?.rules[0]?.then).toHaveLength(1);

    // Turn two: they take the improvement. The rules have to change.
    const { options: turnTwo } = pipeline([
      revisionAnswer("Carry 20% of the pot into the next round"),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const second = await decideBuild(first.id, [{ kind: "accept", id: "roll-forward" }], {
      ...turnTwo,
      store,
    });

    expect(second.stage).toBe(Stage.DeploymentReady);
    expect(second.specification?.rules[0]?.then.at(-1)?.description).toContain("Carry 20%");

    // Turn three: they correct a reading Agen took two turns ago.
    const { options: turnThree } = pipeline([
      revisionAnswer("Count the streak per wallet"),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const third = await decideBuild(
      second.id,
      [{ kind: "override", id: "streak-scope", interpretation: "Counted separately per wallet" }],
      { ...turnThree, store },
    );

    expect(third.stage).toBe(Stage.DeploymentReady);

    const settled = third.specification!;

    // Turn one's mechanic, turn two's improvement and turn three's correction, all
    // present at once. This is the assertion the whole conversational layer exists for.
    expect(settled.rules[0]!.id).toBe("buy-streak");
    expect(settled.rules[0]!.then.at(-1)?.description).toContain("per wallet");
    expect(settled.assumptions.find((entry) => entry.id === "streak-scope")?.interpretation).toBe(
      "Counted separately per wallet",
    );
    expect(acceptedSuggestions(settled)).toEqual(["Carry 20% of the pot into the round that follows."]);

    // The improvement is marked as built, so a fourth turn does not apply it a second
    // time and carry 20% of what is left of the 20%.
    expect(settled.suggestions[0]!.applied).toBe(true);
    expect(rulesAreStale(settled)).toBe(false);

    // One market with a history, rather than three markets.
    expect(settled.version).toBeGreaterThan(first.specification!.version);
    expect(third.specificationHistory.length).toBeGreaterThanOrEqual(3);
    expect(third.id).toBe(first.id);
  }, 240_000);

  it("takes a change typed in the creator's own words and rebuilds around it", async () => {
    // The review screen's whole purpose: read the market, say "make the sell fee 1%
    // instead", get that market back. Not a new one, and not a form with a fee field.
    const { options, store } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const built = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);
    expect(built.stage).toBe(Stage.DeploymentReady);

    const { options: edited } = pipeline([
      revisionAnswer("Charge 1% on sells"),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const after = await decideBuild(
      built.id,
      [{ kind: "edit", instruction: "Make the sell fee 1% instead" }],
      { ...edited, store },
    );

    expect(after.stage).toBe(Stage.DeploymentReady);
    expect(after.specification?.rules[0]?.then.at(-1)?.description).toContain("1% on sells");

    // What they asked for is on the specification in their own words, which is what the
    // review screen shows them when they ask what they changed.
    expect(after.specification?.edits?.[0]?.instruction).toBe("Make the sell fee 1% instead");
    expect(after.specification?.edits?.[0]?.applied).toBe(true);

    // And it is the same market, not a second one.
    expect(after.id).toBe(built.id);
    expect(after.specification?.rules.map((rule) => rule.id)).toEqual(
      built.specification?.rules.map((rule) => rule.id),
    );
  }, 240_000);

  it("does not pay for a revision when nothing was decided", async () => {
    // Resuming a build that stopped for an unrelated reason must not re-derive the
    // mechanic. The script is the assertion: it holds no revision answer, so a revision
    // would consume the planning answer and the build would come apart.
    const { options, store } = pipeline([
      ...interpretationAnswers(),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      new ModelError("scripted", "test_generation", "connection reset", { retryable: false }),
    ]);

    const stopped = await runBuild(
      { prompt: PROMPT, name: "Canopy", symbol: "CNPY" },
      { ...options, disposeOnSuccess: false },
    );
    expect(stopped.stage).toBe(Stage.Failed);

    const { options: again } = pipeline([tests(GOOD_TESTS)]);
    const resumed = await resumeBuild(stopped.id, { ...again, store });

    expect(resumed.stage).toBe(Stage.DeploymentReady);
    expect(resumed.specification?.version).toBe(stopped.specification?.version);
  }, 240_000);

  it("lets a creator who does not care take the default and still build", async () => {
    const { options, store } = pipeline(interpretationAnswers(withQuestion()));
    const paused = await runBuild({ prompt: PROMPT, name: "Canopy", symbol: "CNPY" }, options);

    const { options: second } = pipeline([
      revisionAnswer("Execute the buyback on the first buy after ten minutes"),
      matchAnswer(),
      planAnswer(),
      sources(GOOD_HOOK),
      tests(GOOD_TESTS),
    ]);

    const built = await answerBuild(paused.id, [{ id: "buyback-timing" }], {
      ...second,
      store,
    });

    expect(built.stage).toBe(Stage.DeploymentReady);
    expect(built.specification?.assumptions.at(-1)?.interpretation).toBe(
      "On the first buy after each ten-minute interval.",
    );
  }, 360_000);
});
