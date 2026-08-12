#!/usr/bin/env node
/**
 * Is the model endpoint reachable, and does it answer the way the pipeline expects?
 *
 * Worth its own script rather than discovering it inside a fifteen-minute build. The
 * pipeline's first stage is the most expensive one to fail on: a wrong model id, an
 * unreachable endpoint or a rejected schema all surface as `MODEL_UNAVAILABLE` after
 * the creator has already typed a paragraph.
 *
 * It also checks the part most likely to be wrong for a reason nobody expects: whether
 * this model supports strict structured outputs on the Responses API at all. The
 * pipeline relies on that for every machine-facing stage.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { object, openAiProvider, text } from "@verdant/market-compiler";

// `node --env-file` exists, but reading it here keeps the script runnable the same way
// whichever node version is around.
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

const wanted = process.argv[2] ?? process.env["AGEN_MODEL"] ?? "gpt-5";

// Which models this key can see at all, so a wrong id is a list rather than a guess.
const listing = await fetch("https://api.openai.com/v1/models", {
  headers: { authorization: `Bearer ${apiKey}` },
});

if (!listing.ok) {
  console.error(`listing models: ${String(listing.status)} ${listing.statusText}`);
  process.exit(1);
}

const body = (await listing.json()) as { data?: { id: string }[] };
const ids = (body.data ?? []).map((model) => model.id).sort();

console.log(`the key can see ${String(ids.length)} models`);
console.log(
  "reasoning-capable candidates:",
  ids.filter((id) => /^(gpt-5|gpt-4\.1|o3|o4)/.test(id)).slice(0, 24).join(", ") || "none",
);
console.log(`\ntrying "${wanted}" with a strict schema…`);

const provider = openAiProvider({ apiKey, model: wanted });

try {
  const answer = await provider.generate<{ verdict: string }>({
    stage: "probe",
    instructions: "Answer with a single short word.",
    input: "Is a Uniswap v4 hook's permission set encoded in its address? Yes or no.",
    schemaName: "probe",
    schema: object({ verdict: text("yes or no") }),
    timeoutMs: 90_000,
    effort: "low",
  });

  console.log(`  ok: ${JSON.stringify(answer.value)}`);
  console.log(`  model: ${answer.model}`);
  console.log(`  tokens: in ${String(answer.usage?.inputTokens ?? 0)}, out ${String(answer.usage?.outputTokens ?? 0)}`);
} catch (error) {
  console.error(`  failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
