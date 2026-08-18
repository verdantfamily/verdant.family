"use client";

/**
 * What this agent is, right now.
 *
 * The brief asked for a screen that answers "what is my agent doing" rather than one that
 * puts a portfolio value in the middle, and the honest answer today is mostly about
 * boundaries: what it holds, what it has spent against what it may spend, what it has
 * created, and what it has been refused. All of that is real and all of it is already
 * recorded — see `data.ts` for where each number comes from.
 *
 * The one thing it cannot answer yet is whether the agent is thinking, so that question
 * lives in its own component and says so.
 */

import Link from "next/link";

import { age, eth } from "../../lib/format";
import { EXPLORER_URL } from "../../lib/chain";
import { labelActivity, weiToEth } from "../activity";
import { workspaceHref } from "../routing";
import { useActiveAgent } from "../shell";
import {
  AgentFace,
  AgentMetric,
  AgentMetrics,
  AgentNothing,
  AgentSection,
  AgentStatus,
  AgentTile,
  AgentTiles,
  LaunchRow,
  Sparkline,
  type AgentState,
} from "../ui";
import type { Snapshot } from "./data";
import { AutonomyPanel } from "./autonomy-panel";
import { CopyWallet } from "./copy-wallet";
import { useAgentSnapshot } from "./data";

export function Overview() {
  const { agent, refresh, call } = useActiveAgent();
  const { snapshot, loading, error, reload } = useAgentSnapshot();

  const toggle = async () => {
    await call(`/api/v1/owner/agents/${agent.id}/${agent.status === "paused" ? "resume" : "pause"}`, {
      method: "POST",
      body: "{}",
    });
    await refresh();
    reload();
  };

  return (
    <div className="ag-wide">
      <div className="ag-hero">
        <AgentFace name={agent.name} imageUrl={agent.imageUrl} />

        <div className="ag-hero-name">
          <h1>{agent.name}</h1>
          <AgentStatus state={agent.status as AgentState} />
          <button type="button" className="ag-quiet" style={{ height: 24 }} onClick={() => void toggle()}>
            {agent.status === "paused" ? "resume" : "pause"}
          </button>
        </div>

        <p className="ag-hero-sub">
          {agent.description === ""
            ? "This agent has no description yet."
            : agent.description}
        </p>
      </div>

      {error !== null ? <p className="ag-note ag-note-bad">{error}</p> : null}

      {loading ? (
        <p className="ag-gate-note">loading current state…</p>
      ) : snapshot === null ? null : (
        <>
          <AgentTiles>
            {topThree(snapshot).map((tile) => (
              <AgentTile key={tile.label} label={tile.label} value={tile.value} />
            ))}
            <Month history={snapshot.history} />
          </AgentTiles>

          <AutonomyPanel name={agent.name} username={agent.username} />

          <AgentSection title="Wallet" more={<Link className="ag-sec-more" href={workspaceHref(agent.username, "wallet")}>open</Link>}>
            <AgentMetrics columns={3}>
              <AgentMetric
                label="Budget left today"
                value={eth(weiToEth(snapshot.allowance.spendRemainingWei))}
                note={`of ${eth(weiToEth(snapshot.permissions.maxEthPerDayWei))}`}
              />
              <AgentMetric
                label="Max per launch"
                value={eth(weiToEth(snapshot.permissions.maxEthPerLaunchWei))}
              />
              <AgentMetric
                label="Launches today"
                value={snapshot.allowance.launchesUsed}
                note={`${snapshot.allowance.launchesRemaining} left`}
              />
            </AgentMetrics>

            <div className="ag-wallet">
              <span className="ag-wallet-tag">Address</span>
              {EXPLORER_URL === undefined ? (
                <code>{agent.walletAddress}</code>
              ) : (
                <a href={`${EXPLORER_URL}/address/${agent.walletAddress}`} target="_blank" rel="noreferrer">
                  <code>{agent.walletAddress}</code>
                </a>
              )}
              <CopyWallet address={agent.walletAddress} />
            </div>
          </AgentSection>

          <AgentSection title="Creator revenue">
            {snapshot.revenue === null ? (
              <AgentNothing>Fee balances could not be read from the chain just now.</AgentNothing>
            ) : (
              <AgentMetrics columns={3}>
                <AgentMetric label="Earned" value={eth(weiToEth(snapshot.revenue.lifetimeWei))} />
                <AgentMetric label="Claimable" value={eth(weiToEth(snapshot.revenue.claimableWei))} />
                <AgentMetric label="Claimed" value={eth(weiToEth(snapshot.revenue.claimedWei))} />
              </AgentMetrics>
            )}
          </AgentSection>

          <AgentSection
            title="Recent markets"
            more={
              snapshot.launches.length === 0 ? undefined : (
                <Link className="ag-sec-more" href={workspaceHref(agent.username, "launches")}>
                  all {snapshot.launches.length}
                </Link>
              )
            }
          >
            {snapshot.launches.length === 0 ? (
              <AgentNothing>No markets created yet.</AgentNothing>
            ) : (
              <div className="ag-rows">
                {snapshot.launches.slice(0, 5).map((row) => (
                  <LaunchRow key={String(row.id)} row={row} />
                ))}
              </div>
            )}
          </AgentSection>

          <AgentSection
            title="Recent activity"
            more={
              snapshot.activity.length === 0 ? undefined : (
                <Link className="ag-sec-more" href={workspaceHref(agent.username, "activity")}>
                  all
                </Link>
              )
            }
          >
            {snapshot.activity.length === 0 ? (
              <AgentNothing>Nothing to show yet.</AgentNothing>
            ) : (
              <div className="ag-rows">
                {snapshot.activity.slice(0, 6).map((row) => (
                  <div className="ag-row" key={String(row.id)}>
                    <span className="ag-row-id">
                      <strong>{labelActivity(String(row.type))}</strong>
                    </span>
                    <time className="ag-row-when">{age(Number(row.createdAt ?? 0))}</time>
                  </div>
                ))}
              </div>
            )}
          </AgentSection>
        </>
      )}
    </div>
  );
}

/**
 * Which three numbers go at the top.
 *
 * Treasury and revenue are the two an owner came to see, and either can be genuinely
 * unknown: the treasury is a chain read and the revenue is a chain read per market, and a
 * node having a bad minute is not the same as an agent holding nothing. So both are
 * candidates rather than fixtures, and when one cannot be read it is dropped and the next
 * true thing takes its place. The last two are counted in our own database and cannot fail,
 * which is what guarantees there are always three.
 *
 * Nothing here ever renders a dash. A dash in a row of figures reads as zero to everybody
 * who is not thinking about it.
 */
function topThree(snapshot: Snapshot): readonly { readonly label: string; readonly value: string }[] {
  const candidates = [
    snapshot.treasuryEth === null
      ? null
      : { label: "Treasury", value: eth(Number(snapshot.treasuryEth)) },
    snapshot.revenue === null
      ? null
      : { label: "Revenue earned", value: eth(weiToEth(snapshot.revenue.lifetimeWei)) },
    { label: "Budget today", value: eth(weiToEth(snapshot.allowance.spendRemainingWei)) },
    { label: "Markets created", value: String(snapshot.launches.length) },
  ];

  return candidates.filter((tile) => tile !== null).slice(0, 3);
}

/**
 * What the agent has spent over the last thirty days.
 *
 * Spending rather than revenue, because spending is the thing we record ourselves, daily,
 * as it happens — creator fees are only ever read as a balance standing right now, and a
 * month of them would have to be invented. The figure and the line are the same numbers,
 * so the one that can be read precisely is printed and the one that shows the shape of the
 * month is drawn.
 */
function Month({ history }: { readonly history: Snapshot["history"] }) {
  const daily = history.map((day) => Number(weiToEth(day.spentWei) ?? 0));
  const total = daily.reduce((sum, value) => sum + value, 0);

  return (
    <div className={total === 0 ? "ag-chart ag-chart-flat" : "ag-chart"}>
      <div className="ag-chart-head">
        <span className="ag-chart-label">30 day spend</span>
        <span className="ag-chart-figure">{eth(total)}</span>
      </div>
      <Sparkline values={daily} />
    </div>
  );
}
