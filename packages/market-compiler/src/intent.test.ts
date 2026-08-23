import { describe, expect, it } from "vitest";

import { activeCreatorInstruction, creatorIntent, objectiveProblems } from "./intent.js";
import { applyStatedEconomics } from "./requirements.js";
import type { MarketSpecification } from "./spec.js";

function specification(partial: Partial<MarketSpecification>): MarketSpecification {
  return {
    version: 1,
    name: "Test",
    symbol: "TEST",
    summary: "A market",
    baseFeePpm: 5_000,
    maxFeePpm: 40_000,
    phases: [],
    state: [],
    rules: [],
    invariants: [],
    externalDependencies: [],
    assumptions: [],
    ambiguities: [],
    suggestions: [],
    unsupported: [],
    ...partial,
  };
}

describe("creator intent", () => {
  it("keeps the exact clauses and links them to the rules that implement them", () => {
    const prompt =
      "Launch a token called Floor, ticker FLOR. Charge 0.5% on every buy and every sell. " +
      "On any sell of at least 1% of immutable supply, charge 4% instead.";
    const spec = applyStatedEconomics(
      prompt,
      specification({
        rules: [
          {
            id: "base-fee",
            title: "BASE FEE",
            when: { kind: "swap", description: "every buy and sell" },
            conditions: [],
            then: [{ kind: "setFee", description: "charge 0.5%", parameters: { feePpm: 5_000 } }],
          },
          {
            id: "large-sell",
            title: "LARGE SELL",
            when: { kind: "sell", description: "a sell" },
            conditions: [
              {
                kind: "tradeSizeVsSupply",
                description: "at least 1% of immutable supply",
                parameters: { operator: ">=", percent: 1, basis: "totalSupply" },
              },
            ],
            then: [{ kind: "setFee", description: "charge 4% instead", parameters: { feePpm: 40_000 } }],
          },
        ],
      }),
    );

    const intent = creatorIntent(prompt, spec);

    expect(intent.complete, intent.problems.join("\n")).toBe(true);
    expect(intent.atoms.map((atom) => atom.quote)).toEqual([
      "Charge 0.5% on every buy and every sell.",
      "On any sell of at least 1% of immutable supply, charge 4% instead.",
    ]);
    expect(intent.atoms[1]?.kind).toBe("replacement");
    expect(intent.atoms[1]?.ruleIds).toContain("large-sell");
  });

  it("refuses replacement phrasing implemented as a stacked fee", () => {
    const prompt =
      "Charge 0.5% on every trade. On sells over 1% of supply, charge 4% instead.";
    const stacked = specification({
      maxFeePpm: 45_000,
      rules: [
        {
          id: "base",
          title: "BASE",
          when: { kind: "swap", description: "every trade" },
          conditions: [],
          then: [{ kind: "setFee", description: "0.5%", parameters: { feePpm: 5_000 } }],
        },
        {
          id: "large",
          title: "LARGE",
          when: { kind: "sell", description: "a sell" },
          conditions: [
            {
              kind: "tradeSizeVsSupply",
              description: "over 1% of supply",
              parameters: { operator: ">", percent: 1, basis: "totalSupply" },
            },
          ],
          then: [{ kind: "extraFee", description: "extra 4%", parameters: { feePpm: 40_000 } }],
        },
      ],
    });

    expect(objectiveProblems(prompt, stacked).join(" ")).toContain("instead");
  });

  it("requires counts, durations and fee splits as parameters rather than prose", () => {
    const prompt =
      "After 10 consecutive buys, waive the next fee for 2 hours. Route 80% of the fee to the creator.";
    const proseOnly = specification({
      rules: [
        {
          id: "streak",
          title: "STREAK",
          when: { kind: "buy", description: "after 10 consecutive buys" },
          conditions: [],
          then: [
            { kind: "waiveFee", description: "waive the next fee for 2 hours" },
            { kind: "routeFee", description: "route 80% of the fee to the creator" },
          ],
        },
      ],
    });

    expect(objectiveProblems(prompt, proseOnly)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("10 consecutive buys"),
        expect.stringContaining("2 hours"),
        expect.stringContaining("80% of the fee"),
      ]),
    );
  });

  it("holds a named rate to the side the creator put it on", () => {
    const prompt =
      "Charge 0.3% on every buy and every sell. On any buy of at least 2% of supply, " +
      "charge 3% instead. Sells never pay the 3% fee.";
    const wrongSide = specification({
      baseFeePpm: 3_000,
      maxFeePpm: 30_000,
      rules: [
        {
          id: "base",
          title: "BASE",
          when: { kind: "swap", description: "every buy and sell" },
          conditions: [],
          then: [{ kind: "setFee", description: "0.3%", parameters: { feePpm: 3_000 } }],
        },
        {
          id: "large-sell",
          title: "LARGE SELL",
          when: { kind: "sell", description: "a sell" },
          conditions: [
            {
              kind: "tradeSizeVsSupply",
              description: "at least 2% of supply",
              parameters: { operator: ">=", percent: 2, basis: "totalSupply" },
            },
          ],
          then: [{ kind: "setFee", description: "3%", parameters: { feePpm: 30_000 } }],
        },
      ],
    });

    const problems = objectiveProblems(prompt, wrongSide).join(" ");
    expect(problems).toContain("buys must pay 3%");
    expect(problems).toContain("sells must never pay 3%");
  });

  it("keeps a liquidity surcharge and fee split distinct", () => {
    const prompt =
      "Charge 1% on every buy and every sell. If somebody sells more than 1% of current " +
      "pool liquidity, charge an additional 2%. 80% of the fee goes to the creator and " +
      "20% goes to the vault.";
    const canopy = specification({
      baseFeePpm: 10_000,
      maxFeePpm: 30_000,
      rules: [
        {
          id: "base",
          title: "BASE",
          when: { kind: "swap", description: "every buy and sell" },
          conditions: [],
          then: [{ kind: "setFee", description: "1%", parameters: { feePpm: 10_000 } }],
        },
        {
          id: "large-sell",
          title: "LARGE SELL",
          when: { kind: "sell", description: "a sell" },
          conditions: [
            {
              kind: "tradeSizeVsLiquidity",
              description: "more than 1% of current pool liquidity",
              parameters: { operator: ">", percent: 1, basis: "poolLiquidity" },
            },
          ],
          then: [
            { kind: "extraFee", description: "additional 2%", parameters: { feePpm: 20_000 } },
            {
              kind: "routeFee",
              description: "80% to creator and 20% to vault",
              parameters: { creatorSharePercent: 80, vaultSharePercent: 20 },
            },
          ],
        },
      ],
    });

    expect(objectiveProblems(prompt, canopy)).toEqual([]);
  });

  it("records custom language for approval without pretending lexical matching proves it", () => {
    const prompt = "Make trading feel like a slot machine.";
    const intent = creatorIntent(
      prompt,
      specification({
        rules: [
          {
            id: "random-reward",
            title: "SLOT MACHINE",
            when: { kind: "buy", description: "a trade" },
            conditions: [],
            then: [{ kind: "rewardWallet", description: "occasionally reward the trader" }],
          },
        ],
      }),
    );

    expect(intent.atoms[0]?.kind).toBe("custom");
    expect(intent.complete).toBe(true);
  });

  it("treats the latest creator edit as authoritative without erasing the original review", () => {
    const original = "Sells pay 0.5%. Buys pay nothing.";
    const edited = specification({
      baseFeePpm: 10_000,
      maxFeePpm: 10_000,
      edits: [{ instruction: "Make the sell fee 1%.", applied: true }],
      rules: [
        {
          id: "sell-fee",
          title: "SELL FEE",
          when: { kind: "sell", description: "a sell" },
          conditions: [],
          then: [{ kind: "setFee", description: "1%", parameters: { feePpm: 10_000 } }],
        },
        {
          id: "free-buy",
          title: "FREE BUY",
          when: { kind: "buy", description: "a buy" },
          conditions: [],
          then: [{ kind: "waiveFee", description: "no fee" }],
        },
      ],
    });

    expect(activeCreatorInstruction(original, edited)).toBe("Make the sell fee 1%.");
    const intent = creatorIntent(original, edited);
    expect(intent.complete, intent.problems.join("\n")).toBe(true);
    expect(intent.atoms.some((atom) => atom.quote.includes("0.5%") && !atom.objective)).toBe(true);
    expect(intent.atoms.some((atom) => atom.quote.includes("1%") && atom.objective)).toBe(true);
  });
});
