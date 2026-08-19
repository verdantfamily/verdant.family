/**
 * Whether the pre-compile pass would have caught the suites that killed real builds — and
 * whether it stays quiet on the ones that were fine.
 *
 * Five of eleven recorded failures ended on `DeclarationError: Undeclared identifier` in a
 * model-authored test file: a suite written against members the harness does not have. The checks
 * in `testapi.ts` exist to catch that before Solidity does, so the model is asked to correct a
 * named mistake instead of being handed a message it has already proved it cannot read.
 *
 * Recall is only half of it. A false report costs a repair round that was not needed, so the
 * second half replays every recorded workspace whose suite did compile and counts how often the
 * pass would have interrupted a build that had nothing wrong with it. Both halves need no model
 * and no credits, which is the point — this was written while both provider accounts were empty.
 *
 * Usage:
 *   node scripts/precompile-recall.mjs            recall on failures, then false positives on all
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { unknownHelpers, unknownReceivers, unknownValues } from "../dist/testapi.js";

const ROOT = resolve(import.meta.dirname, "../../../generated");

/** Agen's own test files. Everything else under test/ was written by a model. */
const AGEN_FILES = new Set([
  "MarketTestBase.sol",
  "AgenTest.sol",
  "MarketCore.t.sol",
  "MarketTestEnvironment.t.sol",
]);

async function suiteOf(dir) {
  let names;
  try {
    names = await readdir(resolve(dir, "test"));
  } catch {
    return null;
  }

  const harness = [];
  const tests = [];
  for (const name of names) {
    if (!name.endsWith(".sol")) continue;
    const content = await readFile(resolve(dir, "test", name), "utf8");
    (AGEN_FILES.has(name) ? harness : tests).push({ path: `test/${name}`, content });
  }

  const fixture = harness.find((file) => file.path.endsWith("MarketTestBase.sol"));
  if (fixture === undefined || tests.length === 0) return null;

  return { harness, tests, fixture };
}

function findingsFor(suite) {
  return [
    ...unknownReceivers({ tests: suite.tests, fixture: suite.fixture }),
    ...unknownHelpers({ tests: suite.tests, harness: suite.harness }),
    ...unknownValues({ tests: suite.tests, harness: suite.harness }),
  ];
}

const jobs = (await readdir(ROOT)).filter((name) => !name.startsWith("_"));

let caught = 0;
let missed = 0;
let quiet = 0;
const noisy = [];

for (const job of jobs) {
  const dir = resolve(ROOT, job);
  if (!(await stat(dir)).isDirectory()) continue;

  const suite = await suiteOf(dir);
  if (suite === null) continue;

  let diagnostics = null;
  try {
    diagnostics = JSON.parse(await readFile(resolve(dir, "diagnostics/build.json"), "utf8"));
  } catch {
    /* a workspace kept without its diagnostics is still worth checking for false reports */
  }

  const last = (diagnostics?.testAttempts ?? []).at(-1);
  const failure = Array.isArray(last?.buildFailure) ? last.buildFailure : [];
  const undeclared = failure.filter(
    (entry) => entry.type === "DeclarationError" && entry.file?.startsWith("test/"),
  );

  const found = findingsFor(suite);

  if (undeclared.length > 0) {
    const byFile = new Set(found.map((entry) => entry.file));
    const files = [...new Set(undeclared.map((entry) => entry.file))];
    const hit = files.filter((file) => byFile.has(file));

    caught += hit.length;
    missed += files.length - hit.length;

    console.log(
      `${job.slice(0, 8)}  rejected ${String(files.length)} file(s), pass names ` +
        `${String(found.length)}: ${[...new Set(found.map((e) => e.receiver))].slice(0, 5).join(", ") || "nothing"}`,
    );
    continue;
  }

  // The suite compiled, or at least did not fail this way. Anything reported here is a build the
  // pass would have interrupted for nothing.
  if (found.length === 0) quiet += 1;
  else noisy.push({ job, names: [...new Set(found.map((entry) => entry.receiver))] });
}

console.log(`\nrecall over suites the compiler rejected: caught ${String(caught)}, missed ${String(missed)}`);
console.log(
  `reports on suites it did not reject: ${String(noisy.length)} of ` +
    `${String(quiet + noisy.length)} workspaces`,
);
for (const entry of noisy.slice(0, 15)) {
  console.log(`  ${entry.job.slice(0, 8)}  ${entry.names.slice(0, 6).join(", ")}`);
}

/*
 * A measurement worth keeping is one that fails.
 *
 * The unit tests prove the checks work on the cases they were written for. This proves they still
 * work on every suite a real model has written, which is the population that matters and the one
 * no test fixture can stand in for. It went from four of ten to ten of ten; anything less than
 * that from here is a regression, whatever the unit tests say.
 *
 * Only recall is a gate. The reports on suites that were not rejected this way are not noise by
 * definition — at the time of writing all three were genuine, each naming a real undeclared name
 * in a build that died elsewhere — so they are printed for reading rather than counted against a
 * threshold that would go stale the moment a workspace is added.
 */
if (missed > 0) {
  console.error(
    `\nregression: ${String(missed)} rejected suite(s) that the pre-compile pass does not name. ` +
      "A build hitting one of these loses its repair budget to a compiler message that names " +
      "Solidity's lookup rules instead of the fixture's fields.",
  );
  process.exit(1);
}

if (caught === 0) {
  console.error(
    "\nnothing measured: no workspace on disk failed this way, so this run proves nothing. " +
      "Keep the workspaces from a benchmark run and try again.",
  );
  process.exit(1);
}
