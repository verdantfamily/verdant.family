#!/usr/bin/env node
/**
 * One market, three turns, a real model.
 *
 * The scripted pipeline test proves that decisions reach the specification and that the
 * specification reaches the later stages. It cannot prove the thing that actually matters
 * here, which is whether a revision is a revision: whether asking a model to fold one
 * accepted change into a settled mechanic returns that mechanic with one thing changed,
 * or returns a different market wearing the same name.
 *
 * So this prints the rules after every turn and leaves the comparison visible. What to
 * look for, in order of how much damage it does:
 *
 *   - a rule id that disappeared, which is a rule the creator has already read and agreed
 *     to being silently replaced
 *   - an effect that changed in a rule the turn said nothing about
 *   - the change from an earlier turn missing after a later one
 *
 * Build the compiler first; this resolves through package exports to `dist`.
 *
 * Usage:
 *   pnpm --filter @verdant/market-compiler build && node scripts/converse.ts
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { MarketSpecification } from "@verdant/market-compiler";
import {
  acceptedSuggestions,
  decide,
  interpret,
  openAiProvider,
  outstanding,
  revise,
  rulesAreStale,
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

const model = process.env["AGEN_MODEL"] ?? "gpt-5.6-sol";
const provider = openAiProvider({
  apiKey,
  model,
  fastModel: process.env["AGEN_MODEL_FAST"] ?? "gpt-5-mini",
});

const PROMPT =
  process.argv[2] ??
  "After 10 consecutive buys, make the next trade free. A sell resets the streak.";

/**
 * Try again once.
 *
 * The pipeline retries transient provider failures and this script did not, so a
 * revision that takes fourteen seconds one minute and times out at three the next ends
 * the whole conversation two turns in. That is the provider having a bad moment, not the
 * market being wrong, and it should not cost the run.
 */
async function twice<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.log(`  ${what} failed (${error instanceof Error ? error.message : String(error)}); trying once more`);
    return work();
  }
}

function show(specification: MarketSpecification, label: string): void {
  console.log(`\n  ${label} — version ${String(specification.version)}, rules derived at ${String(specification.rulesDerivedAtVersion ?? 0)}`);

  for (const rule of specification.rules) {
    console.log(`    ${rule.id}`);
    for (const effect of rule.then) {
      console.log(`      ${effect.kind}: ${effect.description}`);
    }
  }
}

console.log(`model: ${model}`);
console.log(`prompt: "${PROMPT}"`);

// --- turn one: read it ------------------------------------------------------

const opening = await twice("interpretation", async () =>
  interpret(provider, { prompt: PROMPT, name: "Run", symbol: "RUN" }),
);
let specification = opening.value;

console.log(`\n${"─".repeat(76)}\nTURN 1 — first reading\n${"─".repeat(76)}`);
show(specification, "as read");
console.log(`\n  ${String(specification.suggestions.length)} suggestions, ${String(specification.ambiguities.length)} questions`);

for (const suggestion of specification.suggestions) {
  console.log(`    ${suggestion.id}: ${suggestion.title}`);
  console.log(`      ${suggestion.proposedChange}`);
}

// --- turn two: take an improvement ------------------------------------------

const taking = specification.suggestions[0];

if (taking === undefined) {
  console.log("\nNo suggestion was offered, so there is nothing to accept. Stopping here.");
  process.exit(0);
}

console.log(`\n${"─".repeat(76)}\nTURN 2 — accepting "${taking.title}"\n${"─".repeat(76)}`);

specification = decide(specification, { kind: "accept", id: taking.id });
console.log(`  recorded: stale=${String(rulesAreStale(specification))}, outstanding=${String(outstanding(specification).accepted.length)}`);

const held = specification;
const secondTurn = await twice("revision", async () =>
  revise(provider, { specification: held, decisions: outstanding(held) }),
);
specification = secondTurn.value;

show(specification, "after the revision");
console.log(`  took ${(secondTurn.durationMs / 1000).toFixed(1)}s`);

// --- turn three: correct a reading ------------------------------------------
//
// The reading has to be one the replacement is actually about. An earlier version of this
// script overrode whichever assumption came first with a sentence on an unrelated
// subject, and the revision — correctly — did nothing with "market fee: only trades above
// 1% of liquidity count towards the streak", which is not a statement about the market
// fee. The lesson was about the script; the defect it exposed was real, and is that
// settled readings were being resent to every later revision.

const correcting =
  specification.assumptions.find((entry) => /fee/i.test(entry.term)) ?? specification.assumptions[0];

if (correcting === undefined) {
  console.log("\nNo assumption to override. Stopping after two turns.");
  process.exit(0);
}

const replacement = /fee/i.test(correcting.term)
  ? "The ordinary trading fee is 1%, not 0.3%"
  : "Counted separately for each wallet rather than across the market";

console.log(`\n${"─".repeat(76)}\nTURN 3 — overriding "${correcting.term}"\n${"─".repeat(76)}`);
console.log(`  was: ${correcting.interpretation}`);
console.log(`  now: ${replacement}`);

specification = decide(specification, {
  kind: "override",
  id: correcting.id,
  interpretation: replacement,
});

const corrected = specification;
const thirdTurn = await twice("revision", async () =>
  revise(provider, { specification: corrected, decisions: outstanding(corrected) }),
);
specification = thirdTurn.value;

show(specification, "after the second revision");
console.log(`  took ${(thirdTurn.durationMs / 1000).toFixed(1)}s`);

// --- did anything get forgotten? --------------------------------------------

console.log(`\n${"─".repeat(76)}\nWHAT SURVIVED\n${"─".repeat(76)}`);
console.log(`  accepted and applied: ${acceptedSuggestions(specification).join("; ")}`);
console.log(`  overridden reading:   ${specification.assumptions.find((entry) => entry.id === correcting.id)?.interpretation ?? "GONE"}`);
console.log(`  rules level with decisions: ${String(!rulesAreStale(specification))}`);
console.log(
  `  rule ids: turn 1 [${opening.value.rules.map((rule) => rule.id).join(", ")}] ` +
    `-> turn 3 [${specification.rules.map((rule) => rule.id).join(", ")}]`,
);
console.log("");
