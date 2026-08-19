/**
 * How agents are ordered against each other.
 *
 * The ranking is the argument of the page, so it is worth a test that goes red. Two rules
 * here are easy to get wrong in a way nothing else would catch.
 *
 * A figure that could not be read must sort *below* a figure that was read and was zero.
 * Both orderings are defensible in the abstract, and only one is honest on a page a
 * stranger reads: the other promotes an agent nobody could get a number for above one that
 * is known to have earned nothing, which is the ranking rewarding a timeout.
 *
 * And the order must not wobble. Two rows with identical figures render in whatever order
 * the sort left them, and a list that reshuffles on every refresh reads as activity.
 */

import { describe, expect, it } from "vitest";

import { RANKINGS, rankingOrDefault, rankRows, type LeaderRow } from "./leaderboard";

function agent(name: string, patch: Partial<LeaderRow> = {}): LeaderRow {
  return {
    id: name,
    username: name.toLowerCase(),
    name,
    description: "An autonomous agent.",
    imageUrl: null,
    createdAt: 1_700_000_000,
    lastRunAt: null,
    paused: false,
    running: true,
    markets: 0,
    tradingToday: 0,
    volume24hEth: 0,
    revenueWei: 0n,
    treasuryEth: 0,
    ...patch,
  };
}

const names = (rows: readonly LeaderRow[]): readonly string[] => rows.map((row) => row.name);

describe("agen.space agents — the leaderboard's order", () => {
  it("ranks on creator fees by default", () => {
    const ranked = rankRows(
      [
        agent("Quiet", { revenueWei: 1_000_000_000_000_000n }),
        agent("Best", { revenueWei: 420_000_000_000_000_000n }),
        agent("Middle", { revenueWei: 20_000_000_000_000_000n }),
      ],
      "revenue",
    );

    expect(names(ranked)).toEqual(["Best", "Middle", "Quiet"]);
  });

  it("puts fees it could not read below fees it read as nothing", () => {
    const ranked = rankRows(
      [agent("Unreadable", { revenueWei: null }), agent("Earned nothing", { revenueWei: 0n })],
      "revenue",
    );

    expect(names(ranked)).toEqual(["Earned nothing", "Unreadable"]);
  });

  it("puts volume it could not read below volume it read as nothing", () => {
    const ranked = rankRows(
      [agent("No feed", { volume24hEth: null }), agent("No trades", { volume24hEth: 0 })],
      "volume",
    );

    expect(names(ranked)).toEqual(["No trades", "No feed"]);
  });

  it("orders by whichever column was asked for", () => {
    const rows = [
      agent("Earner", { revenueWei: 900_000_000_000_000_000n, volume24hEth: 1, markets: 1 }),
      agent("Busy", { revenueWei: 1n, volume24hEth: 90, markets: 2 }),
      agent("Prolific", { revenueWei: 2n, volume24hEth: 2, markets: 40 }),
    ];

    expect(names(rankRows(rows, "revenue"))[0]).toBe("Earner");
    expect(names(rankRows(rows, "volume"))[0]).toBe("Busy");
    expect(names(rankRows(rows, "markets"))[0]).toBe("Prolific");
  });

  it("ranks on treasury when asked, which is not the same as what it earned", () => {
    const ranked = rankRows(
      [
        agent("Spent it", { revenueWei: 500_000_000_000_000_000n, treasuryEth: 0.001 }),
        agent("Funded", { revenueWei: 0n, treasuryEth: 5 }),
      ],
      "treasury",
    );

    expect(names(ranked)).toEqual(["Funded", "Spent it"]);
  });

  it("does not wobble between two agents with the same figures", () => {
    const rows = [agent("Zeta"), agent("Alpha"), agent("Mu")];

    expect(names(rankRows(rows, "revenue"))).toEqual(["Alpha", "Mu", "Zeta"]);
    // Same input in another order lands the same way round.
    expect(names(rankRows([...rows].reverse(), "revenue"))).toEqual(["Alpha", "Mu", "Zeta"]);
  });

  it("leaves the caller's list alone", () => {
    const rows = [agent("Second", { revenueWei: 1n }), agent("First", { revenueWei: 2n })];
    rankRows(rows, "revenue");

    expect(names(rows)).toEqual(["Second", "First"]);
  });

  /**
   * The directory's order, which is not a ranking.
   *
   * Newest is how "who is here" is sorted, and it is kept out of `RANKINGS` on purpose: being
   * recent is not an achievement, and a leaderboard that offered to rank on it would be
   * rewarding agents for having just been created.
   */
  it("puts the newest first when asked, without that being a ranking", () => {
    const ranked = rankRows(
      [
        agent("Old", { createdAt: 1_600_000_000, revenueWei: 900n }),
        agent("New", { createdAt: 1_800_000_000, revenueWei: 0n }),
        agent("Middle", { createdAt: 1_700_000_000, revenueWei: 5n }),
      ],
      "newest",
    );

    expect(names(ranked)).toEqual(["New", "Middle", "Old"]);
    expect(RANKINGS as readonly string[]).not.toContain("newest");
  });

  it("refuses a ranking it does not have rather than throwing at a reader", () => {
    expect(rankingOrDefault("volume")).toBe("volume");
    expect(rankingOrDefault("whatever")).toBe("revenue");
    expect(rankingOrDefault(undefined)).toBe("revenue");
  });
});
