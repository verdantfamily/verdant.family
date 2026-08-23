/**
 * The engine-v1 path does not reach the generated-Solidity machinery. Proven by tracing the
 * import graph rather than by asserting it.
 *
 * A direct-imports check would pass trivially and prove almost nothing: the interesting way
 * for this to break is a module two or three hops away pulling in `engineer.ts` for one
 * helper, which drags the whole model-writes-Solidity apparatus into the engine's runtime.
 * So this walks the transitive closure of what the engine actually imports and fails naming
 * the path it found.
 *
 * The point is not tidiness. Engine v1's guarantee to a creator is that no code was
 * generated for their market, and a guarantee whose enforcement is "nobody has added the
 * import yet" is not one.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

/**
 * The modules that exist to make a model write Solidity, or to reason about what it wrote.
 *
 * Every one is still in the repository and still serves engine 0. None may appear anywhere in
 * engine v1's transitive imports.
 */
const GENERATED_SOLIDITY_MODULES: readonly string[] = [
  "engineer.ts",
  "prelude.ts",
  "context.ts",
  "gates.ts",
  "feemode.ts",
  "deployment-validation.ts",
  "test-environment.ts",
  "core-tests.ts",
  "oracle.ts",
  "workspace.ts",
  // Not on the brief's list, and pulled in for the same reason the others would be: they only
  // exist because a market's contracts are written per launch.
  "foundry.ts",
  "mechanical-repair.ts",
  "playbook.ts",
  "recovery.ts",
  "catalogue.ts",
  "contract-api.ts",
  "testapi.ts",
  "preflight.ts",
  "devbuy.ts",
];

/** The engine's own entry points. Everything reachable from these is engine-v1 runtime. */
const ENGINE_ENTRY_POINTS: readonly string[] = [
  "engine/pipeline.ts",
  "engine/interpret.ts",
  "engine/prepare.ts",
];

/**
 * Relative imports in a source file, split by whether they survive compilation.
 *
 * The distinction is the whole substance of this audit, and getting it wrong once already
 * made the check unpassable. `job.ts` is the shared job model: it describes engine 0's fields
 * as well as engine 1's, so it names `GateFinding`, `TestOutcome`, `GeneratedSource` and
 * `DeploymentSpecification` — and it names them with `import type`, which erases entirely.
 * Nothing from those modules can execute as a result, and demanding that engine v1 not even
 * *mention* their types would mean forking the job model, which would be a worse outcome
 * bought with a weaker guarantee.
 *
 * So `runtime` is what the guarantee is about: code that can run. `types` is reported
 * separately, because a type import is where a value import usually starts and it is worth
 * being able to see them.
 *
 * `verbatimModuleSyntax` is on in this repository, which is what makes the split reliable:
 * `import { type A } from "x"` still emits a side-effect import under it, so only a
 * statement-level `import type` / `export type` actually erases. Those are the two forms
 * treated as type-only below, and nothing else is.
 */
function importsOf(file: string): { readonly runtime: readonly string[]; readonly types: readonly string[] } {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return { runtime: [], types: [] };
  }

  const runtime: string[] = [];
  const types: string[] = [];

  // `import ... from "x"`, `export ... from "x"`, `import("x")`, with an optional `type` after
  // the keyword. Captured so the two can be told apart.
  const pattern = /\b(import|export)\s+(type\s+)?[^"';]*?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[3] ?? match[4];
    if (specifier === undefined || !specifier.startsWith(".")) continue;

    // Written as `.js` for ESM, resolved as `.ts` on disk.
    const resolved = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
    (match[2] === undefined ? runtime : types).push(resolved);
  }

  return { runtime, types };
}

/**
 * Every file whose code can execute when `entry` runs, with the path taken to reach each.
 *
 * Follows runtime imports only. A type-only edge is a dead end for reachability: nothing
 * beyond it is emitted, so nothing beyond it can run.
 */
function runtimeClosureOf(entry: string): ReadonlyMap<string, readonly string[]> {
  const reached = new Map<string, readonly string[]>();
  const queue: { readonly file: string; readonly path: readonly string[] }[] = [
    { file: resolve(SRC, entry), path: [entry] },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    if (reached.has(current.file)) continue;

    reached.set(current.file, current.path);

    for (const next of importsOf(current.file).runtime) {
      if (reached.has(next)) continue;
      queue.push({ file: next, path: [...current.path, next.slice(SRC.length + 1)] });
    }
  }

  return reached;
}

/** Type-only edges out of the runtime closure, for the record rather than for a verdict. */
function typeOnlyEdges(entry: string): readonly string[] {
  const edges: string[] = [];

  for (const [file, path] of runtimeClosureOf(entry)) {
    for (const type of importsOf(file).types) {
      for (const forbidden of GENERATED_SOLIDITY_MODULES) {
        if (type.endsWith(`/${forbidden}`)) {
          edges.push(`${forbidden} as a type via ${[...path, forbidden].join(" -> ")}`);
        }
      }
    }
  }

  return edges;
}

describe("engine v1 does not depend on generated Solidity", () => {
  for (const entry of ENGINE_ENTRY_POINTS) {
    it(`${entry} cannot execute any generation module`, () => {
      const offences: string[] = [];

      for (const [file, path] of runtimeClosureOf(entry)) {
        for (const forbidden of GENERATED_SOLIDITY_MODULES) {
          if (file.endsWith(`/${forbidden}`)) {
            offences.push(`${forbidden} via ${path.join(" -> ")}`);
          }
        }
      }

      expect(offences, offences.join("\n")).toHaveLength(0);
    });
  }

  it("traces chains, not just direct imports", () => {
    /*
     * A guard on the guard. If the walker stopped at an entry point's own import list it would
     * pass every assertion here while proving nothing.
     *
     * Demonstrated against engine 0's pipeline rather than the engine's, because that is where
     * depth actually exists — and the reason for that is itself the finding below.
     */
    const depths = [...runtimeClosureOf("pipeline.ts").values()].map((path) => path.length);

    expect(Math.max(...depths)).toBeGreaterThan(3);
  });

  it("has a runtime footprint shallow enough to read in one sitting", () => {
    /*
     * Worth asserting rather than merely noticing. Engine v1's whole runtime is its three own
     * modules plus the job model, the store interface and the model client — every path is one
     * hop from an entry point, because none of those pull anything else in at runtime.
     *
     * That is the structural reason the audit above passes and keeps passing: there is almost
     * no graph in which a generation module could hide. Engine 0's closure is an order of
     * magnitude larger, which is what makes its behaviour hard to reason about.
     */
    const engine = runtimeClosureOf("engine/pipeline.ts");
    const legacy = runtimeClosureOf("pipeline.ts");

    expect(engine.size).toBeLessThan(10);
    expect(engine.size * 4).toBeLessThan(legacy.size);
  });

  it("would catch a generation module if one were reachable", () => {
    // The walker is exercised against a module that genuinely does reach them, so a passing
    // result above means "not reachable" rather than "walker broken". `pipeline.ts` at the
    // package root is engine 0 and reaches most of the list at runtime.
    const found = [...runtimeClosureOf("pipeline.ts").keys()].filter((file) =>
      GENERATED_SOLIDITY_MODULES.some((forbidden) => file.endsWith(`/${forbidden}`)),
    );

    expect(found.length).toBeGreaterThan(5);
  });

  /*
   * The type-only edges, recorded rather than refused.
   *
   * `job.ts` is shared: it describes engine 0's fields as well as engine 1's, so it names
   * `GateFinding`, `TestOutcome`, `GeneratedSource` and `DeploymentSpecification` as types.
   * Those imports erase, so no code behind them can run — and forking the job model to avoid
   * mentioning them would buy a weaker guarantee at a higher price.
   *
   * What this test protects is that the set stays small and stays confined to `job.ts`. A type
   * edge appearing anywhere else in the engine is the first step toward a value import, and
   * worth failing on.
   */
  it("names its type-only edges, and they all come from the shared job model", () => {
    const edges = typeOnlyEdges("engine/pipeline.ts");

    for (const edge of edges) {
      expect(edge, `an engine module names a generation type outside job.ts: ${edge}`).toContain("job.ts");
    }
  });

  it("keeps the engine's runtime free of generation code, entry point by entry point", () => {
    for (const entry of ENGINE_ENTRY_POINTS) {
      const modules = [...runtimeClosureOf(entry).keys()].map((file) => file.slice(SRC.length + 1));

      expect(modules.length).toBeGreaterThan(0);
      for (const module of modules) {
        expect(
          GENERATED_SOLIDITY_MODULES.some((forbidden) => module.endsWith(forbidden)),
          `${entry} can execute ${module}`,
        ).toBe(false);
      }
    }
  });
});
