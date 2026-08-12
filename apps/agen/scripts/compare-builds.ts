#!/usr/bin/env node
/**
 * The same numbers for several markets, side by side.
 *
 * `profile-build.ts` answers "where did this build spend its time"; this answers "is the
 * pipeline getting better, and at what". One build's waterfall cannot tell you whether
 * six compile repairs is normal or a disaster, and the interesting failures so far have
 * all been visible only across runs — a wiring setter guarded in one build and not the
 * next, from the same prompt.
 *
 * Reads whatever is in the job store, newest first, one row per market symbol unless
 * asked for all of them.
 *
 *   node --experimental-strip-types scripts/compare-builds.ts PULSE EMBER STEP KING
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const JOBS = resolve(process.cwd(), "../../generated/_jobs");

interface StageRecord {
  readonly stage: string;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly status: string;
  readonly attempt: number;
  readonly detail: string | null;
}

interface Job {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly stage: string;
  readonly stages: readonly StageRecord[];
  readonly exchanges: readonly { readonly stage: string; readonly call?: string; readonly durationMs: number | null }[];
  readonly specification: { readonly rules: readonly unknown[]; readonly state: readonly unknown[] } | null;
  readonly plan: {
    readonly components: readonly { readonly contractName: string; readonly origin?: string; readonly role: string }[];
  } | null;
  readonly sources: readonly unknown[];
  readonly tests: readonly unknown[];
  readonly testOutcomes: readonly { readonly passed: boolean }[];
  readonly compilationAttempts: number;
  readonly testAttempts: number;
  readonly failure: { readonly code: string; readonly stage: string } | null;
}

async function jobs(): Promise<readonly Job[]> {
  const entries = (await readdir(JOBS)).filter((entry) => entry.endsWith(".json"));

  const dated = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      at: (await stat(resolve(JOBS, entry))).mtimeMs,
    })),
  );

  dated.sort((left, right) => right.at - left.at);

  return Promise.all(
    dated.map(async ({ entry }) => JSON.parse(await readFile(resolve(JOBS, entry), "utf8")) as Job),
  );
}

/** Seconds a stage took across every attempt of it, which is what a creator waited. */
function spent(job: Job, stage: string): number {
  return job.stages
    .filter((record) => record.stage === stage && record.completedAt !== null)
    .reduce((total, record) => total + (record.completedAt! - record.startedAt), 0);
}

function attempts(job: Job, stage: string): number {
  return job.stages.filter((record) => record.stage === stage).length;
}

const wanted = process.argv.slice(2).map((symbol) => symbol.toUpperCase());
const all = await jobs();

// Newest run per symbol: a symbol rebuilt five times while a defect was being chased
// should appear once, as it currently stands.
const latest = new Map<string, Job>();
for (const job of all) {
  if (!latest.has(job.symbol)) latest.set(job.symbol, job);
}

// A job id selects that exact run. Needed because "newest for this symbol" is the wrong
// answer while a defect is being chased: the newest PULSE was a run killed halfway, and
// the one worth comparing against is the one that finished.
const byId = new Map(all.map((job) => [job.id, job]));

const chosen =
  wanted.length === 0
    ? [...latest.values()]
    : wanted
        .map((token) => byId.get(token.toLowerCase()) ?? latest.get(token) ?? byId.get(token))
        .filter((job): job is Job => job !== undefined);

if (chosen.length === 0) {
  console.log("no builds found for those symbols");
  process.exit(0);
}

const seconds = (value: number): string => `${value.toFixed(0)}s`;

const rows: readonly { readonly label: string; readonly of: (job: Job) => string }[] = [
  { label: "status", of: (job) => (job.failure === null ? job.stage : `FAILED ${job.failure.stage}`) },
  { label: "rules", of: (job) => String(job.specification?.rules.length ?? 0) },
  { label: "state variables", of: (job) => String(job.specification?.state.length ?? 0) },
  {
    label: "effects repaired",
    of: (job) => {
      const detail = job.stages.find((record) => record.detail?.includes("filled in the effects"))?.detail;
      if (detail === undefined || detail === null) return "no";
      return /(\d+) rule/.exec(detail)?.[1] ?? "yes";
    },
  },
  { label: "interpretation", of: (job) => seconds(spent(job, "interpreting")) },
  { label: "planning", of: (job) => seconds(spent(job, "architecture_planning")) },
  { label: "components", of: (job) => String(job.plan?.components.length ?? 0) },
  {
    label: "reuse/extend/new",
    of: (job) => {
      const counts = { reuse: 0, extend: 0, generate: 0 } as Record<string, number>;
      for (const component of job.plan?.components ?? []) {
        counts[component.origin ?? "generate"] = (counts[component.origin ?? "generate"] ?? 0) + 1;
      }
      return `${String(counts["reuse"] ?? 0)}/${String(counts["extend"] ?? 0)}/${String(counts["generate"] ?? 0)}`;
    },
  },
  { label: "generation", of: (job) => seconds(spent(job, "code_generation")) },
  { label: "compile attempts", of: (job) => String(attempts(job, "compilation")) },
  { label: "compile repairs", of: (job) => String(job.compilationAttempts) },
  { label: "security repairs", of: (job) => String(attempts(job, "static_analysis")) },
  { label: "test files", of: (job) => String(job.tests.length) },
  {
    label: "tests passing",
    of: (job) =>
      job.testOutcomes.length === 0
        ? "0"
        : `${String(job.testOutcomes.filter((outcome) => outcome.passed).length)}/${String(job.testOutcomes.length)}`,
  },
  { label: "test repairs", of: (job) => String(job.testAttempts) },
  {
    label: "time to review",
    of: (job) => {
      const start = job.stages[0]?.startedAt ?? 0;
      const review = job.stages.find(
        (record) => record.stage === "review_ready" && record.completedAt !== null,
      )?.completedAt;
      return review === undefined || review === null ? "—" : seconds(review - start);
    },
  },
  {
    label: "total",
    of: (job) => {
      const start = job.stages[0]?.startedAt ?? 0;
      const last = job.stages.reduce(
        (latestAt, record) => Math.max(latestAt, record.completedAt ?? record.startedAt),
        start,
      );
      return seconds(last - start);
    },
  },
];

const width = Math.max(18, ...rows.map((row) => row.label.length + 2));
const column = 14;

console.log("");
console.log("".padEnd(width) + chosen.map((job) => `$${job.symbol}`.padStart(column)).join(""));
console.log("-".repeat(width + column * chosen.length));

for (const row of rows) {
  console.log(row.label.padEnd(width) + chosen.map((job) => row.of(job).padStart(column)).join(""));
}

console.log("");
for (const job of chosen) {
  const components = (job.plan?.components ?? [])
    .map((component) => `${component.contractName}${component.origin === undefined ? "" : ` (${component.origin})`}`)
    .join(", ");
  console.log(`$${job.symbol}  ${components || "no plan"}`);
}
console.log("");
