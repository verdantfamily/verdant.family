import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
  AllocationError,
  BPS_DENOMINATOR,
  LEGS,
  LEG_COUNT,
  MAX_UNALLOCATED_DUST,
  allocatable,
  allocate,
  emptyLedger,
  entitlement,
  entitlements,
  expectedBalance,
  isValid,
  pending,
  recognise,
  settle,
  totalOf,
  unallocated,
  validate,
  type Allocation,
  type AssetLedger,
  type Leg,
} from "./allocation.js";

/**
 * The TypeScript half of the differential harness.
 *
 * packages/contracts/test/agents/RevenueAllocationLib.vectors.t.sol asserts the
 * same expected values from the same file. Neither implementation may be
 * adjusted to satisfy these vectors: they were generated first, from the naive
 * definition, and they are what the split *means*.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = resolve(HERE, "vectors/allocation.json");

interface Vectors {
  readonly seed: number;
  readonly bounds: {
    readonly bpsDenominator: string;
    readonly legCount: number;
    readonly maxUnallocatedDust: string;
  };
  readonly legs: readonly string[];
  readonly caseCount: number;
  readonly probeCount: number;
  readonly invalidCount: number;
  readonly streamCount: number;
  readonly bpsStride: number;
  readonly caseNames: readonly string[];
  readonly caseWhy: readonly string[];
  readonly caseBps: readonly number[];
  readonly probeCase: readonly number[];
  readonly probeReceived: readonly string[];
  readonly probeEntitlement: readonly string[];
  readonly probeDust: readonly string[];
  readonly streamNames: readonly string[];
  readonly streamWhy: readonly string[];
  readonly streamBps: readonly number[];
  readonly streamTotal: readonly string[];
  readonly streamArrivalCount: readonly number[];
  readonly streamArrival: readonly string[];
  readonly streamFinal: readonly string[];
  readonly invalidNames: readonly string[];
  readonly invalidWhy: readonly string[];
  readonly invalidError: readonly string[];
  readonly invalidBps: readonly number[];
}

let vectors: Vectors;

beforeAll(() => {
  vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vectors;
});

// --- reading the corpus ---------------------------------------------------

function at<T>(values: readonly T[], index: number, what: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`${what}: no entry at ${index}`);
  return value;
}

function allocationFrom(bps: readonly number[], offset: number): Allocation {
  return {
    operations: at(bps, offset, "bps"),
    buybacks: at(bps, offset + 1, "bps"),
    developer: at(bps, offset + 2, "bps"),
    protocol: at(bps, offset + 3, "bps"),
  };
}

function caseAllocation(index: number): Allocation {
  return allocationFrom(vectors.caseBps, index * LEG_COUNT);
}

/** A ledger that has received `amount` and allocated nothing. */
function received(amount: bigint): AssetLedger {
  return recognise(emptyLedger(), amount);
}

// --- corpus integrity -----------------------------------------------------

describe("the corpus", () => {
  it("has the counts it claims", () => {
    expect(vectors.caseCount).toBe(159);
    expect(vectors.probeCount).toBe(4716);
    expect(vectors.streamCount).toBe(5);
    expect(vectors.invalidCount).toBe(5);
    expect(vectors.seed).toBe(0x41474e54);
  });

  it("has index-aligned arrays", () => {
    expect(vectors.caseNames).toHaveLength(vectors.caseCount);
    expect(vectors.caseWhy).toHaveLength(vectors.caseCount);
    expect(vectors.caseBps).toHaveLength(vectors.caseCount * LEG_COUNT);

    expect(vectors.probeCase).toHaveLength(vectors.probeCount);
    expect(vectors.probeReceived).toHaveLength(vectors.probeCount);
    expect(vectors.probeDust).toHaveLength(vectors.probeCount);
    expect(vectors.probeEntitlement).toHaveLength(
      vectors.probeCount * LEG_COUNT,
    );

    expect(vectors.streamArrival).toHaveLength(
      vectors.streamArrivalCount.reduce((total, count) => total + count, 0),
    );
    expect(vectors.streamFinal).toHaveLength(vectors.streamCount * LEG_COUNT);
  });

  it("agrees with the model about the bounds", () => {
    expect(BigInt(vectors.bounds.bpsDenominator)).toBe(BPS_DENOMINATOR);
    expect(vectors.bounds.legCount).toBe(LEG_COUNT);
    expect(BigInt(vectors.bounds.maxUnallocatedDust)).toBe(
      MAX_UNALLOCATED_DUST,
    );
    expect(vectors.legs).toEqual([...LEGS]);
    expect(vectors.bpsStride).toBe(LEG_COUNT);
  });

  it("only contains allocations the model considers valid", () => {
    for (let i = 0; i < vectors.caseCount; i++) {
      expect(
        isValid(caseAllocation(i)),
        `case ${at(vectors.caseNames, i, "name")}`,
      ).toBe(true);
    }
  });
});

// --- entitlements ---------------------------------------------------------

describe("entitlements", () => {
  it("match the vectors at every probe", () => {
    for (let probe = 0; probe < vectors.probeCount; probe++) {
      const caseIndex = at(vectors.probeCase, probe, "probeCase");
      const allocation = caseAllocation(caseIndex);
      const total = BigInt(at(vectors.probeReceived, probe, "probeReceived"));

      const owed = entitlements(received(total), allocation);
      const base = probe * LEG_COUNT;

      LEGS.forEach((leg, index) => {
        const expected = BigInt(
          at(vectors.probeEntitlement, base + index, "probeEntitlement"),
        );
        expect(
          owed[leg],
          `${at(vectors.caseNames, caseIndex, "name")} / ${leg} at ${total}`,
        ).toBe(expected);
      });
    }
  });

  it("leave the dust the vectors expect", () => {
    for (let probe = 0; probe < vectors.probeCount; probe++) {
      const caseIndex = at(vectors.probeCase, probe, "probeCase");
      const total = BigInt(at(vectors.probeReceived, probe, "probeReceived"));
      const expected = BigInt(at(vectors.probeDust, probe, "probeDust"));

      expect(unallocated(received(total), caseAllocation(caseIndex))).toBe(
        expected,
      );
    }
  });

  it("never leave more than three units unallocated", () => {
    for (let probe = 0; probe < vectors.probeCount; probe++) {
      const dust = BigInt(at(vectors.probeDust, probe, "probeDust"));
      expect(dust).toBeGreaterThanOrEqual(0n);
      expect(dust).toBeLessThanOrEqual(MAX_UNALLOCATED_DUST);
    }
  });

  it("reach the three-unit bound somewhere in the corpus", () => {
    // Otherwise `MAX_UNALLOCATED_DUST` is an untested claim: a corpus that never
    // rounds all four legs down at once would pass a bound of any size.
    const worst = vectors.probeDust.reduce(
      (highest, dust) => (BigInt(dust) > highest ? BigInt(dust) : highest),
      0n,
    );
    expect(worst).toBe(MAX_UNALLOCATED_DUST);
  });

  it("give a leg with no share exactly nothing, at every total", () => {
    for (let probe = 0; probe < vectors.probeCount; probe++) {
      const caseIndex = at(vectors.probeCase, probe, "probeCase");
      const allocation = caseAllocation(caseIndex);
      const total = BigInt(at(vectors.probeReceived, probe, "probeReceived"));
      const owed = entitlements(received(total), allocation);

      for (const leg of LEGS) {
        if (allocation[leg] === 0) {
          expect(owed[leg], `${leg} has no share`).toBe(0n);
        }
      }
    }
  });

  it("never exceed what was received", () => {
    for (let probe = 0; probe < vectors.probeCount; probe++) {
      const caseIndex = at(vectors.probeCase, probe, "probeCase");
      const total = BigInt(at(vectors.probeReceived, probe, "probeReceived"));
      const owed = entitlements(received(total), caseAllocation(caseIndex));

      expect(totalOf(owed)).toBeLessThanOrEqual(total);
    }
  });

  it("agree with the naive definition, including where it would overflow a uint256", () => {
    // The reason the implementation is written as a decomposition at all. A
    // bigint cannot overflow, so this comparison is only meaningful as the
    // TypeScript half of a claim the Solidity half proves under real arithmetic.
    for (let probe = 0; probe < vectors.probeCount; probe++) {
      const caseIndex = at(vectors.probeCase, probe, "probeCase");
      const allocation = caseAllocation(caseIndex);
      const total = BigInt(at(vectors.probeReceived, probe, "probeReceived"));

      for (const leg of LEGS) {
        const naive = (total * BigInt(allocation[leg])) / BPS_DENOMINATOR;
        expect(entitlement(total, allocation[leg])).toBe(naive);
      }
    }
  });
});

// --- streaming ------------------------------------------------------------

describe("allocation over a stream of arrivals", () => {
  it("lands on the same buckets as one payment of the same total", () => {
    let arrivalCursor = 0;

    for (let stream = 0; stream < vectors.streamCount; stream++) {
      const name = at(vectors.streamNames, stream, "streamName");
      const allocation = allocationFrom(vectors.streamBps, stream * LEG_COUNT);
      const count = at(vectors.streamArrivalCount, stream, "arrivalCount");

      let ledger = emptyLedger();
      for (let i = 0; i < count; i++) {
        const amount = BigInt(
          at(vectors.streamArrival, arrivalCursor + i, "streamArrival"),
        );
        ledger = recognise(ledger, amount);

        // Allocate after every arrival, including the ones that move nothing.
        // A run that only allocates at the end would never exercise the
        // high-water mark, which is the whole mechanism.
        if (totalOf(allocatable(ledger, allocation)) > 0n) {
          ledger = allocate(ledger, allocation).ledger;
        }
      }
      arrivalCursor += count;

      const total = BigInt(at(vectors.streamTotal, stream, "streamTotal"));
      expect(ledger.received, `${name}: total received`).toBe(total);

      const base = stream * LEG_COUNT;
      LEGS.forEach((leg, index) => {
        const expected = BigInt(
          at(vectors.streamFinal, base + index, "streamFinal"),
        );
        expect(ledger.allocated[leg], `${name} / ${leg}`).toBe(expected);
      });
    }
  });

  it("does not depend on how the total was broken up", () => {
    const allocation: Allocation = {
      operations: 6000,
      buybacks: 2000,
      developer: 1000,
      protocol: 1000,
    };
    const total = 1000n;

    let dripped = emptyLedger();
    for (let i = 0; i < 1000; i++) {
      dripped = recognise(dripped, 1n);
      if (totalOf(allocatable(dripped, allocation)) > 0n) {
        dripped = allocate(dripped, allocation).ledger;
      }
    }

    const atOnce = allocate(received(total), allocation).ledger;

    expect(dripped.allocated).toEqual(atOnce.allocated);
  });

  it("refuses to allocate twice over", () => {
    const allocation = caseAllocation(0);
    const { ledger } = allocate(received(10_000n), allocation);

    expect(() => allocate(ledger, allocation)).toThrowError(AllocationError);
    expect(totalOf(allocatable(ledger, allocation))).toBe(0n);
  });

  it("never lets an entitlement fall below what was already allocated", () => {
    // The property that makes `allocatable` safe to compute as a subtraction.
    const allocation = caseAllocation(0);
    let ledger = emptyLedger();

    for (const amount of [7n, 1n, 999n, 1n, 10n ** 24n, 3n]) {
      ledger = recognise(ledger, amount);
      const owed = entitlements(ledger, allocation);

      for (const leg of LEGS) {
        expect(owed[leg]).toBeGreaterThanOrEqual(ledger.allocated[leg]);
      }

      if (totalOf(allocatable(ledger, allocation)) > 0n) {
        ledger = allocate(ledger, allocation).ledger;
      }
    }
  });
});

// --- settlement -----------------------------------------------------------

describe("settlement", () => {
  const allocation: Allocation = {
    operations: 2500,
    buybacks: 2500,
    developer: 2500,
    protocol: 2500,
  };

  it("pays a bucket out exactly once", () => {
    const { ledger } = allocate(received(400n), allocation);
    const first = settle(ledger, "operations");

    expect(first.paid).toBe(100n);
    expect(pending(first.ledger).operations).toBe(0n);
    expect(() => settle(first.ledger, "operations")).toThrowError(
      AllocationError,
    );
  });

  it("leaves the other buckets alone", () => {
    const { ledger } = allocate(received(400n), allocation);
    const after = settle(ledger, "developer").ledger;

    expect(pending(after)).toEqual({
      operations: 100n,
      buybacks: 100n,
      developer: 0n,
      protocol: 100n,
    });
  });

  it("keeps the balance equal to what has not been paid out", () => {
    let ledger = allocate(received(400n), allocation).ledger;
    expect(expectedBalance(ledger)).toBe(400n);

    for (const leg of LEGS) {
      ledger = settle(ledger, leg).ledger;
    }

    expect(expectedBalance(ledger)).toBe(0n);
    expect(totalOf(pending(ledger))).toBe(0n);
  });

  it("holds back the dust rather than paying it to anyone", () => {
    const awkward: Allocation = {
      operations: 3333,
      buybacks: 3333,
      developer: 3333,
      protocol: 1,
    };
    let ledger = received(3n);

    // 3 units across four legs at these shares: nobody is entitled to a whole
    // unit, so there is nothing to allocate and allocating says so rather than
    // succeeding with a zero.
    expect(totalOf(allocatable(ledger, awkward))).toBe(0n);
    expect(() => allocate(ledger, awkward)).toThrowError(AllocationError);
    expect(unallocated(ledger, awkward)).toBe(3n);

    ledger = recognise(ledger, 10_000n);
    ledger = allocate(ledger, awkward).ledger;

    expect(totalOf(ledger.allocated) + unallocated(ledger, awkward)).toBe(
      ledger.received,
    );
    expect(expectedBalance(ledger)).toBe(10_003n);
  });
});

// --- validation -----------------------------------------------------------

describe("validation", () => {
  it("rejects every invalid allocation with the error the vectors name", () => {
    for (let i = 0; i < vectors.invalidCount; i++) {
      const name = at(vectors.invalidNames, i, "invalidName");
      const expected = at(vectors.invalidError, i, "invalidError");
      const allocation = allocationFrom(vectors.invalidBps, i * LEG_COUNT);

      let thrown: unknown;
      try {
        validate(allocation);
      } catch (error) {
        thrown = error;
      }

      expect(thrown, `${name} should be rejected`).toBeInstanceOf(
        AllocationError,
      );
      expect((thrown as AllocationError).id, `${name}`).toBe(expected);
    }
  });

  it("accepts a leg at zero", () => {
    expect(
      isValid({
        operations: 10_000,
        buybacks: 0,
        developer: 0,
        protocol: 0,
      }),
    ).toBe(true);
  });

  it("rejects a share that is not a whole number of basis points", () => {
    expect(() =>
      validate({
        operations: 2500.5,
        buybacks: 2499.5,
        developer: 2500,
        protocol: 2500,
      }),
    ).toThrowError(AllocationError);
  });

  it("names the offending leg when the error is about one", () => {
    let thrown: AllocationError | undefined;
    try {
      validate({
        operations: 0,
        buybacks: 10_001,
        developer: 0,
        protocol: 0,
      });
    } catch (error) {
      thrown = error as AllocationError;
    }

    expect(thrown?.leg).toBe<Leg>("buybacks");
  });

  it("refuses to compute entitlements for an allocation it would reject", () => {
    // Otherwise a caller who skipped validation gets numbers that look like
    // money and do not sum to it.
    expect(() =>
      entitlements(received(100n), {
        operations: 5000,
        buybacks: 0,
        developer: 0,
        protocol: 0,
      }),
    ).toThrowError(AllocationError);
  });
});
