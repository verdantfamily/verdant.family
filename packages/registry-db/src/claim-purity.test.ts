/**
 * That eligibility can only ever be the earliest market's creator.
 *
 * `programs.author_address` and `program_markets.creator` look like the same fact and are not. The
 * first is written first-write-wins by `saveProgram`, so it records whichever market was *observed*
 * first; the second records who launched a particular market. They agree on the live population,
 * because each Program there has one market, and they diverge precisely when two people launched
 * identical economics — which is the case decision 2 exists for and the case acceptance test 5
 * checks.
 *
 * `claims.test.ts` covers the behaviour: with the earliest market's creator nulled, every claim is
 * refused, including one from an author whose creator *is* known. But a behavioural test only shows
 * that for the inputs somebody thought of. What would defeat it is a later edit adding
 * `?? program.author_address` as a kindness — a one-line change that looks like robustness, leaves
 * that test passing for every Program whose two authors happen to agree, and silently hands a
 * contested Program to the wrong address.
 *
 * So this is a check on the source. If the claim path cannot name the column, there is no input for
 * which it could read it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** The modules that decide who may name a Program. */
const CLAIM_PATH = ["claims.ts"] as const;

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const modules = CLAIM_PATH.map((name) => {
  const source = readFileSync(join(here, name), "utf8");
  return { name, source, code: code(source) };
});

describe("the claim path cannot read author_address", () => {
  it("finds the claim path to check, so the assertions below are not vacuous", () => {
    expect(modules).toHaveLength(CLAIM_PATH.length);
    for (const module of modules) {
      expect(module.source.length).toBeGreaterThan(0);
    }
  });

  it("names neither the column nor the field", () => {
    const offenders = modules.flatMap((module) =>
      ["author_address", "authorAddress"]
        .filter((name) => module.code.includes(name))
        .map((name) => `${module.name} references "${name}"`),
    );

    expect(offenders).toEqual([]);
  });

  it("reads authorship only from program_markets.creator", () => {
    /*
     * The positive half. Forbidding one column would be satisfied by a file that read authorship
     * from somewhere else entirely, so the source of the answer is asserted as well as its absence.
     */
    const claims = modules.find(({ name }) => name === "claims.ts");
    expect(claims).toBeDefined();
    expect(claims?.code).toMatch(/programMarkets\.creator/);
  });

  it("orders eligibility by launch block", () => {
    // "Earliest by block" is the rule. An eligibility query that dropped the ordering would return
    // whichever row the planner happened to hand back, which is the first-write-wins behaviour this
    // whole arrangement exists to avoid — arrived at by accident instead of by a column name.
    const claims = modules.find(({ name }) => name === "claims.ts");
    expect(claims?.code).toMatch(/asc\(\s*programMarkets\.launchBlock\s*\)/);
  });

  it("has no fallback operator on the eligibility result", () => {
    /*
     * A `??` or an `||` applied to the recovered creator is the shape the mistake would take. The
     * creator is read into a checked branch that refuses when it is null, and that branch is the
     * only thing standing between an unknown author and a wrong one.
     */
    const claims = modules.find(({ name }) => name === "claims.ts");
    const fallbacks = [...(claims?.code.matchAll(/creator\s*(?:\?\?|\|\|)/g) ?? [])].map(
      (match) => match[0],
    );

    expect(fallbacks).toEqual([]);
  });
});
