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
  AgentMetric,
  AgentMetrics,
  AgentNothing,
  AgentSection,
  AgentStatus,
  LaunchRow,
  type AgentState,
} from "../ui";
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
      <div className="ag-head">
        <h1>{agent.name}</h1>
        <AgentStatus state={agent.status as AgentState} />
        <button type="button" className="ag-quiet" style={{ height: 24 }} onClick={() => void toggle()}>
          {agent.status === "paused" ? "resume" : "pause"}
        </button>
      </div>
      <p className="ag-head-sub">
        {agent.description === ""
          ? "This agent has no description yet."
          : agent.description}
      </p>

      <AutonomyPanel name={agent.name} username={agent.username} />

      {error !== null ? <p className="ag-note ag-note-bad">{error}</p> : null}

      {loading ? (
        <p className="ag-gate-note" style={{ marginTop: 46 }}>
          loading current state…
        </p>
      ) : snapshot === null ? null : (
        <>
          <AgentSection title="Wallet" more={<Link className="ag-sec-more" href={workspaceHref(agent.username, "wallet")}>open</Link>}>
            <AgentMetrics columns={3}>
              <AgentMetric
                label="Treasury"
                value={eth(snapshot.treasuryEth === null ? null : Number(snapshot.treasuryEth))}
                note="funded by you"
              />
              <AgentMetric
                label="Budget left today"
                value={eth(weiToEth(snapshot.allowance.spendRemainingWei))}
                note={`of ${eth(weiToEth(snapshot.permissions.maxEthPerDayWei))}`}
              />
              <AgentMetric
                label="Max per launch"
                value={eth(weiToEth(snapshot.permissions.maxEthPerLaunchWei))}
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

          <AgentSection title={`Today · ${snapshot.allowance.day}`}>
            <AgentMetrics>
              <AgentMetric label="Spent" value={eth(weiToEth(snapshot.allowance.spentWei))} />
              <AgentMetric
                label="Spend limit"
                value={eth(weiToEth(snapshot.permissions.maxEthPerDayWei))}
              />
              <AgentMetric label="Launches" value={snapshot.allowance.launchesUsed} />
              <AgentMetric
                label="Launch limit"
                value={snapshot.permissions.maxLaunchesPerDay}
                note={`${snapshot.allowance.launchesRemaining} left`}
              />
            </AgentMetrics>
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
