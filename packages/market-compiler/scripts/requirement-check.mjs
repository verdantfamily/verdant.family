/**
 * Whether the requirement gate would have refused any market that was actually right.
 *
 * The gate stops a build when a rate the creator wrote down is absent from the market Agen locked.
 * That is worth having only if it never fires on a correct market: a build turned away over a
 * number misread out of a sentence is a worse failure than the one the gate prevents, and it would
 * be invisible in a pass rate that had simply gone down.
 *
 * So this replays every recorded prompt against the specification that build locked, and reports
 * every case the gate would stop. Each one has to be read: a build that reached `deployment_ready`
 * and would now be refused is either a real requirement that was lost — the SPEC class, worth
 * refusing — or a misreading, which means the extraction is wrong and has to be narrowed.
 *
 * Usage: node scripts/requirement-check.mjs
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { lockedRates, statedRates, unmetRates } from "../dist/requirements.js";

const JOBS = resolve(import.meta.dirname, "../../../generated/_jobs");

const rate = (ppm) => `${(ppm / 10_000).toFixed(3)}%`;

let checked = 0;
let withRequirements = 0;
const stopped = [];

for (const name of await readdir(JOBS)) {
  if (!name.endsWith(".json")) continue;

  const job = JSON.parse(await readFile(resolve(JOBS, name), "utf8"));
  const specification = job.specification;
  if (specification === null || specification === undefined) continue;
  if (!Array.isArray(specification.rules)) continue;

  checked += 1;

  const stated = statedRates(job.prompt ?? "");
  if (stated.length > 0) withRequirements += 1;

  const unmet = unmetRates(job.prompt ?? "", specification);
  if (unmet.length === 0) continue;

  stopped.push({
    symbol: job.symbol,
    id: job.id,
    stage: job.stage,
    unmet: unmet.map((entry) => `${entry.phrase} (${rate(entry.ppm)})`),
    locked: [...lockedRates(specification)].sort((a, b) => a - b).map(rate),
  });
}

console.log(
  `${String(checked)} specifications, ${String(withRequirements)} with a stated rate, ` +
    `${String(stopped.length)} the gate would stop:\n`,
);

for (const entry of stopped) {
  console.log(
    `  ${entry.symbol.padEnd(8)} ${entry.stage.padEnd(20)} ${entry.id.slice(0, 8)}\n` +
      `      asked: ${entry.unmet.join(", ")}\n` +
      `      locked: ${entry.locked.join(", ") || "no rate at all"}`,
  );
}

/*
 * Every stop on a market that launched is a claim about that market, and the claim has to be true.
 * This is not gated automatically — the whole point is that a human reads these — but it exits
 * non-zero when there is anything to read, so it cannot pass unnoticed in a script.
 */
if (stopped.some((entry) => entry.stage === "deployment_ready")) {
  console.error(
    "\nsome of these launched. Each one is either a requirement that was genuinely lost, or a " +
      "misreading that would refuse a correct market — read them before trusting the gate.",
  );
  process.exit(1);
}
