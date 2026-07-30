import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
  LAYOUT,
  MAX_FEE_PPM,
  MAX_HORIZON,
  MAX_STAGES,
  MIN_FEE_PPM,
  MIN_STAGE_GAP,
  STAGES_IN_FIRST_WORD,
  ScheduleError,
  feeAt,
  isValid,
  pack,
  stageAt,
  unpack,
  validate,
  type ScheduleConfig,
  type Stage,
} from "./schedule.js";

/**
 * The TypeScript half of the differential harness.
 *
 * packages/contracts/test/ScheduleLib.vectors.t.sol asserts the same expected
 * values from the same file. Neither implementation may be adjusted to satisfy
 * these vectors: the vectors were generated first, from an independent reference
 * scan, and the expected values are what the schedule *means*.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = resolve(HERE, "vectors/schedule.json");

interface Vectors {
  readonly seed: number;
  readonly bounds: {
    readonly minStages: number;
    readonly maxStages: number;
    readonly minFeePpm: number;
    readonly maxFeePpm: number;
    readonly minStageGap: number;
    readonly maxHorizon: number;
  };
  readonly caseCount: number;
  readonly probeCount: number;
  readonly invalidCount: number;
  readonly validStride: number;
  readonly invalidStride: number;
  readonly caseNames: readonly string[];
  readonly caseWhy: readonly string[];
  readonly caseModel: readonly number[];
  readonly caseInitTime: readonly number[];
  readonly caseStageCount: readonly number[];
  readonly caseOffsets: readonly number[];
  readonly caseFees: readonly number[];
  readonly probeCase: readonly number[];
  readonly probeTime: readonly number[];
  readonly probeFee: readonly number[];
  readonly probeStage: readonly number[];
  readonly invalidNames: readonly string[];
  readonly invalidWhy: readonly string[];
  readonly invalidError: readonly string[];
  readonly invalidModel: readonly number[];
  readonly invalidInitTime: readonly number[];
  readonly invalidStageCount: readonly number[];
  readonly invalidOffsets: readonly number[];
  readonly invalidFees: readonly number[];
}

let vectors: Vectors;
let configs: ScheduleConfig[];

/** Index into a flat array, refusing to silently read undefined. */
function at(values: readonly number[], index: number, what: string): number {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`${what}: index ${index} out of range`);
  }
  return value;
}

function readStages(
  offsets: readonly number[],
  fees: readonly number[],
  caseIndex: number,
  stride: number,
  stageCount: number,
): Stage[] {
  const stages: Stage[] = [];
  for (let i = 0; i < stageCount; i++) {
    const flat = caseIndex * stride + i;
    stages.push({
      startOffset: at(offsets, flat, "offsets"),
      feePpm: at(fees, flat, "fees"),
    });
  }
  return stages;
}

beforeAll(() => {
  vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vectors;

  configs = [];
  for (let i = 0; i < vectors.caseCount; i++) {
    configs.push({
      model: at(vectors.caseModel, i, "caseModel"),
      initTime: at(vectors.caseInitTime, i, "caseInitTime"),
      stages: readStages(
        vectors.caseOffsets,
        vectors.caseFees,
        i,
        vectors.validStride,
        at(vectors.caseStageCount, i, "caseStageCount"),
      ),
    });
  }
});

describe("vector corpus integrity", () => {
  it("is the corpus both suites expect", () => {
    // If this fails, someone regenerated the vectors without rerunning the
    // Solidity side, and the differential guarantee is void until they do.
    expect(vectors.caseCount).toBe(515);
    expect(vectors.probeCount).toBe(11_435);
    expect(vectors.invalidCount).toBe(13);
    expect(vectors.seed).toBe(0x5645524e);
  });

  it("agrees with the bounds the implementation enforces", () => {
    expect(vectors.bounds.maxStages).toBe(MAX_STAGES);
  });

  it("has index-aligned arrays", () => {
    expect(vectors.caseOffsets.length).toBe(
      vectors.caseCount * vectors.validStride,
    );
    expect(vectors.caseFees.length).toBe(vectors.caseCount * vectors.validStride);
    expect(vectors.probeTime.length).toBe(vectors.probeCount);
    expect(vectors.probeFee.length).toBe(vectors.probeCount);
    expect(vectors.probeStage.length).toBe(vectors.probeCount);
    expect(vectors.probeCase.length).toBe(vectors.probeCount);
  });
});

describe("feeAt and stageAt against the shared vectors", () => {
  it("matches every expected fee and stage", () => {
    let checked = 0;

    for (let p = 0; p < vectors.probeCount; p++) {
      const caseIndex = at(vectors.probeCase, p, "probeCase");
      const config = configs[caseIndex];
      if (config === undefined) {
        throw new Error(`probe ${p} references unknown case ${caseIndex}`);
      }

      const t = at(vectors.probeTime, p, "probeTime");
      const expectedFee = at(vectors.probeFee, p, "probeFee");
      const expectedStage = at(vectors.probeStage, p, "probeStage");

      const actualFee = feeAt(config, t);
      const actualStage = stageAt(config, t);

      if (actualFee !== expectedFee || actualStage !== expectedStage) {
        // Build the message only on failure: doing it eagerly for 11 405 probes
        // dominates the runtime of the whole suite.
        const name = vectors.caseNames[caseIndex] ?? `case ${caseIndex}`;
        throw new Error(
          `${name} at t=${t} (initTime + ${t - config.initTime}): ` +
            `expected fee ${expectedFee} stage ${expectedStage}, ` +
            `got fee ${actualFee} stage ${actualStage}\n` +
            `  why this case exists: ${vectors.caseWhy[caseIndex]}`,
        );
      }
      checked += 1;
    }

    expect(checked).toBe(vectors.probeCount);
  });
});

describe("pack and unpack", () => {
  it("round-trips every valid case exactly", () => {
    for (let i = 0; i < vectors.caseCount; i++) {
      const config = configs[i];
      if (config === undefined) throw new Error("unreachable");
      const name = vectors.caseNames[i] ?? `case ${i}`;

      const restored = unpack(pack(config));

      expect(restored.model, name).toBe(config.model);
      expect(restored.initTime, name).toBe(config.initTime);
      expect(restored.stages.length, name).toBe(config.stages.length);
      for (let s = 0; s < config.stages.length; s++) {
        expect(restored.stages[s], `${name} stage ${s}`).toEqual(
          config.stages[s],
        );
      }
    }
  });

  it("gives a packed schedule the same fees as an unpacked one", () => {
    // A packing bug that survives round-tripping but corrupts a read would be
    // invisible to the test above.
    for (let p = 0; p < vectors.probeCount; p++) {
      const caseIndex = at(vectors.probeCase, p, "probeCase");
      const config = configs[caseIndex];
      if (config === undefined) throw new Error("unreachable");
      const t = at(vectors.probeTime, p, "probeTime");
      expect(feeAt(unpack(pack(config)), t)).toBe(
        at(vectors.probeFee, p, "probeFee"),
      );
    }
  });

  it("fits a schedule of four or fewer stages entirely in the first word", () => {
    // The storage-slot property the gas snapshot depends on. Expressed here too
    // because it is a property of the encoding, not of Solidity.
    for (let i = 0; i < vectors.caseCount; i++) {
      const config = configs[i];
      if (config === undefined) throw new Error("unreachable");
      if (config.stages.length > STAGES_IN_FIRST_WORD) continue;
      const packed = pack(config);
      expect(packed.word1, vectors.caseNames[i]).toBe(0n);
    }
  });

  it("uses the second word once a schedule needs more stages than the first holds", () => {
    const eightStage = configs.find((c) => c.stages.length === 8);
    expect(eightStage).toBeDefined();
    if (eightStage === undefined) return;
    expect(pack(eightStage).word1).not.toBe(0n);
  });
});

describe("validation", () => {
  it("accepts every valid case", () => {
    for (let i = 0; i < vectors.caseCount; i++) {
      const config = configs[i];
      if (config === undefined) throw new Error("unreachable");
      expect(() => validate(config), vectors.caseNames[i]).not.toThrow();
      expect(isValid(config), vectors.caseNames[i]).toBe(true);
    }
  });

  it("rejects each invalid case with its own specific error", () => {
    for (let i = 0; i < vectors.invalidCount; i++) {
      const name = vectors.invalidNames[i] ?? `invalid ${i}`;
      const expectedError = vectors.invalidError[i];
      const config: ScheduleConfig = {
        model: at(vectors.invalidModel, i, "invalidModel"),
        initTime: at(vectors.invalidInitTime, i, "invalidInitTime"),
        stages: readStages(
          vectors.invalidOffsets,
          vectors.invalidFees,
          i,
          vectors.invalidStride,
          at(vectors.invalidStageCount, i, "invalidStageCount"),
        ),
      };

      let thrown: unknown;
      try {
        validate(config);
      } catch (error) {
        thrown = error;
      }

      expect(thrown, `${name}: expected validate() to throw`).toBeInstanceOf(
        ScheduleError,
      );
      // The specific error matters. A validator that rejects everything with one
      // generic failure cannot tell a creator what to fix, and cannot be shown
      // to reject for the right reason.
      expect((thrown as ScheduleError).id, `${name} (${vectors.invalidWhy[i]})`).toBe(
        expectedError,
      );
      expect(isValid(config), name).toBe(false);
    }
  });
});

describe("step-function properties", () => {
  it("is monotone in time: the active stage never moves backwards", () => {
    for (let i = 0; i < vectors.caseCount; i++) {
      const config = configs[i];
      if (config === undefined) throw new Error("unreachable");

      let previous = 0;
      for (const stage of config.stages) {
        for (const delta of [-1, 0, 1]) {
          const index = stageAt(config, config.initTime + stage.startOffset + delta);
          expect(index, vectors.caseNames[i]).toBeGreaterThanOrEqual(previous);
          previous = index;
        }
      }
    }
  });

  it("changes value only at a declared offset", () => {
    // The defining property of a step function: between two adjacent
    // transitions the fee is constant. Sampled at both ends and the midpoint.
    for (let i = 0; i < vectors.caseCount; i++) {
      const config = configs[i];
      if (config === undefined) throw new Error("unreachable");

      for (let s = 0; s < config.stages.length; s++) {
        const stage = config.stages[s];
        const next = config.stages[s + 1];
        if (stage === undefined) throw new Error("unreachable");

        const from = config.initTime + stage.startOffset;
        const to =
          next === undefined
            ? from + vectors.bounds.maxHorizon
            : config.initTime + next.startOffset - 1;
        const mid = from + Math.floor((to - from) / 2);

        for (const t of [from, mid, to]) {
          expect(feeAt(config, t), `${vectors.caseNames[i]} stage ${s}`).toBe(
            stage.feePpm,
          );
        }
      }
    }
  });

  it("clamps to the first stage at and before initTime", () => {
    for (let i = 0; i < vectors.caseCount; i++) {
      const config = configs[i];
      if (config === undefined) throw new Error("unreachable");
      const first = config.stages[0];
      if (first === undefined) throw new Error("unreachable");

      expect(feeAt(config, config.initTime), vectors.caseNames[i]).toBe(
        first.feePpm,
      );
      expect(stageAt(config, config.initTime), vectors.caseNames[i]).toBe(0);
      if (config.initTime > 0) {
        expect(feeAt(config, config.initTime - 1), vectors.caseNames[i]).toBe(
          first.feePpm,
        );
      }
      // Timestamp 0 is not reachable on a live chain, but a library that
      // underflows on it is a library that can be made to underflow.
      expect(() => feeAt(config, 0)).not.toThrow();
    }
  });

  it("holds the final fee forever", () => {
    for (let i = 0; i < vectors.caseCount; i++) {
      const config = configs[i];
      if (config === undefined) throw new Error("unreachable");
      const last = config.stages[config.stages.length - 1];
      if (last === undefined) throw new Error("unreachable");

      const wayPast = config.initTime + last.startOffset + 100 * 365 * 86_400;
      expect(feeAt(config, wayPast), vectors.caseNames[i]).toBe(last.feePpm);
      expect(stageAt(config, wayPast), vectors.caseNames[i]).toBe(
        config.stages.length - 1,
      );
    }
  });

  it("never returns a fee outside the permitted band", () => {
    for (let p = 0; p < vectors.probeCount; p++) {
      const caseIndex = at(vectors.probeCase, p, "probeCase");
      const config = configs[caseIndex];
      if (config === undefined) throw new Error("unreachable");
      const fee = feeAt(config, at(vectors.probeTime, p, "probeTime"));
      expect(fee).toBeGreaterThanOrEqual(vectors.bounds.minFeePpm);
      expect(fee).toBeLessThanOrEqual(vectors.bounds.maxFeePpm);
    }
  });
});

/**
 * The 48-bit stage is narrower than the 56 bits originally specified. That buys a
 * fourth stage in `word0`, but only if both fields still span their full declared
 * range — and this is the one property the corpus cannot establish, because the
 * generator derives its configurations FROM the bounds. A field too small to hold
 * a bound truncates identically on the way in and on the way out, so every round
 * trip in the corpus would still pass.
 */
describe("field capacity", () => {
  it("gives startOffset enough bits for the whole horizon", () => {
    // 730 days = 63_072_000 needs ceil(log2(63_072_001)) = 26 bits.
    const capacity = (1n << LAYOUT.offsetBits) - 1n;
    expect(capacity).toBeGreaterThanOrEqual(BigInt(MAX_HORIZON));
    // Stated as a floor too, so the plausible-looking 24-bit even split — which
    // would hold only 194 days — fails here rather than somewhere subtle.
    expect(LAYOUT.offsetBits).toBeGreaterThanOrEqual(26n);
  });

  it("gives feePpm enough bits for the maximum fee", () => {
    // 100_000 ppm needs ceil(log2(100_001)) = 17 bits.
    const capacity = (1n << LAYOUT.feeBits) - 1n;
    expect(capacity).toBeGreaterThanOrEqual(BigInt(MAX_FEE_PPM));
    expect(LAYOUT.feeBits).toBeGreaterThanOrEqual(17n);
    // Uniswap's own MAX_LP_FEE, which Verdant's policy sits below.
    expect(capacity).toBeGreaterThanOrEqual(1_000_000n);
  });

  it("splits the stage between exactly its two fields", () => {
    expect(LAYOUT.offsetBits + LAYOUT.feeBits).toBe(LAYOUT.stageBits);
  });

  it("puts exactly as many stages in word0 as fit", () => {
    const four =
      LAYOUT.headerBits + BigInt(STAGES_IN_FIRST_WORD) * LAYOUT.stageBits;
    const five =
      LAYOUT.headerBits + BigInt(STAGES_IN_FIRST_WORD + 1) * LAYOUT.stageBits;

    expect(four).toBeLessThanOrEqual(LAYOUT.wordBits);
    expect(five).toBeGreaterThan(LAYOUT.wordBits);
    expect(four).toBe(248n); // 56 + 4 x 48
  });

  it("keeps a stage on the horizon intact through packing", () => {
    const config: ScheduleConfig = {
      model: 0,
      initTime: 1_800_000_000,
      stages: [
        { startOffset: 0, feePpm: 50_000 },
        { startOffset: MAX_HORIZON, feePpm: 12_345 },
      ],
    };

    expect(unpack(pack(config)).stages[1]?.startOffset).toBe(MAX_HORIZON);

    const at730 = config.initTime + MAX_HORIZON;
    expect(feeAt(config, at730)).toBe(12_345);
    expect(stageAt(config, at730)).toBe(1);
    // One second earlier belongs to the previous stage, which is what makes this
    // an assertion about the boundary and not just about a plausible result.
    expect(feeAt(config, at730 - 1)).toBe(50_000);
    expect(stageAt(config, at730 - 1)).toBe(0);
  });

  it("keeps both extremes intact in the highest stage slot", () => {
    // Stage 7 lives in word1 at a different shift from stage 0. A mask correct
    // for one word and wrong for the other passes every test above.
    const stages: Stage[] = [];
    for (let i = 0; i < MAX_STAGES - 1; i++) {
      stages.push({ startOffset: i * MIN_STAGE_GAP, feePpm: 10_000 });
    }
    stages.push({ startOffset: MAX_HORIZON, feePpm: MAX_FEE_PPM });

    const config: ScheduleConfig = { model: 0, initTime: 1_800_000_000, stages };
    const restored = unpack(pack(config));

    expect(restored.stages[7]?.startOffset).toBe(MAX_HORIZON);
    expect(restored.stages[7]?.feePpm).toBe(MAX_FEE_PPM);
    expect(feeAt(config, config.initTime + MAX_HORIZON)).toBe(MAX_FEE_PPM);
    expect(stageAt(config, config.initTime + MAX_HORIZON)).toBe(7);
  });

  it("round-trips the maximum fee in every stage slot", () => {
    for (let slot = 0; slot < MAX_STAGES; slot++) {
      const stages: Stage[] = [];
      for (let i = 0; i < MAX_STAGES; i++) {
        stages.push({
          startOffset: i * MIN_STAGE_GAP,
          feePpm: i === slot ? MAX_FEE_PPM : MIN_FEE_PPM,
        });
      }
      const config: ScheduleConfig = {
        model: 3,
        initTime: 1_800_000_000,
        stages,
      };
      const restored = unpack(pack(config));
      for (let i = 0; i < MAX_STAGES; i++) {
        expect(restored.stages[i], `slot ${slot}, stage ${i}`).toEqual(
          stages[i],
        );
      }
    }
  });
});

/**
 * The Solidity side fuzzes this at 10 000 runs. Doing the same here with a fixed
 * seed rather than a property-testing dependency: the inputs are cheap to
 * construct, and a fixed seed means a failure is reproducible by anyone rather
 * than only by whoever saw it.
 */
describe("pack/unpack round trip, 10 000 seeded configurations", () => {
  /** mulberry32, the same generator the vector script uses. */
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

  it("returns every field exactly as it went in", () => {
    const random = makeRandom(0x52545250); // "RTRP"
    const ITERATIONS = 10_000;

    for (let n = 0; n < ITERATIONS; n++) {
      const stageCount = 1 + Math.floor(random() * MAX_STAGES);
      const stages: Stage[] = [];
      let offset = 0;

      for (let i = 0; i < stageCount; i++) {
        if (i > 0) {
          const remaining = stageCount - i;
          const headroom = MAX_HORIZON - offset - MIN_STAGE_GAP * remaining;
          offset +=
            MIN_STAGE_GAP + (headroom > 0 ? Math.floor(random() * headroom) : 0);
        }
        stages.push({
          startOffset: offset,
          feePpm:
            MIN_FEE_PPM + Math.floor(random() * (MAX_FEE_PPM - MIN_FEE_PPM + 1)),
        });
      }

      const config: ScheduleConfig = {
        model: Math.floor(random() * 256),
        // Up to the full width of the 40-bit initTime field, not merely to
        // plausible present-day timestamps, so the header is exercised across
        // its whole range.
        initTime: Math.floor(random() * 2 ** 40),
        stages,
      };

      const restored = unpack(pack(config));

      expect(restored.model, `iteration ${n}`).toBe(config.model);
      expect(restored.initTime, `iteration ${n}`).toBe(config.initTime);
      expect(restored.stages, `iteration ${n}`).toEqual(config.stages);
    }
  });
});
