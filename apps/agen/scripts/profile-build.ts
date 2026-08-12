#!/usr/bin/env node
/**
 * Where a build spent its time.
 *
 * Reads a finished or half-finished job out of the store and prints the stage timeline
 * and every model call inside it. Separate from live-build.ts because the question
 * "why did that take twenty minutes" is usually asked after the run, often about a run
 * that was interrupted, and re-running to find out costs another twenty minutes.
 *
 * Stage timestamps are seconds and call durations are milliseconds, which is a wart of
 * the record rather than of this script; both are printed as seconds.
 *
 * Usage:
 *   node scripts/profile-build.ts            the most recent job
 *   node scripts/profile-build.ts <jobId>
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const GENERATED_ROOT = resolve(process.cwd(), "../../generated");
const JOBS = resolve(GENERATED_ROOT, "_jobs");

interface StageRecord {
  readonly stage: string;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly status: string;
  readonly detail: string | null;
  readonly attempt: number;
}

interface Exchange {
  readonly call?: string;
  readonly retries?: number;
  readonly stage: string;
  readonly model: string;
  readonly durationMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly rejected: string | null;
}

async function mostRecent(): Promise<string> {
  const entries = await readdir(JOBS);
  const times = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const { mtimeMs } = await (await import("node:fs/promises")).stat(resolve(JOBS, entry));
        return { entry, mtimeMs };
      }),
  );

  const newest = times.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (newest === undefined) throw new Error("no jobs in the store");
  return newest.entry.replace(/\.json$/, "");
}

const id = process.argv[2] ?? (await mostRecent());
const job = JSON.parse(await readFile(resolve(JOBS, `${id}.json`), "utf8")) as {
  symbol: string;
  name: string;
  stage: string;
  stages: StageRecord[];
  exchanges: Exchange[];
  failure: { code: string; stage: string; detail: string } | null;
};

const seconds = (value: number): string => `${(value / 1000).toFixed(1)}s`;

console.log(`\n${job.name} ($${job.symbol}) — ${job.stage}\n`);

console.log("STAGES");
let wall = 0;
for (const record of job.stages) {
  // Stage timestamps are whole seconds; a stage that starts and ends within one reads
  // as zero rather than as missing.
  const elapsed = record.completedAt === null ? null : (record.completedAt - record.startedAt) * 1000;
  if (elapsed !== null) wall += elapsed;

  const shown = elapsed === null ? "running" : seconds(elapsed);
  const attempt = record.attempt > 1 ? ` (attempt ${String(record.attempt)})` : "";
  console.log(`  ${(record.stage + attempt).padEnd(34)} ${record.status.padEnd(10)} ${shown.padStart(9)}`);
  if (record.detail !== null) console.log(`      ${record.detail.slice(0, 140)}`);
}

// The two numbers the product is judged on: how long until the creator sees their
// market, and how long until it may be deployed.
const reachedAt = (stage: string): number | null => {
  const record = job.stages.find((entry) => entry.stage === stage && entry.completedAt !== null);
  return record?.completedAt ?? null;
};

const start = job.stages[0]?.startedAt ?? null;
const toReview = start === null ? null : reachedAt("review_ready");
const toDeploy = start === null ? null : reachedAt("deployment_ready");

console.log(`\n  ${"wall clock".padEnd(34)} ${"".padEnd(10)} ${seconds(wall).padStart(9)}`);
if (toReview !== null && start !== null) {
  console.log(`  ${"TOTAL TO REVIEW".padEnd(34)} ${"".padEnd(10)} ${seconds((toReview - start) * 1000).padStart(9)}`);
}
if (toDeploy !== null && start !== null) {
  console.log(`  ${"TOTAL TO DEPLOYMENT READY".padEnd(34)} ${"".padEnd(10)} ${seconds((toDeploy - start) * 1000).padStart(9)}`);
}

console.log("\nMODEL CALLS");
const byStage = new Map<string, number>();
let modelTime = 0;

for (const exchange of job.exchanges) {
  const label = exchange.call === undefined ? exchange.stage : `${exchange.stage} · ${exchange.call}`;
  const duration = exchange.durationMs ?? 0;
  modelTime += duration;
  byStage.set(exchange.stage, (byStage.get(exchange.stage) ?? 0) + duration);

  console.log(
    `  ${label.slice(0, 42).padEnd(42)} ${exchange.model.padEnd(12)} ${seconds(duration).padStart(9)}` +
      ` ${String(exchange.inputTokens ?? "-").padStart(7)}in ${String(exchange.outputTokens ?? "-").padStart(7)}out` +
      (exchange.retries === undefined || exchange.retries === 0 ? "" : `  ${String(exchange.retries)} retries`) +
      (exchange.rejected === null ? "" : "  REJECTED"),
  );
}

console.log("\nMODEL TIME BY STAGE");
for (const [stage, total] of [...byStage].sort((left, right) => right[1] - left[1])) {
  const share = modelTime === 0 ? 0 : Math.round((total / modelTime) * 100);
  console.log(`  ${stage.padEnd(34)} ${seconds(total).padStart(9)}  ${String(share).padStart(3)}%`);
}

console.log(`\n  ${"model time".padEnd(34)} ${seconds(modelTime).padStart(9)} across ${String(job.exchanges.length)} calls`);
console.log(`  ${"time outside model calls".padEnd(34)} ${seconds(Math.max(0, wall - modelTime)).padStart(9)}\n`);

if (job.failure !== null) console.log(`FAILED at ${job.failure.stage}: ${job.failure.code}\n`);
