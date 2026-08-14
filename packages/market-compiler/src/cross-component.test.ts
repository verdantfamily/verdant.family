/**
 * A market whose contracts call each other, and the four ways that used to end a build.
 *
 * These are regressions for one live failure. FLOWTEST asked for a 1% sell fee split between
 * a fee receiver and the creator, and Agen designed it correctly: a hook, an accounting
 * contract, and Agen's own `FeeVault` holding the money. The hook then made two ordinary
 * mistakes — it converted an address to `FeeVault` without going through `payable`, and it
 * called `recordFee(currency, toReceiver, toCreator)` on an accounting contract that exposes
 * `recordSellFee(currency, total)` and does the split itself.
 *
 * Neither mistake was interesting. What killed the build was the shape of the recovery. The
 * compilation repair diagnosed both perfectly and fixed them; a later stage then found an
 * unrelated disagreement about the pool and *regenerated the hook from scratch*, which threw
 * the fixes away and reproduced both errors verbatim, because it was the same prompt that had
 * produced them the first time. The build died on two errors that had already been fixed,
 * with its repair budget untouched.
 *
 * So there are two properties here, and the second is the one that matters:
 *
 *   - a cross-component call is written against the sibling's real interface, because the
 *     interface is in the prompt rather than left to be inferred from a summary
 *   - a component changed late keeps everything earlier rounds fixed, because it is edited
 *     rather than written again
 *
 * The model is scripted, so what these prove about a real model is precise and limited: that
 * the facts reach the prompt, and that the pipeline no longer discards work. Everything else
 * is real — forge, the v4 tree, the factory, the launch.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DYNAMIC_FEE_FLAG } from "@verdant/config";

import { Stage, type GenerationJob } from "./job.js";
import type { StructuredRequest } from "./model.js";
import { scriptedProvider } from "./model.js";
import { DEFAULT_BUDGET, runBuild } from "./pipeline.js";
import { memoryJobStore } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = resolve(here, "../../contracts/vendor");

let generatedRoot: string | null = null;
let clock = 1_000;
let ids = 0;

beforeAll(async () => {
  await promisify(execFile)("forge", ["--version"]).catch(() => {
    throw new Error("forge is not on the PATH; these tests compile and launch real markets");
  });
});

beforeEach(async () => {
  generatedRoot = await mkdtemp(join(tmpdir(), "agen-cross-"));
});

afterEach(async () => {
  clock = 1_000;
  if (generatedRoot !== null) await rm(generatedRoot, { recursive: true, force: true });
  generatedRoot = null;
});

// --- the market ------------------------------------------------------------

const PROMPT = "Sells pay a fee, and an accounting contract keeps track of what was taken.";

function interpretationAnswers(): readonly unknown[] {
  return [
    { behaviours: ["sells pay a fee"] },
    {
      summary: "Sells pay a fee the market accounts for",
      rules: [
        {
          id: "sell-fee",
          title: "SELL FEE",
          when: { kind: "sell", description: "Somebody sells", parameters: null },
          conditions: [],
          then: [
            {
              kind: "chargeFee",
              description: "The trade pays the hook's fee",
              parameters: [{ key: "ppm", value: 10_000 }],
              writes: ["collected"],
            },
          ],
          activeInPhases: [],
          onceOnly: false,
        },
      ],
    },
    {
      baseFeePpm: 5_000,
      maxFeePpm: 30_000,
      phases: [],
      state: [
        { name: "collected", type: "counter", description: "What the market has taken", writeOnce: false },
      ],
      invariants: [{ id: "fee-ceiling", statement: "The hook fee never exceeds 3%", expression: null }],
      externalDependencies: [],
      assumptions: [],
      ambiguities: [],
      unsupported: [],
    },
    { suggestions: [] },
  ];
}

const MATCH = {
  reuse: [
    { catalogueId: "base-hook", why: "it needs a hook at all" },
    { catalogueId: "fee-vault", why: "the money must not sit in the hook" },
    { catalogueId: "wiring", why: "the accounting contract is told its vault at launch" },
  ],
  novel: [{ concern: "accounting for what a sell paid", why: "nothing in the catalogue does it" }],
};

function plan(hookPermissions: readonly string[]) {
  return {
    approach: "A hook that charges sells, a vault that holds the money, and accounting over it.",
    components: [
      {
        id: "flowToken",
        contractName: "FlowToken",
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
        id: "flowAccounting",
        contractName: "FlowAccounting",
        role: "accounting",
        origin: "extend",
        purpose: "Records what each sell paid",
        requiredBy: ["sell-fee"],
        reuses: ["wiring"],
        dependsOn: [],
        hookPermissions: [],
        custodial: false,
        implementationNotes: [],
      },
      {
        id: "feeVault",
        contractName: "FeeVault",
        role: "vault",
        origin: "reuse",
        purpose: "Holds what sells paid",
        requiredBy: ["sell-fee"],
        reuses: ["fee-vault"],
        dependsOn: ["flowAccounting"],
        hookPermissions: [],
        custodial: true,
        implementationNotes: [],
      },
      {
        id: "flowHook",
        contractName: "FlowHook",
        role: "hook",
        origin: "extend",
        purpose: "Charges the sell fee and reports it",
        requiredBy: ["sell-fee"],
        reuses: ["base-hook"],
        dependsOn: ["feeVault", "flowAccounting"],
        hookPermissions: [...hookPermissions],
        custodial: false,
        implementationNotes: [],
      },
    ],
    dependencies: [],
    adaptations: [],
  };
}

function deployment(hookPermissions: readonly string[]) {
  return {
    components: [
      {
        componentId: "flowToken",
        constructorArguments: [{ name: "recipient", type: "address", source: "INFRA:INSTALLER" }],
        immutable: ["recipient"],
        wiring: [],
        controller: null,
      },
      {
        componentId: "flowAccounting",
        constructorArguments: [{ name: "installer_", type: "address", source: "INFRA:INSTALLER" }],
        immutable: ["installer_"],
        wiring: [
          {
            functionName: "setFeeVault",
            argument: "COMPONENT:feeVault",
            caller: "INSTALLER",
            phase: "before_pool_initialize",
            once: true,
          },
          {
            functionName: "setHook",
            argument: "COMPONENT:flowHook",
            caller: "INSTALLER",
            phase: "before_pool_initialize",
            once: true,
          },
        ],
        controller: null,
      },
      {
        componentId: "feeVault",
        constructorArguments: [
          { name: "owner_", type: "address", source: "COMPONENT:flowAccounting" },
        ],
        immutable: ["owner_"],
        wiring: [],
        controller: "COMPONENT:flowAccounting",
      },
      {
        componentId: "flowHook",
        constructorArguments: [
          { name: "manager_", type: "address", source: "INFRA:POOL_MANAGER" },
          { name: "feeVault_", type: "address", source: "COMPONENT:feeVault" },
          { name: "feeAccounting_", type: "address", source: "COMPONENT:flowAccounting" },
        ],
        immutable: ["manager_", "feeVault_", "feeAccounting_"],
        wiring: [],
        controller: null,
      },
    ],
    pool: { feeMode: "dynamic", lpFee: String(DYNAMIC_FEE_FLAG) },
    hookPermissions: [...hookPermissions],
    custodyComponentId: "feeVault",
    feeClaimComponentId: "flowAccounting",
    oneTimeInitialization: [],
  };
}

// --- the accounting contract, which is the ground truth under test ----------

/**
 * The sibling whose interface the hook has to get right.
 *
 * `recordSellFee(address, uint256)` takes the whole fee. There is no `recordFee`, and no
 * three-argument anything — which is exactly what the hook in a real build assumed.
 */
const ACCOUNTING = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgenWired} from "./AgenWired.sol";
import {FeeVault} from "./FeeVault.sol";

contract FlowAccounting is AgenWired {
    FeeVault public feeVault;
    address public hook;
    uint256 public collected;

    error InvalidVaultOwner(address owner);

    constructor(address installer_) AgenWired(installer_) {}

    function setFeeVault(address feeVault_) external onlyInstaller {
        _wireOnce(address(feeVault));
        require(feeVault_ != address(0), "vault");

        FeeVault vault = FeeVault(payable(feeVault_));
        address vaultOwner = vault.owner();
        if (vaultOwner != address(this)) revert InvalidVaultOwner(vaultOwner);

        feeVault = vault;
        if (hook != address(0)) vault.setHook(hook);
    }

    function setHook(address hook_) external onlyInstaller {
        _wireOnce(hook);
        require(hook_ != address(0), "hook");

        hook = hook_;
        FeeVault vault = feeVault;
        if (address(vault) != address(0)) vault.setHook(hook_);
    }

    function recordSellFee(address currency, uint256 collectedFee) external {
        require(msg.sender == hook, "hook");
        currency;
        collected += collectedFee;
    }
}
`;

/** The correct conversion, and the one solc refuses. */
const CAST_GOOD = "        feeVault = FeeVault(payable(feeVault_));";
const CAST_BAD = "        feeVault = FeeVault(feeVault_);";

/** The correct call, and the two ways a guess gets it wrong. */
const RECORD_GOOD =
  "        feeAccounting.recordSellFee(currency, swapAmount(params) * SELL_FEE_PPM / 1_000_000);";
const RECORD_MISSING_MEMBER =
  "        feeAccounting.recordFee(currency, swapAmount(params) / 2, swapAmount(params) / 2);";
const RECORD_WRONG_ARITY =
  "        feeAccounting.recordSellFee(currency, swapAmount(params), SELL_FEE_PPM);";

function hookSource({
  cast,
  record,
  permissions,
}: {
  readonly cast: string;
  readonly record: string;
  readonly permissions: readonly string[];
}): string {
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {AgenBaseHook} from "./AgenBaseHook.sol";
import {FeeVault} from "./FeeVault.sol";
import {FlowAccounting} from "./FlowAccounting.sol";

contract FlowHook is AgenBaseHook {
    uint24 public constant SELL_FEE_PPM = 10_000;

    FeeVault public immutable feeVault;
    FlowAccounting public immutable feeAccounting;

    constructor(address manager_, address feeVault_, address feeAccounting_)
        AgenBaseHook(IPoolManager(manager_))
    {
${cast}
        feeAccounting = FlowAccounting(feeAccounting_);
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
${permissions.map((name) => `        permissions.${name} = true;`).join("\n")}
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
        if (isBuy(params)) return (BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);

        address currency = Currency.unwrap(inputCurrency(key, params));
${record}

        return (BeforeSwapDeltaLibrary.ZERO_DELTA, SELL_FEE_PPM | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
`;
}

const BEHAVIOUR = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MarketTestBase} from "./MarketTestBase.sol";

contract FlowBehaviorTest is MarketTestBase {
    function test_the_market_launches_and_trades() public {
        assertTrue(address(hook).code.length > 0);
        assertGt(buy(0.01 ether), 0);
    }

    /// Invariant: fee-ceiling
    function testFuzz_feeCeiling_isNeverExceeded(uint8 trades) public {
        trades = uint8(bound(trades, 1, 4));
        for (uint256 index = 0; index < trades; index++) buy(0.001 ether);
        assertGe(tokenBalance(TRADER), 0);
    }
}
`;

const TESTS = { files: [{ path: "test/FlowBehavior.t.sol", content: BEHAVIOUR }], notes: [] };

// --- running one ------------------------------------------------------------

async function launch(
  script: readonly unknown[],
): Promise<{ readonly job: GenerationJob; readonly calls: readonly StructuredRequest[] }> {
  const provider = scriptedProvider(script);

  const job = await runBuild(
    { prompt: PROMPT, name: "Flow", symbol: "FLOW" },
    {
      provider,
      store: memoryJobStore(),
      vendorRoot: VENDOR,
      generatedRoot: generatedRoot!,
      budget: DEFAULT_BUDGET,
      now: () => (clock += 10),
      newId: () => `cross-${String(++ids)}`,
    },
  );

  return { job, calls: provider.calls };
}

function reachedLaunch(job: GenerationJob): void {
  const detail = job.failure === null ? "" : `${job.failure.code}: ${job.failure.detail}`;
  expect(job.failure, detail).toBeNull();
  expect(job.stage, detail).toBe(Stage.DeploymentReady);
  expect(job.testOutcomes.every((outcome) => outcome.passed), detail).toBe(true);
}

/** The source of one contract as the build left it. */
function finalSource(job: GenerationJob, contractName: string): string {
  return job.sources.find((source) => source.path.endsWith(`/${contractName}.sol`))!.content;
}

const repairCalls = (calls: readonly StructuredRequest[]) =>
  calls.filter((call) => call.stage === "compilation_repair");

// --- 1. the cast, which needs no model at all -------------------------------

describe("an address converted to a vault that can receive ether", () => {
  it(
    "is fixed without spending a repair round, and the market launches",
    async () => {
      const { job, calls } = await launch([
        ...interpretationAnswers(),
        MATCH,
        { plan: plan(["beforeSwap"]), deployment: deployment(["beforeSwap"]) },
        { content: ACCOUNTING, notes: [] },
        {
          content: hookSource({
            cast: CAST_BAD,
            record: RECORD_GOOD,
            permissions: ["beforeSwap"],
          }),
          notes: [],
        },
        TESTS,
      ]);

      reachedLaunch(job);

      // The script has no repair answer in it, and the build did not need one: had the
      // pipeline asked, the scripted provider would have thrown for want of a reply.
      expect(repairCalls(calls)).toHaveLength(0);
      expect(finalSource(job, "FlowHook")).toContain("FeeVault(payable(feeVault_))");
    },
    600_000,
  );
});

// --- 2. and 3. the calls that need a judgement, with the facts supplied -----

describe("a hook calling something its sibling does not have", () => {
  it(
    "is repaired with the sibling's real interface in the prompt",
    async () => {
      const { job, calls } = await launch([
        ...interpretationAnswers(),
        MATCH,
        { plan: plan(["beforeSwap"]), deployment: deployment(["beforeSwap"]) },
        { content: ACCOUNTING, notes: [] },
        {
          content: hookSource({
            cast: CAST_GOOD,
            record: RECORD_MISSING_MEMBER,
            permissions: ["beforeSwap"],
          }),
          notes: [],
        },
        {
          diagnosis: "The accounting contract takes the whole fee and splits it itself.",
          files: [
            {
              path: "contracts/FlowHook.sol",
              content: hookSource({
                cast: CAST_GOOD,
                record: RECORD_GOOD,
                permissions: ["beforeSwap"],
              }),
            },
          ],
          giveUp: false,
        },
        TESTS,
      ]);

      reachedLaunch(job);

      const [repair] = repairCalls(calls);
      expect(repair, "the repair was never asked for").toBeDefined();

      // The whole point. The model is told the signature rather than left to infer one
      // from a summary of what the contract is for.
      expect(repair!.input).toContain("recordSellFee(address currency, uint256 collectedFee)");
      expect(repair!.input).toContain("FlowAccounting has no member recordFee");
      expect(repair!.input).toContain("do not add a function to FlowAccounting");
    },
    600_000,
  );
});

describe("a hook calling its sibling with the wrong number of arguments", () => {
  it(
    "is repaired with the arity stated and the interface supplied",
    async () => {
      const { job, calls } = await launch([
        ...interpretationAnswers(),
        MATCH,
        { plan: plan(["beforeSwap"]), deployment: deployment(["beforeSwap"]) },
        { content: ACCOUNTING, notes: [] },
        {
          content: hookSource({
            cast: CAST_GOOD,
            record: RECORD_WRONG_ARITY,
            permissions: ["beforeSwap"],
          }),
          notes: [],
        },
        {
          diagnosis: "recordSellFee takes the currency and the total, and nothing else.",
          files: [
            {
              path: "contracts/FlowHook.sol",
              content: hookSource({
                cast: CAST_GOOD,
                record: RECORD_GOOD,
                permissions: ["beforeSwap"],
              }),
            },
          ],
          giveUp: false,
        },
        TESTS,
      ]);

      reachedLaunch(job);

      const [repair] = repairCalls(calls);
      expect(repair!.input).toContain("arguments to a function that takes 2");
      expect(repair!.input).toContain("recordSellFee(address currency, uint256 collectedFee)");
    },
    600_000,
  );
});

// --- 4. the regression that FLOWTEST actually was ---------------------------

describe("a component changed to match its declared deployment", () => {
  /**
   * The FLOWTEST failure, reproduced in the order it happened.
   *
   * The hook arrives with both mistakes, the repair fixes them, and only then does
   * deployment validation object to something else entirely — here the callbacks the hook
   * implements, in the live build the pool's fee. What must not happen is what used to: the
   * component being written again from its declaration, losing both fixes, and failing the
   * build on errors that were already dealt with.
   */
  it(
    "keeps what earlier repairs fixed, and reaches a launch",
    async () => {
      const permissions = ["beforeSwap", "afterSwap"];

      const { job, calls } = await launch([
        ...interpretationAnswers(),
        MATCH,
        { plan: plan(permissions), deployment: deployment(permissions) },
        { content: ACCOUNTING, notes: [] },
        // Both mistakes, and only `beforeSwap` — so the contracts disagree with the
        // declaration even once they compile.
        {
          content: hookSource({
            cast: CAST_BAD,
            record: RECORD_MISSING_MEMBER,
            permissions: ["beforeSwap"],
          }),
          notes: [],
        },
        // The compilation repair. The cast is already fixed by then, mechanically, so this
        // only has the call to deal with.
        {
          diagnosis: "The accounting contract takes the whole fee.",
          files: [
            {
              path: "contracts/FlowHook.sol",
              content: hookSource({
                cast: CAST_GOOD,
                record: RECORD_GOOD,
                permissions: ["beforeSwap"],
              }),
            },
          ],
          giveUp: false,
        },
        // The rewrite deployment validation asks for: the missing callback, nothing else.
        {
          content: hookSource({
            cast: CAST_GOOD,
            record: RECORD_GOOD,
            permissions,
          }),
          notes: ["Declared afterSwap, which the deployment mines the address for."],
        },
        TESTS,
      ]);

      reachedLaunch(job);

      const rewrite = calls.find(
        (call) => call.schemaName === "rewritten_contract",
      );
      expect(rewrite, "deployment validation never asked for a rewrite").toBeDefined();

      // It was handed the file as it stood — with both earlier fixes in it — rather than
      // being asked to produce the contract again from its declaration. This is the
      // assertion the live failure would have caught.
      expect(rewrite!.input).toContain("FeeVault(payable(feeVault_))");
      expect(rewrite!.input).toContain("recordSellFee(currency,");
      expect(rewrite!.input).toContain("Change as little as settles");

      // And the sibling's interface came with it, so the rewrite had no reason to guess
      // the name back to what it was.
      expect(rewrite!.input).toContain("recordSellFee(address currency, uint256 collectedFee)");

      // What actually shipped still has both fixes and the declared callbacks.
      const shipped = finalSource(job, "FlowHook");
      expect(shipped).toContain("FeeVault(payable(feeVault_))");
      expect(shipped).toContain("recordSellFee(currency,");
      expect(shipped).toContain("permissions.afterSwap = true;");

      // The deployment validation stage passed on the second pass rather than failing the
      // market, which is the whole difference.
      expect(job.stages.filter((entry) => entry.stage === Stage.DeploymentValidation).at(-1)?.status).toBe(
        "succeeded",
      );
    },
    600_000,
  );
});
