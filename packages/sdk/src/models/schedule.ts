/**
 * The TypeScript twin of ScheduleLib.sol.
 *
 * This file and `packages/contracts/src/libraries/ScheduleLib.sol` are two
 * implementations of one definition, and they are asserted equal against shared
 * vectors by two test suites. The Solidity decides what a trader pays; this
 * decides what the interface promises they will pay. If the two can disagree,
 * the interface lies — most convincingly at a stage boundary, which is exactly
 * where someone is watching a countdown and deciding whether to trade.
 *
 * Consequences for how this file is written:
 *
 *  - **Function names, error ids and check order match the Solidity exactly.** A
 *    reviewer must be able to read them side by side. Where the shape differs
 *    (a config object here, positional arguments there) it differs only because
 *    the languages differ.
 *
 *  - **No floating point anywhere.** Every value is an integer `number` or a
 *    `bigint`. There is no division that is not exact, and `Math.floor` appears
 *    only where the operand is provably even. A rounding difference of one ppm
 *    between the two implementations would be a real bug in a real fee.
 *
 *  - **Timestamps are seconds, and never block numbers.** On Robinhood Chain
 *    `block.number` is the L1 block number; see docs/verification.md V7. That
 *    matters here because the SDK is where a countdown is computed, and a
 *    countdown derived from block heights would be wrong by a factor of ~119.
 */

// --- bounds ---------------------------------------------------------------
// Mirrored in ScheduleLib.sol and in @verdant/config, asserted equal by the
// differential vectors. These copies must never disagree.

export const MAX_STAGES = 8;
export const MIN_FEE_PPM = 100;
export const MAX_FEE_PPM = 100_000;
export const MIN_STAGE_GAP = 300;
export const MAX_HORIZON = 730 * 24 * 60 * 60; // 63_072_000

/** Stages that fit in `word0` alongside the header. See ScheduleLib's layout. */
export const STAGES_IN_FIRST_WORD = 4;

// --- layout ---------------------------------------------------------------
// Bit widths and shifts, identical to the Solidity.

const MODEL_BITS = 8n;
const STAGE_COUNT_BITS = 8n;
const INIT_TIME_BITS = 40n;
const HEADER_BITS = MODEL_BITS + STAGE_COUNT_BITS + INIT_TIME_BITS; // 56n

const OFFSET_BITS = 28n;
const FEE_BITS = 20n;
const STAGE_BITS = OFFSET_BITS + FEE_BITS; // 48n

const MODEL_SHIFT = 0n;
const STAGE_COUNT_SHIFT = MODEL_BITS; // 8n
const INIT_TIME_SHIFT = MODEL_BITS + STAGE_COUNT_BITS; // 16n

const MASK_U8 = 0xffn;
const MASK_U40 = (1n << INIT_TIME_BITS) - 1n;
const MASK_U28 = (1n << OFFSET_BITS) - 1n;
const MASK_U20 = (1n << FEE_BITS) - 1n;
const MASK_STAGE = (1n << STAGE_BITS) - 1n;

const STAGES_IN_FIRST_WORD_BIG = BigInt(STAGES_IN_FIRST_WORD);

/** Bits in one EVM word. */
const WORD_BITS = 256n;

/**
 * The field widths, exported for the same reason `ScheduleLib` makes them
 * `internal`: they are part of the definition rather than an implementation
 * detail, and a field too narrow to hold its own bound is the one bug here that
 * no behavioural test is guaranteed to catch. Both suites assert each field's
 * capacity against the bound it must represent.
 *
 * `startOffset` needs 26 bits to hold MAX_HORIZON and has 28; `feePpm` needs 17
 * to hold MAX_FEE_PPM and has 20.
 */
export const LAYOUT = {
  modelBits: MODEL_BITS,
  stageCountBits: STAGE_COUNT_BITS,
  initTimeBits: INIT_TIME_BITS,
  headerBits: HEADER_BITS,
  offsetBits: OFFSET_BITS,
  feeBits: FEE_BITS,
  stageBits: STAGE_BITS,
  wordBits: WORD_BITS,
} as const;

// --- types ----------------------------------------------------------------

/** One step of the schedule. */
export interface Stage {
  /**
   * Seconds after the pool's initTime at which this stage becomes active.
   * Stage 0 is always 0.
   */
  readonly startOffset: number;
  /** LP fee while active, in hundredths of a basis point. 10_000 is 1%. */
  readonly feePpm: number;
}

export interface ScheduleConfig {
  /** Model discriminant, carried in the header alongside the schedule. */
  readonly model: number;
  /** Pool initialisation time, in seconds. All offsets are relative to this. */
  readonly initTime: number;
  readonly stages: readonly Stage[];
}

/** Two 256-bit words, matching the on-chain storage layout exactly. */
export interface PackedSchedule {
  readonly word0: bigint;
  readonly word1: bigint;
}

// --- errors ---------------------------------------------------------------

/**
 * Error ids identical to the Solidity error names.
 *
 * The ids are the contract between the two implementations: a config rejected
 * on-chain with `StageGapTooSmall` must be rejected here with `StageGapTooSmall`
 * and not merely rejected. That is what lets the create form tell someone which
 * rule they broke before they spend gas discovering it.
 */
export const ScheduleErrorId = {
  InvalidStageCount: "InvalidStageCount",
  FirstOffsetNonZero: "FirstOffsetNonZero",
  ScheduleNotIncreasing: "ScheduleNotIncreasing",
  StageGapTooSmall: "StageGapTooSmall",
  HorizonExceeded: "HorizonExceeded",
  FeeOutOfBounds: "FeeOutOfBounds",
} as const;

export type ScheduleErrorId =
  (typeof ScheduleErrorId)[keyof typeof ScheduleErrorId];

export class ScheduleError extends Error {
  readonly id: ScheduleErrorId;
  /** The offending stage index, where the error is about a specific stage. */
  readonly index: number | undefined;

  constructor(id: ScheduleErrorId, message: string, index?: number) {
    super(message);
    this.name = "ScheduleError";
    this.id = id;
    this.index = index;
  }
}

// --- validation -----------------------------------------------------------

/**
 * Throws a `ScheduleError` unless `config.stages` is a well-formed schedule.
 *
 * Checks run in the same order as `ScheduleLib.validate`, from the most
 * structural to the most local, so the error someone sees is the one they have
 * to fix first: a schedule with nine stages and a bad fee reports the stage
 * count.
 */
export function validate(config: ScheduleConfig): void {
  const { stages } = config;
  const count = stages.length;

  if (count === 0 || count > MAX_STAGES) {
    throw new ScheduleError(
      ScheduleErrorId.InvalidStageCount,
      `a schedule needs between 1 and ${MAX_STAGES} stages, got ${count}`,
    );
  }

  const first = stages[0];
  if (first === undefined) {
    throw new ScheduleError(
      ScheduleErrorId.InvalidStageCount,
      "a schedule needs at least one stage",
    );
  }
  if (first.startOffset !== 0) {
    throw new ScheduleError(
      ScheduleErrorId.FirstOffsetNonZero,
      `the first stage must start at the pool's initialisation, got offset ${first.startOffset}`,
      0,
    );
  }

  let previousOffset = 0;
  for (let i = 0; i < count; i++) {
    const stage = stages[i];
    if (stage === undefined) {
      throw new ScheduleError(
        ScheduleErrorId.InvalidStageCount,
        `stage ${i} is missing`,
        i,
      );
    }
    const { startOffset: offset, feePpm: fee } = stage;

    if (i > 0) {
      if (offset <= previousOffset) {
        throw new ScheduleError(
          ScheduleErrorId.ScheduleNotIncreasing,
          `stage offsets must strictly increase: stage ${i} starts at ${offset}, after ${previousOffset}`,
          i,
        );
      }
      const gap = offset - previousOffset;
      if (gap < MIN_STAGE_GAP) {
        throw new ScheduleError(
          ScheduleErrorId.StageGapTooSmall,
          `stages must be at least ${MIN_STAGE_GAP} seconds apart, stage ${i} is ${gap}`,
          i,
        );
      }
    }

    if (offset > MAX_HORIZON) {
      throw new ScheduleError(
        ScheduleErrorId.HorizonExceeded,
        `stage ${i} starts ${offset} seconds in, beyond the ${MAX_HORIZON} second horizon`,
        i,
      );
    }

    // Checked for every stage, not only the first: a schedule whose last stage
    // is out of bounds is just as broken as one whose first is.
    if (fee < MIN_FEE_PPM || fee > MAX_FEE_PPM) {
      throw new ScheduleError(
        ScheduleErrorId.FeeOutOfBounds,
        `stage ${i} fee ${fee} ppm is outside [${MIN_FEE_PPM}, ${MAX_FEE_PPM}]`,
        i,
      );
    }

    previousOffset = offset;
  }
}

/** Non-throwing form of `validate`. */
export function isValid(config: ScheduleConfig): boolean {
  try {
    validate(config);
    return true;
  } catch (error) {
    if (error instanceof ScheduleError) return false;
    throw error;
  }
}

// --- packing --------------------------------------------------------------

/**
 * Validates and packs a schedule into two words.
 *
 * Validation is not optional. Every field is written through a mask, so an
 * out-of-range value would otherwise be silently truncated into a different,
 * valid-looking schedule — the worst possible failure for a parameter that
 * becomes immutable.
 */
export function pack(config: ScheduleConfig): PackedSchedule {
  validate(config);

  const { model, initTime, stages } = config;
  const count = stages.length;

  let word0 =
    ((BigInt(model) & MASK_U8) << MODEL_SHIFT) |
    ((BigInt(count) & MASK_U8) << STAGE_COUNT_SHIFT) |
    ((BigInt(initTime) & MASK_U40) << INIT_TIME_SHIFT);
  let word1 = 0n;

  for (let i = 0; i < count; i++) {
    const stage = stages[i];
    if (stage === undefined) throw new Error("unreachable: validated stages");

    const encoded =
      (BigInt(stage.startOffset) & MASK_U28) |
      ((BigInt(stage.feePpm) & MASK_U20) << OFFSET_BITS);

    const slot = BigInt(i);
    if (i < STAGES_IN_FIRST_WORD) {
      word0 |= encoded << (HEADER_BITS + slot * STAGE_BITS);
    } else {
      word1 |= encoded << ((slot - STAGES_IN_FIRST_WORD_BIG) * STAGE_BITS);
    }
  }

  return { word0, word1 };
}

/** Expands a packed schedule back into its fields. */
export function unpack(packed: PackedSchedule): ScheduleConfig {
  const { word0, word1 } = packed;

  const model = Number((word0 >> MODEL_SHIFT) & MASK_U8);
  const initTime = Number((word0 >> INIT_TIME_SHIFT) & MASK_U40);
  const count = Number((word0 >> STAGE_COUNT_SHIFT) & MASK_U8);

  const stages: Stage[] = [];
  for (let i = 0; i < count; i++) {
    const slot = BigInt(i);
    const encoded =
      i < STAGES_IN_FIRST_WORD
        ? (word0 >> (HEADER_BITS + slot * STAGE_BITS)) & MASK_STAGE
        : (word1 >> ((slot - STAGES_IN_FIRST_WORD_BIG) * STAGE_BITS)) &
          MASK_STAGE;

    stages.push({
      startOffset: Number(encoded & MASK_U28),
      feePpm: Number((encoded >> OFFSET_BITS) & MASK_U20),
    });
  }

  return { model, initTime, stages };
}

// --- reading --------------------------------------------------------------

/**
 * The index of the active stage at `timestamp`.
 *
 * For `timestamp <= initTime` the result is stage 0. This is a clamp rather than
 * an error, matching the Solidity, and the reason is worth repeating here: the
 * on-chain version runs inside `beforeSwap`, so a revert there would not report
 * an error to anyone — it would make the pool untradeable. There is no timestamp
 * for which the fee schedule should fail.
 */
export function stageAt(config: ScheduleConfig, timestamp: number): number {
  const { stages, initTime } = config;
  const elapsed = timestamp > initTime ? timestamp - initTime : 0;

  for (let i = stages.length; i > 0; i--) {
    const index = i - 1;
    const stage = stages[index];
    if (stage === undefined) continue;
    if (stage.startOffset <= elapsed) return index;
  }

  // Unreachable for a validated schedule, whose stage 0 has offset 0. Returning
  // 0 rather than throwing keeps the no-failure guarantee true even for a
  // schedule that bypassed validation.
  return 0;
}

/** The active LP fee at `timestamp`, in ppm. Never throws. */
export function feeAt(config: ScheduleConfig, timestamp: number): number {
  const stage = config.stages[stageAt(config, timestamp)];
  if (stage === undefined) {
    throw new Error("unreachable: stageAt returned an out-of-range index");
  }
  return stage.feePpm;
}

/** The number of stages in a schedule. */
export function stageCount(config: ScheduleConfig): number {
  return config.stages.length;
}

/**
 * The timestamp of the next transition, or `undefined` if none remains.
 *
 * `undefined` rather than the Solidity's `0` sentinel, because TypeScript can
 * express absence and a caller that forgets to check gets a type error rather
 * than a countdown to the epoch.
 */
export function nextTransition(
  config: ScheduleConfig,
  timestamp: number,
): number | undefined {
  const current = stageAt(config, timestamp);
  const next = config.stages[current + 1];
  if (next === undefined) return undefined;
  return config.initTime + next.startOffset;
}

/**
 * Seconds until the next transition, or `undefined` if none remains.
 *
 * Returns 0 rather than a negative number if the transition has just passed, so
 * a countdown never renders as negative time.
 */
export function secondsUntilNextTransition(
  config: ScheduleConfig,
  timestamp: number,
): number | undefined {
  const next = nextTransition(config, timestamp);
  if (next === undefined) return undefined;
  return next > timestamp ? next - timestamp : 0;
}
