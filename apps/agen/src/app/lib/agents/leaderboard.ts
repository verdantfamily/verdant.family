/**
 * Every agent, ranked by what it actually earned.
 *
 * A screener for agents rather than for tokens. The figures are the ones already on each
 * agent's public profile — this page's contribution is putting them next to each other,
 * which is the thing a profile cannot do and the thing that makes an autonomous agent's
 * record legible at a glance.
 *
 * Ranked on creator revenue by default, and that choice is the argument of the page. Volume
 * is the figure a launchpad usually leads with and it is the wrong one here: an agent does
 * not keep volume, and a market that traded heavily once and died looks identical to one
 * that is working. Creator fees are money that arrived in the agent's own wallet because
 * somebody traded a market it chose to create. Nothing else on the platform is as close to
 * a measure of whether an agent was right.
 *
 * ## Not on this page
 *
 * Growth on the money it was given, which is the figure everyone asks for first. Nothing
 * records deposits: an owner funds an agent by sending ether to its address, which this
 * product never sees as an event, so "turned 0.02 into 4.2" cannot be computed from
 * anything here. It would have to be inferred from a balance and a guess, and a guess is
 * not what belongs in a ranking.
 *
 * ## One feed read, not one per agent
 *
 * `summariseAgent` asks the market feed for every market once per agent, which is fine for
 * a profile and quadratic for a directory. This asks once and joins, so the page costs one
 * feed read however many agents there are.
 */

import { marketSource } from "../markets";
import { agentRevenue, readTreasury } from "./service";
import { agentStore, type AgentStore } from "./store";
import type { AgentRecord } from "./types";

/** How the board can be ranked. Each is a figure this file actually has. */
export const RANKINGS = ["revenue", "volume", "markets", "treasury"] as const;
export type Ranking = (typeof RANKINGS)[number];

/**
 * Every order the same list can be put in, ranked or not.
 *
 * `newest` is not a ranking and is deliberately not in `RANKINGS`: nothing about being recent
 * is an achievement, so it must never turn up as a column the leaderboard offers to rank on.
 * It is how the directory sorts, which is a different question — "who is here" rather than
 * "who is winning" — asked of the same rows by the same function.
 */
export type Order = Ranking | "newest";

export function rankingOrDefault(value: string | undefined): Ranking {
  return (RANKINGS as readonly string[]).includes(value ?? "") ? (value as Ranking) : "revenue";
}

/**
 * One agent's line.
 *
 * Every figure that can be missing is `null` rather than zero, and they can all be missing
 * independently: the chain answers for the treasury and the fee vaults, the indexer answers
 * for volume, and either can be down while the other is not. An agent that earned nothing
 * and an agent whose fees could not be read are different rows, and a ranking that treats
 * them the same puts a working agent last on the strength of a timeout.
 */
export interface LeaderRow {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly description: string;
  readonly imageUrl: string | null;
  readonly createdAt: number;
  /** When it last woke, which is the one signal every agent has whether or not it earned. */
  readonly lastRunAt: number | null;
  readonly paused: boolean;
  /** Whether it has an objective and autonomy switched on, which is what makes it autonomous. */
  readonly running: boolean;
  readonly markets: number;
  /** Markets of its own that traded in the last day. Null when the feed did not answer. */
  readonly tradingToday: number | null;
  readonly volume24hEth: number | null;
  readonly revenueWei: bigint | null;
  readonly treasuryEth: number | null;
}

export async function agentLeaderboard(
  order: Order = "revenue",
  store: AgentStore = agentStore(),
): Promise<readonly LeaderRow[]> {
  const agents = store.listPublicAgents().filter((agent) => agent.status !== "archived");
  if (agents.length === 0) return [];

  const markets = await marketSource()
    .list()
    .catch(() => null);

  const byToken =
    markets === null
      ? null
      : new Map(
          markets
            .filter((market) => market.tokenAddress !== null)
            .map((market) => [(market.tokenAddress as string).toLowerCase(), market]),
        );

  const rows = await Promise.all(agents.map((agent) => row(store, agent, byToken)));
  return rankRows(rows, order);
}

/** Exported so the ordering rules can be tested without a chain or an indexer. */
export function rankRows(rows: readonly LeaderRow[], order: Order): readonly LeaderRow[] {
  return [...rows].sort(compare(order));
}

async function row(
  store: AgentStore,
  agent: AgentRecord,
  byToken: Map<string, { readonly trading?: { readonly volume24h: number | null } }> | null,
): Promise<LeaderRow> {
  const launches = store
    .listLaunches(agent.id)
    .filter((launch) => launch.status === "succeeded" && launch.token !== null);

  let volume: number | null = null;
  let trading: number | null = null;
  if (byToken !== null) {
    volume = 0;
    trading = 0;
    for (const launch of launches) {
      const measured = byToken.get((launch.token as string).toLowerCase())?.trading?.volume24h;
      if (measured === undefined || measured === null) continue;
      volume += measured;
      if (measured > 0) trading += 1;
    }
  }

  const [revenueWei, treasuryEth] = await Promise.all([
    agentRevenue(store, agent)
      .then((revenue) => BigInt(revenue.lifetimeWei))
      .catch(() => null),
    readTreasury(agent)
      .then((view) => Number(view.eth))
      .catch(() => null),
  ]);

  const autonomy = store.getAutonomy(agent.id);
  const mandate = store.getMandate(agent.id);

  return {
    id: agent.id,
    username: agent.username,
    name: agent.name,
    description: agent.description,
    imageUrl: agent.imageUrl,
    createdAt: agent.createdAt,
    lastRunAt: autonomy.lastRunAt,
    paused: agent.status === "paused",
    running: autonomy.enabled && mandate !== null && mandate.text.trim() !== "",
    markets: launches.length,
    tradingToday: trading,
    volume24hEth: volume,
    revenueWei,
    treasuryEth,
  };
}

/**
 * Ranked, with what could not be measured last.
 *
 * An unmeasured figure sorts below a measured zero rather than above it. Both orderings are
 * defensible in the abstract; this one is the honest one on a page a stranger reads, because
 * the alternative promotes an agent nobody could get a figure for above one that is known to
 * have earned nothing.
 */
function compare(order: Order): (a: LeaderRow, b: LeaderRow) => number {
  return (a, b) => {
    const primary = by(order, b) - by(order, a);
    if (primary !== 0) return primary;
    // Tie-broken by the other figures, then by name so the order never wobbles between
    // two identical rows on successive renders.
    const revenue = by("revenue", b) - by("revenue", a);
    if (revenue !== 0) return revenue;
    const volume = by("volume", b) - by("volume", a);
    if (volume !== 0) return volume;
    if (b.markets !== a.markets) return b.markets - a.markets;
    return a.name.localeCompare(b.name);
  };
}

function by(order: Order, row: LeaderRow): number {
  switch (order) {
    case "newest":
      return row.createdAt;
    case "revenue":
      // Ether as a float, for ordering only. Sub-wei precision cannot change a rank, and
      // the figure a reader sees is still formatted from the bigint.
      return row.revenueWei === null ? -1 : Number(row.revenueWei) / 1e18;
    case "volume":
      return row.volume24hEth ?? -1;
    case "markets":
      return row.markets;
    case "treasury":
      return row.treasuryEth ?? -1;
  }
}
