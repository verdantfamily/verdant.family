#!/usr/bin/env node
/**
 * Real prompts, real models, end to end, with the pass rate per stage and per register.
 *
 * Everything else that measures this pipeline uses a scripted provider, which is right for
 * proving control flow and useless for the question that actually matters: out of a hundred
 * people typing a market into Agen, how many get one. The only way to know that is to type
 * prompts into it and count, and the only way to know whether a change helped is to have
 * counted before.
 *
 * The prompts are not invented. They are the ones creators actually sent, taken from the
 * builds on the volume — including the ones that failed, which is the point. A benchmark
 * made of prompts Agen is known to handle measures nothing.
 *
 * The last five are one market written five ways: a v4 developer's spec, trader slang, a
 * six-word fragment, a paragraph of backstory with the rate spelled out in words, and typo-ridden
 * second-language English with an emoji in it. They ask for exactly the same half-percent sell
 * fee, so anything that separates them is comprehension rather than difficulty — and each
 * declares the fee it asked for, so a market that launches at the wrong rate is reported as
 * wrong instead of counted as a pass.
 *
 * Usage:
 *   node scripts/benchmark-prompts.ts                run everything, two at a time
 *   node scripts/benchmark-prompts.ts --only SIMPLE,FRAG   these cases, by symbol
 *   node scripts/benchmark-prompts.ts --provider anthropic  drive with Claude, not comparable
 *   AGEN_BENCH_CONCURRENCY=1 node scripts/benchmark-prompts.ts
 *
 * Each run writes generated/_benchmarks/<timestamp>.json and, when an earlier run is there,
 * prints what moved. Comparable across runs only because the prompt set is fixed: adding a
 * prompt is fine, changing one silently is not.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  anthropicProvider,
  fileJobStore,
  object,
  openAiProvider,
  runBuild,
  Stage,
  statedFee,
  text,
  type GenerationJob,
} from "@verdant/market-compiler";

const env = await readFile(resolve(process.cwd(), ".env.local"), "utf8").catch(() => "");
for (const line of env.split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (match !== null) process.env[match[1]!] ??= match[2]!;
}

const apiKey = process.env["OPENAI_API_KEY"];
if (apiKey === undefined || apiKey.length === 0) {
  console.error("no OPENAI_API_KEY in apps/agen/.env.local");
  process.exit(1);
}

/**
 * Which provider drives the build, rather than only the escalation.
 *
 * Results from the two are not comparable and must not be filed as though they were — the
 * number a change is judged against is the one from the provider production uses. It is here
 * because a dry OpenAI account otherwise means no measurement at all, and a comprehension
 * question ("is slang understood?") can be answered by either model.
 */
const driver = process.argv.includes("--provider")
  ? process.argv[process.argv.indexOf("--provider") + 1]
  : "openai";

const REPO_ROOT = resolve(process.cwd(), "../..");
const GENERATED_ROOT = resolve(REPO_ROOT, "generated");
const RESULTS_ROOT = resolve(GENERATED_ROOT, "_benchmarks");

/**
 * How the prompt is written, as opposed to what it asks for.
 *
 * The mechanic and the wording are separate ways to lose a build and they need separating in
 * the results, because the fixes are nothing alike. A market lost on its mechanic is a
 * generation problem; the same market lost because it was typed in slang is a comprehension
 * problem, and no amount of work on the generator touches it.
 */
type Register =
  | "plain" // how most people write: lowercase, direct, a sentence or two
  | "spec" // written by somebody who knows the domain, in the domain's words
  | "slang" // trader shorthand: tax, dump, jeet, ape, wen
  | "terse" // a fragment, with everything else left to be assumed
  | "rambling" // the market buried in a paragraph about why they want it
  | "broken"; // typos, no punctuation, second-language phrasing, emoji

interface Case {
  readonly name: string;
  readonly symbol: string;
  readonly prompt: string;
  /** Why this one is in the set, so nobody removes it for being inconvenient. */
  readonly why: string;
  readonly register: Register;
  /**
   * The fee the prompt asks for, in parts per million, per side, where the prompt states one
   * unconditionally. `null` means free; omit a side the prompt leaves conditional.
   *
   * Read out of the locked specification with the same function the core test suite uses, so
   * this asks the question the pass rate cannot: not whether a market was produced, but
   * whether it is the market that was asked for. A build that launches at 5% when the prompt
   * said 0.5% is worse than a build that fails, and it counts as a failure here.
   */
  readonly fees?: { readonly sell?: number | null; readonly buy?: number | null };
}

/**
 * The set.
 *
 * Weighted towards the plain fee market on purpose: it is what most people ask for, it is
 * what most of the failures were, and a launcher that cannot do it reliably has no business
 * attempting a jackpot. The harder cases are here to keep the plain ones honest — a change
 * that fixes flat fees by assuming every market is flat would pass six of these and fail
 * four.
 */
const CASES: readonly Case[] = [
  {
    name: "Simple",
    symbol: "SIMPLE",
    prompt:
      "launch a token called SIMPLE with ticker SIMPLE. buys have no hook fee. sells pay a " +
      "1% fee to the configured fee receiver.",
    why: "the plainest market anybody asks for, and it failed three times in one day",
    register: "plain",
    fees: { sell: 10_000, buy: null },
  },
  {
    name: "Harbour",
    symbol: "HRBR",
    prompt: "Charge a 1% fee on every sell and send it to the token creator. Buys are free and pay no fee.",
    why: "fees to the creator rather than the fee receiver — a different destination role",
    register: "plain",
    fees: { sell: 10_000, buy: null },
  },
  {
    name: "Ember",
    symbol: "EMBR",
    prompt:
      "Charge a 3% fee on sells and a 1% fee on buys. Send every fee collected straight to " +
      "the creator, with no accumulation and no rounds.",
    why: "both sides charged, at different rates, with no vault in between",
    register: "plain",
    fees: { sell: 30_000, buy: 10_000 },
  },
  {
    name: "Pulse",
    symbol: "PULSE",
    prompt:
      "launch a token called PULSE with ticker PULSE. buys have no hook fee. sells pay a " +
      "0.75% fee to the configured fee receiver. track consecutive buys. after 5 buys in a " +
      "row without a sell, the next trade is completely fee-free.",
    why: "a flat fee with a waiver behind it, which is where an inferred flat rate goes wrong",
    register: "plain",
  },
  {
    name: "Streak",
    symbol: "STREAK",
    prompt:
      "launch a token called STREAK with ticker STREAK. buys have no hook fee. sells pay a " +
      "0.5% fee to the configured fee receiver. after the same wallet buys 3 times in a " +
      "row, make that wallet's next buy fee-free.",
    why: "per-wallet state, which needs the router to know who is trading",
    register: "plain",
  },
  {
    name: "Canopy",
    symbol: "CNPY",
    prompt:
      "launch canopy cnpy ticker, normal fee 1%, every buy above 2% of the total supply " +
      "should be taxed 5%",
    why: "a threshold on trade size, written the way somebody actually writes it",
    register: "terse",
  },
  {
    name: "Testc",
    symbol: "TESTC",
    prompt:
      "launch a token called TESTC with ticker TESTC. buys have no hook fee. sells pay a " +
      "0.5% fee to the configured fee receiver. after every 10 successful buys, make the " +
      "next sell fee-free. reset the counter after the fee-free sell.",
    why: "a counter with a reset — state that has to survive across trades",
    register: "plain",
  },
  {
    name: "Jackpot",
    symbol: "POT",
    prompt:
      "Charge a 2% fee on every sell and no fee on buys. Collect those fees and pay the " +
      "whole accumulated pot to every 25th buyer, then reset the counter and start the " +
      "next round.",
    why: "custody plus a payout, which is the most complex shape Agen claims to support",
    register: "plain",
    fees: { sell: 20_000, buy: null },
  },
  {
    name: "Holders",
    symbol: "HOLD",
    prompt: "trading fee splits to all holders that has minimum hold of 20k tokens",
    why: "a request that cannot be implemented literally, so the honest outcome is a refusal or an adaptation",
    register: "terse",
  },
  {
    name: "Shift",
    symbol: "SHIFT",
    prompt:
      "launch a token called SHIFT with ticker SHIFT. buys have no hook fee. sells pay a " +
      "0.5% fee to the configured fee receiver.",
    why: "the same plain market as SIMPLE at a different rate: two runs of one shape catch flakiness",
    register: "plain",
    fees: { sell: 5_000, buy: null },
  },

  // --- one market, five ways of asking for it -------------------------------
  //
  // Every case below is SHIFT: half a percent off sells, nothing off buys, paid to the fee
  // receiver. Only the English changes. Holding the mechanic still is what makes the result
  // mean anything — if four launch and the slang one does not, the gap is comprehension and
  // nothing in the generator will close it. The declared fee is the same in all five, so a
  // build that launches at a rate nobody asked for is caught rather than counted as a pass.
  {
    name: "Precise",
    symbol: "SPEC",
    prompt:
      "Deploy a Uniswap v4 market with a custom hook implementing beforeSwap. On every sell " +
      "of the launch token — that is, any swap where the launch token is the input — the hook " +
      "takes a fee of 0.5% (5000 ppm) of the input amount and credits it to the configured " +
      "fee receiver. Buys are untaxed: the hook returns a zero delta and no override fee. The " +
      "hook must never hold the collected fee itself; custody belongs in a vault the fee " +
      "receiver controls. The fee is a constant of the market and cannot exceed 0.5%.",
    why: "written by somebody who knows v4: exact terms, exact ppm, custody stated outright",
    register: "spec",
    fees: { sell: 5_000, buy: null },
  },
  {
    name: "Degen",
    symbol: "DEGEN",
    prompt:
      "yo launch $DEGEN ser. 0.5% tax on dumps only, jeets pay it not the apes. buys totally " +
      "clean no tax fr fr. tax goes straight to the fee receiver wallet, dont let it sit in " +
      "the contract. keep it simple no rug mechanics",
    why: "trader shorthand: dumps, jeets, apes, ser — the register half of crypto types in",
    register: "slang",
    fees: { sell: 5_000, buy: null },
  },
  {
    name: "Fragment",
    symbol: "FRAG",
    prompt: "0.5% sell tax, buys free",
    why: "six words, everything else left for Agen to assume, which is how a lot of them arrive",
    register: "terse",
    fees: { sell: 5_000, buy: null },
  },
  {
    name: "Story",
    symbol: "STORY",
    prompt:
      "So I've been in this space since 2021 and honestly what killed every project I was in " +
      "was people dumping on day one while the buyers got punished for showing up early, " +
      "which never made sense to me. I want to do the opposite of that with my community. " +
      "Buying should cost you nothing at all, not a cent, because that's the person taking " +
      "the risk. But if you're selling, you pay a small fee, half a percent, nothing crazy, " +
      "and that goes to the fee receiver so it's actually funding the project rather than " +
      "disappearing. That's it really, I don't need anything complicated, no reflections or " +
      "rewards or anything like that, just that one rule done properly.",
    why: "the mechanic buried in a paragraph of motivation, with the rate stated in words",
    register: "rambling",
    fees: { sell: 5_000, buy: null },
  },
  {
    name: "Typo",
    symbol: "TYPO",
    prompt:
      "hi pls i want make token 🙏 wen somone sell take 0.5 percent fee and send to fee " +
      "reciver wallet, buy is no fee free for everyone ok. no other tax just this one thx",
    why: "typos, missing punctuation, second-language phrasing and an emoji, which is common",
    register: "broken",
    fees: { sell: 5_000, buy: null },
  },
];

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]?.toUpperCase().split(",")
  : undefined;
const cases = only === undefined ? CASES : CASES.filter((entry) => only.includes(entry.symbol));
if (cases.length === 0) {
  console.error(`no benchmark case with symbol ${(only ?? []).join(", ")}`);
  process.exit(1);
}

const concurrency = Number(process.env["AGEN_BENCH_CONCURRENCY"] ?? "2");
const model = process.env["AGEN_MODEL"] ?? "gpt-5";
const fastModel = process.env["AGEN_MODEL_FAST"] ?? "gpt-5-mini";
const escalationKey = process.env["ANTHROPIC_API_KEY"];
const escalationModel = process.env["AGEN_ESCALATION_MODEL"] ?? "claude-sonnet-4-5";

/*
 * Built once rather than per case.
 *
 * Hoisted so the preflight below can ask the question against the same provider the cases
 * will use. A preflight that instantiates its own is a preflight that can pass while every
 * build fails, which is worse than not having one.
 */
const escalation =
  escalationKey === undefined || escalationKey.length === 0
    ? null
    : anthropicProvider({ apiKey: escalationKey, model: escalationModel });

const driving =
  driver === "anthropic" && escalation !== null
    ? escalation
    : openAiProvider({ apiKey: apiKey, model, fastModel });

interface Result {
  readonly symbol: string;
  readonly register: Register;
  readonly jobId: string;
  readonly launched: boolean;
  /** Where the locked specification charges something the prompt did not ask for. */
  readonly misread: readonly string[];
  readonly stage: string;
  readonly failureStage: string | null;
  readonly failureCode: string | null;
  readonly detail: string | null;
  readonly seconds: number;
  readonly repairs: { readonly compile: number; readonly harness: number; readonly test: number };
  readonly quarantined: number;
  readonly tests: { readonly passed: number; readonly total: number };
}

/**
 * Whether the market Agen locked is the market the prompt described.
 *
 * Read with `statedFee`, the same function that writes the core test suite's fee assertions,
 * so the rate checked here is the rate the generated market is held to. Only unconditional
 * fees are compared: a prompt with a waiver or a threshold behind it has no single answer per
 * side, and those cases declare no expectation rather than a wrong one.
 *
 * This is the question the pass rate cannot answer. A build that reaches the launch button
 * charging five percent because "0.5" was read as "5" is a worse outcome than one that fails,
 * and counting it as a pass is how a benchmark starts lying about the thing it exists for.
 */
function misreadFees(entry: Case, job: GenerationJob): readonly string[] {
  const specification = job.specification;
  if (entry.fees === undefined || specification === null) return [];

  const found: string[] = [];

  for (const side of ["sell", "buy"] as const) {
    if (!(side in entry.fees)) continue;

    // Zero and nothing are the same market. "buys free" is formalised either as a rule that
    // charges nothing or as no rule at all, and both are the free side the prompt asked for.
    const free = (ppm: number | null | undefined) => (ppm === null || ppm === undefined || ppm === 0 ? null : ppm);
    const asked = free(entry.fees[side]);
    const locked = free(statedFee(specification, side));
    if (locked === asked) continue;

    const rate = (ppm: number | null) => (ppm === null ? "nothing" : `${(ppm / 10_000).toFixed(3)}%`);
    found.push(`${side}s: asked ${rate(asked)}, locked ${rate(locked)}`);
  }

  return found;
}

function resultOf(entry: Case, job: GenerationJob, seconds: number): Result {
  return {
    symbol: entry.symbol,
    register: entry.register,
    jobId: job.id,
    launched: job.stage === Stage.DeploymentReady,
    misread: misreadFees(entry, job),
    stage: job.stage,
    failureStage: job.failure?.stage ?? null,
    failureCode: job.failure?.code ?? null,
    detail: job.failure === null ? null : job.failure.detail.slice(0, 400),
    seconds,
    repairs: {
      compile: job.compilationAttempts,
      harness: job.harnessAttempts,
      test: job.testAttempts,
    },
    // Named in the stage record rather than on the job, so it is read from there.
    quarantined: job.stages.filter((record) => (record.detail ?? "").includes("dropped as unreliable"))
      .length,
    tests: {
      passed: job.testOutcomes.filter((outcome) => outcome.passed).length,
      total: job.testOutcomes.length,
    },
  };
}

/**
 * Whether the provider will answer at all, asked before anything expensive depends on it.
 *
 * An exhausted account does not look like an exhausted account in the results. Every stage
 * raises `MODEL_UNAVAILABLE` in about a second, so the set completes in under a minute and
 * files a run that reads as a catastrophic regression: fifteen prompts, none launched, the
 * comparison against the previous run announcing that everything broke. Ninety-three of the
 * two hundred and sixty-nine attempts on file are this, across four runs that measured
 * nothing, and one of them sits in the history next to a genuine 11/15 where it is
 * indistinguishable from a collapse in quality.
 *
 * One low-effort call with a two-field schema costs a fraction of a cent and tells the
 * difference. It also catches the other cheap ways to lose an hour — a wrong model id, a
 * key without access to it, a provider refusing structured outputs — all of which otherwise
 * surface identically, one per prompt, after the concurrency has spread them across the set.
 */
async function unreachable(): Promise<string | null> {
  try {
    await driving.generate<{ verdict: string }>({
      stage: "preflight",
      instructions: "Answer with a single short word.",
      input: 'Reply with the word "ready".',
      schemaName: "preflight",
      schema: object({ verdict: text("a single word") }),
      timeoutMs: 60_000,
      effort: "low",
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Set when a build dies for want of credit, read by the queue workers to stop pulling.
 *
 * The preflight cannot catch an account that empties halfway through a run, and that is the
 * common case rather than an edge one: a fifteen-prompt run costs real money and the balance
 * it needs is spent while it runs. Without this the remaining prompts each fail in a second
 * and are filed as failures, so a run that measured eight markets before the money ran out
 * reports as 4/15 instead of 4/7.
 */
let exhausted = false;

async function build(entry: Case): Promise<Result> {
  const started = Date.now();

  process.stdout.write(`start  ${entry.symbol}\n`);

  try {
    const job = await runBuild(
      { prompt: entry.prompt, name: entry.name, symbol: entry.symbol },
      {
        provider: driving,
        ...(escalation === null || driver === "anthropic" ? {} : { escalationProvider: escalation }),
        store: fileJobStore(resolve(GENERATED_ROOT, "_jobs")),
        vendorRoot: resolve(REPO_ROOT, "packages/contracts/vendor"),
        generatedRoot: GENERATED_ROOT,
      },
    );

    const result = resultOf(entry, job, Math.round((Date.now() - started) / 1_000));
    if (result.failureCode === "MODEL_UNAVAILABLE") exhausted = true;
    process.stdout.write(
      `${result.launched ? (result.misread.length === 0 ? "  ok  " : " WRONG") : " FAIL "} ` +
        `${entry.symbol.padEnd(7)} ${String(result.seconds).padStart(4)}s  ` +
        `${result.misread[0] ?? result.failureStage ?? result.stage}\n`,
    );
    return result;
  } catch (error) {
    // A thrown build is a bug in the pipeline rather than a failed market, and it counts
    // against the rate all the same: the creator's experience of it is identical.
    process.stdout.write(` THREW ${entry.symbol}: ${error instanceof Error ? error.message : ""}\n`);
    return {
      symbol: entry.symbol,
      register: entry.register,
      jobId: "",
      launched: false,
      misread: [],
      stage: "threw",
      failureStage: null,
      failureCode: "THREW",
      detail: error instanceof Error ? error.message.slice(0, 400) : null,
      seconds: Math.round((Date.now() - started) / 1_000),
      repairs: { compile: 0, harness: 0, test: 0 },
      quarantined: 0,
      tests: { passed: 0, total: 0 },
    };
  }
}

/**
 * Run the set with a fixed number in flight, in the order given.
 *
 * Stops early once the account is dry, leaving the untried cases out of the results rather
 * than in them as failures. What is measured is what was paid for; a prompt nobody asked a
 * model about is not evidence either way.
 */
async function all(): Promise<{ readonly results: readonly Result[]; readonly skipped: number }> {
  const queue = [...cases];
  const results: Result[] = [];

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
      for (;;) {
        if (exhausted) return;
        const next = queue.shift();
        if (next === undefined) return;
        results.push(await build(next));
      }
    }),
  );

  return { results, skipped: queue.length };
}

console.log(
  driver === "anthropic"
    ? `model: ${escalationModel} (anthropic, not the provider production uses)`
    : `model: ${model} (fast ${fastModel})`,
);
console.log(
  `escalation: ${escalationKey === undefined || driver === "anthropic" ? "none" : escalationModel}`,
);
console.log(`${String(cases.length)} prompts, ${String(concurrency)} at a time\n`);

const refusal = await unreachable();
if (refusal !== null) {
  // No results file. A run that never reached a model has nothing to say about the pipeline,
  // and filing it as a zero would put a fake regression in the history that every later run
  // is compared against.
  console.error(`preflight failed, nothing was run: ${refusal}`);
  console.error(
    /no credits left/i.test(refusal)
      ? "top up the account and run this again."
      : `check AGEN_MODEL (currently "${model}") with: node scripts/probe-model.ts ${model}`,
  );
  process.exit(2);
}

const started = Date.now();
const { results, skipped } = await all();
const right = (result: Result): boolean => result.launched && result.misread.length === 0;
const launched = results.filter((result) => result.launched).length;
const correct = results.filter(right).length;

/*
 * A prompt the model never answered is not a prompt the pipeline failed.
 *
 * The rate is reported over what was actually measured, so a run that ran out of money after
 * eight markets says 4/7 rather than 4/15. Both numbers are kept in the record — the rate is
 * only honest next to the count it was taken from.
 */
const starved = results.filter((result) => result.failureCode === "MODEL_UNAVAILABLE").length;
const measured = results.length - starved;
const incomplete = starved > 0 || skipped > 0;

console.log(`\n${"=".repeat(78)}`);
console.log(
  measured === 0
    ? `nothing measured: all ${String(results.length)} attempts died for want of credit`
    : `launched ${String(launched)}/${String(measured)} ` +
        `(${((launched / measured) * 100).toFixed(0)}%) in ` +
        `${String(Math.round((Date.now() - started) / 60_000))} minutes`,
);
if (incomplete) {
  console.log(
    `INCOMPLETE: the account ran dry mid-run — ${String(starved)} attempt(s) never reached a ` +
      `model and ${String(skipped)} were not tried. Not comparable with a full run.`,
  );
}
if (correct !== launched) {
  console.log(
    `of those, ${String(launched - correct)} charge a fee the prompt did not ask for — ` +
      `${String(correct)}/${String(measured)} are both launchable and right`,
  );
}
console.log("=".repeat(78));

for (const result of [...results].sort((left, other) => left.symbol.localeCompare(other.symbol))) {
  const repairs = `${String(result.repairs.compile)}c/${String(result.repairs.harness)}h/${String(result.repairs.test)}t`;
  console.log(
    `${right(result) ? "ok   " : result.launched ? "WRONG" : "FAIL "} ${result.symbol.padEnd(7)} ` +
      `${result.register.padEnd(9)} ${String(result.seconds).padStart(4)}s ${repairs.padEnd(9)} ` +
      `${String(result.tests.passed)}/${String(result.tests.total)} tests  ` +
      `${result.failureStage === null ? "" : `${result.failureStage}: ${result.failureCode ?? ""}`}`,
  );
  for (const misread of result.misread) console.log(`     ${misread}`);
  if (result.detail !== null) console.log(`     ${result.detail.split("\n")[0]}`);
}

// The five registers all ask for SHIFT's market, so a register that trails the others is
// measuring how the market was written down rather than what it was.
const registers = new Map<Register, { asked: number; got: number }>();
for (const result of results) {
  const tally = registers.get(result.register) ?? { asked: 0, got: 0 };
  registers.set(result.register, {
    asked: tally.asked + 1,
    got: tally.got + (right(result) ? 1 : 0),
  });
}

console.log("\nby how the prompt was written:");
for (const [register, tally] of [...registers].sort((left, other) => other[1].asked - left[1].asked)) {
  console.log(
    `  ${register.padEnd(9)} ${String(tally.got)}/${String(tally.asked)}` +
      `${tally.got === tally.asked ? "" : "   <-- the wording, not the market"}`,
  );
}

// Which stage is costing markets, which is the only number that tells you what to fix next.
const byStage = new Map<string, number>();
for (const result of results.filter((entry) => !entry.launched)) {
  const key = result.failureStage ?? result.stage;
  byStage.set(key, (byStage.get(key) ?? 0) + 1);
}

if (byStage.size > 0) {
  console.log("\nfailures by stage:");
  for (const [stage, count] of [...byStage].sort((left, right) => right[1] - left[1])) {
    console.log(`  ${String(count)}  ${stage}`);
  }
}

await mkdir(RESULTS_ROOT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const record = {
  at: Date.now(),
  driver,
  model,
  escalationModel: escalationKey === undefined ? null : escalationModel,
  launched,
  correct,
  total: results.length,
  /*
   * Whether this run is evidence.
   *
   * Read by everything that compares runs, so a starved run stops being cited as a
   * regression. `measured` is the denominator the rate was taken over; `starved` and
   * `skipped` are what it excludes.
   */
  incomplete,
  measured,
  starved,
  skipped,
  results,
};

const earlier = (await readdir(RESULTS_ROOT).catch(() => [])).filter((file) => file.endsWith(".json")).sort();
await writeFile(resolve(RESULTS_ROOT, `${stamp}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");

// The most recent run of the same provider, rather than the most recent run. Two models are
// two different systems, and reporting one as a movement in the other is how a benchmark ends
// up being cited for something it never measured.
const sameDriver: (typeof record)[] = [];
for (const file of earlier) {
  const read = JSON.parse(await readFile(resolve(RESULTS_ROOT, file), "utf8")) as typeof record;
  if ((read.driver ?? "openai") !== driver) continue;

  /*
   * Skip runs that measured nothing.
   *
   * Older records predate the `incomplete` field, so starvation is also detected the way it
   * has to be read off the history: by the failure code on the attempts themselves. Four runs
   * on file are entirely this, and comparing against one reports every market as broken.
   */
  const dry = read.results.filter((result) => result.failureCode === "MODEL_UNAVAILABLE").length;
  if (read.incomplete === true || dry > 0) continue;

  sameDriver.push(read);
}

const comparable = sameDriver.at(-1) ?? null;

if (incomplete) {
  console.log("\nnot compared against earlier runs: this one is incomplete.");
} else if (comparable !== null) {
  const previous = comparable;

  console.log(
    `\nprevious complete run: ${String(previous.launched)}/${String(previous.measured ?? previous.total)} launched` +
      ` — now ${String(launched)}/${String(measured)}`,
  );

  const was = new Map(previous.results.map((result) => [result.symbol, result.launched]));
  for (const result of results) {
    const before = was.get(result.symbol);
    if (before === undefined || before === result.launched) continue;
    console.log(`  ${result.launched ? "fixed  " : "broke  "} ${result.symbol}`);
  }
}

console.log(`\nwritten to generated/_benchmarks/${stamp}.json`);

// Two is "this did not measure anything", distinct from one, which is "markets were lost".
// A caller that treats a dry account as a test failure will chase a regression that is a
// billing problem, which is exactly what happened by hand for two days.
if (incomplete) process.exit(2);
process.exit(correct === measured ? 0 : 1);
