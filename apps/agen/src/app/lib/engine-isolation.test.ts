/**
 * That the engine-v1 path does not reach the generated-Solidity stack, across package lines.
 *
 * ## What this adds to the audit already in market-compiler
 *
 * `packages/market-compiler/src/engine/isolation.test.ts` walks the import graph inside that
 * package and proves the engine's three entry points cannot execute `engineer.ts`, `gates.ts`,
 * `oracle.ts` and the rest. That is the deeper half of the guarantee and it is not repeated
 * here.
 *
 * What it cannot see is the half that lives in this app. The compiler's public entry point is a
 * barrel that exports both engines, so *any* app module importing `@verdant/market-compiler`
 * transitively reaches every generation module, and an import-graph walk at this level would
 * fail on every file while proving nothing. The barrel is not the problem: what would be a
 * problem is an engine code path *calling* into generation.
 *
 * So this audits the call surface instead. For each module on the engine path, every value
 * imported from the compiler must be an engine symbol. Types are ignored — they erase, and the
 * job model is deliberately shared between the two engines.
 *
 * ## Why an allowlist rather than a denylist
 *
 * A denylist of generation functions passes the day somebody adds a new one. The engine's call
 * surface into the compiler is four symbols wide and has no reason to grow quietly, so the list
 * is the permitted side and an addition has to be justified here before it compiles anywhere.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");

/**
 * Every module that runs while an engine-v1 build is built, approved, launched or displayed.
 *
 * `queue.ts` is deliberately absent and is covered by `engine-routing.test.ts` instead. It is
 * the router: it imports both engines by design, and the property that matters there is which
 * branch an engine job takes, which is a question about control flow rather than imports.
 */
const ENGINE_PATH: readonly string[] = [
  "lib/engine-prove.ts",
  "lib/engine-launch.ts",
  "launch/engine-review.tsx",
  "launch/engine-outcome.tsx",
  "launch/engine-launch.tsx",
  "markets/[id]/mechanics.tsx",
];

/**
 * What the engine path may call in `@verdant/market-compiler`.
 *
 * Four symbols. `prepareLaunch` builds the typed calldata, `engineApprovalMessage` is the
 * preimage a creator signs, `runEngineBuild` is the pipeline and `engineVersionOf` reads which
 * engine built a job. None of them can write, compile, repair or judge Solidity.
 */
const PERMITTED_COMPILER_VALUES: readonly string[] = [
  "prepareLaunch",
  "engineApprovalMessage",
  "runEngineBuild",
  "engineVersionOf",
];

/**
 * Value imports from a package, with statement-level `import type` excluded.
 *
 * The distinction matters for the same reason it does in the compiler's own audit: under
 * `verbatimModuleSyntax` only a statement-level `import type` erases, so those are the only
 * ones treated as non-executing. An inline `{ type A }` still emits the import and is counted.
 */
function valueImportsFrom(file: string, packageName: string): readonly string[] {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const found: string[] = [];
  const pattern = new RegExp(
    String.raw`\bimport\s+(type\s+)?\{([^}]*)\}\s+from\s+["']${packageName}["']`,
    "g",
  );

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match[1] !== undefined) continue;

    for (const clause of (match[2] ?? "").split(",")) {
      const name = clause.trim();
      if (name === "" || name.startsWith("type ")) continue;

      // `a as b` imports `a`; the local name is irrelevant to what executes.
      found.push((name.split(/\s+as\s+/)[0] ?? name).trim());
    }
  }

  return found;
}

describe("the engine path's call surface into the compiler", () => {
  for (const module of ENGINE_PATH) {
    it(`${module} calls only engine entry points`, () => {
      const imported = valueImportsFrom(resolve(APP, module), "@verdant/market-compiler");

      for (const symbol of imported) {
        expect(
          PERMITTED_COMPILER_VALUES.includes(symbol),
          `${module} calls ${symbol}, which is not on the engine's permitted surface. If this ` +
            `is an engine entry point, add it to PERMITTED_COMPILER_VALUES and say why. If it ` +
            `is part of the generated-Solidity pipeline, the engine path must not reach it.`,
        ).toBe(true);
      }
    });
  }

  /*
   * A guard on the guard. If the extractor matched nothing — a changed import style, a broken
   * regex, a renamed package — every assertion above would pass vacuously.
   */
  it("is actually reading imports", () => {
    const surface = ENGINE_PATH.flatMap((module) =>
      valueImportsFrom(resolve(APP, module), "@verdant/market-compiler"),
    );

    expect(surface.length).toBeGreaterThan(0);
    expect(surface).toContain("prepareLaunch");
  });

  /*
   * And that the extractor can tell a value import from a type one, which is the distinction
   * the whole audit rests on. `engine-prove.ts` imports `PreparedLaunch` as a statement-level
   * type and nothing else from the compiler, so it must come back empty rather than reporting
   * a type as something that executes.
   */
  it("does not mistake a type import for a call", () => {
    expect(valueImportsFrom(resolve(APP, "lib/engine-prove.ts"), "@verdant/market-compiler")).toEqual(
      [],
    );
  });
});

describe("the engine path's own modules", () => {
  /*
   * Nothing on the engine path may name a generated-Solidity concept from this app either.
   * These are the app-side counterparts of the compiler's forbidden list: the modules that
   * exist to present, validate or launch a market whose contracts were written for it.
   */
  const GENERATED_APP_MODULES: readonly string[] = [
    "./launch", // engine 0's launch panel
    "./review", // engine 0's review screen
    "../lib/launch", // engine 0's launch preparation
    "./mechanics", // only the engine's own half of this file may be used, see below
  ];

  it("does not reuse engine 0's launch or review screens", () => {
    for (const module of ["launch/engine-review.tsx", "launch/engine-launch.tsx"]) {
      const source = readFileSync(resolve(APP, module), "utf8");

      for (const forbidden of GENERATED_APP_MODULES) {
        if (forbidden === "./mechanics") continue;

        expect(
          new RegExp(String.raw`from\s+["']${forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(
            source,
          ),
          `${module} imports ${forbidden}, which is engine 0's presentation of a generated market`,
        ).toBe(false);
      }
    }
  });

  /*
   * The engine's launch preparation must not go through engine 0's, which reads a manifest, a
   * specification and a semantic-coverage proof that an engine build does not have — and which
   * would refuse every engine market for lacking them, if it were ever reached.
   */
  it("prepares its launches through its own path", () => {
    const source = readFileSync(resolve(APP, "lib/engine-launch.ts"), "utf8");

    expect(source).not.toContain('from "./launch"');
    expect(source).toContain('from "@verdant/market-compiler"');
  });
});
