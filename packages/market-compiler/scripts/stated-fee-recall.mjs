/**
 * Whether Agen can read the fee it locked, for every market it has ever locked one for.
 *
 * `statedFee` is what writes the core suite's fee assertions, so a fee it cannot read is a fee
 * nothing proves. That is not a missing test among many: on a market whose whole point is "sells
 * pay 0.5%", it means the build reaches the launch button with its central requirement resting on
 * the model having done the right thing unprompted. SPEC did exactly that, twice, and passed.
 *
 * So this replays every recorded specification and reports, per side, whether a rate was read. It
 * needs no model. The three numbers that matter:
 *
 *   - read: a rate was recovered, and the core suite asserts it;
 *   - honestly silent: the market has a mechanic on that side — a threshold, a waiver, a phase —
 *     so there is no flat rate to assert and saying nothing is correct;
 *   - unreadable: a rule charges an unconditional fee on that side and the rate could not be
 *     recovered from it. This is the number to drive to zero, because each one is a market whose
 *     stated fee nothing checks.
 *
 * Usage: node scripts/stated-fee-recall.mjs
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { statedFee } from "../dist/core-tests.js";

const JOBS = resolve(import.meta.dirname, "../../../generated/_jobs");

/**
 * Whether this market's fee on this side is one a reader should be able to recover.
 *
 * Mirrors the conditions `statedFee` itself requires, which an earlier version of this script did
 * not: it asked only whether some rule looked flat, and counted every market whose fee is genuinely
 * conditional somewhere else as a miss. That reported 99 unreadable fees of which nearly all were
 * a fee that legitimately has no single answer — a number too alarming to act on and too wrong to
 * trust.
 *
 * So the population is the one where an answer must exist: exactly one rule in the whole market
 * touches a fee, it fires on this side, and nothing about it is conditional. If a rate cannot be
 * read out of that, the rate is unreadable and the market can launch with it asserted by nothing.
 */
function shouldBeReadable(specification, side) {
  /*
   * A rule that charges a trade, not one that divides what a trade already paid.
   *
   * KING's only fee-ish rule is `routeFee { destination: rewardPool, share: 20 }` — a fifth of the
   * fees join an hourly pool — and its prompt states no trade rate at all. Counted as a fee rule it
   * became ten "unreadable" fees across five builds, every one of them a rate that does not exist.
   * A rule charges a trade when it names a rate: ppm, basis points or percent.
   */
  const rated = (effect) =>
    Object.keys(effect.parameters ?? {}).some(
      (key) =>
        /ppm|bps|basispoint|percent|pct/i.test(key) && !/share|split|portion|allocation|payout/i.test(key),
    );

  /*
   * A waiver counts as touching the fee even though it states no rate.
   *
   * PULSE charges 75 basis points on sells and waives it after ten buys. Counting only the rule that
   * states a rate made that look like a market with one flat fee, and reported the reader as having
   * missed it — when the reader was right: a fee with a waiver behind it has no single answer, and
   * asserting 75 would fail a market that is correct.
   */
  const fee = (rule) =>
    (rule.then ?? []).some(
      (effect) =>
        (/fee|tax|charge|skim|toll|cut/i.test(effect.kind ?? "") && rated(effect)) ||
        /waive|exempt|free|no.?fee/i.test(effect.kind ?? ""),
    );
  const feeRules = specification.rules.filter((rule) => fee(rule));
  if (feeRules.length !== 1) return false;

  const rule = feeRules[0];
  const fires = rule.when?.kind === side || rule.when?.kind === "swap" || rule.when?.kind === "trade";
  const numeric = (clause) => Object.values(clause.parameters ?? {}).some((value) => typeof value === "number");
  const sideOnly = (clause) =>
    !numeric(clause) && /^(?:trade)?side$|direction|isbuy|issell|buyorsell|zeroforone|swapkind/i.test(clause.kind ?? "");

  const flat =
    (rule.conditions ?? []).every((clause) => sideOnly(clause)) &&
    rule.onceOnly !== true &&
    (rule.activeInPhases ?? []).length === 0;

  return fires && flat;
}

const counts = { read: 0, silent: 0, unreadable: 0 };
const unreadable = [];

for (const name of await readdir(JOBS)) {
  if (!name.endsWith(".json")) continue;

  const job = JSON.parse(await readFile(resolve(JOBS, name), "utf8"));
  const specification = job.specification;
  if (specification === null || specification === undefined) continue;
  if (!Array.isArray(specification.rules)) continue;

  for (const side of ["sell", "buy"]) {
    const rate = statedFee(specification, side);

    if (rate !== null) {
      counts.read += 1;
      continue;
    }

    if (shouldBeReadable(specification, side)) {
      counts.unreadable += 1;
      unreadable.push({ symbol: job.symbol, side, id: job.id });
    } else {
      counts.silent += 1;
    }
  }
}

console.log(
  `read ${String(counts.read)}, honestly silent ${String(counts.silent)}, ` +
    `unreadable ${String(counts.unreadable)}`,
);

for (const entry of unreadable.slice(0, 20)) {
  console.log(`  ${entry.symbol.padEnd(8)} ${entry.side.padEnd(5)} ${entry.id.slice(0, 8)}`);
}

/*
 * A gate rather than a report, for the same reason the pre-compile measurement is one: the unit
 * tests cover the shapes that have been seen, and this covers the shapes models actually produce.
 * An unconditional fee whose rate cannot be read is a market that can launch unproven.
 */
if (counts.unreadable > 0) {
  console.error(
    `\nregression: ${String(counts.unreadable)} unconditional fee(s) whose rate cannot be read. ` +
      "Each is a market that can reach the launch button with its stated fee asserted by nothing.",
  );
  process.exit(1);
}
