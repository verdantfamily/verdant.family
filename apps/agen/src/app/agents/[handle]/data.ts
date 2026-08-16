"use client";

/**
 * Everything the environment knows about the active agent.
 *
 * All of it comes from endpoints that already existed and were exercised on mainnet. No
 * route was added for this phase and no shape was invented: the owner detail endpoint has
 * always returned the agent, its permissions, its keys, its launches and today's
 * allowance in one response, and revenue and activity have always had their own.
 *
 * The treasury balance is the one thing read from the *public* profile rather than an
 * owner route, because that is where the chain read lives. It is the same number a
 * stranger sees, which is correct — a balance is not a secret, and duplicating the read
 * behind auth would mean two code paths that could disagree about the same wallet.
 *
 * One hook rather than a fetch in each page, so moving between Overview, Launches,
 * Wallet and Activity does not re-ask four questions per screen and cannot show two
 * different answers to the same one.
 */

import { useCallback, useEffect, useState } from "react";

import { useActiveAgent } from "../shell";

export interface Permissions {
  readonly instantAllowed: boolean;
  readonly programmableAllowed: boolean;
  readonly maxEthPerLaunchWei: string;
  readonly maxEthPerDayWei: string;
  readonly maxCreatorBuyWei: string;
  readonly maxLaunchesPerDay: number;
  readonly canClaimCreatorFees: boolean;
  readonly externalTransfers: boolean;
  readonly approvedContractsOnly: boolean;
}

export interface Allowance {
  readonly day: string;
  readonly launchesUsed: number;
  readonly launchesReserved: number;
  readonly launchesRemaining: number;
  readonly spentWei: string;
  readonly reservedWei: string;
  readonly spendRemainingWei: string;
}

export interface ApiKey {
  readonly id: string;
  readonly prefix: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly lastUsedAt: number | null;
}

export interface Revenue {
  readonly lifetimeWei: string;
  readonly claimedWei: string;
  readonly claimableWei: string;
}

export interface Snapshot {
  readonly permissions: Permissions;
  readonly allowance: Allowance;
  readonly keys: readonly ApiKey[];
  readonly launches: readonly Record<string, unknown>[];
  readonly activity: readonly Record<string, unknown>[];
  readonly revenue: Revenue | null;
  /** Ether, as a decimal string, or null when the chain could not be read. */
  readonly treasuryEth: string | null;
}

export function useAgentSnapshot(): {
  readonly snapshot: Snapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
} {
  const { agent, call } = useActiveAgent();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((was) => was + 1), []);

  useEffect(() => {
    let live = true;
    setError(null);

    const run = async () => {
      try {
        const [detail, revenue, activity, treasuryEth] = await Promise.all([
          call<{
            agent: { permissions: Permissions };
            keys: ApiKey[];
            launches: Record<string, unknown>[];
            allowance: Allowance;
          }>(`/api/v1/owner/agents/${agent.id}`),
          // Revenue reads the chain per market and can fail where the rest cannot. A
          // missing fee figure should not take the whole screen down with it.
          call<Revenue>(`/api/v1/owner/agents/${agent.id}/revenue`).catch(() => null),
          call<{ activity: Record<string, unknown>[] }>(`/api/v1/owner/agents/${agent.id}/activity`),
          readTreasury(agent.username),
        ]);

        if (!live) return;
        setSnapshot({
          permissions: detail.agent.permissions,
          allowance: detail.allowance,
          keys: detail.keys,
          launches: detail.launches,
          activity: activity.activity,
          revenue,
          treasuryEth,
        });
      } catch (caught) {
        if (!live) return;
        setError(caught instanceof Error ? caught.message : "Could not load this agent.");
      }
    };

    void run();
    return () => {
      live = false;
    };
  }, [agent.id, agent.username, call, nonce]);

  return { snapshot, loading: snapshot === null && error === null, error, reload };
}

async function readTreasury(username: string): Promise<string | null> {
  try {
    const response = await fetch(`/api/v1/agents/${username}`, { cache: "no-store" });
    const body = (await response.json()) as {
      data?: { agent?: { treasury?: { eth?: string } | null } };
    };
    return body.data?.agent?.treasury?.eth ?? null;
  } catch {
    return null;
  }
}
