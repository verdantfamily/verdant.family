#!/usr/bin/env node
/**
 * Time one stage in isolation.
 *
 * Tuning interpretation by running whole builds costs twenty minutes a question and
 * answers it with a number that includes planning, generation and three repair rounds.
 * This runs a single stage against a real model and prints what it cost, so a change to
 * effort or schema can be judged in a couple of minutes.
 *
 * Usage:
 *   node scripts/time-stage.ts interpret "<prompt>" NAME TICKER
 *   node scripts/time-stage.ts plan <specification.json>
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildContext,
  design,
  interpret,
  matchArchitecture,
  openAiProvider,
  type MarketSpecification,
} from "@verdant/market-compiler";

const env = await readFile(resolve(process.cwd(), ".env.local"), "utf8");
for (const line of env.split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (match !== null) process.env[match[1]!] ??= match[2]!;
}

const apiKey = process.env["OPENAI_API_KEY"]!;
const model = process.env["AGEN_MODEL"] ?? "gpt-5";
const fastModel = process.env["AGEN_MODEL_FAST"] ?? "gpt-5-mini";
const provider = openAiProvider({ apiKey, model, fastModel });

const REPO_ROOT = resolve(process.cwd(), "../..");
const VENDOR_ROOT = resolve(REPO_ROOT, "packages/contracts/vendor");

const what = process.argv[2] ?? "interpret";
const started = Date.now();

if (what === "interpret") {
  const prompt = process.argv[3]!;
  const output = await interpret(provider, {
    prompt,
    name: process.argv[4] ?? "Tidal",
    symbol: process.argv[5] ?? "TIDE",
  });

  for (const call of output.calls) {
    console.log(
      `  ${call.label.padEnd(28)} ${(call.output.durationMs / 1000).toFixed(1).padStart(7)}s` +
        ` ${String(call.output.inputTokens ?? "-").padStart(7)}in` +
        ` ${String(call.output.outputTokens ?? "-").padStart(7)}out`,
    );
  }

  console.log(`\n  rules:   ${String(output.value.rules.length)}`);
  console.log(`  state:   ${String(output.value.state.length)}`);
  console.log(`  repairs: ${String(output.effectsRepairs.filter((repair) => repair.filled).length)} filled`);
  console.log(`  calls:   ${String(output.calls.length)}`);
  console.log(`\n  TOTAL    ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  await (await import("node:fs/promises")).writeFile(
    resolve(REPO_ROOT, "generated/_last-specification.json"),
    JSON.stringify(output.value, null, 2),
  );
  console.log("  specification written to generated/_last-specification.json\n");
} else {
  const specification = JSON.parse(
    await readFile(process.argv[3] ?? resolve(REPO_ROOT, "generated/_last-specification.json"), "utf8"),
  ) as MarketSpecification;

  const context = await buildContext({ vendorRoot: VENDOR_ROOT });

  const matchStarted = Date.now();
  const matched = await matchArchitecture(provider, { specification });
  console.log(`\n  match    ${((Date.now() - matchStarted) / 1000).toFixed(1)}s` +
    `  reuse: ${matched.value.reuse.map((entry) => entry.catalogueId).join(", ") || "none"}`);
  for (const novel of matched.value.novel) console.log(`    novel: ${novel.concern}`);

  const designStarted = Date.now();
  const output = await design(provider, { specification, context, match: matched.value });
  console.log(`\n  design   ${((Date.now() - designStarted) / 1000).toFixed(1)}s`);

  console.log(`\n  approach: ${output.value.approach.slice(0, 200)}`);
  for (const component of output.value.components) {
    const reuses = component.reuses.length === 0 ? "" : `  reuses: ${component.reuses.join(", ")}`;
    console.log(`  ${component.role.padEnd(14)} ${component.contractName.padEnd(24)}${reuses}`);
  }

  console.log(
    `\n  components: ${String(output.value.components.length)}` +
      `   ${String(output.inputTokens ?? "-")}in ${String(output.outputTokens ?? "-")}out`,
  );
  console.log(`  TOTAL    ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}
