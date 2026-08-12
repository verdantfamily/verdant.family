/**
 * Artefacts, read out of a real compilation.
 *
 * The shape of Foundry's `out/` is somebody else's decision and changes between
 * versions, so a fixture of what it looked like once would test this file's memory
 * rather than its correctness. These compile and read.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { keccak256, toHex } from "viem";

import { hashSources, hashSpecification, readArtifacts } from "./artifacts.js";
import type { BuildDiagnostics } from "./diagnostics.js";
import {
  emptyDiagnostics,
  isConverging,
  summariseDiagnostics,
  withCompileAttempt,
  withRepair,
} from "./diagnostics.js";
import { SURCHARGE } from "./fixtures.js";
import { Stage } from "./job.js";
import { scriptedProvider } from "./model.js";
import { runBuild } from "./pipeline.js";
import { memoryJobStore } from "./store.js";
import { createJobWorkspace, LAYOUT } from "./workspace.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = resolve(here, "../../contracts/vendor");

let generatedRoot: string | null = null;

afterEach(async () => {
  if (generatedRoot !== null) await rm(generatedRoot, { recursive: true, force: true });
  generatedRoot = null;
});

beforeAll(async () => {
  await run("forge", ["--version"]).catch(() => {
    throw new Error("forge is not on the PATH");
  });
});

const VAULT = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract RewardVault {
    uint256 public balance;

    function credit(uint256 amount) external {
        balance += amount;
    }
}
`;

const HOOK = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RewardVault} from "./RewardVault.sol";

contract MarketHook {
    RewardVault public immutable vault;

    constructor(RewardVault vault_) {
        vault = vault_;
    }

    function feeFor(bool isBuy) external pure returns (uint24) {
        return isBuy ? 5_000 : 10_000;
    }
}
`;

describe("reading artefacts from a compilation", () => {
  it("keeps the generated contracts and ignores the vendored tree", async () => {
    generatedRoot = await mkdtemp(join(tmpdir(), "agen-artifacts-"));
    const workspace = await createJobWorkspace({
      vendorRoot: VENDOR,
      generatedRoot,
      jobId: "job-artifacts",
    });

    const sources = [
      { path: "contracts/RewardVault.sol", content: VAULT },
      { path: "contracts/MarketHook.sol", content: HOOK },
    ];
    await workspace.write(sources);
    await run("forge", ["build"], { cwd: workspace.root, maxBuffer: 64 * 1024 * 1024 });

    const artifacts = await readArtifacts({
      outDir: join(workspace.paths.artifacts, "out"),
      sources,
    });

    expect(artifacts.map((artifact) => artifact.contractName)).toEqual([
      "MarketHook",
      "RewardVault",
    ]);

    const hook = artifacts.find((artifact) => artifact.contractName === "MarketHook")!;
    expect(hook.sourcePath).toBe("contracts/MarketHook.sol");
    expect(hook.bytecode.startsWith("0x")).toBe(true);
    expect(hook.bytecode.length).toBeGreaterThan(2);
    expect(hook.deployedBytecode.length).toBeGreaterThan(2);
    expect(hook.compilerVersion).toMatch(/^0\.8\.26\+commit\./);
    expect(hook.abi.some((entry) => "name" in entry && entry.name === "feeFor")).toBe(true);
    // The hash binds the artefact to the exact text it was compiled from, which is what
    // lets a later audit tell a reviewed contract from a substituted one.
    expect(hook.sourceHash).toBe(keccak256(toHex(HOOK)));
    expect(hook.source).toBe(HOOK);
  });

  it("hashes a source set stably regardless of the order it arrives in", () => {
    const forward = hashSources([
      { path: "contracts/A.sol", content: "a" },
      { path: "contracts/B.sol", content: "b" },
    ]);
    const backward = hashSources([
      { path: "contracts/B.sol", content: "b" },
      { path: "contracts/A.sol", content: "a" },
    ]);

    expect(backward).toBe(forward);

    // And changes when any byte does, which is the property the manifest relies on.
    const altered = hashSources([
      { path: "contracts/A.sol", content: "a " },
      { path: "contracts/B.sol", content: "b" },
    ]);
    expect(altered).not.toBe(forward);
  });

  it("binds a specification to a hash that changes with it", () => {
    const original = hashSpecification(SURCHARGE.specification);
    const edited = hashSpecification({ ...SURCHARGE.specification, baseFeePpm: 2_500 });

    expect(edited).not.toBe(original);
  });
});

describe("artefacts are written only for a build that was cleared", () => {
  it("writes ABI, bytecode, hashes and test results after every gate passes", async () => {
    generatedRoot = await mkdtemp(join(tmpdir(), "agen-artifacts-"));

    const hook = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract StreakHook {
    uint256 public consecutiveBuys;

    function onSwap(bool isBuy) external returns (uint24) {
        if (!isBuy) {
            consecutiveBuys = 0;
            return 5_000;
        }
        consecutiveBuys += 1;
        return consecutiveBuys >= 10 ? 0 : 5_000;
    }
}
`;

    const suite = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StreakHook} from "../contracts/StreakHook.sol";

contract StreakHookTest is Test {
    StreakHook hook;

    function setUp() public {
        hook = new StreakHook();
    }

    function test_feeCeiling_holds() public {
        assertLe(hook.onSwap(true), 30_000);
    }
}
`;

    const job = await runBuild(
      { prompt: "streak", name: "Canopy", symbol: "CNPY" },
      {
        provider: scriptedProvider([
          // Interpretation is four calls: what the market does, the rules formalising
          // it, the frame around them, and the critique that runs beside the frame.
          { behaviours: ["every tenth buy is free"] },
          {
            summary: "Every tenth buy is free",
            rules: [
              {
                id: "streak",
                title: "STREAK",
                when: { kind: "buy", description: "a buy", parameters: null },
                conditions: [],
                then: [
                  { kind: "waiveFee", description: "free", parameters: null, writes: ["consecutiveBuys"] },
                ],
                activeInPhases: [],
                onceOnly: false,
              },
            ],
          },
          {
            baseFeePpm: 5_000,
            maxFeePpm: 5_000,
            phases: [],
            state: [
              { name: "consecutiveBuys", type: "counter", description: "buys since a sell", writeOnce: false },
            ],
            invariants: [{ id: "fee-ceiling", statement: "never above 3%", expression: null }],
            externalDependencies: [],
            assumptions: [],
            ambiguities: [],
            unsupported: [],
          },
          { suggestions: [] },
          // Planning is two calls: what is already solved, then what to build.
          { reuse: [{ catalogueId: "base-hook", why: "it needs a hook" }], novel: [] },
          {
            approach: "one hook",
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
                purpose: "counts buys",
                requiredBy: ["streak"],
                reuses: ["base-hook"],
                dependsOn: [],
                hookPermissions: ["beforeSwap"],
                custodial: false,
                implementationNotes: [],
              },
            ],
            dependencies: [],
            adaptations: [],
          },
          { content: hook, notes: [] },
          { files: [{ path: "test/StreakHook.t.sol", content: suite }], notes: [] },
        ]),
        store: memoryJobStore(),
        vendorRoot: VENDOR,
        generatedRoot,
        newId: () => "job-cleared",
      },
    );

    expect(job.stage).toBe(Stage.DeploymentReady);

    const artifacts = JSON.parse(
      await readFile(join(generatedRoot, "job-cleared", LAYOUT.artifacts, "build.json"), "utf8"),
    ) as {
      contracts: { contractName: string; abi: unknown[]; bytecode: string; compilerVersion: string }[];
      implementationHash: string;
      specificationHash: string;
      toolchain: { solcVersion: string };
      tests: { passed: number; failed: number };
    };

    // Both components: the hook the model wrote and the token Agen wrote itself.
    expect(artifacts.contracts.map((entry) => entry.contractName).sort()).toEqual([
      "StreakHook",
      "StreakToken",
    ]);

    const built = artifacts.contracts.find((entry) => entry.contractName === "StreakHook")!;
    expect(built.abi.length).toBeGreaterThan(0);
    expect(built.bytecode.length).toBeGreaterThan(2);
    expect(built.compilerVersion).toContain("0.8.26");
    expect(artifacts.implementationHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(artifacts.specificationHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(artifacts.toolchain.solcVersion).toBe("0.8.26");
    expect(artifacts.tests.passed).toBeGreaterThan(0);
    expect(artifacts.tests.failed).toBe(0);

    // The specification and plan sit beside them, so the directory is self-describing.
    const specification = JSON.parse(
      await readFile(join(generatedRoot, "job-cleared", LAYOUT.specification), "utf8"),
    ) as { symbol: string };
    expect(specification.symbol).toBe("CNPY");
  });

  it("writes no artefacts for a build that failed", async () => {
    generatedRoot = await mkdtemp(join(tmpdir(), "agen-artifacts-"));

    const job = await runBuild(
      { prompt: "streak", name: "Canopy", symbol: "CNPY" },
      {
        provider: scriptedProvider([{ summary: "", rules: [] }]),
        store: memoryJobStore(),
        vendorRoot: VENDOR,
        generatedRoot,
        newId: () => "job-failed",
      },
    );

    expect(job.failure).not.toBeNull();

    // An artefacts file that exists is evidence a build was cleared. A failed build
    // leaving one behind would make that evidence worthless.
    await expect(
      readFile(join(generatedRoot, "job-failed", LAYOUT.artifacts, "build.json"), "utf8"),
    ).rejects.toThrow();

    // The diagnostics, however, survive: they are the only way to see what happened.
    const diagnostics = await readFile(
      join(generatedRoot, "job-failed", LAYOUT.diagnostics, "build.json"),
      "utf8",
    );
    expect(JSON.parse(diagnostics)).toMatchObject({ jobId: "job-failed" });
  });
});

describe("the diagnostics record", () => {
  function attempt(errors: readonly { code: string; line: number }[], index: number) {
    return {
      attempt: index,
      at: 1_000 + index,
      durationMs: 100,
      ok: errors.length === 0,
      errorCount: errors.length,
      warningCount: 0,
      errors: errors.map((error) => ({
        severity: "error" as const,
        type: "TypeError",
        code: error.code,
        file: "contracts/Hook.sol",
        line: error.line,
        column: 1,
        message: "something",
        excerpt: null,
      })),
    };
  }

  it("notices when a repair loop stops making progress", () => {
    let diagnostics: BuildDiagnostics = emptyDiagnostics("job-1");
    diagnostics = withCompileAttempt(diagnostics, attempt([{ code: "1", line: 10 }], 0));

    // One attempt: nothing to compare against yet.
    expect(isConverging(diagnostics)).toBe(true);

    diagnostics = withCompileAttempt(diagnostics, attempt([{ code: "2", line: 20 }], 1));
    expect(isConverging(diagnostics)).toBe(true);

    // The same error in the same place twice running: the model is going in circles,
    // and one more round will produce the same thing.
    diagnostics = withCompileAttempt(diagnostics, attempt([{ code: "2", line: 20 }], 2));
    expect(isConverging(diagnostics)).toBe(false);
  });

  it("summarises a build in a line", () => {
    let diagnostics: BuildDiagnostics = emptyDiagnostics("job-1");
    diagnostics = withCompileAttempt(diagnostics, attempt([{ code: "1", line: 10 }], 0));
    diagnostics = withCompileAttempt(diagnostics, attempt([], 1));
    diagnostics = withRepair(diagnostics, {
      attempt: 1,
      at: 1_001,
      kind: "compilation",
      diagnosis: "missing import",
      files: ["contracts/Hook.sol"],
      gaveUp: false,
    });

    expect(summariseDiagnostics(diagnostics)).toBe("2 compiles, 0 test runs, 1 repair");
  });
});
