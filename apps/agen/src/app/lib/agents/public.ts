/**
 * Public agent identity, assembled for pages rather than for the API.
 */

import { formatEther } from "viem";

import { marketSource } from "../markets";
import { agentStore, type AgentStore } from "./store";
import { publicAgentView } from "./service";
import { agentRevenue, readTreasury } from "./service";
import type { AgentRecord } from "./types";

export async function publicCatalogue(store: AgentStore = agentStore()): Promise<readonly Record<string, unknown>[]> {
  const agents = store.listPublicAgents().filter((agent) => agent.status !== "archived");
  return Promise.all(agents.map(async (agent) => summariseAgent(store, agent)));
}

export async function publicProfile(
  username: string,
  store: AgentStore = agentStore(),
): Promise<Record<string, unknown> | null> {
  const agent = store.getAgentByUsername(username);
  if (agent === null || agent.status === "archived") return null;
  // A trading wallet is one person's account, not a published agent. It has no profile to
  // serve, and serving one would put somebody's X handle next to their wallet address on a
  // page they never asked to exist.
  if (agent.kind !== "agent") return null;

  const [summary, launches, activity, revenue, treasury] = await Promise.all([
    summariseAgent(store, agent),
    Promise.resolve(store.listLaunches(agent.id).filter((row) => row.status === "succeeded")),
    Promise.resolve(store.listActivity(agent.id, 20)),
    agentRevenue(store, agent).catch(() => ({
      lifetimeWei: "0",
      claimedWei: "0",
      claimableWei: "0",
      markets: [],
    })),
    readTreasury(agent).catch(() => null),
  ]);

  return {
    ...summary,
    ownerHidden: true,
    autonomy: publicAutonomy(store, agent),
    treasury: treasury === null ? null : { address: treasury.address, eth: treasury.eth, ethWei: treasury.ethWei },
    revenue,
    launches: launches.map((row) => ({
      id: row.id,
      kind: row.kind,
      token: row.token,
      pool: row.pool,
      txHash: row.txHash,
      name: row.name,
      symbol: row.symbol,
      createdAt: row.createdAt,
    })),
    activity: activity.map((row) => ({
      id: row.id,
      type: row.type,
      createdAt: row.createdAt,
      payload: row.payload,
    })),
  };
}

/**
 * The autonomous side of an agent, as a stranger may see it.
 *
 * An agent that acts on its own in public should be legible in public: what it was
 * told to do, whether it is switched on, what it last decided and when it will
 * think again. Proposals awaiting the owner are not here — those are the owner's
 * business until they happen — and neither is anything about the policy that would
 * tell an onlooker exactly how much it can spend.
 */
function publicAutonomy(store: AgentStore, agent: AgentRecord): Record<string, unknown> {
  const autonomy = store.getAutonomy(agent.id);
  const mandate = store.getMandate(agent.id);
  const last = store.lastDecision(agent.id);
  const now = Math.floor(Date.now() / 1000);

  return {
    enabled: autonomy.enabled,
    mode: autonomy.mode,
    running: autonomy.leaseExpiresAt !== null && autonomy.leaseExpiresAt > now,
    mandate: mandate === null ? null : mandate.text,
    lastRunAt: autonomy.lastRunAt,
    nextRunAt: autonomy.enabled ? autonomy.nextRunAt : null,
    lastDecision:
      last === null
        ? null
        : {
            kind: last.kind,
            status: last.status,
            rationale: last.rationale,
            createdAt: last.createdAt,
          },
    // Only what the agent did by itself, so a reader can tell autonomous work from
    // things the owner did to it.
    recent: store
      .listRuns(agent.id, 10)
      .filter((run) => run.finishedAt !== null)
      .map((run) => ({
        id: run.id,
        outcome: run.outcome,
        mode: run.mode,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      })),
  };
}

/**
 * One agent, counted rather than assumed.
 *
 * Exported because an owner looking at their own agents should not be shown worse
 * numbers than a stranger is: the temptation is to answer the owner's list from the
 * record alone, since it is already in hand, and the result is a dashboard that
 * reports nothing happened to somebody who watched it happen.
 */
export async function summariseAgent(store: AgentStore, agent: AgentRecord): Promise<Record<string, unknown>> {
  const launches = store.listLaunches(agent.id).filter((row) => row.status === "succeeded");
  const tokens = new Set(launches.map((row) => row.token?.toLowerCase()).filter((value): value is string => value !== undefined));

  let volume = 0;
  try {
    const markets = await marketSource().list();
    for (const market of markets) {
      if (market.tokenAddress !== null && tokens.has(market.tokenAddress.toLowerCase())) {
        volume += market.trading?.volume24h ?? 0;
      }
    }
  } catch {
    volume = 0;
  }

  let revenueWei = "0";
  try {
    const revenue = await agentRevenue(store, agent);
    revenueWei = revenue.lifetimeWei;
  } catch {
    revenueWei = "0";
  }

  let treasuryEth: string | null = null;
  try {
    const treasury = await readTreasury(agent);
    treasuryEth = treasury.eth;
  } catch {
    treasuryEth = null;
  }

  return publicAgentView(agent, {
    launches: launches.length,
    volume: String(volume),
    revenueWei,
    ...(treasuryEth === null ? {} : { treasuryEth }),
  });
}

export function formatWeiEth(wei: string): string {
  try {
    return `${formatEther(BigInt(wei))} ETH`;
  } catch {
    return "0 ETH";
  }
}
