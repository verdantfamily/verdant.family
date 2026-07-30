#!/usr/bin/env node
/**
 * Generates packages/sdk/src/models/vectors/schedule.json.
 *
 * These vectors are the contract between two implementations of the fee
 * schedule: ScheduleLib.sol, which decides what traders actually pay, and
 * schedule.ts, which decides what the interface promises they will pay. If those
 * two ever disagree, the interface lies — and it lies most convincingly at
 * exactly the moments that matter, the stage boundaries.
 *
 * Three rules make that guarantee real:
 *
 *  1. The vectors are generated BEFORE either implementation exists, so neither
 *     can be written to fit them.
 *
 *  2. Expected values are computed here by a deliberately naive linear scan
 *     (`referenceFeeAt` below) that is obvious by inspection. It is NOT the
 *     optimized library, and it does not import from it. If the generator
 *     imported schedule.ts, the differential test would be checking that a
 *     thing equals itself.
 *
 *  3. Randomized cases come from a fixed seed, so the corpus is identical on
 *     every machine and in CI. A vector that fails is reproducible by anyone.
 *
 * Usage: pnpm vectors:generate
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "../src/models/vectors/schedule.json");

// --- bounds ---------------------------------------------------------------
// Duplicated as literals rather than imported from @verdant/config on purpose:
// this generator must not change behaviour because a config file changed. If a
// bound moves, these vectors should fail to regenerate identically and somebody
// should have to look at why.

const MIN_STAGES = 1;
const MAX_STAGES = 8;
const MIN_FEE_PPM = 100;
const MAX_FEE_PPM = 100_000;
const MIN_STAGE_GAP = 300;
const MAX_HORIZON = 730 * 24 * 60 * 60; // 63_072_000

const SEED = 0x5645524e; // "VERN"

// --- types ----------------------------------------------------------------

interface Stage {
  readonly startOffset: number;
  readonly feePpm: number;
}

interface Case {
  name: string;
  why: string;
  model: number;
  initTime: number;
  stageCount: number;
  offsets: number[];
  fees: number[];
  probeTimes: number[];
  probeFees: number[];
  probeStages: number[];
}

interface InvalidCase {
  name: string;
  why: string;
  model: number;
  initTime: number;
  stageCount: number;
  offsets: number[];
  fees: number[];
  error: string;
}

// --- reference implementation ---------------------------------------------

/**
 * The definition of the fee schedule, written as plainly as possible.
 *
 * The active stage is the LAST stage whose start offset has elapsed. Before
 * initTime nothing has elapsed, so stage 0 applies — this is a clamp rather
 * than an error because a pool cannot be swapped before it is initialised, and a
 * library that reverts on a timestamp is a library that can brick a swap.
 */
function referenceStageAt(
  stages: readonly Stage[],
  initTime: number,
  t: number,
): number {
  const elapsed = t <= initTime ? 0 : t - initTime;
  let active = 0;
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    if (stage === undefined) throw new Error("unreachable: sparse stages");
    if (stage.startOffset <= elapsed) {
      active = i;
    }
  }
  return active;
}

function referenceFeeAt(
  stages: readonly Stage[],
  initTime: number,
  t: number,
): number {
  const index = referenceStageAt(stages, initTime, t);
  const stage = stages[index];
  if (stage === undefined) throw new Error("unreachable: sparse stages");
  return stage.feePpm;
}

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

// --- case construction ----------------------------------------------------

function buildCase(
  name: string,
  why: string,
  initTime: number,
  stages: readonly Stage[],
  extraProbes: readonly number[] = [],
  model = 0,
): Case {
  const probeSet = new Set<number>();

  const add = (t: number): void => {
    // Timestamps are unsigned on-chain; a negative probe is not expressible.
    if (t >= 0) probeSet.add(t);
  };

  // Before the pool exists, at the instant it is created, and just after.
  add(initTime - 1000);
  add(initTime - 1);
  add(initTime);
  add(initTime + 1);

  // The boundaries. One second either side of every transition plus the
  // transition itself: this is where an off-by-one in a comparison operator
  // lives, and where a user watching a countdown will be looking.
  for (const stage of stages) {
    add(initTime + stage.startOffset - 1);
    add(initTime + stage.startOffset);
    add(initTime + stage.startOffset + 1);
  }

  // Well past the final stage, including absurdly far, to prove the schedule
  // holds its last value forever rather than wrapping or reverting.
  const last = stages[stages.length - 1];
  if (last === undefined) throw new Error("a schedule needs at least one stage");
  add(initTime + last.startOffset + MIN_STAGE_GAP);
  add(initTime + last.startOffset + MAX_HORIZON);
  add(initTime + MAX_HORIZON * 4);
  add(2_000_000_000);
  add(4_000_000_000);

  for (const t of extraProbes) add(t);

  const probeTimes = [...probeSet].sort((a, b) => a - b);

  return {
    name,
    why,
    model,
    initTime,
    stageCount: stages.length,
    offsets: stages.map((s) => s.startOffset),
    fees: stages.map((s) => s.feePpm),
    probeTimes,
    probeFees: probeTimes.map((t) => referenceFeeAt(stages, initTime, t)),
    probeStages: probeTimes.map((t) => referenceStageAt(stages, initTime, t)),
  };
}

// --- hand-written cases ---------------------------------------------------

const DAY = 86_400;
const HOUR = 3_600;
const T0 = 1_800_000_000; // a round, plausible mainnet timestamp

const cases: Case[] = [
  buildCase(
    "single-stage-minimum-fee",
    "The degenerate schedule. One stage at offset 0 means the fee is constant forever, and the lower fee bound must survive packing.",
    T0,
    [{ startOffset: 0, feePpm: MIN_FEE_PPM }],
  ),

  buildCase(
    "single-stage-maximum-fee",
    "Upper fee bound, same shape. Together with the case above this pins both ends of the fee field.",
    T0,
    [{ startOffset: 0, feePpm: MAX_FEE_PPM }],
  ),

  buildCase(
    "single-stage-default-fee",
    "The default a creator gets if they change nothing: 1%.",
    T0,
    [{ startOffset: 0, feePpm: 10_000 }],
  ),

  buildCase(
    "two-stage-decaying",
    "The canonical progressive market: a high launch fee stepping down once.",
    T0,
    [
      { startOffset: 0, feePpm: 50_000 },
      { startOffset: 7 * DAY, feePpm: 10_000 },
    ],
  ),

  buildCase(
    "two-stage-rising",
    "Fees are not required to fall. A rising schedule must be handled by exactly the same code path, with no ordering assumption about fee values.",
    T0,
    [
      { startOffset: 0, feePpm: 1_000 },
      { startOffset: 30 * DAY, feePpm: 80_000 },
    ],
  ),

  buildCase(
    "two-stage-equal-fees",
    "Adjacent stages with the same fee are valid: only offsets must strictly increase. A validator that rejects this is over-strict.",
    T0,
    [
      { startOffset: 0, feePpm: 10_000 },
      { startOffset: 14 * DAY, feePpm: 10_000 },
    ],
  ),

  buildCase(
    "three-stage-slot-zero-boundary",
    "Three stages is the largest schedule that must be readable from storage slot 0 alone. The gas snapshot depends on this case.",
    T0,
    [
      { startOffset: 0, feePpm: 30_000 },
      { startOffset: 1 * DAY, feePpm: 20_000 },
      { startOffset: 7 * DAY, feePpm: 10_000 },
    ],
  ),

  buildCase(
    "eight-stage-maximum",
    "The maximum stage count, which is also the case that must read the second storage slot.",
    T0,
    [
      { startOffset: 0, feePpm: 100_000 },
      { startOffset: 1 * HOUR, feePpm: 80_000 },
      { startOffset: 6 * HOUR, feePpm: 60_000 },
      { startOffset: 1 * DAY, feePpm: 40_000 },
      { startOffset: 7 * DAY, feePpm: 20_000 },
      { startOffset: 30 * DAY, feePpm: 10_000 },
      { startOffset: 90 * DAY, feePpm: 5_000 },
      { startOffset: 365 * DAY, feePpm: 100 },
    ],
  ),

  buildCase(
    "eight-stage-minimum-gaps",
    "Eight stages packed as tightly as the 300-second minimum gap allows. Every transition is 300 seconds after the last, so an off-by-one in a gap check shows up here and nowhere else.",
    T0,
    [
      { startOffset: 0, feePpm: 100_000 },
      { startOffset: MIN_STAGE_GAP, feePpm: 90_000 },
      { startOffset: MIN_STAGE_GAP * 2, feePpm: 80_000 },
      { startOffset: MIN_STAGE_GAP * 3, feePpm: 70_000 },
      { startOffset: MIN_STAGE_GAP * 4, feePpm: 60_000 },
      { startOffset: MIN_STAGE_GAP * 5, feePpm: 50_000 },
      { startOffset: MIN_STAGE_GAP * 6, feePpm: 40_000 },
      { startOffset: MIN_STAGE_GAP * 7, feePpm: 30_000 },
    ],
  ),

  buildCase(
    "two-stage-at-horizon",
    "The final stage sits exactly on the 730-day horizon: the last offset that validation must accept.",
    T0,
    [
      { startOffset: 0, feePpm: 40_000 },
      { startOffset: MAX_HORIZON, feePpm: 100 },
    ],
  ),

  buildCase(
    "eight-stage-spanning-horizon",
    "Eight stages spread across the whole permitted horizon, so the offset field is exercised near its maximum in every slot.",
    T0,
    [
      { startOffset: 0, feePpm: 99_999 },
      { startOffset: 9_000_000, feePpm: 87_654 },
      { startOffset: 18_000_000, feePpm: 76_543 },
      { startOffset: 27_000_000, feePpm: 65_432 },
      { startOffset: 36_000_000, feePpm: 54_321 },
      { startOffset: 45_000_000, feePpm: 43_210 },
      { startOffset: 54_000_000, feePpm: 32_109 },
      { startOffset: MAX_HORIZON, feePpm: 101 },
    ],
  ),

  buildCase(
    "eight-stage-extremes-in-last-slot",
    "Both field extremes at once, in the highest stage slot: startOffset at the 730-day horizon and feePpm at the cap, in stage 7 — which lives in word1 at a different shift from stage 0. A mask that is correct for the first word and wrong for the second passes every other case in this corpus.",
    T0,
    [
      { startOffset: 0, feePpm: MIN_FEE_PPM },
      { startOffset: MIN_STAGE_GAP, feePpm: MIN_FEE_PPM },
      { startOffset: MIN_STAGE_GAP * 2, feePpm: MIN_FEE_PPM },
      { startOffset: MIN_STAGE_GAP * 3, feePpm: MIN_FEE_PPM },
      { startOffset: MIN_STAGE_GAP * 4, feePpm: MIN_FEE_PPM },
      { startOffset: MIN_STAGE_GAP * 5, feePpm: MIN_FEE_PPM },
      { startOffset: MIN_STAGE_GAP * 6, feePpm: MIN_FEE_PPM },
      { startOffset: MAX_HORIZON, feePpm: MAX_FEE_PPM },
    ],
  ),

  buildCase(
    "init-time-zero",
    "initTime of 0 is not reachable on a live chain, but it is the value a zeroed storage slot holds. If unpacking is wrong, this is where it shows.",
    0,
    [
      { startOffset: 0, feePpm: 10_000 },
      { startOffset: 1 * DAY, feePpm: 5_000 },
    ],
  ),

  buildCase(
    "init-time-far-future",
    "A large initTime, to confirm the 40-bit field is not silently truncated and that initTime + offset does not overflow anything.",
    1_099_511_627_000,
    [
      { startOffset: 0, feePpm: 25_000 },
      { startOffset: 30 * DAY, feePpm: 12_500 },
    ],
  ),

  buildCase(
    "model-evergreen-tag",
    "The model byte travels in the same header as the schedule and must not disturb it. Same schedule as the two-stage case, different model.",
    T0,
    [
      { startOffset: 0, feePpm: 30_000 },
      { startOffset: 7 * DAY, feePpm: 15_000 },
    ],
    [],
    2,
  ),
];

// --- invalid cases --------------------------------------------------------
// One per failure mode, each asserting its own specific error. A validator that
// returns the right boolean for the wrong reason is not a validator, so these
// name the error rather than merely expecting a revert.

const invalid: InvalidCase[] = [
  {
    name: "zero-stages",
    why: "A schedule with no stages has no defined fee.",
    model: 0,
    initTime: T0,
    stageCount: 0,
    offsets: [],
    fees: [],
    error: "InvalidStageCount",
  },
  {
    name: "nine-stages",
    why: "Above the maximum the ninth stage has nowhere to live in two storage slots.",
    model: 0,
    initTime: T0,
    stageCount: 9,
    offsets: [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400],
    fees: [
      100_000, 90_000, 80_000, 70_000, 60_000, 50_000, 40_000, 30_000, 20_000,
    ],
    error: "InvalidStageCount",
  },
  {
    name: "first-offset-non-zero",
    why: "If stage 0 does not start at the pool's own initialisation, the fee between initTime and the first offset is undefined.",
    model: 0,
    initTime: T0,
    stageCount: 2,
    offsets: [1, 1 * DAY],
    fees: [50_000, 10_000],
    error: "FirstOffsetNonZero",
  },
  {
    name: "offsets-equal",
    why: "Two stages starting at the same instant make the active fee ambiguous.",
    model: 0,
    initTime: T0,
    stageCount: 2,
    offsets: [0, 0],
    fees: [50_000, 10_000],
    error: "ScheduleNotIncreasing",
  },
  {
    name: "offsets-decreasing",
    why: "Out-of-order offsets mean a stage can never be active.",
    model: 0,
    initTime: T0,
    stageCount: 3,
    offsets: [0, 2 * DAY, 1 * DAY],
    fees: [50_000, 30_000, 10_000],
    error: "ScheduleNotIncreasing",
  },
  {
    name: "gap-one-second-under-minimum",
    why: "299 seconds. The boundary case that a >= / > mix-up in the gap check would let through.",
    model: 0,
    initTime: T0,
    stageCount: 2,
    offsets: [0, MIN_STAGE_GAP - 1],
    fees: [50_000, 10_000],
    error: "StageGapTooSmall",
  },
  {
    name: "gap-too-small-late-in-schedule",
    why: "The gap check must apply to every adjacent pair, not only the first.",
    model: 0,
    initTime: T0,
    stageCount: 4,
    offsets: [0, 1 * DAY, 2 * DAY, 2 * DAY + 10],
    fees: [50_000, 40_000, 30_000, 20_000],
    error: "StageGapTooSmall",
  },
  {
    name: "horizon-exceeded-by-one-second",
    why: "One second past 730 days. Also the boundary the on-horizon valid case pins from below.",
    model: 0,
    initTime: T0,
    stageCount: 2,
    offsets: [0, MAX_HORIZON + 1],
    fees: [50_000, 10_000],
    error: "HorizonExceeded",
  },
  {
    name: "fee-below-minimum",
    why: "99 ppm. A fee of zero or near-zero makes the position uneconomic to hold.",
    model: 0,
    initTime: T0,
    stageCount: 1,
    offsets: [0],
    fees: [MIN_FEE_PPM - 1],
    error: "FeeOutOfBounds",
  },
  {
    name: "fee-zero",
    why: "Zero is the value an uninitialised field holds, so it must be rejected explicitly rather than by accident.",
    model: 0,
    initTime: T0,
    stageCount: 1,
    offsets: [0],
    fees: [0],
    error: "FeeOutOfBounds",
  },
  {
    name: "fee-above-maximum",
    why: "100_001 ppm. Above Verdant's cap, though still far below Uniswap's own 1_000_000.",
    model: 0,
    initTime: T0,
    stageCount: 1,
    offsets: [0],
    fees: [MAX_FEE_PPM + 1],
    error: "FeeOutOfBounds",
  },
  {
    name: "fee-above-maximum-in-last-stage",
    why: "The fee check must apply to every stage, not only the first.",
    model: 0,
    initTime: T0,
    stageCount: 3,
    offsets: [0, 1 * DAY, 2 * DAY],
    fees: [50_000, 30_000, MAX_FEE_PPM + 1],
    error: "FeeOutOfBounds",
  },
  {
    name: "fee-at-uniswap-max",
    why: "1_000_000 ppm is a legal Uniswap fee and an illegal Verdant one. Verdant's cap is a policy, and policies have to be enforced where they are declared.",
    model: 0,
    initTime: T0,
    stageCount: 1,
    offsets: [0],
    fees: [1_000_000],
    error: "FeeOutOfBounds",
  },
];

// --- randomized corpus ----------------------------------------------------

function randomValidStages(random: () => number): Stage[] {
  const stageCount =
    MIN_STAGES + Math.floor(random() * (MAX_STAGES - MIN_STAGES + 1));

  const stages: Stage[] = [];
  let offset = 0;

  for (let i = 0; i < stageCount; i++) {
    if (i > 0) {
      // Leave room for every remaining stage to fit its minimum gap, otherwise
      // the generator would produce configs it then has to discard.
      const remaining = stageCount - i;
      const headroom = MAX_HORIZON - offset - MIN_STAGE_GAP * remaining;
      const extra = headroom > 0 ? Math.floor(random() * headroom) : 0;
      offset += MIN_STAGE_GAP + extra;
    }
    const feePpm =
      MIN_FEE_PPM + Math.floor(random() * (MAX_FEE_PPM - MIN_FEE_PPM + 1));
    stages.push({ startOffset: offset, feePpm });
  }

  return stages;
}

function generateRandomCases(count: number): Case[] {
  const random = makeRandom(SEED);
  const generated: Case[] = [];

  for (let i = 0; i < count; i++) {
    const stages = randomValidStages(random);
    // Spread initTime over the plausible range rather than reusing one value,
    // so a bug that only appears for certain header bit patterns has a chance
    // to show up.
    const initTime = Math.floor(random() * 2_000_000_000);

    // A few random probe points on top of the structural ones, biased into the
    // schedule's own span where the interesting behaviour is.
    const last = stages[stages.length - 1];
    if (last === undefined) throw new Error("unreachable: empty stages");
    const span = Math.max(last.startOffset, MIN_STAGE_GAP);
    const extraProbes = [
      initTime + Math.floor(random() * span),
      initTime + Math.floor(random() * span),
      initTime + Math.floor(random() * span * 2),
    ];

    generated.push(
      buildCase(
        `random-${String(i).padStart(3, "0")}`,
        "Seeded randomized configuration.",
        initTime,
        stages,
        extraProbes,
        Math.floor(random() * 3),
      ),
    );
  }

  return generated;
}

// --- emit -----------------------------------------------------------------

const allCases = [...cases, ...generateRandomCases(500)];

/**
 * The file is emitted as flat, index-aligned arrays rather than as an array of
 * nested case objects.
 *
 * This is for Foundry's benefit and it is not a cosmetic choice. `vm.parseJson`
 * re-parses the document on every call, so a nested shape would need roughly
 * five parse calls per case — about 2 600 full parses of a 700 KB file — which
 * turns a millisecond test into a multi-minute one. Flat arrays reduce the whole
 * corpus to a fixed handful of `parseJsonUintArray` calls, after which both
 * suites loop in their own language.
 *
 * There is exactly one numeric encoding, read by both suites, so the two cannot
 * drift. The `caseNames` / `caseWhy` arrays are index-aligned metadata so a
 * failure reports which case failed and why that case exists.
 *
 * Stage arrays are zero-padded to a fixed stride so an index is arithmetic
 * rather than a lookup.
 */
const VALID_STRIDE = MAX_STAGES; // 8
const INVALID_STRIDE = MAX_STAGES + 1; // 9, so the over-length case still fits

function padTo(values: readonly number[], stride: number): number[] {
  if (values.length > stride) {
    throw new Error(`stage list of ${values.length} exceeds stride ${stride}`);
  }
  return [...values, ...Array<number>(stride - values.length).fill(0)];
}

const probeCase: number[] = [];
const probeTime: number[] = [];
const probeFee: number[] = [];
const probeStage: number[] = [];

allCases.forEach((c, caseIndex) => {
  c.probeTimes.forEach((t, probeIndex) => {
    const fee = c.probeFees[probeIndex];
    const stage = c.probeStages[probeIndex];
    if (fee === undefined || stage === undefined) {
      throw new Error(`case ${c.name}: probe arrays are ragged`);
    }
    probeCase.push(caseIndex);
    probeTime.push(t);
    probeFee.push(fee);
    probeStage.push(stage);
  });
});

const document = {
  $comment: [
    "GENERATED FILE - do not edit by hand. Regenerate with `pnpm vectors:generate`.",
    "Shared differential vectors for the fee schedule, asserted by",
    "packages/sdk/src/models/schedule.test.ts (vitest) and",
    "packages/contracts/test/ScheduleLib.vectors.t.sol (foundry) against these",
    "same bytes. Expected values come from a naive reference scan in the",
    "generator, not from either implementation under test.",
    "Arrays are flat and index-aligned; stage arrays use a fixed stride.",
  ].join(" "),
  seed: SEED,
  bounds: {
    minStages: MIN_STAGES,
    maxStages: MAX_STAGES,
    minFeePpm: MIN_FEE_PPM,
    maxFeePpm: MAX_FEE_PPM,
    minStageGap: MIN_STAGE_GAP,
    maxHorizon: MAX_HORIZON,
  },

  caseCount: allCases.length,
  probeCount: probeTime.length,
  invalidCount: invalid.length,
  validStride: VALID_STRIDE,
  invalidStride: INVALID_STRIDE,

  caseNames: allCases.map((c) => c.name),
  caseWhy: allCases.map((c) => c.why),
  caseModel: allCases.map((c) => c.model),
  caseInitTime: allCases.map((c) => c.initTime),
  caseStageCount: allCases.map((c) => c.stageCount),
  caseOffsets: allCases.flatMap((c) => padTo(c.offsets, VALID_STRIDE)),
  caseFees: allCases.flatMap((c) => padTo(c.fees, VALID_STRIDE)),

  probeCase,
  probeTime,
  probeFee,
  probeStage,

  invalidNames: invalid.map((c) => c.name),
  invalidWhy: invalid.map((c) => c.why),
  invalidError: invalid.map((c) => c.error),
  invalidModel: invalid.map((c) => c.model),
  invalidInitTime: invalid.map((c) => c.initTime),
  invalidStageCount: invalid.map((c) => c.stageCount),
  invalidOffsets: invalid.flatMap((c) => padTo(c.offsets, INVALID_STRIDE)),
  invalidFees: invalid.flatMap((c) => padTo(c.fees, INVALID_STRIDE)),
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(document, null, 2)}\n`, "utf8");

console.log(`wrote ${OUT_PATH}`);
console.log(
  `  ${allCases.length} valid cases (${cases.length} hand-written, ${allCases.length - cases.length} seeded)`,
);
console.log(`  ${probeTime.length} probes`);
console.log(`  ${invalid.length} invalid configurations`);
