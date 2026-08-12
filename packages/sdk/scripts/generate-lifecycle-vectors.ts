#!/usr/bin/env node
/**
 * Generates packages/sdk/src/agents/vectors/lifecycle.json.
 *
 * The lifecycle is the one deterministic twin whose two implementations were, until
 * this file existed, checked only against themselves. `AgentLifecycle.t.sol` walks all
 * twenty-five ordered pairs against the Solidity and `lifecycle.test.ts` walks the same
 * twenty-five against the TypeScript, and both passed — but neither run ever compared
 * the two answers. Two exhaustive suites agreeing that each side matches its own
 * expectations is not the same claim as the two sides agreeing with each other, and the
 * difference is exactly the bug this would have to catch: a clause transposed in one
 * mirror and in its own test.
 *
 * So the expectations are written here, once, from the rules as prose rather than from
 * either implementation:
 *
 *  - A state never transitions to itself. Re-entering a state is not an event.
 *  - Revoked is terminal. Nothing leaves it.
 *  - Every live state may go to Revoked. An emergency stop that required a good state
 *    would not be one.
 *  - Otherwise the path is a line: Created -> MarketBound -> Active, and Active and
 *    Paused swap back and forth.
 *
 * Everything below is derived from those four sentences and from nothing else. Neither
 * `AgentLifecycle.sol` nor `lifecycle.ts` is imported, because a generator that imports
 * the thing under test cannot falsify it.
 *
 * Usage: pnpm vectors:generate:lifecycle
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "../src/agents/vectors/lifecycle.json");

// --- the states, by the ordinal the chain uses ----------------------------
//
// Written as literals for the reason above, and ordered so that the index is the
// ordinal. A renumbering here would be caught by both suites at once, which is the
// point: the ordinal is what an event carries.

const STATES = ["Created", "MarketBound", "Active", "Paused", "Revoked"] as const;

const CREATED = 0;
const MARKET_BOUND = 1;
const ACTIVE = 2;
const PAUSED = 3;
const REVOKED = 4;

// --- the rules, restated ---------------------------------------------------

/**
 * The line an agent walks when nothing goes wrong, as pairs.
 *
 * Listed rather than computed, so that the shape of the lifecycle is legible in one
 * glance and a new edge has to be typed out by somebody who meant to add it.
 */
const ADVANCES: readonly (readonly [number, number])[] = [
  [CREATED, MARKET_BOUND],
  [MARKET_BOUND, ACTIVE],
  [ACTIVE, PAUSED],
  [PAUSED, ACTIVE],
];

function canTransition(from: number, to: number): boolean {
  if (from === to) return false;
  if (from === REVOKED) return false;
  if (to === REVOKED) return true;
  return ADVANCES.some(([a, b]) => a === from && b === to);
}

/** Only an Active agent may spend on an action it chose. */
function mayExecute(state: number): boolean {
  return state === ACTIVE;
}

/** From having something to sell against until being stopped. */
function mayConfigureServices(state: number): boolean {
  return state === MARKET_BOUND || state === ACTIVE;
}

/**
 * Always, in both cases, and stated rather than omitted.
 *
 * A guardian who could stop money arriving could starve the developer and the protocol
 * of entitlements fixed at launch — ADR-012. An absence cannot be tested; a function
 * that returns true for all five states can.
 */
function mayReceiveRevenue(_state: number): boolean {
  return true;
}

function maySettleFixedEntitlement(_state: number): boolean {
  return true;
}

function isTerminal(state: number): boolean {
  return state === REVOKED;
}

// --- the corpus -----------------------------------------------------------

const from: number[] = [];
const to: number[] = [];
const allowed: boolean[] = [];

for (let a = 0; a < STATES.length; a++) {
  for (let b = 0; b < STATES.length; b++) {
    from.push(a);
    to.push(b);
    allowed.push(canTransition(a, b));
  }
}

const vectors = {
  $comment:
    "GENERATED FILE - do not edit by hand. Regenerate with `pnpm vectors:generate:lifecycle`. " +
    "Shared differential vectors for the agent lifecycle, asserted by " +
    "packages/sdk/src/agents/lifecycle.test.ts (vitest) and " +
    "packages/contracts/test/agents/AgentLifecycle.vectors.t.sol (foundry) against these same " +
    "values. Expected values are derived in the generator from the four rules stated in its " +
    "header, not from either implementation, so this checks that the two mirrors agree with a " +
    "third statement of the lifecycle rather than that each agrees with itself. " +
    "`from`, `to` and `allowed` are flat and index-aligned over all ordered pairs; the " +
    "per-state arrays are indexed by the ordinal.",
  stateNames: STATES,
  stateCount: STATES.length,
  pairCount: from.length,
  allowedCount: allowed.filter(Boolean).length,
  from,
  to,
  allowed,
  mayExecute: STATES.map((_, state) => mayExecute(state)),
  mayConfigureServices: STATES.map((_, state) => mayConfigureServices(state)),
  mayReceiveRevenue: STATES.map((_, state) => mayReceiveRevenue(state)),
  maySettleFixedEntitlement: STATES.map((_, state) => maySettleFixedEntitlement(state)),
  isTerminal: STATES.map((_, state) => isTerminal(state)),
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(vectors, null, 2)}\n`);

console.log(
  `wrote ${vectors.pairCount} lifecycle pairs (${vectors.allowedCount} permitted) to ${OUT_PATH}`,
);
