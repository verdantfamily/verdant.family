/**
 * That a launched engine market is visible in the product that made it.
 *
 * This is a regression test for a gap that had no error attached to it. `summaryFrom` refused
 * any build whose `specification` was null, which is every engine-v1 build — the canonical
 * configuration *is* their specification, and they carry no separate document. So an engine
 * market could be described, approved, launched and traded, and appear nowhere: not on the
 * discovery shelf, not on a market page, not in any listing. Nothing failed. It was simply
 * absent, which is the failure mode most likely to survive a test suite.
 *
 * The tests read the module's source rather than calling it because `markets.ts` is a server
 * module wired to a job store, a chain client and a feed. What is being asserted is structural
 * — which document each engine is described from — and that is legible in the source and stable
 * under the mocking it would otherwise take three fixtures to arrange.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const MARKETS = readFileSync(
  fileURLToPath(new URL("./markets.ts", import.meta.url)),
  "utf8",
);

/** The source with comments removed, so prose about a rule cannot pass for the rule. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

function functionText(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} is not in markets.ts`).toBeGreaterThan(-1);

  let depth = 0;
  let seen = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
      seen = true;
    } else if (character === "}") {
      depth -= 1;
      if (seen && depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error(`${signature} has no closing brace`);
}

describe("listing an engine market", () => {
  /*
   * The bug itself. A guard on `specification` is a guard on engine 0's document, and applying
   * it to every build is what made engine markets disappear. The summary may still refuse a
   * build it cannot describe — that check now lives in `mechanicsOf`, which knows about both
   * engines — but it must not refuse one for lacking a document its engine never produces.
   */
  it("does not drop a build for lacking engine 0's specification", () => {
    const body = functionText(code(MARKETS), "function summaryFrom");

    expect(body).not.toMatch(/job\.specification === null\s*\)\s*return null/);
    expect(body).toContain("mechanicsOf(job)");
  });

  it("describes each engine from the document that engine actually deploys", () => {
    const body = functionText(code(MARKETS), "function mechanicsOf");

    // Engine 1 from the engine's own summary, derived from the canonical configuration.
    expect(body).toContain("job.engineVersion === 1");
    expect(body).toContain("job.engine?.summary");

    // Engine 0 from the compiled specification, unchanged.
    expect(body).toContain("mechanicSummary(job.specification)");
  });

  /*
   * The honesty property. `contractCount` is drawn on a card as "how much bespoke code is
   * behind this market". For an engine market the answer is none, and reporting the engine-0
   * source count — or any non-zero number — would advertise code that was never written.
   */
  it("reports no contracts for a market that has none", () => {
    const body = functionText(code(MARKETS), "function summaryFrom");

    expect(body).toMatch(/contractCount:\s*job\.engineVersion === 1 \? 0/);
  });

  /*
   * The no-second-opinion property, which is the same invariant the review screen is held to.
   * A listing must not compute a rate, a threshold or a worst case: it renders what the engine
   * already derived. Anything else and a card can describe a market the chain does not run.
   */
  it("computes no economics of its own for an engine market", () => {
    const body = functionText(code(MARKETS), "function mechanicsOf");

    for (const forbidden of [/\bPPM\b/, /1e6/, /10n \*\* /, / \/ /, /Number\(BigInt/]) {
      expect(body, `mechanicsOf does the engine's arithmetic: ${String(forbidden)}`).not.toMatch(
        forbidden,
      );
    }

    // Every field it returns is either copied from the engine's summary or a constant that is
    // true of every engine market by construction.
    for (const copied of ["summary.headline", "summary.ruleCount", "summary.hasPhases"]) {
      expect(body).toContain(copied);
    }
  });

  /*
   * Supply comes from the launch arguments the commitment covers, not from engine 0's manifest,
   * which an engine build does not have. Getting this wrong shows every engine market with a
   * supply of zero and therefore a market capitalisation of zero — a number a reader would
   * take as a fact about the market rather than a fact about the code reading it.
   */
  it("reads supply from the engine's own launch arguments", () => {
    const body = functionText(code(MARKETS), "function supplyOf");

    expect(body).toContain("job.engineVersion === 1");
    expect(body).toContain("preparation");
    expect(body).toContain("job.launch === null ? 0 : Number(job.launch.supplyTokens)");
  });
});
