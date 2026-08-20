import { describe, expect, it } from "vitest";

import {
  asDuration,
  asPercent,
  describeRule,
  headlineMechanic,
  howThisMarketWorks,
  liveStateDescriptors,
  mechanicSummary,
} from "./describe.js";
import { EPOCH, SURCHARGE } from "./fixtures.js";
import type { MarketSpecification } from "./spec.js";

describe("units, as a person would say them", () => {
  it("renders fees as percentages", () => {
    expect(asPercent(5_000)).toBe("0.5%");
    expect(asPercent(20_000)).toBe("2%");
    expect(asPercent(0)).toBe("0%");
  });

  it("renders durations in the largest whole unit", () => {
    expect(asDuration(3_600)).toBe("1 hour");
    expect(asDuration(900)).toBe("15 minutes");
    expect(asDuration(172_800)).toBe("2 days");
    expect(asDuration(90)).toBe("90 seconds");
  });
});

describe("a rule as a sentence", () => {
  /**
   * "Of the pool's liquidity" rather than "of liquidity", because the basis is now read out
   * of the condition instead of assumed. This sentence used to say liquidity for every
   * size-gated sell rule there was, including the ones measured against a fixed total supply
   * — two materially different mechanics described identically.
   */
  it("reads a size-triggered surcharge the way a trader would say it", () => {
    const rule = SURCHARGE.specification.rules.find((entry) => entry.id === "large-sell-surcharge")!;

    expect(describeRule(rule)).toBe(
      "When someone sells more than 1% of the pool's liquidity, an extra 2% applies and it " +
        "goes to buyback reserve",
    );
  });

  /**
   * A share of the token's fixed supply is a different mechanic from a share of the
   * pool, and used to be described as the same sentence. The basis is read, not assumed.
   */
  it("names a share of the total supply when that is what the rule measures", () => {
    const rule = {
      id: "large-sell",
      title: "LARGE SELL",
      when: { kind: "sell", description: "Somebody sells" },
      conditions: [
        {
          kind: "tradeSizeVsSupply",
          description: "The sell is more than 2% of the token's total supply",
          parameters: { operator: ">", percent: 2, basis: "totalSupply" },
        },
      ],
      then: [{ kind: "setFee", description: "Charge 5%", parameters: { feePpm: 50_000 } }],
    };

    expect(describeRule(rule)).toBe(
      "When someone sells more than 2% of the total supply, the fee becomes 5%",
    );
    expect(describeRule(rule)).not.toContain("1%");
    expect(describeRule(rule)).not.toContain("liquidity");
  });

  it("reads a streak rule", () => {
    const rule = SURCHARGE.specification.rules.find((entry) => entry.id === "buy-streak")!;

    expect(describeRule(rule)).toBe(
      "After 10 buys in a row, the trade pays no fee and the count starts again",
    );
  });

  it("reads a rule that fires when nothing happens", () => {
    const rule = EPOCH.specification.rules.find((entry) => entry.id === "inactivity-payout")!;
    expect(describeRule(rule)).toContain("After 15 minutes with no trade");
  });

  it("reads a milestone", () => {
    const rule = SURCHARGE.specification.rules.find((entry) => entry.id === "volume-milestone")!;

    expect(describeRule(rule)).toContain("At $1,000,000 of volume");
    expect(describeRule(rule)).toContain("the fee becomes 0.25%");
  });

  it("falls back to the interpretation's own words for a mechanic nobody anticipated", () => {
    // The open case, and the one that decides whether this file is a translator or a
    // whitelist. A kind absent from every switch must still produce a real sentence.
    const rule = {
      id: "recovery-auction",
      title: "RECOVERY AUCTION",
      when: {
        kind: "accumulatorReachedThreshold",
        description: "The stranded sell fees reach one ether.",
      },
      conditions: [],
      then: [
        {
          kind: "openCompetitiveWindow",
          description: "Buyers compete for ten minutes on the price impact they reverse.",
        },
      ],
    };

    expect(describeRule(rule)).toBe(
      "The stranded sell fees reach one ether, buyers compete for ten minutes on the price " +
        "impact they reverse",
    );
  });
});

describe("the line on a market card", () => {
  it("picks the most unusual rule, not the first", () => {
    // The surcharge market's first rule is a fee adjustment; its streak rule is the one
    // somebody would look twice at.
    expect(headlineMechanic(SURCHARGE.specification)).toContain("buys in a row");
  });

  it("prefers a rule that fires on absence over one that fires on a trade", () => {
    expect(headlineMechanic(EPOCH.specification)).toContain("with no trade");
  });

  it("never invents copy: everything comes from the specification", () => {
    const headline = headlineMechanic(SURCHARGE.specification);

    // Nothing promotional, nothing about the token, no adjectives nobody wrote.
    expect(headline).not.toMatch(/CNPY|Canopy|best|revolutionary|opportunity/i);
  });

  it("is stable: the same specification always gives the same line", () => {
    expect(headlineMechanic(SURCHARGE.specification)).toBe(headlineMechanic(SURCHARGE.specification));
  });

  it("falls back to the summary for a market with no rules", () => {
    const empty: MarketSpecification = { ...SURCHARGE.specification, rules: [] };
    expect(headlineMechanic(empty)).toBe(empty.summary);
  });
});

describe("how this market works", () => {
  it("leads with the fee a trader actually pays", () => {
    const sections = howThisMarketWorks(SURCHARGE.specification);

    expect(sections[0]?.heading).toBe("FEES");
    expect(sections[0]?.lines[0]).toBe("The base fee is 0.5% on every trade.");
  });

  it("describes a supply-gated sell as a share of the total supply, not of liquidity", () => {
    const sections = howThisMarketWorks({
      ...SURCHARGE.specification,
      baseFeePpm: 20_000,
      maxFeePpm: 50_000,
      rules: [
        {
          id: "large-sell",
          title: "LARGE SELL",
          when: { kind: "sell", description: "Somebody sells" },
          conditions: [
            {
              kind: "tradeSizeVsSupply",
              description: "more than 2% of the total supply",
              parameters: { operator: ">", percent: 2, basis: "totalSupply" },
            },
          ],
          then: [{ kind: "setFee", description: "Charge 5%", parameters: { feePpm: 50_000 } }],
        },
      ],
    });

    const selling = sections.find((section) => section.heading === "SELLING");
    expect(selling?.lines[0]).toContain("more than 2% of the total supply");
    expect(selling?.lines.join(" ")).not.toContain("1%");
    expect(selling?.lines.join(" ")).not.toContain("liquidity");
  });

  it("groups rules by what they react to rather than by order", () => {
    const headings = howThisMarketWorks(SURCHARGE.specification).map((section) => section.heading);

    expect(headings).toContain("SELLING");
    expect(headings).toContain("BUYING");
    expect(headings).toContain("MILESTONES");
  });

  it("puts several rules about the same thing under one heading", () => {
    const sections = howThisMarketWorks(EPOCH.specification);
    const everyTrade = sections.find((section) => section.heading === "EVERY TRADE");

    expect(everyTrade).toBeDefined();
    expect(sections.find((section) => section.heading === "WHEN IT GOES QUIET")).toBeDefined();
  });

  it("discloses an external dependency and what happens when it fails", () => {
    const withOracle: MarketSpecification = {
      ...SURCHARGE.specification,
      externalDependencies: [
        {
          kind: "priceOracle",
          description: "The fee follows the price of ETH.",
          failureBehaviour: "the fee holds at its last value",
        },
      ],
    };

    const section = howThisMarketWorks(withOracle).find(
      (entry) => entry.heading === "OUTSIDE THE POOL",
    );

    expect(section?.lines[0]).toContain("The fee follows the price of ETH");
    expect(section?.lines[0]).toContain("the fee holds at its last value");
  });

  it("says nothing about dependencies when a market has none", () => {
    const headings = howThisMarketWorks(SURCHARGE.specification).map((section) => section.heading);
    expect(headings).not.toContain("OUTSIDE THE POOL");
  });
});

describe("live state", () => {
  it("only describes state the market actually declares", () => {
    const surcharge = liveStateDescriptors(SURCHARGE.specification).map((entry) => entry.name);
    const epoch = liveStateDescriptors(EPOCH.specification).map((entry) => entry.name);

    // The rule the brief asks for: no market shows a leaderboard it does not have.
    expect(epoch).toContain("epochLeader");
    expect(surcharge).not.toContain("epochLeader");

    expect(surcharge).toContain("buybackReserve");
    expect(epoch).not.toContain("buybackReserve");
  });

  it("labels state the way a page should read it", () => {
    const descriptors = liveStateDescriptors(SURCHARGE.specification);
    const reserve = descriptors.find((entry) => entry.name === "buybackReserve")!;

    expect(reserve.label).toBe("buyback reserve");
    expect(reserve.format).toBe("amount");
  });

  it("finds the target for a counter so it can read as progress", () => {
    // "consecutive buys 7 of 10" needs the 10, which lives in the rule that reads the
    // counter rather than in its declaration.
    const buys = liveStateDescriptors(SURCHARGE.specification).find(
      (entry) => entry.name === "consecutiveBuys",
    )!;

    expect(buys.format).toBe("count");
    expect(buys.target).toBe(10);
  });

  it("maps each declared type to how it should be rendered", () => {
    const descriptors = liveStateDescriptors(EPOCH.specification);
    const byName = new Map(descriptors.map((entry) => [entry.name, entry.format]));

    expect(byName.get("epochLeader")).toBe("address");
    expect(byName.get("lastBuyAt")).toBe("time");
    expect(byName.get("rewardPool")).toBe("amount");
    expect(byName.get("currentEpoch")).toBe("count");
  });
});

describe("the card summary", () => {
  it("counts what the market has", () => {
    const summary = mechanicSummary(SURCHARGE.specification);

    expect(summary.ruleCount).toBe(3);
    expect(summary.stateCount).toBe(4);
    expect(summary.hasPhases).toBe(true);
    expect(summary.hasExternalDependencies).toBe(false);
  });

  it("scores a market with more distinct ideas as more unusual", () => {
    const epoch = mechanicSummary(EPOCH.specification);
    const surcharge = mechanicSummary(SURCHARGE.specification);

    // The epoch market has a leaderboard, a timeout and periodic settlement; the
    // surcharge market is fees and a counter.
    expect(epoch.noveltyScore).toBeGreaterThan(surcharge.noveltyScore);
    expect(epoch.noveltyScore).toBeLessThanOrEqual(1);
  });

  it("does not reward repetition", () => {
    // Five rules that all do the same thing are one idea, not five.
    const repetitive: MarketSpecification = {
      ...SURCHARGE.specification,
      rules: Array.from({ length: 5 }, (_unused, index) => ({
        id: `fee-${String(index)}`,
        title: "FEE",
        when: { kind: "sell", description: "a sell" },
        conditions: [],
        then: [{ kind: "extraFee", description: "more fee", parameters: { feePpm: 1_000 } }],
      })),
    };

    expect(mechanicSummary(repetitive).noveltyScore).toBeLessThan(
      mechanicSummary(EPOCH.specification).noveltyScore,
    );
  });
});
