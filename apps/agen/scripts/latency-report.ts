#!/usr/bin/env node
/**
 * Where the pipeline's time goes, across every real build rather than one.
 *
 * A single waterfall is misleading in both directions. One build's planning taking four
 * minutes might be the stage or might be that morning's model; one build's compile
 * costing a second says nothing about the build that needed three repairs. The stages
 * worth optimising are the ones that are consistently expensive, and that only shows up
 * in aggregate.
 *
 * Only real-model builds count. Scripted runs have no latency worth measuring, and
 * builds that died in their first stage would drag every median toward zero, so a run
 * has to have reached code generation to be included.
 *
 *   node --experimental-strip-types scripts/latency-report.ts
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const JOBS = resolve(process.cwd(), "../../generated/_jobs");

interface StageRecord {
  readonly stage: string;
  readonly startedAt: number;
  readonly completedAt: number | null;
}

interface Exchange {
  readonly stage: string;
  readonly call?: string;
  readonly model: string;
  readonly durationMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

interface Job {
  readonly id: string;
  readonly symbol: string;
  readonly stage: string;
  readonly stages: readonly StageRecord[];
  readonly exchanges: readonly Exchange[];
  readonly failure: { readonly stage: string } | null;
}

const entries = (await readdir(JOBS)).filter((entry) => entry.endsWith(".json"));

const dated = await Promise.all(
  entries.map(async (entry) => ({ entry, at: (await stat(resolve(JOBS, entry))).mtimeMs })),
);
dated.sort((left, right) => left.at - right.at);

const all = await Promise.all(
  dated.map(async ({ entry }) => JSON.parse(await readFile(resolve(JOBS, entry), "utf8")) as Job),
);

const real = all.filter(
  (job) =>
    job.exchanges.length > 0 &&
    job.exchanges.some((exchange) => (exchange.durationMs ?? 0) > 2_000) &&
    job.stages.some((record) => record.stage === "code_generation"),
);

if (real.length === 0) {
  console.log("no real-model builds in the store");
  process.exit(0);
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** Seconds a stage cost in one build, summed over every attempt of it. */
function spent(job: Job, stage: string): number {
  return job.stages
    .filter((record) => record.stage === stage && record.completedAt !== null)
    .reduce((total, record) => total + (record.completedAt! - record.startedAt) * 1000, 0);
}

const STAGES: readonly string[] = [
  "interpreting",
  "architecture_planning",
  "code_generation",
  "compilation",
  "compilation_repair",
  "static_analysis",
  "test_generation",
  "test_execution",
  "test_repair",
  "deep_validation",
  "simulation",
  "final_validation",
];

console.log(`\n${String(real.length)} real builds: ${real.map((job) => `$${job.symbol}`).join(" ")}\n`);

console.log("STAGE                        median      worst     builds   share of median build");
console.log("-".repeat(84));

const medians = new Map<string, number>();
for (const stage of STAGES) {
  const measured = real.map((job) => spent(job, stage)).filter((value) => value > 0);
  if (measured.length === 0) continue;
  medians.set(stage, median(measured));
}

const wholeBuild = [...medians.values()].reduce((total, value) => total + value, 0);

for (const [stage, value] of [...medians].sort((left, right) => right[1] - left[1])) {
  const measured = real.map((job) => spent(job, stage)).filter((entry) => entry > 0);
  const share = wholeBuild === 0 ? 0 : Math.round((value / wholeBuild) * 100);
  const bar = "#".repeat(Math.round(share / 2));

  console.log(
    stage.padEnd(26) +
      seconds(value).padStart(9) +
      seconds(Math.max(...measured)).padStart(11) +
      String(measured.length).padStart(9) +
      `   ${String(share).padStart(3)}% ${bar}`,
  );
}

console.log("-".repeat(84));
console.log("median build".padEnd(26) + seconds(wholeBuild).padStart(9));

// --- the individual calls, which is where a stage's cost actually lives -------

console.log("\nMODEL CALLS (median across builds that made the call)\n");
console.log("CALL                              model          median    out tokens   calls");
console.log("-".repeat(84));

const byCall = new Map<string, { model: string; durations: number[]; output: number[] }>();

for (const job of real) {
  for (const exchange of job.exchanges) {
    const label = exchange.call === undefined ? exchange.stage : `${exchange.stage} · ${exchange.call}`;
    const seen = byCall.get(label) ?? { model: exchange.model, durations: [], output: [] };
    seen.durations.push(exchange.durationMs ?? 0);
    if (exchange.outputTokens !== null) seen.output.push(exchange.outputTokens);
    byCall.set(label, seen);
  }
}

const ranked = [...byCall].sort((left, right) => median(right[1].durations) - median(left[1].durations));

for (const [label, seen] of ranked.slice(0, 20)) {
  console.log(
    label.slice(0, 33).padEnd(34) +
      seen.model.padEnd(15) +
      seconds(median(seen.durations)).padStart(8) +
      String(Math.round(median(seen.output))).padStart(13) +
      String(seen.durations.length).padStart(8),
  );
}

// --- what a model was asked for versus what it was worth ---------------------

console.log("\nMODEL TIME BY ROLE\n");

const byModel = new Map<string, number[]>();
for (const job of real) {
  for (const exchange of job.exchanges) {
    byModel.set(exchange.model, [...(byModel.get(exchange.model) ?? []), exchange.durationMs ?? 0]);
  }
}

for (const [model, durations] of byModel) {
  const total = durations.reduce((sum, value) => sum + value, 0);
  console.log(
    `  ${model.padEnd(16)} ${String(durations.length).padStart(4)} calls   ` +
      `${seconds(total / real.length).padStart(8)} per build   median call ${seconds(median(durations))}`,
  );
}

console.log("");
