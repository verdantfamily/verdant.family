/**
 * Whether the same prompt gets the same answer twice.
 *
 * The benchmark measures how many markets reach a launch. This measures something the score
 * cannot say on its own: whether the number means anything. A run of 6/15 where the six are the
 * same six every time is a compiler with three known gaps. A run of 6/15 where the six are a
 * different six each time is a lottery, and the gaps are unknown — the second is much worse, and
 * both look identical in the summary.
 *
 * So this reads several runs of the identical prompt set and asks, per prompt, whether the
 * outcome held. A prompt only counts as reliable if every run agreed.
 *
 * ## Where variance is attributed
 *
 * To the stage the outcomes disagree at. If a prompt reaches `deployment_ready` once and fails
 * at `test_generation` the next time, something before or at test generation answered
 * differently, and the only thing in this pipeline that can answer differently to identical
 * input is a model. That is the distinction the report makes:
 *
 *   - a stage prompts *flip* at is model nondeterminism surfacing there, whether the model is
 *     wrong or the stage is merely intolerant of a second correct answer;
 *   - a stage every run fails at with the same code is deterministic — a compiler or runtime
 *     gap, or a market Agen genuinely does not support.
 *
 * The second kind is the honest kind: it can be reproduced, diagnosed and fixed. The first kind
 * is what has to be driven out before a score is worth quoting.
 *
 * ## Where the divergence starts
 *
 * A stage is where an outcome *ended up*, which is not the same as where the runs started to
 * differ. So each prompt's artefacts are compared across runs as well: the locked specification,
 * the generated Solidity, and the generated tests. That separates the three questions worth
 * asking separately —
 *
 *   - identical prompt, different specification: interpretation is where the variance enters, and
 *     everything downstream is building a different market;
 *   - identical specification, different Solidity: interpretation held and generation drifted;
 *   - identical specification and Solidity, different tests: the market is reproducible and only
 *     the suite written to judge it is not, which is the cheapest kind to be left with.
 *
 * Compared by content hash, and only for prompts with an artefact in more than one run. Equality
 * is stricter than it needs to be — two specifications can differ in wording and describe the
 * same market — so a difference reported here is a question to look at, not a verdict.
 *
 * Usage:
 *   node scripts/repeatability.ts                    the last 3 runs of the production provider
 *   node scripts/repeatability.ts --runs 4           the last 4
 *   node scripts/repeatability.ts --driver anthropic runs driven by Claude
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Behaviour, MarketSpecification } from "@verdant/market-compiler";
import { behaviour, claimDifferences, divergences } from "@verdant/market-compiler";

const GENERATED = resolve(import.meta.dirname, "../../../generated");
const ROOT = resolve(GENERATED, "_benchmarks");
const JOBS = resolve(GENERATED, "_jobs");

const argument = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};

const runs = Number(argument("runs", "3"));
const driver = argument("driver", "openai");

interface Result {
  readonly symbol: string;
  readonly jobId: string;
  readonly register: string;
  readonly launched: boolean;
  readonly stage: string;
  readonly failureStage: string | null;
  readonly failureCode: string | null;
  readonly seconds: number;
  readonly misread: readonly string[];
}

interface Run {
  readonly at: string;
  readonly driver: string;
  readonly launched: number;
  readonly total: number;
  readonly results: readonly Result[];
}

/**
 * What happened to one prompt, as a string two runs can be compared on.
 *
 * A clarification is its own outcome rather than a failure: a market Agen asked a question about
 * is not a market it got wrong, and a prompt that asks for a question every time is repeatable.
 */
function outcomeOf(result: Result): string | null {
  if (result.launched) return result.misread.length === 0 ? "ready" : "ready (fee misread)";
  if (result.stage === "awaiting_clarification") return "clarify";

  // A vendor that could not be reached said nothing about the market, so it is not an
  // observation. Counting it would report an exhausted balance as a pipeline that flips.
  if (result.failureCode === "MODEL_UNAVAILABLE") return null;

  return `failed at ${result.failureStage ?? "?"} (${result.failureCode ?? "?"})`;
}

/** A short content hash, which is all that is needed to say "the same" or "not the same". */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

/**
 * What a build produced, as three hashes.
 *
 * From the job store rather than the workspace, because that is the record of what the build
 * actually accepted at each stage. A job whose record is gone is silence, not a difference.
 */
interface Artefacts {
  readonly specification: string | null;
  /**
   * The market the specification describes, field by field, as opposed to how it was written.
   *
   * Kept as separate fields rather than one hash so the report can say what moved. "The
   * specification differs" is true of any two model answers and says nothing useful; "the fee
   * changed" and "the rules were named differently" are different findings with different fixes.
   */
  readonly market: Behaviour | null;
  readonly sources: string | null;
  readonly tests: string | null;
}

async function artefactsOf(jobId: string): Promise<Artefacts | null> {
  if (jobId === "") return null;

  let job: {
    specification?: MarketSpecification | null;
    sources?: readonly { readonly path: string; readonly content: string }[];
    tests?: readonly { readonly path: string; readonly content: string }[];
  };
  try {
    job = JSON.parse(await readFile(resolve(JOBS, `${jobId}.json`), "utf8"));
  } catch {
    return null;
  }

  const sources = job.sources ?? [];
  const tests = job.tests ?? [];

  const specification = job.specification ?? null;

  return {
    specification: specification === null ? null : digest(specification),
    /*
     * What the market does, rather than how the specification says it.
     *
     * This started as names and counts, and it could not tell a renamed rule from a changed fee: it
     * reported eleven of twelve prompts as unstable, nearly all of it wording, which is a finding
     * that sends you to fix the wrong stage. `behaviour` compares fees, what each side of a trade
     * experiences, thresholds, where value ends up, phase boundaries and state transitions, and
     * treats one rule on any trade as equal to a buy rule and a sell rule that say the same thing.
     */
    market: specification === null ? null : behaviour(specification),
    // Paths and contents, sorted, so a file written in a different order is not a difference.
    sources: sources.length === 0 ? null : digest([...sources].map((file) => [file.path, file.content]).sort()),
    tests: tests.length === 0 ? null : digest([...tests].map((file) => [file.path, file.content]).sort()),
  };
}

const files = (await readdir(ROOT)).filter((name) => name.endsWith(".json")).sort();

const loaded: Run[] = [];
for (const name of [...files].reverse()) {
  const run = JSON.parse(await readFile(resolve(ROOT, name), "utf8")) as Run;
  if (run.driver !== driver) continue;
  loaded.push(run);
  if (loaded.length === runs) break;
}

const compared = [...loaded].reverse();

if (compared.length < 2) {
  console.log(
    `Only ${String(compared.length)} run of the ${driver} provider on record. ` +
      "Repeatability needs at least two.",
  );
  process.exit(0);
}

console.log(`${String(compared.length)} runs, driven by ${driver}:`);
for (const run of compared) {
  console.log(
    `  ${run.at}  ${String(run.launched)}/${String(run.total)} launched`,
  );
}

const symbols = [...new Set(compared.flatMap((run) => run.results.map((r) => r.symbol)))];

const stable: string[] = [];
const flipping: { readonly symbol: string; readonly outcomes: readonly string[] }[] = [];
/** Prompts with fewer than two usable observations: nothing to conclude either way. */
const thin: string[] = [];
/**
 * How often a prompt produced its most common outcome.
 *
 * Reported per prompt because the interesting cases are not symmetrical: a prompt that launched
 * four times out of five is one flake away from reliable, and a prompt that launched once out of
 * five is a prompt that got lucky. A single score cannot tell those apart.
 */
const rate = new Map<string, { readonly runs: number; readonly agreed: number; readonly common: string }>();

console.log("\nper prompt:");
for (const symbol of symbols) {
  const seen = compared.map((run) => {
    const found = run.results.find((r) => r.symbol === symbol);
    return found === undefined ? null : outcomeOf(found);
  });
  const outcomes = seen.filter((entry): entry is string => entry !== null);

  if (outcomes.length > 0) {
    const tally = new Map<string, number>();
    for (const outcome of outcomes) tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
    const [common, agreed] = [...tally].sort((a, b) => b[1] - a[1])[0]!;
    rate.set(symbol, { runs: outcomes.length, agreed, common });
  }

  if (outcomes.length < 2) {
    thin.push(symbol);
    console.log(
      `  ?    ${symbol.padEnd(8)} ${outcomes.length === 0 ? "no usable run" : `${outcomes[0]} (once only)`}`,
    );
    continue;
  }

  const agreed = new Set(outcomes).size === 1;
  if (agreed) stable.push(symbol);
  else flipping.push({ symbol, outcomes });

  const mark = agreed ? (outcomes[0] === "ready" ? "  ok  " : " same ") : " FLIP ";
  console.log(`${mark} ${symbol.padEnd(8)} ${outcomes.join("  |  ")}`);
}

/**
 * Which stages the disagreements showed up at.
 *
 * Counted per prompt rather than per run, so a prompt that flips between two stages names both
 * once instead of weighting whichever the extra run happened to hit.
 */
const varianceByStage = new Map<string, Set<string>>();
for (const { symbol, outcomes } of flipping) {
  for (const outcome of new Set(outcomes)) {
    const stage = outcome.startsWith("failed at ")
      ? (outcome.slice("failed at ".length).split(" ")[0] ?? "?")
      : outcome === "ready" || outcome === "ready (fee misread)"
        ? "reached a launch"
        : outcome;

    const seen = varianceByStage.get(stage) ?? new Set<string>();
    seen.add(symbol);
    varianceByStage.set(stage, seen);
  }
}

/** Stages every run fails at identically: reproducible, and therefore fixable. */
const deterministic = new Map<string, Set<string>>();
for (const symbol of stable) {
  const first = compared[0]?.results.find((r) => r.symbol === symbol);
  if (first === undefined || first.launched || first.stage === "awaiting_clarification") continue;

  const stage = first.failureStage ?? "?";
  const seen = deterministic.get(stage) ?? new Set<string>();
  seen.add(symbol);
  deterministic.set(stage, seen);
}

const held = (symbol: string, holds: (found: Result) => boolean): boolean =>
  compared
    .map((run) => run.results.find((r) => r.symbol === symbol))
    .filter((found): found is Result => found !== undefined && outcomeOf(found) !== null)
    .every(holds);

const readyEveryRun = stable.filter((symbol) => held(symbol, (found) => found.launched));
const clarifyEveryRun = stable.filter((symbol) =>
  held(symbol, (found) => found.stage === "awaiting_clarification"),
);

/*
 * Where identical prompts stopped agreeing.
 *
 * Read in order — specification, then Solidity, then tests — and reported at the first stage that
 * differs, because everything after a different specification is a different market and saying
 * "the Solidity differs too" adds nothing.
 */
const divergence = new Map<string, string[]>();
/** What moved, per prompt, so the summary can be read without opening two job files. */
const details = new Map<string, string[]>();

for (const symbol of symbols) {
  const seen: Artefacts[] = [];
  for (const run of compared) {
    const found = run.results.find((r) => r.symbol === symbol);
    if (found === undefined) continue;
    const artefacts = await artefactsOf(found.jobId ?? "");
    if (artefacts !== null) seen.push(artefacts);
  }

  if (seen.length < 2) continue;

  const differs = (pick: (entry: Artefacts) => string | null): boolean => {
    const values = seen.map(pick).filter((value): value is string => value !== null);
    return values.length > 1 && new Set(values).size > 1;
  };

  /*
   * Compared against the first run rather than pairwise across all of them: the question is whether
   * a prompt produces one market repeatedly, so one reading disagreeing with the first is enough to
   * answer it, and naming every pair would bury that in combinations.
   */
  const markets = seen.map((entry) => entry.market).filter((entry): entry is Behaviour => entry !== null);
  const behavioural = markets.slice(1).flatMap((entry) => divergences(markets[0]!, entry));
  const promised = markets.slice(1).flatMap((entry) => claimDifferences(markets[0]!, entry));

  if (behavioural.length > 0) {
    for (const entry of behavioural) {
      const what = `the market itself differs — ${entry.what}`;
      divergence.set(what, [...(divergence.get(what) ?? []), symbol]);
      details.set(symbol, [...(details.get(symbol) ?? []), `${entry.what}: ${entry.detail}`]);
    }
    continue;
  }

  const at =
    differs((entry) => entry.sources)
      ? "same market, different Solidity — generation drifted"
      : differs((entry) => entry.tests)
        ? "same market and Solidity, different tests — only the suite is unstable"
        : promised.length > 0
          ? "the same market, held to a different set of invariants"
          : differs((entry) => entry.specification)
            ? "the same market, worded differently — interpretation is stable in substance"
            : null;

  if (promised.length > 0) {
    details.set(symbol, [...(details.get(symbol) ?? []), `invariants: ${promised[0]!.detail}`]);
  }

  if (at === null) continue;
  divergence.set(at, [...(divergence.get(at) ?? []), symbol]);
}

console.log("\nwhere identical prompts stopped agreeing:");
if (divergence.size === 0) {
  console.log("  nothing to compare — no prompt has artefacts recorded in two runs");
} else {
  for (const [where, prompts] of divergence) {
    console.log(`  ${String(prompts.length).padStart(2)}  ${where}: ${prompts.join(", ")}`);
  }
}

if (details.size > 0) {
  console.log("\nwhat moved, per prompt:");
  for (const [symbol, moved] of details) {
    console.log(`  ${symbol}`);
    for (const entry of moved) console.log(`      ${entry.slice(0, 300)}`);
  }
}

console.log("\nrepeatability rate per prompt:");
for (const [symbol, entry] of [...rate].sort((a, b) => a[1].agreed / a[1].runs - b[1].agreed / b[1].runs)) {
  const percent = Math.round((entry.agreed / entry.runs) * 100);
  console.log(
    `  ${String(percent).padStart(3)}%  ${symbol.padEnd(8)} ${String(entry.agreed)}/${String(entry.runs)} runs  ${entry.common}`,
  );
}

console.log("\nvariance introduced by stage (prompts whose outcome moved):");
if (varianceByStage.size === 0) {
  console.log("  none — every prompt produced the same outcome in every run");
} else {
  for (const [stage, prompts] of [...varianceByStage].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`  ${String(prompts.size).padStart(2)}  ${stage}: ${[...prompts].join(", ")}`);
  }
}

console.log("\nreproducible failures (same stage and code in every run):");
if (deterministic.size === 0) {
  console.log("  none");
} else {
  for (const [stage, prompts] of [...deterministic].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`  ${String(prompts.size).padStart(2)}  ${stage}: ${[...prompts].join(", ")}`);
  }
}

const feasible = symbols.length - clarifyEveryRun.length - thin.length;
// Counted over the runs that produced usable observations, so a vendor outage does not enter
// the record as a run where nothing launched.
const scores = compared
  .filter((run) => run.results.some((found) => outcomeOf(found) !== null))
  .map((run) => run.launched);
const worst = Math.min(...scores);
const best = Math.max(...scores);

console.log("");
console.log(`reliable launches: ${String(readyEveryRun.length)}/${String(feasible)} feasible prompts`);
console.log(`  reached a launch in every run: ${readyEveryRun.join(", ") || "none"}`);
console.log(`  asked for clarification every run: ${clarifyEveryRun.join(", ") || "none"}`);
console.log(`  flipped: ${flipping.map((entry) => entry.symbol).join(", ") || "none"}`);
console.log(`  score across runs: ${String(worst)}–${String(best)} of ${String(symbols.length)}`);
if (thin.length > 0) {
  console.log(`  too little data to judge: ${thin.join(", ")}`);
}
console.log(
  `\nverdict: ${
    flipping.length === 0
      ? "repeatable — every prompt produced the same outcome in every run"
      : `not yet repeatable — ${String(flipping.length)} prompt${flipping.length === 1 ? "" : "s"} ` +
        "produced different outcomes across runs"
  }`,
);
