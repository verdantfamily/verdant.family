#!/usr/bin/env node
/**
 * What Agen decides for itself, and what it asks about.
 *
 * Interpretation only: no planning, no Solidity, no compiler. The question this answers
 * is the one no deterministic test can — whether the real model, reading a real prompt,
 * keeps quiet when it should. The plumbing around assumptions and suggestions is proved
 * by unit tests; the judgement is not, and judgement is most of the value here.
 *
 * The failure it exists to catch is over-production. A model asked whether it has
 * questions will find questions, and a model asked for improvements will find
 * improvements, and both are worse than silence: four questions turn a launch into an
 * interview, and five generic suggestions bury the one that came from actually reading
 * the market. So the output is arranged to make excess obvious at a glance rather than
 * to celebrate coverage.
 *
 * Build the compiler first. This resolves `@verdant/market-compiler` through its package
 * exports, which point at `dist`, so a prompt edited in `src` and not compiled is a
 * prompt this script does not run — and the output looks like a real result rather than
 * a stale one. Two rounds of live calls were spent on that.
 *
 * Usage:
 *   pnpm --filter @verdant/market-compiler build && node scripts/interpret.ts
 *   node scripts/interpret.ts "<prompt>" NAME TICKER
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { LabelledCall, MarketSpecification } from "@verdant/market-compiler";
import {
  acceptedSuggestions,
  assess,
  interpret,
  openAiProvider,
  openSuggestions,
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

/**
 * Four prompts chosen for what the right answer is, not for variety.
 *
 * A and D should produce nothing to decide: they are clear, and anything Agen raises
 * about them is noise. B is buildable exactly as asked and has one thing worth
 * mentioning. C cannot be built correctly without knowing what "large" means, and is the
 * only one of the four that has earned the right to interrupt.
 */
const CALIBRATION = [
  {
    name: "Shield",
    symbol: "SHLD",
    prompt: "Charge 1% on sells.",
    expect: "no questions; an assumption that buys are fee-free",
  },
  {
    name: "Century",
    symbol: "CENT",
    prompt: "Every 100th trade wins all accumulated fees.",
    expect: "buildable as asked; a rollover or cap suggestion would be fair",
  },
  {
    name: "Rebound",
    symbol: "RBND",
    prompt: "Every large sell triggers a buyback.",
    expect: "a question about what large means",
  },
  {
    name: "Run",
    symbol: "RUN",
    prompt: "After 10 consecutive buys, make the next trade free. A sell resets the streak.",
    expect: "nothing to ask, nothing to suggest",
  },
] as const;

const model = process.env["AGEN_MODEL"] ?? "gpt-5.6-sol";
const fastModel = process.env["AGEN_MODEL_FAST"] ?? "gpt-5-mini";
const provider = openAiProvider({ apiKey, model, fastModel });

const custom = process.argv[2];
const markets =
  custom === undefined
    ? CALIBRATION
    : [
        {
          name: process.argv[3] ?? "Custom",
          symbol: process.argv[4] ?? "CSTM",
          prompt: custom,
          expect: "—",
        },
      ];

console.log(`model: ${model} (fast: ${fastModel})\n`);

/**
 * What each call cost, rather than what the stage cost.
 *
 * The frame and the critique are in flight together, so their durations overlap and
 * summing them would report time nobody waited. The elapsed figure printed beside the
 * status is the wall clock; this is where the money went.
 */
function spend(calls: readonly LabelledCall[]): void {
  let input = 0;
  let output = 0;

  console.log("");
  for (const { label, output: call } of calls) {
    input += call.inputTokens ?? 0;
    output += call.outputTokens ?? 0;

    console.log(
      `  ${label.padEnd(12)} ${(call.durationMs / 1000).toFixed(1).padStart(6)}s  ` +
        `${String(call.inputTokens ?? 0).padStart(6)} in  ${String(call.outputTokens ?? 0).padStart(6)} out`,
    );
  }

  console.log(`  ${"total".padEnd(12)} ${" ".repeat(7)}  ${String(input).padStart(6)} in  ${String(output).padStart(6)} out`);
}

function report(specification: MarketSpecification, seconds: string): void {
  const assessment = assess(specification);

  console.log(`  ${assessment.status}  in ${seconds}s`);
  console.log(`  ${specification.rules.length} rules: ${specification.summary}`);

  // The property that makes a suggestion safe to offer. Checked on every run rather than
  // assumed, because "it only suggests, it never applies" is the kind of claim that stays
  // true right up until a prompt is reworded.
  const applied = acceptedSuggestions(specification);
  if (applied.length > 0) {
    console.log(`\n  *** A SUGGESTION WAS APPLIED WITHOUT BEING ACCEPTED: ${applied.join("; ")}`);
  }
  if (openSuggestions(specification).length !== specification.suggestions.length) {
    console.log("\n  *** A SUGGESTION ARRIVED ALREADY DECIDED");
  }

  for (const question of specification.ambiguities) {
    console.log(`\n  ASK${question.blocking ? " (blocking)" : ""}  ${question.question}`);
    console.log(`      why:       ${question.why}`);
    console.log(`      otherwise: ${question.otherwise}`);
  }

  for (const assumption of specification.assumptions) {
    console.log(`\n  ASSUME (${assumption.importance})  ${assumption.term}`);
    console.log(`      ${assumption.interpretation}`);
    console.log(`      because: ${assumption.why}`);
  }

  for (const suggestion of specification.suggestions) {
    console.log(`\n  SUGGEST (${suggestion.category})  ${suggestion.title}`);
    console.log(`      ${suggestion.reason}`);
    console.log(`      change: ${suggestion.proposedChange}`);
  }

  for (const entry of specification.unsupported) {
    console.log(`\n  REFUSE  ${entry.request} — ${entry.reason}`);
  }
}

// One at a time. They are independent and would run happily in parallel, but the output
// of four interleaved markets is unreadable and reading it is the entire point.
for (const market of markets) {
  console.log(`\n${"─".repeat(76)}`);
  console.log(`${market.name} ($${market.symbol})  "${market.prompt}"`);
  console.log(`expected: ${market.expect}`);
  console.log(`${"─".repeat(76)}`);

  const started = Date.now();

  try {
    const output = await interpret(provider, {
      prompt: market.prompt,
      name: market.name,
      symbol: market.symbol,
    });

    report(output.value, ((Date.now() - started) / 1000).toFixed(1));

    // A rule that came back doing nothing had to be asked about again. This was every
    // rule in every market until the rules schema started asking what a rule does before
    // asking when it fires, so it is worth keeping in front of us.
    if (output.effectsRepairs.length > 0) {
      console.log(
        `\n  ${String(output.effectsRepairs.length)} of ${String(output.value.rules.length)} rules ` +
          `came back with no effects: ${output.effectsRepairs.map((entry) => entry.ruleId).join(", ")}`,
      );
    }

    spend(output.calls);
  } catch (error) {
    console.log(`  FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("");
