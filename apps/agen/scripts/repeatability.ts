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
 * Usage:
 *   node scripts/repeatability.ts                    the last 3 runs of the production provider
 *   node scripts/repeatability.ts --runs 4           the last 4
 *   node scripts/repeatability.ts --driver anthropic runs driven by Claude
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../generated/_benchmarks");

const argument = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};

const runs = Number(argument("runs", "3"));
const driver = argument("driver", "openai");

interface Result {
  readonly symbol: string;
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

console.log("\nper prompt:");
for (const symbol of symbols) {
  const seen = compared.map((run) => {
    const found = run.results.find((r) => r.symbol === symbol);
    return found === undefined ? null : outcomeOf(found);
  });
  const outcomes = seen.filter((entry): entry is string => entry !== null);

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
