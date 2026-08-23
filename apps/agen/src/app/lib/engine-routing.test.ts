/**
 * That an engine-v1 build stays an engine-v1 build.
 *
 * Two properties, both structural rather than behavioural, and both about what the app is
 * forbidden from doing rather than what it does:
 *
 *  1. **No fallback into generated Solidity.** An engine-v1 job that cannot proceed must fail
 *     visibly. It must never be handed to `runBuild`, which would write a contract the creator
 *     was never shown and launch economics they never approved. This is the one property the
 *     architecture cannot recover from getting wrong, because the result is a live market.
 *  2. **The engine version is decided once.** A job carries the pipeline it was submitted
 *     under. Flipping the flag mid-build must not reinterpret a job already running, and an
 *     engine-0 job must never be read as an engine-v1 one.
 *
 * Asserted against the source rather than by running a build, deliberately. Running one needs a
 * model, a chain and a deployed factory; the property is about which function is reachable from
 * which branch, which is decidable by reading — and a test that needs a chain is a test that
 * gets skipped on the machine where the mistake is made.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const QUEUE = readFileSync(fileURLToPath(new URL("./queue.ts", import.meta.url)), "utf8");

/** Comments describe the rule; the code has to follow it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * One function's text, brace-matched from its declaration.
 *
 * Matched rather than sliced to the next `}` at column zero, which the first version did and
 * which was wrong for exactly the functions here: a destructured parameter list closes with
 * `}: {` in column zero, so the slice ended before the body began and the assertions passed
 * vacuously.
 */
function functionText(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `${declaration} has moved or been renamed`).toBeGreaterThan(-1);

  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;

  for (let at = open; at < source.length; at++) {
    if (source[at] === "{") depth++;
    if (source[at] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, at + 1);
    }
  }

  throw new Error(`${declaration} is unbalanced`);
}

/**
 * The body of the branch that runs a build, from the `try` to its `catch`.
 *
 * Narrowed to that because the file legitimately mentions both pipelines — it imports both and
 * routes between them — and the property is about which one a given job can reach.
 */
function dispatch(): string {
  const body = code(QUEUE);
  const start = body.indexOf("const finished =");
  expect(start, "the dispatch in execute() has moved").toBeGreaterThan(-1);

  return body.slice(start, body.indexOf("} catch", start));
}

describe("engine routing", () => {
  /*
   * The generated-Solidity entry points, and every engine-v1 branch must be upstream of the
   * test that excludes them. If `runEngineJob` ever appears after a `runBuild` in the same
   * conditional chain, an engine-v1 job could reach the generator.
   */
  it("tests the engine version before anything that generates Solidity", () => {
    const branch = dispatch();

    const engine = branch.indexOf("runEngineJob");
    expect(engine, "engine-v1 builds must be dispatched").toBeGreaterThan(-1);

    for (const generator of ["runBuild", "answerBuild", "decideBuild"]) {
      const at = branch.indexOf(generator);
      if (at === -1) continue;

      expect(
        engine,
        `${generator} is reachable before the engine-version check, so an engine-v1 job could ` +
          `be handed to the generated-Solidity pipeline`,
      ).toBeLessThan(at);
    }
  });

  it("dispatches on the stamped version rather than on which artefacts exist", () => {
    const branch = dispatch();

    expect(branch).toContain("job.engineVersion === 1");
    // Sniffing artefacts is the failure mode this replaces: a job that failed before
    // interpretation has neither a specification nor a configuration, so absence decides
    // nothing and would silently pick the wrong pipeline exactly when there is least to go on.
    expect(branch).not.toContain("job.engine !==");
    expect(branch).not.toContain("job.specification");
  });

  /*
   * The engine-unavailable path. It is the one place a fallback would be tempting — the engine
   * is undeployed, the other pipeline works, the creator is waiting — and it is exactly where a
   * fallback would be worst, because nothing would tell them which market they got.
   */
  it("fails an engine-v1 build outright when the engine is unavailable", () => {
    const fn = functionText(code(QUEUE), "async function runEngineJob");

    expect(fn).toContain("Stage.Failed");
    expect(fn, "an unavailable engine must not fall through to the generator").not.toContain(
      "runBuild",
    );
    expect(fn).not.toContain("engineVersion: 0");
  });

  /*
   * `runEngineBuild`, never `runEngineBuildForTest`. The distinction is the launchability
   * proof: the test-only entry point is the only one that may omit it, so a job it produces has
   * reached `deployment_ready` without anything having established that its transaction works.
   */
  it("uses the entry point that requires a launchability proof", () => {
    const body = code(QUEUE);

    expect(body).toContain("runEngineBuild(");
    expect(body).toContain("proveLaunchable");
    expect(body, "the app must not use the test-only entry point").not.toContain(
      "runEngineBuildForTest",
    );
  });

  it("stamps the engine version at submission and never rewrites it", () => {
    const body = code(QUEUE);

    expect(body).toContain("engineVersion: engineVersionForNewBuilds()");

    // One assignment, in `newJob`. A second would be a build whose pipeline changed under it.
    expect([...body.matchAll(/engineVersion:/g)]).toHaveLength(1);
  });

  /*
   * The flag alone is not enough. Routing to a factory with no code at it spends a model call
   * to fail at preparation, and the creator gets a failed build for an operator's mistake.
   */
  it("requires the engine to be deployed, not merely switched on", () => {
    const fn = functionText(code(QUEUE), "function engineVersionForNewBuilds");

    expect(fn).toContain("ENGINE_V1_ENABLED");
    expect(fn).toContain("engineAddressesOrNull()");
  });
});
