/**
 * Proving the pipeline is not shaped around one market.
 *
 * The claim being tested is architectural: the same code path takes two markets with no
 * mechanic in common and treats them identically, producing two isolated workspaces with
 * the same structure and different contents. That claim is testable without a model,
 * and it is the claim worth testing — a pipeline that has special-cased its demo fails
 * here regardless of how good its Solidity is.
 *
 * What is deliberately *not* faked: the generated contracts. Writing two hooks by hand
 * and asserting the pipeline copied them would test nothing and would be exactly the
 * "hardcoded implementation dressed as generation" this is supposed to rule out. The
 * end-to-end run against a live model is at the bottom of this file and skips itself,
 * loudly, when there is no key.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildContext } from "./context.js";
import { EPOCH, FIXTURES, SURCHARGE } from "./fixtures.js";
import { FailureCode, Stage } from "./job.js";
import { ModelError, openAiProvider, scriptedProvider } from "./model.js";
import { runBuild } from "./pipeline.js";
import { validateSpecification } from "./spec.js";
import { memoryJobStore } from "./store.js";
import { createJobWorkspace, LAYOUT } from "./workspace.js";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = resolve(here, "../../contracts/vendor");

let generatedRoot: string | null = null;

afterEach(async () => {
  if (generatedRoot !== null) await rm(generatedRoot, { recursive: true, force: true });
  generatedRoot = null;
});

async function scratch(): Promise<string> {
  generatedRoot = await mkdtemp(join(tmpdir(), "agen-generated-"));
  return generatedRoot;
}

describe("the two fixtures are genuinely different markets", () => {
  it("both describe coherent markets", () => {
    for (const fixture of FIXTURES) {
      expect(validateSpecification(fixture.specification), fixture.key).toEqual([]);
    }
  });

  it("share no rule, and each is triggered by something the other never sees", () => {
    // If this ever starts failing it means the fixtures have converged, and the
    // architectural claim they exist to test has quietly stopped being tested.
    //
    // Note what is *not* asserted: that they share no trigger at all. Both are trading
    // markets and both react to a buy, so demanding otherwise would be demanding an
    // unrealistic fixture rather than a different one. What matters is that each needs
    // machinery the other has no use for.
    const ruleIds = (fixture: typeof SURCHARGE) => fixture.specification.rules.map((rule) => rule.id);
    const triggers = (fixture: typeof SURCHARGE) =>
      new Set(fixture.specification.rules.map((rule) => rule.when.kind));

    expect(ruleIds(SURCHARGE).filter((id) => ruleIds(EPOCH).includes(id))).toEqual([]);

    const surcharge = triggers(SURCHARGE);
    const epoch = triggers(EPOCH);

    const onlySurcharge = [...surcharge].filter((kind) => !epoch.has(kind));
    const onlyEpoch = [...epoch].filter((kind) => !surcharge.has(kind));

    expect(onlySurcharge).toContain("sell");
    expect(onlySurcharge).toContain("volumeThreshold");
    expect(onlyEpoch).toContain("timeElapsed");
    expect(onlyEpoch).toContain("inactivity");
  });

  it("differ in the shape of their state, not merely its names", () => {
    const surchargeTypes = new Set(SURCHARGE.specification.state.map((entry) => entry.type));
    const epochTypes = new Set(EPOCH.specification.state.map((entry) => entry.type));

    // One is counters and accumulators; the other needs addresses and timers, which no
    // amount of counter arithmetic expresses.
    expect(epochTypes.has("address")).toBe(true);
    expect(epochTypes.has("timer")).toBe(true);
    expect(surchargeTypes.has("address")).toBe(false);
    expect(surchargeTypes.has("timer")).toBe(false);
  });

  it("only the epoch market needs a rule that fires when nothing happens", () => {
    const kinds = EPOCH.specification.rules.map((rule) => rule.when.kind);
    expect(kinds).toContain("inactivity");
    expect(SURCHARGE.specification.rules.map((rule) => rule.when.kind)).not.toContain("inactivity");
  });

  it("records that a timer cannot fire by itself, rather than pretending it can", () => {
    // The EVM has no way to wake up on a schedule, so a market described in terms of
    // "at the end of each hour" is being implemented differently from how it was
    // asked for, and a creator is entitled to see that.
    const settlement = EPOCH.specification.assumptions.find(
      (assumption) => assumption.id === "settlement-trigger",
    );

    expect(settlement?.importance).toBe("high");
    expect(settlement?.interpretation).toMatch(/lazily|cannot wake/i);
  });
});

describe("the workspace is isolated per job and identical in shape", () => {
  it("gives each market its own directory with the same layout", async () => {
    const root = await scratch();

    const workspaces = await Promise.all(
      FIXTURES.map((fixture) =>
        createJobWorkspace({ vendorRoot: VENDOR, generatedRoot: root, jobId: `job-${fixture.key}` }),
      ),
    );

    for (const workspace of workspaces) {
      const entries = (await readdir(workspace.root)).sort();
      expect(entries).toEqual([
        LAYOUT.artifacts,
        LAYOUT.contracts,
        LAYOUT.diagnostics,
        "foundry.toml",
        "remappings.txt",
        LAYOUT.scripts,
        LAYOUT.tests,
      ].sort());
    }

    // Two jobs, two directories, no shared state between them.
    expect(workspaces[0]!.root).not.toBe(workspaces[1]!.root);
    expect((await readdir(root)).sort()).toEqual(["job-epoch", "job-surcharge"]);
  });

  it("writes the specification and plan into the job directory", async () => {
    const root = await scratch();
    const workspace = await createJobWorkspace({
      vendorRoot: VENDOR,
      generatedRoot: root,
      jobId: "job-write",
    });

    await workspace.writeJson(LAYOUT.specification, SURCHARGE.specification);
    const written = JSON.parse(await readFile(workspace.paths.specification, "utf8")) as {
      symbol: string;
    };

    expect(written.symbol).toBe("CNPY");
  });

  it("refuses a job id that would escape the generated root", async () => {
    const root = await scratch();

    await expect(
      createJobWorkspace({ vendorRoot: VENDOR, generatedRoot: root, jobId: "../escape" }),
    ).rejects.toThrow(/url-safe/);
  });

  it("points the compiler at contracts/ rather than Foundry's default src/", async () => {
    const root = await scratch();
    const workspace = await createJobWorkspace({
      vendorRoot: VENDOR,
      generatedRoot: root,
      jobId: "job-config",
    });

    const config = await readFile(join(workspace.root, "foundry.toml"), "utf8");
    expect(config).toContain('src = "contracts"');
    expect(config).toContain('out = "artifacts/out"');
    // The security controls travel with every generated project, not just the first.
    expect(config).toContain("ffi = false");
    expect(config).toContain("ast = true");
  });
});

describe("the curated context describes this repository, not a remembered one", () => {
  it("resolves every import it advertises against the vendored tree", async () => {
    const context = await buildContext({ vendorRoot: VENDOR });

    // A path that has moved is the failure this file exists to prevent, and it would
    // otherwise be discovered once per generated market inside a repair loop.
    expect(context.generation).not.toContain("[MISSING]");
    expect(context.generation).toContain("v4-core/src/interfaces/IHooks.sol");
  });

  it("states the swap direction convention, which is the easiest thing to get backwards", async () => {
    const context = await buildContext({ vendorRoot: VENDOR });

    expect(context.generation).toContain("zeroForOne == true");
    expect(context.generation).toMatch(/a BUY/);
    expect(context.generation).toContain("OVERRIDE_FEE_FLAG");
  });

  it("warns that block.number is the L1 block on this chain", async () => {
    const context = await buildContext({ vendorRoot: VENDOR });
    expect(context.architecture).toMatch(/block\.number.*L1 block/s);
  });

  it("explains how a hook takes value, including the case that is easy to miss", async () => {
    const context = await buildContext({ vendorRoot: VENDOR });

    // Without this, generated mechanics increment counters and nobody can withdraw
    // anything — a ledger rather than a market.
    expect(context.generation).toContain("beforeSwapReturnDelta");
    expect(context.generation).toContain("poolManager.take");
    expect(context.generation).toContain("toBeforeSwapDelta");

    // The two things a model working from memory gets wrong.
    expect(context.generation).toMatch(/exact output/);
    expect(context.generation).toContain("CurrencyNotSettled");
    expect(context.generation).toMatch(/NOT a penny more|not extra input/);
  });

  it("tells the generator the constraints that are enforced mechanically", async () => {
    const context = await buildContext({ vendorRoot: VENDOR });

    for (const forbidden of ["inline assembly", "delegatecall", "selfdestruct", "tx.origin"]) {
      expect(context.generation).toContain(forbidden);
    }
  });
});

describe("the pipeline treats both markets the same way", () => {
  it("takes both to the same stage and fails identically when the model is absent", async () => {
    const root = await scratch();

    const runs = await Promise.all(
      FIXTURES.map(async (fixture) => {
        const provider = scriptedProvider([
          new ModelError("scripted", "interpreting", "no model endpoint is configured"),
        ]);

        return runBuild(
          { prompt: fixture.prompt, name: fixture.name, symbol: fixture.symbol },
          {
            provider,
            store: memoryJobStore(),
            vendorRoot: VENDOR,
            generatedRoot: root,
            newId: () => `job-${fixture.key}`,
          },
        );
      }),
    );

    // Same failure code, same stage, for two markets with nothing in common: the
    // pipeline is not branching on the market.
    for (const [index, job] of runs.entries()) {
      expect(job.failure?.code, FIXTURES[index]!.key).toBe(FailureCode.ModelUnavailable);
      expect(job.failure?.stage, FIXTURES[index]!.key).toBe(Stage.Interpreting);
    }

    // And each left its own directory behind for inspection.
    expect((await readdir(root)).sort()).toEqual(["job-epoch", "job-surcharge"]);
  });

  it("keeps the diagnostics of a failed build on disk", async () => {
    const root = await scratch();

    await runBuild(
      { prompt: SURCHARGE.prompt, name: SURCHARGE.name, symbol: SURCHARGE.symbol },
      {
        provider: scriptedProvider([new ModelError("scripted", "interpreting", "provider is down")]),
        store: memoryJobStore(),
        vendorRoot: VENDOR,
        generatedRoot: root,
        newId: () => "job-diagnostics",
      },
    );

    const written = JSON.parse(
      await readFile(join(root, "job-diagnostics", LAYOUT.diagnostics, "build.json"), "utf8"),
    ) as { jobId: string; compileAttempts: unknown[] };

    expect(written.jobId).toBe("job-diagnostics");
    expect(written.compileAttempts).toEqual([]);
  });
});

/**
 * The real thing, when there is a key for it.
 *
 * Skipped rather than mocked. A mocked version of this test would assert that a
 * recording still replays, which says nothing about whether the current prompts produce
 * Solidity that compiles — the only question this test exists to answer.
 */
const LIVE = process.env["OPENAI_API_KEY"];

describe.skipIf(LIVE === undefined || LIVE === "")("end to end against a live model", () => {
  for (const fixture of FIXTURES) {
    it(
      `generates, compiles and tests the ${fixture.key} market`,
      async () => {
        const root = await scratch();

        const job = await runBuild(
          { prompt: fixture.prompt, name: fixture.name, symbol: fixture.symbol },
          {
            provider: openAiProvider({
              apiKey: LIVE!,
              model: process.env["AGEN_MODEL"] ?? "gpt-5",
            }),
            store: memoryJobStore(),
            vendorRoot: VENDOR,
            generatedRoot: root,
            newId: () => `live-${fixture.key}`,
          },
        );

        // Reported in full on failure: which stage, why, and what the compiler said.
        if (job.failure !== null) {
          throw new Error(
            `${fixture.key} failed at ${job.failure.stage} (${job.failure.code}): ` +
              `${job.failure.detail}\n` +
              (job.failure.diagnostics ?? []).map((d) => `  ${d.message}`).join("\n"),
          );
        }

        expect(job.stage).toBe(Stage.DeploymentReady);
        expect(job.sources.length).toBeGreaterThan(0);
        expect(job.testOutcomes.every((outcome) => outcome.passed)).toBe(true);
      },
      // Generation, compilation, tests and up to six repair rounds.
      900_000,
    );
  }
});
