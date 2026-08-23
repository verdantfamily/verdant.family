/**
 * The engine-v1 benchmark, against the real configured model.
 *
 * Runs every prompt through the actual pipeline — one model call, strict parse, semantic
 * validation, canonicalization, simulation, review, typed deployment preparation — and reports
 * what each one classified as and whether repeated runs agree.
 *
 * The interesting measurement is not the pass rate. It is **stability**: whether the same
 * unambiguous prompt produces the same canonical economics every time. A prompt that lands on
 * 1% once and 2% the next is worse than one that reliably asks a question, because a creator
 * cannot tell the difference between the two runs and neither can a reviewer.
 *
 * Run through Railway so the real provider credentials are present:
 *
 *   railway run --service agen -- node packages/market-compiler/scripts/engine-benchmark.mjs
 */

import { resolve } from "node:path";

const ENGINE = "../../market-engine/dist/index.js";
const COMPILER = "../dist/index.js";

const {
  resolve: resolveEnvelope,
  simulate,
  review,
  configHash: hashOf,
} = await import(new URL(ENGINE, import.meta.url).href);
const { interpretForEngine, prepareLaunch } = await import(new URL(COMPILER, import.meta.url).href);
const { openAiProvider, anthropicProvider, fallbackProvider } = await import(new URL(COMPILER, import.meta.url).href);

const ONE_ETH = 10n ** 18n;
const SUPPLY = 1_000_000_000n * ONE_ETH;

const NATIVE = {
  referenceSupply: SUPPLY,
  quoteAsset: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 },
  launchedTokenSymbol: "DOG",
};

const EQUITY = {
  ...NATIVE,
  quoteAsset: { address: "0x1111111111111111111111111111111111111111", symbol: "NVDA", decimals: 18 },
};

const ADDRESSES = {
  chainId: 4663,
  factory: "0x00000000000000000000000000000000000f0001",
  hook: "0x00000000000000000000000000000000000038cc",
  deployer: "0x00000000000000000000000000000000000d0001",
  registry: "0x00000000000000000000000000000000000e0001",
};

const PARAMETERS = {
  metadataURI: "ipfs://bench",
  metadataMutable: false,
  initialTick: 92_200,
  feeReceiver: "0x00000000000000000000000000000000000c0001",
  tokenSalt: "0x".padEnd(66, "1"),
};

/** The 22 from the acceptance suite, plus the six native cases, plus Exact Flow. */
const PROMPTS = [
  { n: 1, expect: "SUPPORTED", binding: EQUITY, prompt: "Launch DOG with a plain 2% fee." },
  { n: 2, expect: "SUPPORTED", binding: EQUITY, prompt: "Charge 1% on buys and 2% on sells." },
  { n: 3, expect: "SUPPORTED", binding: EQUITY, prompt: "1% base. A sell of at least 1% of total supply pays 4%." },
  {
    n: 4,
    expect: "SUPPORTED",
    binding: EQUITY,
    prompt: "1% base. Sells over 1% of supply pay 3%, over 2% pay 5%, over 5% pay 8%.",
  },
  {
    n: 5,
    expect: "SUPPORTED",
    binding: EQUITY,
    prompt: "1% base. Buys of at least 0.5% of supply pay 2%, at least 1% pay 3%.",
  },
  {
    n: 6,
    expect: "SUPPORTED",
    binding: EQUITY,
    prompt:
      "0.5% base. A sell of exactly 1% of supply must pay 4%, not the base 0.5%, and not both added together.",
  },
  {
    n: 7,
    expect: "SUPPORTED",
    binding: EQUITY,
    prompt: "0.5% base. Sells strictly larger than 1% of supply pay 4%. A sell of exactly 1% pays the base rate.",
  },
  { n: 8, expect: "SUPPORTED", binding: EQUITY, prompt: "2% for the first 24 hours, then 1%." },
  { n: 9, expect: "SUPPORTED", binding: EQUITY, prompt: "3% for the first hour, 2% for the next day, 1% after that." },
  {
    n: 10,
    expect: "SUPPORTED",
    binding: EQUITY,
    prompt: "2% base, dropping to 1% after 100 NVDA of cumulative volume.",
  },
  { n: 11, expect: "NEEDS_CLARIFICATION", binding: EQUITY, prompt: "1% base, and charge a higher fee on large sells." },
  { n: 12, expect: "NEEDS_CLARIFICATION", binding: EQUITY, prompt: "1% base, but make whales pay more." },
  {
    n: 13,
    expect: "UNSUPPORTED",
    binding: EQUITY,
    prompt: "1% fee, and a wallet can only sell once every 10 minutes.",
  },
  {
    n: 14,
    expect: "UNSUPPORTED",
    binding: EQUITY,
    prompt: "1% fee, but the first buy from each wallet pays nothing.",
  },
  {
    n: 15,
    expect: "NEEDS_CLARIFICATION",
    binding: NATIVE,
    prompt: "2% base, dropping to 1% after $1m of volume.",
  },
  {
    n: 16,
    expect: "SUPPORTED",
    binding: EQUITY,
    prompt: "2% base, dropping to 1% after 500000 NVDA of cumulative volume.",
  },
  /*
   * 17 and 18 are the two prompts where either answer is defensible, and the expectations here
   * record what is observed rather than what was guessed.
   *
   * A 40% rate is above the engine's 10% ceiling. `UNSUPPORTED` — "not at that rate" — and
   * `NEEDS_CLARIFICATION` — "the maximum is 10%, what did you want?" — are both true and
   * neither misleads. It settles on `UNSUPPORTED` and is stable there.
   *
   * 18 names two rates for one threshold, which is buildable the moment somebody says which, so
   * a question is the better answer and that is what it gives.
   *
   * The compiler's `INVALID_FEE` and `DUPLICATE_THRESHOLD` refusals exist and are tested either
   * way — they are the backstop for a model that emits these instead of asking.
   */
  { n: 17, expect: "UNSUPPORTED", binding: EQUITY, prompt: "Charge 40% on every sell." },
  {
    n: 18,
    expect: "NEEDS_CLARIFICATION",
    binding: EQUITY,
    prompt: "Sells at or above 1% of supply pay 4%. Sells at or above 1% of supply pay 6%.",
  },
  {
    n: 19,
    expect: "UNSUPPORTED",
    binding: EQUITY,
    prompt: "1% fee, and after 10 consecutive buys with no sell, the next buy is free.",
  },
  { n: 20, expect: "SUPPORTED", binding: EQUITY, prompt: "Launch a token called Rock, ticker ROCK. Nothing fancy." },
  { n: 21, expect: "NEEDS_CLARIFICATION", binding: EQUITY, prompt: "Sells pay 2%. Also sells pay nothing." },
  {
    n: 22,
    expect: "SUPPORTED",
    binding: EQUITY,
    prompt: "Send 20% of fees to the treasury and 80% to me. Sells over 2% of supply pay 5%; base is 1%.",
  },

  /*
   * The bare-wording operator default.
   *
   * "Sells of 2% of supply pay 5%" names a size and a rate and no comparison word at all. The
   * interpretation instructions say to read that as `GTE`, because it is the reading that
   * admits the trade the creator named — and asking which comparison was meant would be asking
   * them to restate a sentence they already wrote.
   *
   * Here rather than left as a hand probe so the default is covered by the repeated-run
   * stability measurement like every other reading. 6 and 7 cover the two explicit forms.
   */
  {
    n: 23,
    expect: "SUPPORTED",
    binding: EQUITY,
    prompt: "1% base. Sells of 2% of supply pay 5%.",
  },

  // --- native Robinhood Chain ETH -----------------------------------------
  { n: "N1", expect: "SUPPORTED", binding: NATIVE, prompt: "Launch DOG with a 2% flat fee, quoted in ETH." },
  { n: "N2", expect: "SUPPORTED", binding: NATIVE, prompt: "Quoted in ETH. Charge 1% on buys and 2% on sells." },
  {
    n: "N3",
    expect: "SUPPORTED",
    binding: NATIVE,
    prompt: "Quoted in ETH, 1% base. A sell of at least 1% of total supply pays 4%.",
  },
  {
    n: "N4",
    expect: "SUPPORTED",
    binding: NATIVE,
    prompt: "Quoted in ETH. 3% for the first 24 hours, then 1%.",
  },
  {
    n: "N5",
    expect: "SUPPORTED",
    binding: NATIVE,
    prompt: "Quoted in ETH. 2% base, dropping to 1% after 100 ETH of cumulative volume.",
  },
  {
    n: "N6",
    expect: "SUPPORTED",
    binding: NATIVE,
    prompt:
      "Quoted in ETH. 1% base, dropping to 0.5% after 100 ETH of volume. Sells of at least 1% of supply pay 4%.",
  },

  // --- the historical regression -------------------------------------------
  {
    n: "EXACT_FLOW",
    expect: "UNSUPPORTED",
    binding: NATIVE,
    prompt:
      "Launch a token called Exact Flow, ticker EXCT. Charge 0.5% on every buy and every sell. " +
      "When a sell is at least 1% of the token's immutable total supply, charge 4% instead. A sell of " +
      "exactly 1% must pay 4%, not 0.5%, and the fees must not be added together. Send 80% of every " +
      "collected fee to the creator and 20% to the fee vault. After 10 consecutive buys without a " +
      "sell, make the next buy fee-free and reset the counter. Any sell resets the counter immediately.",
  },
];

const RUNS = Number(process.env["BENCH_RUNS"] ?? "3");

/**
 * The same provider production uses, failover and all.
 *
 * It used to be whichever vendor's key it found first, with no fallback — and that made the
 * benchmark measure a system nobody runs. A run where Anthropic's balance ran dry midway
 * reported seven prompts as SYSTEM_ERROR, which in production would have been seven prompts
 * answered by OpenAI: `providerOrNull` in the app wraps the primary in `fallbackProvider`
 * precisely so an exhausted balance is a failover rather than a failed launch.
 *
 * Measuring the unwrapped primary understates reliability and, worse, attributes an account
 * problem to the pipeline. `AGEN_PRIMARY` is honoured for the same reason: the ordering is
 * part of what is being measured.
 */
function providerOrDie() {
  const claude =
    process.env["ANTHROPIC_API_KEY"] === undefined
      ? null
      : anthropicProvider({
          apiKey: process.env["ANTHROPIC_API_KEY"],
          model: process.env["AGEN_CLAUDE_MODEL"] ?? "claude-sonnet-4-5",
        });

  const openAi =
    process.env["OPENAI_API_KEY"] === undefined
      ? null
      : openAiProvider({
          apiKey: process.env["OPENAI_API_KEY"],
          model: process.env["AGEN_MODEL"] ?? "gpt-5.1",
        });

  const [primary, secondary] =
    process.env["AGEN_PRIMARY"] === "openai" ? [openAi ?? claude, claude] : [claude ?? openAi, openAi];

  if (primary === null) throw new Error("no model credentials in the environment");
  if (secondary === null || secondary === primary) return primary;

  return fallbackProvider(primary, secondary, {
    onFailover: (error) => {
      process.stdout.write(`  [failover] ${error.message}\n`);
    },
  });
}

const provider = providerOrDie();

/** One run of one prompt, through the whole deterministic path. */
async function once(entry) {
  const started = Date.now();

  let answer;
  try {
    const interpreted = await interpretForEngine(provider, {
      prompt: entry.prompt,
      name: "Benchmark",
      symbol: "DOG",
      quoteAssetSymbol: entry.binding.quoteAsset.symbol,
      quoteIsNative: entry.binding.quoteAsset.address === "0x0000000000000000000000000000000000000000",
      // Whole tokens, as the pipeline supplies it, so a prompt naming a size in tokens can be
      // converted rather than refused. See `InterpretRequest.referenceSupplyTokens`.
      referenceSupplyTokens: entry.binding.referenceSupply / ONE_ETH,
    });
    answer = interpreted.answer;
  } catch (error) {
    return { classification: "SYSTEM_ERROR", where: "provider", detail: String(error), ms: Date.now() - started };
  }

  const resolved = resolveEnvelope(answer, entry.binding);

  if (resolved.outcome === "INTERPRETATION_ERROR") {
    return {
      classification: "SYSTEM_ERROR",
      where: "malformed envelope",
      detail: resolved.problems.map((p) => `${p.code} ${p.path}: ${p.detail}`).join(" | "),
      ms: Date.now() - started,
    };
  }

  if (resolved.outcome !== "SUPPORTED") {
    return {
      classification: resolved.outcome,
      detail:
        resolved.outcome === "UNSUPPORTED"
          ? resolved.unsupported.map((u) => u.request).join(" | ")
          : resolved.clarifications.map((c) => c.question).join(" | "),
      /*
       * What was asked, as a shape rather than as prose.
       *
       * A model asking the same question in different words on different runs is fine — a
       * creator reads one of them. A model asking about the rate on one run and the threshold
       * on the next is not: the two runs disagree about what is missing from the prompt, which
       * means at least one of them read it wrong. The ids are the model's own names for what
       * it is missing, so comparing the sorted set compares the substance and ignores the
       * wording.
       */
      asking:
        resolved.outcome === "NEEDS_CLARIFICATION"
          ? [...resolved.clarifications.map((c) => c.id)].sort().join(",")
          : undefined,
      ms: Date.now() - started,
    };
  }

  // Everything below interpretation, exercised on the real answer.
  const config = resolved.config;
  let prepared;
  try {
    simulate(config);
    review(config);
    prepared = prepareLaunch({
      config,
      parameters: {
        ...PARAMETERS,
        name: "Benchmark",
        symbol: "DOG",
        supply: entry.binding.referenceSupply,
        specificationHash: "0x".padEnd(66, "2"),
      },
      addresses: ADDRESSES,
      vaultInitCodeHash: "0x".padEnd(66, "3"),
    });
  } catch (error) {
    return {
      classification: "SYSTEM_ERROR",
      where: "simulation/review/preparation",
      detail: String(error),
      ms: Date.now() - started,
    };
  }

  const shown = review(config);
  return {
    classification: "SUPPORTED_AND_CORRECT",
    configHash: hashOf(config),
    /*
     * The commitment, which is what a creator actually signs.
     *
     * Reported alongside the configuration hash rather than instead of it because they answer
     * different questions. `configHash` asks whether the model produced the same economics
     * twice; `implementationHash` asks whether the same *market* would be deployed — it binds
     * the chain, the engine address and the engine version on top of the economics. A run
     * where the two diverge in stability would mean something outside the model moved, which
     * is worth being able to see separately.
     */
    implementationHash: prepared.implementationHash,
    economics: {
      baseBuy: config.stages[0].buyFeePpm,
      baseSell: config.stages[0].sellFeePpm,
      stages: config.stages.length,
      axis: config.ladderAxis,
      buyTiers: config.buyTiers.map((t) => `${t.thresholdTokens}@${t.feePpm}`).join(","),
      sellTiers: config.sellTiers.map((t) => `${t.thresholdTokens}@${t.feePpm}`).join(","),
      feeCurrency: config.feeCurrency,
      quote: config.quoteAsset.address,
      split: config.distribution.map((s) => `${s.recipient.kind}:${s.sharePpm}`).join(","),
    },
    feeCurrencySymbol: shown.feeCurrencySymbol,
    quoteLabel: shown.quoteAssetLabel,
    ms: Date.now() - started,
  };
}

const results = [];

for (const entry of PROMPTS) {
  const runs = await Promise.all(Array.from({ length: RUNS }, async () => await once(entry)));

  const classifications = new Set(runs.map((run) => run.classification));
  const hashes = new Set(runs.filter((run) => run.configHash !== undefined).map((run) => run.configHash));
  const commitments = new Set(
    runs.filter((run) => run.implementationHash !== undefined).map((run) => run.implementationHash),
  );
  const asked = new Set(runs.filter((run) => run.asking !== undefined).map((run) => run.asking));

  results.push({
    n: entry.n,
    expect: entry.expect,
    runs,
    stableClassification: classifications.size === 1,
    stableEconomics: hashes.size <= 1,
    stableCommitment: commitments.size <= 1,
    // Vacuously true for a prompt that never asks, which is the right reading: there is no
    // inconsistency in a set of no questions.
    stableClarification: asked.size <= 1,
    classifications: [...classifications],
    hashes: [...hashes],
    asked: [...asked],
  });

  const marks = runs.map((run) => run.classification[0]).join("");
  process.stdout.write(
    `${String(entry.n).padStart(10)}  ${marks}  ${[...classifications].join("/")}` +
      `${hashes.size > 1 ? `  UNSTABLE ECONOMICS (${String(hashes.size)} variants)` : ""}\n`,
  );
}

process.stdout.write(`\n${"=".repeat(72)}\n`);

const supported = results.filter((r) => r.classifications.includes("SUPPORTED_AND_CORRECT"));
const errors = results.filter((r) => r.classifications.includes("SYSTEM_ERROR"));
const unstableClass = results.filter((r) => !r.stableClassification);
const unstableEcon = results.filter((r) => !r.stableEconomics);
const unstableCommit = results.filter((r) => !r.stableCommitment);
const unstableAsk = results.filter((r) => !r.stableClarification);
const clarifying = results.filter((r) => r.asked.length > 0);

/*
 * A malformed envelope is counted per *run*, not per prompt.
 *
 * One prompt in five runs producing one unparseable answer is a 20% failure rate for that
 * prompt and would be invisible as "1 prompt affected". The rate is what decides whether a
 * creator sees an interpretation error, so the rate is what is reported.
 */
const allRuns = results.flatMap((r) => r.runs);
const malformed = allRuns.filter((run) => run.where === "malformed envelope");
const asExpected = results.filter(
  (r) => r.stableClassification && r.classifications[0].startsWith(r.expect.split("_")[0]),
);

process.stdout.write(`prompts:                    ${String(results.length)}\n`);
process.stdout.write(`runs each:                  ${String(RUNS)}\n`);
process.stdout.write(`classification as expected: ${String(asExpected.length)}/${String(results.length)}\n`);
process.stdout.write(`stable classification:      ${String(results.length - unstableClass.length)}/${String(results.length)}\n`);
process.stdout.write(`stable economics:           ${String(results.length - unstableEcon.length)}/${String(results.length)}\n`);
process.stdout.write(
  `stable implementationHash:  ${String(results.length - unstableCommit.length)}/${String(results.length)}\n`,
);
process.stdout.write(
  `consistent clarifications:  ${String(clarifying.length - unstableAsk.length)}/${String(clarifying.length)}` +
    ` (of ${String(clarifying.length)} that ask)\n`,
);
process.stdout.write(
  `malformed envelopes:        ${String(malformed.length)}/${String(allRuns.length)} runs\n`,
);
process.stdout.write(`SYSTEM_ERROR prompts:       ${String(errors.length)}\n`);

const latencies = results.flatMap((r) => r.runs.map((run) => run.ms)).sort((a, b) => a - b);
if (latencies.length > 0) {
  process.stdout.write(
    `latency ms  min ${String(latencies[0])}  median ${String(latencies[Math.floor(latencies.length / 2)])}` +
      `  max ${String(latencies[latencies.length - 1])}\n`,
  );
}

if (unstableClass.length > 0) {
  process.stdout.write(`\nUNSTABLE CLASSIFICATION\n`);
  for (const entry of unstableClass) {
    process.stdout.write(`  ${String(entry.n)}: ${entry.classifications.join(" / ")}\n`);
  }
}

if (unstableEcon.length > 0) {
  process.stdout.write(`\nUNSTABLE ECONOMICS\n`);
  for (const entry of unstableEcon) {
    process.stdout.write(`  ${String(entry.n)}:\n`);
    for (const run of entry.runs) {
      if (run.economics !== undefined) {
        process.stdout.write(`    ${JSON.stringify(run.economics)}\n`);
      }
    }
  }
}

if (errors.length > 0) {
  process.stdout.write(`\nSYSTEM_ERROR DETAIL\n`);
  for (const entry of errors) {
    for (const run of entry.runs) {
      if (run.classification === "SYSTEM_ERROR") {
        process.stdout.write(`  ${String(entry.n)} [${run.where}] ${run.detail.slice(0, 400)}\n`);
      }
    }
  }
}

/*
 * The clarification sets that disagreed, printed rather than counted.
 *
 * A count is not actionable here, because two very different things produce it. A model asking
 * about the rate on one run and the threshold on the next has read the prompt differently and
 * that is a real problem. A model asking the same question under the id `rate` once and
 * `fee_rate` the next is cosmetic — the ids are its own labels, not a vocabulary it was given.
 * Only the sets themselves distinguish the two.
 */
if (unstableAsk.length > 0) {
  process.stdout.write(`\nCLARIFICATION SETS THAT VARIED\n`);
  for (const entry of unstableAsk) {
    process.stdout.write(`  ${String(entry.n)}: ${entry.asked.map((set) => `[${set}]`).join(" vs ")}\n`);
  }
}

process.stdout.write(`\nMISMATCHED EXPECTATION\n`);
for (const entry of results) {
  const got = entry.classifications.join("/");
  if (!entry.classifications[0].startsWith(entry.expect.split("_")[0]) || !entry.stableClassification) {
    process.stdout.write(`  ${String(entry.n)}: expected ${entry.expect}, got ${got}\n`);
  }
}
