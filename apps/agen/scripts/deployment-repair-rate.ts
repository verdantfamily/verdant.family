#!/usr/bin/env node
/**
 * How often a build spends a round working out how to deploy itself.
 *
 * The number this reports is the one the declared deployment was built to remove. Before it,
 * a market's shape was recovered from its compiled contracts, and every architecture the
 * recovery guessed wrongly cost a repair round — or the whole build, at the point where the
 * creator was expecting a launch screen. The failures were not exotic: a vault owned by the
 * contract that accounts for it, a hook whose fee arrived through a setter the launch could
 * not call, a market with two destinations for its value.
 *
 * Read from the job records on disk rather than from a log, so the figures are whatever
 * actually happened on this machine and can be recomputed at any time.
 *
 * Usage:
 *   node --experimental-strip-types scripts/deployment-repair-rate.ts
 *   node --experimental-strip-types scripts/deployment-repair-rate.ts --since 2026-08-14
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const GENERATED_ROOT = resolve(process.cwd(), "../../generated");
const JOBS = resolve(GENERATED_ROOT, "_jobs");

interface StageRecord {
  readonly stage: string;
  readonly status: string;
  readonly detail?: string | null;
}

interface Job {
  readonly id: string;
  readonly createdAt: number;
  readonly symbol: string;
  readonly stage: string;
  readonly stages?: readonly StageRecord[];
  readonly harnessAttempts?: number | null;
  readonly compilationAttempts?: number | null;
  readonly testAttempts?: number | null;
  readonly failure?: { readonly code: string; readonly stage: string; readonly detail: string } | null;
  /** Present only on builds designed after the deployment became explicit. */
  readonly deployment?: unknown;
}

const since = (() => {
  const flag = process.argv.indexOf("--since");
  if (flag < 0) return 0;
  const parsed = Date.parse(`${process.argv[flag + 1] ?? ""}T00:00:00Z`);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
})();

const files = await readdir(JOBS).catch(() => {
  console.error(`no job records under ${JOBS}`);
  process.exit(1);
});

const jobs: Job[] = [];
for (const file of files) {
  if (!file.endsWith(".json")) continue;
  try {
    const job = JSON.parse(await readFile(resolve(JOBS, file), "utf8")) as Job;
    if ((job.createdAt ?? 0) >= since) jobs.push(job);
  } catch {
    // A half-written record is not a data point.
  }
}

jobs.sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));

if (jobs.length === 0) {
  console.error("no builds to report on");
  process.exit(1);
}

/**
 * Whether this build's deployment was declared or inferred.
 *
 * The only honest way to split before from after: a record carrying a deployment
 * specification was designed under the new pipeline, and one without it was not. Dates would
 * be a guess about when a change landed.
 */
const declared = jobs.filter((job) => job.deployment != null);
const inferred = jobs.filter((job) => job.deployment == null);

/**
 * Failures the launcher's guessing caused, as opposed to failures of the market.
 *
 * `UNDEPLOYABLE` and `HARNESS_INFRASTRUCTURE` at the fixture are the direct ones. A test
 * failure counts too when the fixture is what was wrong — a market that opened with its fees
 * unset fails its own behaviour tests, and three repair rounds go into tests that were
 * correct — so those are counted separately rather than folded in, because attributing them
 * requires reading the detail.
 */
function inferenceFailure(job: Job): boolean {
  const failure = job.failure;
  if (failure == null) return false;

  if (failure.code === "UNDEPLOYABLE" || failure.code === "HARNESS_INFRASTRUCTURE") return true;
  if (failure.code === "ARCHITECTURE_INCONSISTENT") return true;

  return false;
}

function fixtureShapedTestFailure(job: Job): boolean {
  const failure = job.failure;
  if (failure?.code !== "TESTS_UNREPAIRABLE") return false;

  // The two signatures a mis-built fixture leaves on a behaviour suite: an assertion that
  // read zero where the market promised a fee, and a repair that gave up naming the fixture.
  return /assertion failed: 0 !=|MarketTestBase|fixture|owner 0x/i.test(failure.detail);
}

function summarise(group: readonly Job[], label: string): void {
  if (group.length === 0) {
    console.log(`\n${label}: no builds`);
    return;
  }

  const ready = group.filter((job) => job.stage === "deployment_ready");
  const repairs = group.map((job) => job.harnessAttempts ?? 0);
  const spentARepair = repairs.filter((count) => count > 0).length;
  const inference = group.filter(inferenceFailure);
  const fixtureShaped = group.filter(fixtureShapedTestFailure);
  const percent = (count: number) => `${((count / group.length) * 100).toFixed(0)}%`;

  console.log(`\n${label}`);
  console.log(`  builds                          ${String(group.length)}`);
  console.log(`  reached deployment_ready        ${String(ready.length)} (${percent(ready.length)})`);
  console.log(
    `  spent a deployment repair       ${String(spentARepair)} (${percent(spentARepair)}), ` +
      `${String(repairs.reduce((total, count) => total + count, 0))} rounds in total`,
  );
  console.log(
    `  failed on the deployment        ${String(inference.length)} (${percent(inference.length)})`,
  );
  console.log(
    `  failed tests a fixture broke    ${String(fixtureShaped.length)} (${percent(fixtureShaped.length)})`,
  );

  const byCode = new Map<string, number>();
  for (const job of group) {
    if (job.failure == null) continue;
    const key = `${job.failure.stage} / ${job.failure.code}`;
    byCode.set(key, (byCode.get(key) ?? 0) + 1);
  }

  if (byCode.size > 0) {
    console.log("  failures:");
    for (const [key, count] of [...byCode].sort((left, right) => right[1] - left[1])) {
      console.log(`    ${String(count).padStart(3)}  ${key}`);
    }
  }
}

console.log("Deployment-repair rate, from the job records on disk.");
console.log(`Reading ${String(jobs.length)} builds from ${JOBS}`);

summarise(inferred, "BEFORE — deployment inferred from the compiled contracts");
summarise(declared, "AFTER — deployment declared by the architecture stage");

if (declared.length > 0 && inferred.length > 0) {
  const rate = (group: readonly Job[]) =>
    group.filter((job) => (job.harnessAttempts ?? 0) > 0 || inferenceFailure(job)).length / group.length;

  const before = rate(inferred);
  const after = rate(declared);

  console.log("\nBuilds touched by a deployment repair or a deployment failure:");
  console.log(`  before  ${(before * 100).toFixed(0)}%`);
  console.log(`  after   ${(after * 100).toFixed(0)}%`);
}

console.log(
  "\nA build in the AFTER group that spent a deployment repair is worth reading: it means an " +
    "architecture the declared deployment did not describe, which is a gap in the vocabulary " +
    "rather than a model having a bad day.",
);
