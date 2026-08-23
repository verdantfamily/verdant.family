/**
 * The fee a hook may charge is the fee the creator named, as code.
 */

import { describe, expect, it } from "vitest";

import { feePolicySource } from "./fee-policy.js";
import { applyStatedEconomics } from "./requirements.js";
import type { MarketSpecification } from "./spec.js";

function specification(partial: Partial<MarketSpecification>): MarketSpecification {
  return {
    version: 1,
    name: "Test",
    symbol: "TEST",
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

const FLOR = specification({
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
          description: "at least 1% of supply",
          parameters: { operator: ">=", percent: 1, basis: "totalSupply" },
        },
      ],
      then: [{ kind: "chargeFee", description: "4%", parameters: { feePercent: 4 } }],
    },
  ],
});

describe("the fee policy Agen writes", () => {
  it("writes Floor's inclusive 1% sell ladder, not a stacked or exclusive reading", () => {
    const source = feePolicySource(FLOR)!;

    expect(source.path).toBe("contracts/AgenFeePolicy.sol");
    expect(source.content).toContain("return 5_000");
    expect(source.content).toContain("return 40_000");
    expect(source.content).toContain("tokenAmount * 1_000_000 >= totalSupply * 10_000");
    expect(source.content).not.toContain("3_000");
    expect(source.content).not.toContain("tokenAmount * 1_000_000 > totalSupply * 10_000");
  });

  it("writes Threshold's exclusive 2% gate", () => {
    const thld = specification({
      baseFeePpm: 20_000,
      maxFeePpm: 50_000,
      rules: [
        {
          id: "base",
          title: "BASE",
          when: { kind: "swap", description: "any trade" },
          conditions: [],
          then: [{ kind: "setFee", description: "2%", parameters: { feePpm: 20_000 } }],
        },
        {
          id: "large",
          title: "LARGE",
          when: { kind: "sell", description: "a sell" },
          conditions: [
            {
              kind: "tradeSizeVsSupply",
              description: "more than 2% of supply",
              parameters: { operator: ">", percent: 2, basis: "totalSupply" },
            },
          ],
          then: [{ kind: "setFee", description: "5%", parameters: { feePpm: 50_000 } }],
        },
      ],
    });

    const source = feePolicySource(thld)!;
    expect(source.content).toContain("tokenAmount * 1_000_000 > totalSupply * 20_000");
    expect(source.content).toContain("return 50_000");
    expect(source.content).toContain("return 20_000");
    expect(source.content).not.toContain("tokenAmount * 1_000_000 >= totalSupply * 20_000");
  });

  it("writes Inflow's large-buy gate on buys only", () => {
    const infl = specification({
      baseFeePpm: 3_000,
      maxFeePpm: 30_000,
      rules: [
        {
          id: "base",
          title: "BASE",
          when: { kind: "buyOrSell", description: "any trade" },
          conditions: [],
          then: [{ kind: "chargeFee", description: "0.3%", parameters: { feePercent: 0.3 } }],
        },
        {
          id: "large-buy",
          title: "LARGE BUY",
          when: { kind: "buy", description: "a buy" },
          conditions: [
            {
              kind: "tradeSizeVsSupply",
              description: "at least 2% of supply",
              parameters: { operator: ">=", percent: 2, basis: "totalSupply" },
            },
          ],
          then: [{ kind: "chargeFee", description: "3%", parameters: { feePercent: 3 } }],
        },
      ],
    });

    const source = feePolicySource(infl)!;
    expect(source.content).toContain("if (buying)");
    expect(source.content).toContain("tokenAmount * 1_000_000 >= totalSupply * 20_000");
    expect(source.content).toContain("return 30_000");
    expect(source.content).toMatch(/if \(buying\) \{[\s\S]*return 30_000/);
  });

  it("writes the description, not the model's invented 0.3% and exclusive gate", () => {
    const flor =
      "Charge 0.5% on every buy and every sell. On any sell of at least 1% of the " +
      "token's immutable total supply, charge 4% instead.";

    const invented = specification({
      baseFeePpm: 3_000,
      maxFeePpm: 40_000,
      rules: [
        {
          id: "default",
          title: "DEFAULT",
          when: { kind: "buyOrSell", description: "any trade" },
          conditions: [
            {
              kind: "tradeSizeVsSupply",
              description: "more than 1% of supply",
              parameters: { operator: ">", percent: 1, basis: "totalSupply" },
            },
          ],
          then: [{ kind: "chargeFee", description: "0.5%", parameters: { feePercent: 0.5 } }],
        },
        {
          id: "large-sell",
          title: "LARGE",
          when: { kind: "sell", description: "a sell" },
          conditions: [
            {
              kind: "tradeSizeVsSupply",
              description: "at least 1% of supply",
              parameters: { operator: ">=", percent: 1, basis: "totalSupply" },
            },
          ],
          then: [{ kind: "chargeFee", description: "4%", parameters: { feePercent: 4 } }],
        },
      ],
    });

    const source = feePolicySource(applyStatedEconomics(flor, invented))!;
    expect(source.content).toContain("return 5_000");
    expect(source.content).toContain("return 40_000");
    expect(source.content).toContain("tokenAmount * 1_000_000 >= totalSupply * 10_000");
    expect(source.content).not.toContain("3_000");
    expect(source.content).not.toContain("tokenAmount * 1_000_000 > totalSupply * 10_000");
  });

  it("writes buys at zero when the description said buys pay nothing", () => {
    const prompt = "Sells pay half a percent. Buys pay nothing.";
    const both = specification({
      baseFeePpm: 5_000,
      maxFeePpm: 5_000,
      rules: [
        {
          id: "fee",
          title: "FEE",
          when: { kind: "buyOrSell", description: "any trade" },
          conditions: [],
          then: [{ kind: "setFee", description: "0.5%", parameters: { feePpm: 5_000 } }],
        },
      ],
    });

    const source = feePolicySource(both, prompt)!;
    expect(source.content).toMatch(/if \(buying\) \{[\s\S]*return 0;/);
    expect(source.content).toContain("return 5_000");
  });

  it("turns a gate it cannot compute into a question the hook answers", () => {
    const source = feePolicySource(
      specification({
        rules: [
          {
            id: "free-buy",
            title: "STREAK",
            when: { kind: "buy", description: "a buy" },
            conditions: [
              { kind: "consecutiveCount", description: "ten in a row", parameters: { value: 10 } },
            ],
            then: [{ kind: "waiveFee", description: "free" }],
          },
        ],
      }),
    )!;

    expect(source.content).toContain("bool freeBuy");
    expect(source.content).toContain("if (freeBuy) return 0;");
    // The rate below the gate is still Agen's, which is the whole point of asking.
    expect(source.content).toContain("return 5_000;");
    expect(source.content).toContain("True exactly when ten in a row (rule `free-buy`)");
  });

  it("keeps Exact Flow's sell ladder deterministic beside a buy-side streak", () => {
    const exct = specification({
      rules: [
        ...FLOR.rules,
        {
          id: "free-buy",
          title: "STREAK",
          when: { kind: "buy", description: "a buy" },
          conditions: [
            {
              kind: "consecutiveCount",
              description: "ten consecutive buys without a sell",
              parameters: { value: 10 },
            },
          ],
          then: [{ kind: "waiveFee", description: "free" }],
        },
      ],
    });

    const source = feePolicySource(exct)!;

    // The clause that used to switch this file off entirely.
    expect(source.content).toContain("if (freeBuy) return 0;");
    // And the ladder it used to take down with it.
    expect(source.content).toContain("tokenAmount * 1_000_000 >= totalSupply * 10_000");
    expect(source.content).toContain("return 40_000;");
  });

  it("stops asking once a market has more gates than a call can carry", () => {
    const many = specification({
      rules: ["one", "two", "three", "four"].map((id) => ({
        id,
        title: id.toUpperCase(),
        when: { kind: "buy", description: "a buy" },
        conditions: [
          { kind: "consecutiveCount", description: `${id} in a row`, parameters: { value: 10 } },
        ],
        then: [{ kind: "waiveFee", description: "free" }],
      })),
    });

    // Three is help; four booleans in a row is a call the generator gets wrong, and a
    // wrong call is worse than the model having written the ladder itself.
    expect(feePolicySource(many)).toBe(null);
  });

  it("says nothing about a market whose rate it cannot read", () => {
    expect(
      feePolicySource(
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
    ).toBe(null);
  });

  it("says nothing about a fee that only applies in one phase", () => {
    expect(
      feePolicySource(
        specification({
          phases: [
            { name: "launch", description: "the first hour" },
            { name: "open", description: "after that", terminal: true },
          ],
          rules: [
            {
              id: "launch-tax",
              title: "LAUNCH",
              when: { kind: "sell", description: "a sell" },
              conditions: [],
              activeInPhases: ["launch"],
              then: [{ kind: "setFee", description: "9%", parameters: { feePpm: 90_000 } }],
            },
          ],
        }),
      ),
    ).toBe(null);
  });
});
