/**
 * What a benchmark run is doing right now.
 *
 * The run itself prints a line per prompt as it finishes, which is the wrong granularity for
 * something that takes an hour: a build can spend twenty minutes in deep validation and look
 * identical to one that hung. The job store is written at every stage transition, so reading it
 * says where each of the fifteen actually is.
 *
 * Usage:
 *   node scripts/bench-progress.ts              jobs touched in the last two hours
 *   node scripts/bench-progress.ts --since 30   jobs touched in the last thirty minutes
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const JOBS = resolve(import.meta.dirname, "../../../generated/_jobs");

const at = process.argv.indexOf("--since");
const minutes = at === -1 ? 120 : Number(process.argv[at + 1] ?? "120");
const since = Date.now() - minutes * 60_000;

interface Row {
  readonly symbol: string;
  readonly stage: string;
  readonly stages: number;
  readonly failure: string;
  readonly age: number;
}

const rows: Row[] = [];

for (const name of await readdir(JOBS)) {
  if (!name.endsWith(".json")) continue;

  const path = resolve(JOBS, name);
  const touched = (await stat(path)).mtimeMs;
  if (touched < since) continue;

  const job = JSON.parse(await readFile(path, "utf8")) as {
    symbol: string;
    stage: string;
    stages?: readonly unknown[];
    createdAt?: number;
    failure?: { code?: string } | null;
  };

  rows.push({
    symbol: job.symbol,
    stage: job.stage,
    stages: (job.stages ?? []).length,
    failure: job.failure?.code ?? "",
    // Seconds since the store last heard from it: a build that has gone quiet for a long time in
    // a stage that should be short is the one worth looking at.
    age: Math.round((Date.now() - touched) / 1_000),
  });
}

rows.sort((a, b) => a.symbol.localeCompare(b.symbol));

const done = rows.filter((row) => row.stage === "deployment_ready" || row.failure !== "");

console.log(`${String(rows.length)} jobs, ${String(done.length)} finished:\n`);
for (const row of rows) {
  console.log(
    `  ${row.symbol.padEnd(8)} ${row.stage.padEnd(24)} ${String(row.stages).padStart(2)} stages` +
      `  quiet ${String(row.age).padStart(4)}s  ${row.failure}`,
  );
}
