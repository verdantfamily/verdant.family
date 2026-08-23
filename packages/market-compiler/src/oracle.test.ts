/**
 * The table Agen checks its own fee policy against.
 */

import { describe, expect, it } from "vitest";

import { feeVectors, oracleTests } from "./oracle.js";
import type { MarketSpecification } from "./spec.js";

function specification(partial: Partial<MarketSpecification>): MarketSpecification {
  return {
    version: 1,
    name: "Exact Flow",
    symbol: "EXCT",
    summary: "A market.",
    baseFeePpm: 5_000,
    maxFeePpm: 40_000,
    rules: [],
    state: [],
    phases: [],
    invariants: [],
    externalDependencies: [],
    assumptions: [],
    ambiguities: [],
    unsupported: [],
    disclosures: [],
    ...partial,
  } as MarketSpecification;
}

const LADDER = specification({
  rules: [
    {
      id: "default",
      title: "DEFAULT",
      when: { kind: "buyOrSell", description: "any trade" },
      conditions: [],
      then: [{ kind: "chargeFee", description: "0.5%", parameters: { feePercent: 0.5 } }],
    },
    {
      id: "large-sell",
      title: "LARGE",
      when: { kind: "sell", description: "a sell" },
      conditions: [
        {
          kind: "tradeSizeVsSupply",
          description: "at least 1% of the immutable total supply",
          parameters: { operator: ">=", percent: 1, basis: "totalSupply" },
        },
      ],
      then: [{ kind: "chargeFee", description: "4%", parameters: { feePercent: 4 } }],
    },
  ],
});

const SUPPLY = 1_000_000_000n * 10n ** 18n;

describe("the vectors Agen holds its fee policy to", () => {
  it("puts a trade exactly on the boundary in the table, on the paying side of it", () => {
    const onIt = feeVectors(LADDER).find((entry) => entry.because.includes("exactly 1%"));

    expect(onIt).toBeDefined();
    expect(onIt?.tokenAmount).toBe(SUPPLY / 100n);
    // The clause the creator writes and nobody else checks: at least 1% means 1% pays.
    expect(onIt?.expectedPpm).toBe(40_000);
  });

  it("puts a hair under the boundary on the other side of it", () => {
    const under = feeVectors(LADDER).find((entry) => entry.because.includes("just under 1%"));

    expect(under?.expectedPpm).toBe(5_000);
  });

  it("says what a plain trade on each side pays", () => {
    const plain = feeVectors(LADDER).filter((entry) => entry.because.startsWith("a plain"));

    expect(plain.map((entry) => entry.expectedPpm)).toEqual([5_000, 5_000]);
  });

  it("asks the library in the same arithmetic the specification uses", () => {
    const source = oracleTests(LADDER)!;

    // The scaled comparison, not the one that divides first. See `thresholdSolidity`.
    expect(source.functions).toContain("AgenFeePolicy.feePpm(false,");
    expect(source.functions).toContain("40000");
    // And the failure reads as a sentence about a trade.
    expect(source.functions).toContain('"a sell of exactly 1% of the total supply pays 4%"');
  });

  it("measures a liquidity gate against a basis with a remainder in it", () => {
    const gated = specification({
      rules: [
        {
          id: "whale",
          title: "WHALE",
          when: { kind: "sell", description: "a sell" },
          conditions: [
            {
              kind: "tradeSizeVsLiquidity",
              description: "more than 2% of the pool",
              parameters: { operator: ">", percent: 2, basis: "poolLiquidity" },
            },
          ],
          then: [{ kind: "chargeFee", description: "9%", parameters: { feePercent: 9 } }],
        },
      ],
    });

    const basis = feeVectors(gated)
      .filter((entry) => entry.poolLiquidity > 0n)
      .map((entry) => entry.poolLiquidity);

    expect(basis.length).toBeGreaterThan(0);
    // Round bases hid a truncating comparison for as long as one was emitted; a pool's
    // liquidity is never round, so neither is the basis it is checked against.
    expect(basis.every((value) => value % 100n !== 0n)).toBe(true);
  });

  it("pins which of two branches wins when both hold", () => {
    const both = specification({
      rules: [
        ...LADDER.rules,
        {
          id: "free-buy",
          title: "STREAK",
          when: { kind: "sell", description: "a sell" },
          conditions: [
            { kind: "consecutiveCount", description: "ten in a row", parameters: { value: 10 } },
          ],
          then: [{ kind: "waiveFee", description: "free" }],
        },
      ],
    });

    const vectors = feeVectors(both);
    const together = vectors.find((entry) => entry.because.includes("exactly 1% while"));
    const small = vectors.find((entry) => entry.because === "a sell while ten in a row");

    // The size branch is stated first, so a large sell pays the surcharge even on a
    // streak, and a small one is waived. That precedence is a real decision about the
    // market, and this table is where it is written down rather than discovered.
    expect(together?.expectedPpm).toBe(40_000);
    expect(small?.expectedPpm).toBe(0);
  });

  it("says nothing about a market whose fee Agen did not write", () => {
    expect(oracleTests(specification({}))).not.toBeNull();
    expect(
      oracleTests(
        specification({
          rules: [
            {
              id: "vibes",
              title: "VIBES",
              when: { kind: "buyOrSell", description: "any trade" },
              conditions: [],
              then: [{ kind: "chargeFee", description: "whatever feels right" }],
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});
