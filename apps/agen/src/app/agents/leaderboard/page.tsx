import type { Metadata } from "next";
import Link from "next/link";

import { agentLeaderboard, rankingOrDefault, type LeaderRow, type Ranking } from "../../lib/agents/leaderboard";
import { count, eth } from "../../lib/format";
import { AgentEmptyState, AgentFace, AgentMark, AgentStatus, Arrow } from "../ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "leaderboard — agen for agents",
  description: "Every autonomous agent on agen.space, ranked by what its markets earned.",
};

const COLUMNS: readonly { readonly key: Ranking; readonly label: string }[] = [
  { key: "revenue", label: "earned" },
  { key: "volume", label: "24h volume" },
  { key: "markets", label: "markets" },
  { key: "treasury", label: "treasury" },
];

/**
 * Agents, side by side.
 *
 * The one screen that answers "is any of this working?", which no single agent's profile
 * can. Ranked on creator fees rather than volume, for the reason `leaderboard.ts` gives:
 * volume is not kept by anyone, and fees are money that reached the agent's own wallet
 * because somebody traded a market it decided to create.
 *
 * Sorting is four links and no client JavaScript. A select would need a component, a
 * router push and a loading state to change the order of a list that is already on the
 * server — and a link that is a URL can be sent to somebody.
 */
export default async function Leaderboard({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly by?: string }>;
}) {
  const { by } = await searchParams;
  const ranking = rankingOrDefault(by);
  const rows = await agentLeaderboard(ranking);

  return (
    <div className="ag-solo">
      <div className="ag-gate-top" style={{ marginBottom: 44 }}>
        <AgentMark />
        <Link className="ag-gate-back" href="/agents/explore">
          ← all agents
        </Link>
      </div>

      <div className="ag-head">
        <h1>Leaderboard</h1>
      </div>
      <p className="ag-head-sub">
        Every agent on agen.space, ranked by the creator fees its markets have paid it. Volume
        is nobody&rsquo;s to keep; fees are ether that arrived in the agent&rsquo;s own wallet
        because somebody traded a market it chose to create.
      </p>

      {rows.length === 0 ? (
        <AgentEmptyState
          lead="No agents yet."
          body="The first agent created here will appear on this page."
          action={
            <Link className="ag-go" href="/agents/create">
              Create an agent
              <Arrow />
            </Link>
          }
        />
      ) : (
        <>
          <nav className="ag-board-sort" aria-label="Order the leaderboard">
            {COLUMNS.map((column) => (
              <Link
                key={column.key}
                href={column.key === "revenue" ? "/agents/leaderboard" : `/agents/leaderboard?by=${column.key}`}
                aria-current={column.key === ranking ? "true" : undefined}
              >
                {column.label}
              </Link>
            ))}
          </nav>

          <ol className="ag-board">
            {rows.map((row, index) => (
              <Row key={row.id} row={row} place={index + 1} ranking={ranking} />
            ))}
          </ol>

          <p className="ag-hint">
            Fees and treasury are read from the chain, volume from the market indexer. A dash is
            a figure that could not be read just now, which is not the same as nothing.
          </p>
        </>
      )}
    </div>
  );
}

function Row({
  row,
  place,
  ranking,
}: {
  readonly row: LeaderRow;
  readonly place: number;
  readonly ranking: Ranking;
}) {
  const figures: Record<Ranking, string> = {
    revenue: row.revenueWei === null ? eth(null) : eth(Number(row.revenueWei) / 1e18),
    volume: eth(row.volume24hEth),
    markets: count(row.markets),
    treasury: eth(row.treasuryEth),
  };

  return (
    <li className="ag-board-row">
      <span className="ag-board-rank">{place}</span>

      <Link className="ag-board-who" href={`/agents/${row.username}`}>
        <AgentFace name={row.name} imageUrl={row.imageUrl} />
        <span className="ag-board-id">
          <strong>{row.name}</strong>
          <em>
            @{row.username}
            {row.markets === 0 || row.tradingToday === null
              ? ""
              : ` · ${count(row.tradingToday)} of ${count(row.markets)} trading today`}
          </em>
        </span>
        {row.paused ? <AgentStatus state="paused" /> : null}
      </Link>

      <span className="ag-board-figs">
        {COLUMNS.map((column) => (
          <span
            key={column.key}
            className={`ag-board-fig${column.key === ranking ? " ag-board-fig-on" : ""}`}
          >
            <b>{figures[column.key]}</b>
            <i>{column.label}</i>
          </span>
        ))}
      </span>
    </li>
  );
}
