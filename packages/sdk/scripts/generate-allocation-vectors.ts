#!/usr/bin/env node
/**
 * Generates packages/sdk/src/agents/vectors/allocation.json.
 *
 * These vectors are the contract between two implementations of an agent's
 * revenue split: RevenueAllocationLib.sol, which decides who is actually paid,
 * and allocation.ts, which decides what the agent page says they are owed.
 *
 * Four rules make the guarantee real:
 *
 *  1. The vectors are generated BEFORE either implementation is finished, so
 *     neither can be written to fit them.
 *
 *  2. Expected values are computed here by the naive definition —
 *     `received * bps / 10_000` in `BigInt` arithmetic, which is exact and
 *     obvious by inspection. Both implementations under test instead use an
 *     overflow-free decomposition, because the naive form reverts in Solidity
 *     once `received` passes `2^256 / 10_000`. So this file is not checking that
 *     a thing equals itself: it is checking that the rewrite is exact, at values
 *     where the naive form would have died.
 *
 *  3. The corpus includes a streaming section. The same total revenue is
 *     delivered as one payment and as many, and the vectors record that the
 *     final buckets are identical. That is the property the cumulative rule
 *     exists to provide, and it is the one a per-arrival split would fail.
 *
 *  4. Randomized cases come from a fixed seed, so the corpus is identical on
 *     every machine and in CI, and a failing vector is reproducible by anyone.
 *
 * Usage: pnpm vectors:generate:allocation
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "../src/agents/vectors/allocation.json");

// --- bounds ---------------------------------------------------------------
// Literals rather than imports from the model under test, for the reason in rule
// 2: a generator that imports the implementation cannot falsify it.

const BPS_DENOMINATOR = 10_000n;
const LEG_COUNT = 4;
const MAX_UNALLOCATED_DUST = BigInt(LEG_COUNT - 1);

const MAX_UINT256 = (1n << 256n) - 1n;

const SEED = 0x41474e54; // "AGNT"

// --- reference implementation ---------------------------------------------

/**
 * The definition, written as plainly as it can be written.
 *
 * A leg's lifetime entitlement is its share of everything received, rounded
 * down. Nothing about buckets, nothing about calls, nothing about order.
 */
function referenceEntitlement(received: bigint, bps: number): bigint {
  return (received * BigInt(bps)) / BPS_DENOMINATOR;
}

function referenceEntitlements(
  received: bigint,
  bps: readonly number[],
): bigint[] {
  return bps.map((share) => referenceEntitlement(received, share));
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

// --- types ----------------------------------------------------------------

interface Case {
  readonly name: string;
  readonly why: string;
  /** Operations, buybacks, developer, protocol. Sums to 10 000. */
  readonly bps: readonly number[];
  /** Cumulative totals at which entitlements are checked. */
  readonly probes: readonly bigint[];
}

interface InvalidCase {
  readonly name: string;
  readonly why: string;
  readonly bps: readonly number[];
  readonly error: string;
}

interface StreamCase {
  readonly name: string;
  readonly why: string;
  readonly bps: readonly number[];
  /** Individual arrivals, delivered in order, allocating after each. */
  readonly arrivals: readonly bigint[];
}

// --- amounts --------------------------------------------------------------

const WEI = 1n;
const GWEI = 10n ** 9n;
const ETHER = 10n ** 18n;
const USDC = 10n ** 6n;

/**
 * Probe totals applied to every case.
 *
 * Small values are where rounding lives: with four legs, a total under 10 000
 * has fractional parts in every leg at once. Large values are where an
 * overflow-avoiding rewrite either holds or does not.
 */
function standardProbes(): bigint[] {
  const probes = new Set<bigint>();

  // Nothing, and the smallest possible something.
  probes.add(0n);
  probes.add(1n * WEI);
  probes.add(2n * WEI);
  probes.add(3n * WEI);
  probes.add(4n * WEI);

  // Around the denominator, where a share first becomes a whole unit.
  probes.add(BPS_DENOMINATOR - 1n);
  probes.add(BPS_DENOMINATOR);
  probes.add(BPS_DENOMINATOR + 1n);
  probes.add(BPS_DENOMINATOR * 2n - 1n);
  probes.add(BPS_DENOMINATOR * 2n);

  // Plausible money, in both decimal conventions this chain has.
  probes.add(GWEI);
  probes.add(ETHER / 1000n);
  probes.add(ETHER);
  probes.add(ETHER * 1337n);
  probes.add(USDC);
  probes.add(USDC * 250n);

  // A prime-ish total, so no leg divides evenly by construction.
  probes.add(1_000_003n);
  probes.add(999_999_999_999_999_989n);

  // Past anything real, and then past the point the naive form would revert in
  // Solidity: 2^256 / 10_000 is where `received * bps` overflows.
  probes.add(2n ** 128n);
  probes.add(2n ** 200n);
  probes.add(MAX_UINT256 / BPS_DENOMINATOR);
  probes.add(MAX_UINT256 / BPS_DENOMINATOR + 1n);
  probes.add(MAX_UINT256 - 1n);
  probes.add(MAX_UINT256);

  return [...probes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// --- hand-written cases ---------------------------------------------------

const cases: Case[] = [
  {
    name: "even-quarters",
    why: "Every leg equal. The only configuration where a rounding bias, if one existed, would be invisible in the ratios and visible only in the totals.",
    bps: [2500, 2500, 2500, 2500],
    probes: standardProbes(),
  },
  {
    name: "default-agent",
    why: "The shape most agents are expected to use: most of the revenue funds the agent's own operation, a fifth buys its token back, and the developer and protocol take a tenth each.",
    bps: [6000, 2000, 1000, 1000],
    probes: standardProbes(),
  },
  {
    name: "operations-only",
    why: "One leg takes everything and three take nothing. A leg at zero must receive exactly zero at every total, including totals with dust — this is the case that fails if dust is handed to a nominated leg.",
    bps: [10_000, 0, 0, 0],
    probes: standardProbes(),
  },
  {
    name: "protocol-only",
    why: "The same degenerate shape at the other end of the array, so an off-by-one in leg indexing cannot pass by symmetry.",
    bps: [0, 0, 0, 10_000],
    probes: standardProbes(),
  },
  {
    name: "one-basis-point-protocol",
    why: "The smallest non-zero share. Below 10 000 units of revenue this leg is entitled to nothing at all, which is correct and must not be rounded up into a payment.",
    bps: [9999, 0, 0, 1],
    probes: standardProbes(),
  },
  {
    name: "thirds-and-remainder",
    why: "Shares that do not divide the denominator evenly. Three legs at 3333 leave 1 bps over, so almost every total produces a fractional part in three legs at once.",
    bps: [3333, 3333, 3333, 1],
    probes: standardProbes(),
  },
  {
    name: "prime-shares",
    why: "Deliberately awkward shares with no common factor with 10 000, maximising how often all four legs round down together — the case that reaches the three-unit dust bound.",
    bps: [4649, 3121, 1327, 903],
    probes: standardProbes(),
  },
  {
    name: "no-buybacks",
    why: "The buyback leg at zero, which is the configuration for an agent that sells a service and never touches its own token. Buybacks are phase 4; a v1 agent setting this to zero must behave exactly as if the leg did not exist.",
    bps: [7000, 0, 2000, 1000],
    probes: standardProbes(),
  },
  {
    name: "developer-heavy",
    why: "A configuration a buyer should dislike. It is legal, and the arithmetic must be identical: this library enforces the sum, not the politics.",
    bps: [1000, 0, 9000, 0],
    probes: standardProbes(),
  },
];

// --- streaming cases ------------------------------------------------------
// The property that separates cumulative allocation from per-arrival splitting.
// Each of these delivers a total in pieces; the assertion is that the buckets at
// the end equal the buckets from delivering the same total at once.

const streams: StreamCase[] = [
  {
    name: "thousand-single-wei",
    why: "One wei at a time. Under a per-arrival rule every split floors to zero for three legs and the dust goes to one, so a leg entitled to a tenth receives everything or nothing. Under the cumulative rule the buckets are the same as one payment of 1 000.",
    bps: [6000, 2000, 1000, 1000],
    arrivals: Array<bigint>(1000).fill(1n),
  },
  {
    name: "awkward-shares-drip",
    why: "The same drip against shares that never divide evenly, which is where a per-arrival rule accumulates the largest bias.",
    bps: [3333, 3333, 3333, 1],
    arrivals: Array<bigint>(500).fill(7n),
  },
  {
    name: "mixed-sizes",
    why: "Realistic traffic: a few large fee claims among many small service payments, in an order chosen to be uneven.",
    bps: [6000, 2000, 1000, 1000],
    arrivals: [
      1n,
      ETHER,
      3n,
      USDC,
      999n,
      ETHER / 7n,
      1n,
      1n,
      12_345n,
      ETHER * 3n,
      7n,
    ],
  },
  {
    name: "zero-arrivals-interleaved",
    why: "Allocation called when nothing has arrived since the last call must move nothing and must not disturb what is already allocated.",
    bps: [2500, 2500, 2500, 2500],
    arrivals: [100n, 0n, 0n, 100n, 0n, 1n],
  },
  {
    name: "single-payment-control",
    why: "The control for the drip cases above: one payment of the same total. The vectors record both so the equality is asserted rather than assumed.",
    bps: [6000, 2000, 1000, 1000],
    arrivals: [1000n],
  },
];

// --- invalid cases --------------------------------------------------------
// One per failure mode, each naming its own error. A validator that returns the
// right boolean for the wrong reason is not a validator.

const invalid: InvalidCase[] = [
  {
    name: "sum-below-denominator",
    why: "9 999 basis points leaves one unassigned. Revenue that belongs to nobody would accumulate in the router forever.",
    bps: [6000, 2000, 1000, 999],
    error: "BpsSumMismatch",
  },
  {
    name: "sum-above-denominator",
    why: "10 001 basis points promises more than arrives, so the last leg to settle would find the bucket short.",
    bps: [6000, 2000, 1000, 1001],
    error: "BpsSumMismatch",
  },
  {
    name: "all-zero",
    why: "The value an uninitialised struct holds. It must be rejected explicitly rather than by accident, because it is the configuration a caller gets by forgetting the argument.",
    bps: [0, 0, 0, 0],
    error: "BpsSumMismatch",
  },
  {
    name: "every-leg-full",
    why: "Four legs each claiming the whole. The most obvious way to write a broken allocation.",
    bps: [10_000, 10_000, 10_000, 10_000],
    error: "BpsSumMismatch",
  },
  {
    name: "single-leg-over-denominator",
    why: "One leg claiming more than the whole. The sum is also wrong, and both errors apply — range is checked first, so this must report the range and not the sum.",
    bps: [10_001, 0, 0, 0],
    error: "BpsOutOfRange",
  },
];

// --- seeded PRNG ----------------------------------------------------------

/** mulberry32 — small, deterministic, and adequate for corpus generation. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random allocation summing to exactly 10 000.
 *
 * Built by handing out the denominator leg by leg rather than by generating four
 * numbers and hoping, so every generated case is valid by construction and the
 * corpus never needs discarding.
 */
function randomAllocation(random: () => number): number[] {
  const bps: number[] = [];
  let remaining = Number(BPS_DENOMINATOR);

  for (let leg = 0; leg < LEG_COUNT - 1; leg++) {
    const share = Math.floor(random() * (remaining + 1));
    bps.push(share);
    remaining -= share;
  }
  bps.push(remaining);

  return bps;
}

function randomProbes(random: () => number): bigint[] {
  const probes: bigint[] = [];

  for (let i = 0; i < 6; i++) {
    // Spread across many orders of magnitude: a corpus concentrated at one scale
    // exercises one rounding regime.
    const magnitude = Math.floor(random() * 40);
    const scale = 10n ** BigInt(magnitude);
    const digits = BigInt(Math.floor(random() * 1_000_000));
    probes.push(scale * digits + BigInt(Math.floor(random() * 10_000)));
  }

  return probes;
}

function generateRandomCases(count: number): Case[] {
  const random = makeRandom(SEED);
  const generated: Case[] = [];

  for (let i = 0; i < count; i++) {
    generated.push({
      name: `random-${String(i).padStart(3, "0")}`,
      why: "Seeded randomized allocation.",
      bps: randomAllocation(random),
      // The structural probes on every case, plus a few random totals, so the
      // boundaries are never traded away for breadth.
      probes: [...standardProbes(), ...randomProbes(random)].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    });
  }

  return generated;
}

// --- emit -----------------------------------------------------------------

const allCases = [...cases, ...generateRandomCases(150)];

/**
 * Flat, index-aligned arrays rather than nested objects, for Foundry's benefit.
 * `vm.parseJson` re-parses the whole document per call, so a nested shape costs
 * one parse per field per case and turns a fast test into a slow one.
 *
 * Every amount is a decimal string. JSON has no integer wide enough for a
 * uint256, and a number in the document would arrive as a float that had quietly
 * lost its low bits — which for this corpus would silently delete the very
 * values the overflow cases exist to pin.
 */
const BPS_STRIDE = LEG_COUNT;

const probeCase: number[] = [];
const probeReceived: string[] = [];
const probeEntitlement: string[] = []; // stride LEG_COUNT, index-aligned to probeCase
const probeDust: string[] = [];

allCases.forEach((c, caseIndex) => {
  for (const received of c.probes) {
    const owed = referenceEntitlements(received, c.bps);
    const dust = received - sum(owed);

    if (dust < 0n || dust > MAX_UNALLOCATED_DUST) {
      throw new Error(
        `case ${c.name}: dust ${dust} at received ${received} is outside [0, ${MAX_UNALLOCATED_DUST}]`,
      );
    }

    probeCase.push(caseIndex);
    probeReceived.push(received.toString());
    for (const value of owed) probeEntitlement.push(value.toString());
    probeDust.push(dust.toString());
  }
});

/**
 * Streaming expectations.
 *
 * `finalAllocated` is computed from the cumulative total alone — deliberately
 * ignoring the arrival sequence — because that is precisely the claim: the split
 * does not depend on how the money arrived. A test that replays the arrivals and
 * lands on these numbers has proved it.
 */
const streamTotal: string[] = [];
const streamArrivalCount: number[] = [];
const streamArrival: string[] = [];
const streamFinal: string[] = [];
const streamBps: number[] = [];

for (const stream of streams) {
  const total = sum(stream.arrivals);
  const owed = referenceEntitlements(total, stream.bps);

  streamTotal.push(total.toString());
  streamArrivalCount.push(stream.arrivals.length);
  for (const arrival of stream.arrivals) streamArrival.push(arrival.toString());
  for (const value of owed) streamFinal.push(value.toString());
  for (const share of stream.bps) streamBps.push(share);
}

const document = {
  $comment: [
    "GENERATED FILE - do not edit by hand. Regenerate with `pnpm vectors:generate:allocation`.",
    "Shared differential vectors for an agent's revenue split, asserted by",
    "packages/sdk/src/agents/allocation.test.ts (vitest) and",
    "packages/contracts/test/agents/RevenueAllocationLib.vectors.t.sol (foundry)",
    "against these same bytes. Expected values come from the naive definition",
    "`received * bps / 10000` computed in the generator; both implementations",
    "under test use an overflow-free decomposition instead, so these vectors",
    "check that the rewrite is exact rather than that a thing equals itself.",
    "Amounts are decimal strings because JSON has no uint256.",
    "Arrays are flat and index-aligned; leg arrays use a fixed stride of 4,",
    "ordered operations, buybacks, developer, protocol.",
  ].join(" "),
  seed: SEED,
  bounds: {
    bpsDenominator: BPS_DENOMINATOR.toString(),
    legCount: LEG_COUNT,
    maxUnallocatedDust: MAX_UNALLOCATED_DUST.toString(),
  },
  legs: ["operations", "buybacks", "developer", "protocol"],

  caseCount: allCases.length,
  probeCount: probeReceived.length,
  invalidCount: invalid.length,
  streamCount: streams.length,
  bpsStride: BPS_STRIDE,

  caseNames: allCases.map((c) => c.name),
  caseWhy: allCases.map((c) => c.why),
  caseBps: allCases.flatMap((c) => [...c.bps]),

  probeCase,
  probeReceived,
  probeEntitlement,
  probeDust,

  streamNames: streams.map((s) => s.name),
  streamWhy: streams.map((s) => s.why),
  streamBps,
  streamTotal,
  streamArrivalCount,
  streamArrival,
  streamFinal,

  invalidNames: invalid.map((c) => c.name),
  invalidWhy: invalid.map((c) => c.why),
  invalidError: invalid.map((c) => c.error),
  invalidBps: invalid.flatMap((c) => [...c.bps]),
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(document, null, 2)}\n`, "utf8");

console.log(`wrote ${OUT_PATH}`);
console.log(
  `  ${allCases.length} allocations (${cases.length} hand-written, ${allCases.length - cases.length} seeded)`,
);
console.log(`  ${probeReceived.length} probes`);
console.log(
  `  ${streams.length} streaming cases (${streamArrival.length} arrivals)`,
);
console.log(`  ${invalid.length} invalid allocations`);
