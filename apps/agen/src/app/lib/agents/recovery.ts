/**
 * Getting an owner's money back out.
 *
 * An agent wallet is deliberately hard to spend from: it can only call approved
 * Agen contracts, and `externalTransfers` is false and cannot be set otherwise
 * through any API. That is right for the agent and wrong for the owner, who has
 * to be able to recover funds from an agent that is paused, misbehaving, out of
 * date, or simply finished.
 *
 * So recovery is owner-authenticated, takes the same lease a cycle takes so it
 * cannot interleave with a launch that has already reserved spend, and pays only
 * the owner address recorded on the agent — see `sendOwnerRecovery`, which reads
 * that address itself rather than accepting one.
 */

import { getAddress, type Address } from "viem";

import { AgentError } from "./errors";
import { owned } from "./service";
import { sendOwnerRecovery } from "./signer";
import { agentStore, type AgentStore } from "./store";

export interface RecoveryResult {
  readonly to: Address;
  readonly valueWei: string;
  readonly txHash: string;
}

export async function recoverTreasury(
  owner: Address,
  agentId: string,
  store: AgentStore = agentStore(),
  send: typeof sendOwnerRecovery = sendOwnerRecovery,
): Promise<RecoveryResult> {
  const agent = owned(store, owner, agentId);

  // Belt and braces. `sendOwnerRecovery` reads the destination from the agent row
  // itself, so this cannot disagree with what actually gets paid — but if it ever
  // did, the send is the thing that should stop.
  if (agent.ownerAddress.toLowerCase() !== getAddress(owner).toLowerCase()) {
    throw new AgentError("FORBIDDEN", "That agent is not yours.");
  }

  // Recovery is a withdrawal, not a pause. An agent left switched on would simply
  // start spending again on its next cycle, so the switch goes off with the money.
  store.setAutonomy(agent.id, { enabled: false, nextRunAt: null });

  const holder = `recovery:${crypto.randomUUID().slice(0, 8)}`;
  store.acquireLease(agent.id, holder);

  try {
    const sent = await send(store, agent.id);

    store.recordActivity({
      agentId: agent.id,
      type: "treasury_recovered",
      payload: { to: sent.to, valueWei: sent.valueWei.toString(), txHash: sent.hash },
    });

    return { to: sent.to, valueWei: sent.valueWei.toString(), txHash: sent.hash };
  } finally {
    store.releaseLease(agent.id, holder);
  }
}
