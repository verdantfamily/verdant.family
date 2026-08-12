#!/usr/bin/env node
/**
 * A real build. No scripted provider, no stand-in Solidity.
 *
 * Everything in this repository so far has proved that the pipeline can *carry* a
 * market: the compiler, the gates, the deployment path and the tests all run against
 * contracts a human wrote and handed to a scripted provider. This is the other half —
 * whether a model, given the curated context and the house rules, produces Solidity
 * that compiles against Uniswap v4, satisfies its own invariants under a fuzzer, and
 * survives the gates.
 *
 * Prints the whole run rather than a verdict, because the interesting information when
 * this fails is which stage, how many repair rounds it took, and what the compiler
 * actually said.
 *
 * Usage:
 *   node scripts/live-build.ts                    the CNPY prompt
 *   node scripts/live-build.ts "<prompt>" NAME TICKER
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  fileJobStore,
  materialAssumptions,
  openAiProvider,
  openSuggestions,
  runBuild,
  summariseDiagnostics,
} from "@verdant/market-compiler";

const env = await readFile(resolve(process.cwd(), ".env.local"), "utf8");
for (const line of env.split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (match !== null) process.env[match[1]!] ??= match[2]!;
}

const apiKey = process.env["OPENAI_API_KEY"];
if (apiKey === undefined || apiKey.length === 0) {
  console.error("no OPENAI_API_KEY in apps/agen/.env.local");
  process.exit(1);
}

const REPO_ROOT = resolve(process.cwd(), "../..");
const GENERATED_ROOT = resolve(REPO_ROOT, "generated");

const DEFAULT_PROMPT =
  "Launch CNPY with a 0.5% base fee. If somebody sells more than 1% of current " +
  "liquidity, charge an additional 2% and use it for buybacks. Track consecutive buys. " +
  "After 10 buys without a sell, make the next trade hook-fee-free and reset the " +
  "counter. At $1M cumulative volume permanently reduce the base fee to 0.25%.";

const prompt = process.argv[2] ?? DEFAULT_PROMPT;
const name = process.argv[3] ?? "Canopy";
const symbol = process.argv[4] ?? "CNPY";
const model = process.env["AGEN_MODEL"] ?? "gpt-5";
const fastModel = process.env["AGEN_MODEL_FAST"] ?? "gpt-5-mini";

console.log(`model:  ${model} (fast: ${fastModel})`);
console.log(`market: ${name} ($${symbol})`);
console.log(`prompt: ${prompt.slice(0, 100)}…\n`);

const started = Date.now();

// Printed as it happens rather than at the end. A build that prints nothing for
// eighteen minutes and then fails is one nobody can tell apart from a hung one.
let last = "";
let lastAt = Date.now();

const job = await runBuild(
  { prompt, name, symbol },
  {
    provider: openAiProvider({ apiKey, model, fastModel }),
    store: fileJobStore(resolve(GENERATED_ROOT, "_jobs")),
    vendorRoot: resolve(REPO_ROOT, "packages/contracts/vendor"),
    generatedRoot: GENERATED_ROOT,
    onReviewReady: () => {
      console.log(`\n*** MARKET BUILT — reviewable at ${((Date.now() - started) / 1000).toFixed(1)}s ***\n`);
    },
    onProgress: (current) => {
      if (current.stage === last) return;

      const now = Date.now();
      if (last !== "") {
        console.log(`  ${last} took ${String(Math.round((now - lastAt) / 1000))}s`);
      }
      console.log(`→ ${current.stage}`);

      last = current.stage;
      lastAt = now;
    },
  },
);

console.log(`  ${last} took ${String(Math.round((Date.now() - lastAt) / 1000))}s`);

const seconds = Math.round((Date.now() - started) / 1000);

console.log(`\n${"=".repeat(72)}`);
console.log(`stage: ${job.stage}   (${String(seconds)}s)`);
console.log("=".repeat(72));

console.log("\nstages:");
for (const record of job.stages) {
  const took =
    record.completedAt === null ? "" : ` ${String(record.completedAt - record.startedAt)}s`;
  const attempt = record.attempt > 1 ? ` (attempt ${String(record.attempt)})` : "";
  console.log(`  ${record.status.padEnd(9)} ${record.stage}${attempt}${took}`);
  if (record.detail !== null) console.log(`            ${record.detail.slice(0, 160)}`);
}

if (job.specification !== null) {
  const spec = job.specification;
  console.log(`\nspecification:`);
  console.log(`  summary:   ${spec.summary}`);
  console.log(`  base fee:  ${String(spec.baseFeePpm / 10_000)}%   max: ${String(spec.maxFeePpm / 10_000)}%`);
  console.log(`  rules:     ${spec.rules.map((rule) => rule.id).join(", ")}`);
  console.log(`  state:     ${spec.state.map((entry) => entry.name).join(", ")}`);
  console.log(`  invariants:${spec.invariants.map((entry) => ` ${entry.id}`).join(",")}`);
  for (const assumption of materialAssumptions(spec)) {
    console.log(`  assumed:   ${assumption.term} = ${assumption.interpretation}`);
  }
  for (const question of spec.ambiguities) {
    console.log(`  asked:     ${question.question}  (otherwise: ${question.otherwise})`);
  }
  for (const suggestion of openSuggestions(spec)) {
    console.log(`  suggested: ${suggestion.title} — ${suggestion.proposedChange}`);
  }
  for (const entry of spec.unsupported) {
    console.log(`  refused:   ${entry.request} — ${entry.reason}`);
  }
}

if (job.plan !== null) {
  console.log(`\nplan: ${job.plan.approach}`);
  for (const component of job.plan.components) {
    console.log(`  ${component.role.padEnd(12)} ${component.contractName}  ${component.purpose}`);
  }
  for (const adaptation of job.plan.adaptations) {
    console.log(`  adapted:  ${adaptation.requested}`);
    console.log(`         -> ${adaptation.implemented}  (${adaptation.reason})`);
  }
}

console.log(`\ncontracts: ${job.sources.map((source) => source.path).join(", ")}`);
console.log(`tests:     ${job.tests.map((test) => test.path).join(", ")}`);
console.log(
  `results:   ${String(job.testOutcomes.filter((outcome) => outcome.passed).length)}/${String(
    job.testOutcomes.length,
  )} passing`,
);
console.log(`repairs:   ${String(job.compilationAttempts)} compile, ${String(job.testAttempts)} test`);

for (const finding of job.gateFindings) {
  console.log(`gate [${finding.severity}] ${finding.code} ${finding.file ?? ""}:${String(finding.line ?? 0)}`);
}

if (job.failure !== null) {
  console.log(`\nFAILED at ${job.failure.stage}: ${job.failure.code}`);
  console.log(job.failure.detail);
  for (const diagnostic of (job.failure.diagnostics ?? []).slice(0, 8)) {
    console.log(`  ${diagnostic.file ?? ""}:${String(diagnostic.line ?? 0)} ${diagnostic.message}`);
  }
  for (const test of (job.failure.failingTests ?? []).slice(0, 8)) {
    console.log(`  FAIL ${test.name}: ${(test.reason ?? "").slice(0, 160)}`);
  }
}

const tokens = job.exchanges.reduce(
  (total, exchange) => total + (exchange.inputTokens ?? 0) + (exchange.outputTokens ?? 0),
  0,
);
console.log(`\ntokens:    ${String(tokens)} across ${String(job.exchanges.length)} calls`);
console.log(`workspace: generated/${job.id}`);
console.log(`review:    http://127.0.0.1:4405/markets/${job.id}`);
void summariseDiagnostics;
