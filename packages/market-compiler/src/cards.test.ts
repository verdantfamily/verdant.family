/**
 * The market as a creator reads it on the review screen.
 *
 * These assert on wording, which is usually a bad idea and is the point here: the cards
 * are the only account of the market most people will ever read, and the failure mode is
 * not an ugly sentence but a confident wrong number — a sell fee card showing the base
 * fee when a rule doubles it, or a percentage where the market varies its fee. Both look
 * completely normal on screen.
 */

import { describe, expect, it } from "vitest";

import { behaviourCards } from "./describe";
import { FIXTURES } from "./fixtures";
import type { MarketSpecification } from "./spec";

function specification(partial: Partial<MarketSpecification>): MarketSpecification {
  return {
    version: 1,
    name: "Test",
    symbol: "TEST",
    summary: "A market.",
    baseFeePpm: 30_000,
    maxFeePpm: 100_000,
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

const SELL_SURCHARGE = specification({
  rules: [
    {
      id: "sellFee",
      title: "Sell surcharge",
      when: { kind: "sell", description: "on a sell" },
      conditions: [],
      then: [
        { kind: "extraFee", description: "charge an extra 4.5%", parameters: { feePpm: 45_000 } },
        { kind: "routeFee", description: "route it", parameters: { destination: "feeVault" } },
      ],
    },
  ],
} as Partial<MarketSpecification>);

describe("the fee cards", () => {
  it("states both sides, because a fee nobody mentioned reads as a fee nobody knows", () => {
    const cards = behaviourCards(specification({}));

    expect(cards.map((card) => card.label)).toEqual(["BUY FEE", "SELL FEE"]);
    expect(cards[0]!.value).toBe("3%");
    expect(cards[1]!.value).toBe("3%");
  });

  it("adds a surcharge to the base rather than showing the base", () => {
    const cards = behaviourCards(SELL_SURCHARGE);
    const sell = cards.find((card) => card.label === "SELL FEE")!;

    // 3% base plus the rule's 4.5%. Showing 3% here would be a number a creator would
    // repeat to their holders.
    expect(sell.value).toBe("7.5%");
    expect(sell.note).toBe("Sent to your fee receiver.");
  });

  it("leaves the other side alone", () => {
    expect(behaviourCards(SELL_SURCHARGE).find((card) => card.label === "BUY FEE")!.value).toBe("3%");
  });

  it("says a waived fee is nothing, in words as well as in figures", () => {
    const cards = behaviourCards(
      specification({
        rules: [
          {
            id: "freeBuys",
            title: "Free buys",
            when: { kind: "buy", description: "on a buy" },
            conditions: [],
            then: [{ kind: "waiveFee", description: "no fee" }],
          },
        ],
      } as Partial<MarketSpecification>),
    );

    const buy = cards.find((card) => card.label === "BUY FEE")!;
    expect(buy.value).toBe("0%");
    expect(buy.note).toBe("Buys pay no hook fee.");
  });

  it("refuses to invent a figure for a fee the specification does not state", () => {
    const cards = behaviourCards(
      specification({
        rules: [
          {
            id: "dynamic",
            title: "Dynamic",
            when: { kind: "sell", description: "on a sell" },
            conditions: [],
            then: [{ kind: "setFee", description: "the fee moves with volatility" }],
          },
        ],
      } as Partial<MarketSpecification>),
    );

    const sell = cards.find((card) => card.label === "SELL FEE")!;
    expect(sell.value).toBe("varies");
    // The ceiling is the only hard promise available, so it is the one made.
    expect(sell.note).toContain("10%");
  });

  it("counts a rule that fires on every trade against both sides", () => {
    const cards = behaviourCards(
      specification({
        baseFeePpm: 10_000,
        rules: [
          {
            id: "always",
            title: "Always",
            when: { kind: "swap", description: "on any trade" },
            conditions: [],
            then: [{ kind: "extraFee", description: "extra 1%", parameters: { feePpm: 10_000 } }],
          },
        ],
      } as Partial<MarketSpecification>),
    );

    expect(cards.find((card) => card.label === "BUY FEE")!.value).toBe("2%");
    expect(cards.find((card) => card.label === "SELL FEE")!.value).toBe("2%");
  });
});

/**
 * Where the fee goes, which the specification often does not say and a card must not invent.
 *
 * This note used to read "kept by the pool's liquidity" whenever no destination was recorded.
 * That is not a cautious default, it is a claim, and for a hook taking its fee through custom
 * accounting it is false — PUSH's cards said the liquidity kept its 2% while the decision note
 * directly underneath said the same 2% went to the launcher vault.
 */
describe("what a card says about where a fee ends up", () => {
  const UNROUTED = specification({
    baseFeePpm: 20_000,
    rules: [
      {
        id: "fee",
        title: "Fee",
        when: { kind: "swap", description: "on any trade" },
        conditions: [],
        then: [{ kind: "setFee", description: "charge 2%", parameters: { feePpm: 20_000 } }],
      },
    ],
  } as Partial<MarketSpecification>);

  const noteFor = (collection: "market" | "liquidity" | "unknown"): string =>
    behaviourCards(UNROUTED, { collection }).find((card) => card.label === "SELL FEE")!.note;

  it("claims nothing about a destination nobody established", () => {
    expect(noteFor("unknown")).toBe("Charged on every sell by this market's hook.");
    expect(noteFor("unknown")).not.toContain("liquidity");
  });

  it("says the market keeps it when the hook is the thing collecting it", () => {
    expect(noteFor("market")).toBe(
      "Charged on every sell and collected by this market's own contracts.",
    );
  });

  it("says the liquidity keeps it only where the pool is what charges it", () => {
    expect(noteFor("liquidity")).toBe(
      "Charged on every sell by the pool itself and kept by its liquidity.",
    );
  });

  /** A destination the specification does record still outranks all of this. */
  it("prefers the specification's own destination to the collection mode", () => {
    const routed = specification({
      rules: [
        {
          id: "fee",
          title: "Fee",
          when: { kind: "sell", description: "on a sell" },
          conditions: [],
          then: [
            { kind: "setFee", description: "charge 2%", parameters: { feePpm: 20_000 } },
            { kind: "routeFee", description: "route it", parameters: { destination: "feeVault" } },
          ],
        },
      ],
    } as Partial<MarketSpecification>);

    expect(
      behaviourCards(routed, { collection: "liquidity" }).find((card) => card.label === "SELL FEE")!
        .note,
    ).toBe("Sent to your fee receiver.");
  });
});

/**
 * A fee that only applies above a size, shown as the two rates it is.
 *
 * Both single figures mislead. PUSH charges 2% on almost every sell and 5% above 2% of its
 * supply: a card reading "5%" names a rate no ordinary seller pays, and one reading "2%" hides
 * the rate that stings. The threshold is the mechanic, so the card has to carry it.
 */
describe("the card for a fee with a size threshold", () => {
  const PUSH = specification({
    baseFeePpm: 20_000,
    maxFeePpm: 50_000,
    rules: [
      {
        id: "base-fee",
        title: "Base fee",
        when: { kind: "swap", description: "on any trade" },
        conditions: [],
        then: [{ kind: "setFee", description: "charge 2%", parameters: { feePpm: 20_000 } }],
      },
      {
        id: "large-sell",
        title: "Large sell",
        when: { kind: "sell", description: "on a sell" },
        conditions: [
          {
            kind: "tradeSizeVsSupply",
            description: "more than 2% of the total supply",
            parameters: { operator: ">", percent: 2 },
          },
        ],
        then: [{ kind: "setFee", description: "charge 5%", parameters: { feePpm: 50_000 } }],
      },
    ],
  } as Partial<MarketSpecification>);

  const sell = behaviourCards(PUSH, { collection: "market" }).find(
    (card) => card.label === "SELL FEE",
  )!;

  it("shows both rates rather than either one alone", () => {
    expect(sell.value).toBe("2% → 5%");
  });

  it("names the threshold, the basis and which side of it the boundary falls on", () => {
    expect(sell.note).toContain("5% on a sell of more than 2% of the total supply");
    expect(sell.note).toContain("2% on everything at or below it");
    expect(sell.note).not.toContain("1%");
  });

  it("does not claim the pool's liquidity keeps a fee this market collects itself", () => {
    expect(sell.note).toContain("collected by this market's own contracts");
    expect(sell.note).not.toContain("kept by the pool");
    expect(sell.note).not.toContain("kept by its liquidity");
  });

  it("leaves the untiered side as one figure", () => {
    const buy = behaviourCards(PUSH).find((card) => card.label === "BUY FEE")!;

    expect(buy.value).toBe("2%");
  });
});

describe("the cards for everything that is not a fee", () => {
  it("leads a streak with the count, which is the number the mechanic is about", () => {
    const cards = behaviourCards(
      specification({
        rules: [
          {
            id: "streak",
            title: "Streak",
            when: { kind: "buy", description: "on a buy" },
            conditions: [
              { kind: "consecutiveCount", description: "five in a row", parameters: { value: 5 } },
            ],
            then: [{ kind: "rewardWallet", description: "reward the buyer" }],
          },
        ],
      } as Partial<MarketSpecification>),
    );

    const reward = cards.find((card) => card.label === "REWARD")!;
    expect(reward.value).toBe("5 consecutive buys");
  });

  it("does not repeat a heading when two rules do the same kind of thing", () => {
    const twice = {
      when: { kind: "sell", description: "on a sell" },
      conditions: [],
      then: [{ kind: "resetCounter", description: "reset" }],
    };

    const cards = behaviourCards(
      specification({
        rules: [
          { id: "a", title: "A", ...twice },
          { id: "b", title: "B", ...twice },
        ],
      } as Partial<MarketSpecification>),
    );

    expect(cards.filter((card) => card.label === "RESET")).toHaveLength(1);
  });

  it("stops at four, because a screen of cards is the report this replaces", () => {
    for (const fixture of FIXTURES) {
      const cards = behaviourCards(fixture.specification);

      expect(cards.length, fixture.key).toBeLessThanOrEqual(4);
      expect(cards.length, fixture.key).toBeGreaterThanOrEqual(2);
    }
  });

  it("says something real for both fixtures, rather than falling back to a kind name", () => {
    for (const fixture of FIXTURES) {
      for (const card of behaviourCards(fixture.specification)) {
        expect(card.value, `${fixture.key}/${card.label}`).not.toBe("");
        expect(card.note.length, `${fixture.key}/${card.label}`).toBeGreaterThan(8);
        // A heading that still reads like a field name means a mechanic slipped through
        // without a translation.
        expect(card.label, fixture.key).not.toMatch(/[a-z]/);
      }
    }
  });
});
