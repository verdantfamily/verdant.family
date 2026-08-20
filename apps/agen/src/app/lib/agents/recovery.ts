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
 *
 * Recovery means the tokens too. An agent that has been trading and launching holds
 * most of what it holds in tokens, and neither party can move them without this: the
 * agent because `externalTransfers` is false, the owner because there is no key. The
 * ether sweep alone returned the smaller half and called it a withdrawal.
 */

import { getAddress, type Address } from "viem";

import { AgentError } from "./errors";
import { owned } from "./service";
import { sendOwnerRecovery, sendOwnerTokenRecovery } from "./signer";
import { agentStore, type AgentStore } from "./store";

/** One token returned, or the reason it was not. Amount is in the token's own base units. */
export interface TokenRecovery {
  readonly token: Address;
  readonly amount: string;
  readonly txHash: string | null;
  readonly error: string | null;
}

export interface RecoveryResult {
  readonly to: Address;
  readonly valueWei: string;
  readonly txHash: string;
  readonly tokens: readonly TokenRecovery[];
}

export async function recoverTreasury(
  owner: Address,
  agentId: string,
  store: AgentStore = agentStore(),
  send: typeof sendOwnerRecovery = sendOwnerRecovery,
  sendToken: typeof sendOwnerTokenRecovery = sendOwnerTokenRecovery,
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
    // Tokens before ether, and one at a time. Each transfer costs gas that only the wallet
    // being emptied can pay, so sweeping the ether first would strand every token behind it;
    // and a token whose transfer fails must not take the ether sweep down with it, because
    // that is the part of the withdrawal that always has to work.
    // Every token the agent has traded or launched, which is the only list there is: no chain
    // call enumerates what a wallet holds. Ones it has since sold out of come back as nothing
    // moved and are left out of the result.
    const tokens: TokenRecovery[] = [];
    for (const token of store.heldTokenCandidates(agent.id)) {
      try {
        const moved = await sendToken(store, agent.id, token);
        if (moved.hash === null) continue;
        tokens.push({ token, amount: moved.amount.toString(), txHash: moved.hash, error: null });
      } catch (error) {
        tokens.push({
          token,
          amount: "0",
          txHash: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const sent = await send(store, agent.id);

    store.recordActivity({
      agentId: agent.id,
      type: "treasury_recovered",
      payload: {
        to: sent.to,
        valueWei: sent.valueWei.toString(),
        txHash: sent.hash,
        tokens: tokens.map((entry) => ({
          token: entry.token,
          amount: entry.amount,
          txHash: entry.txHash,
        })),
      },
    });

    return { to: sent.to, valueWei: sent.valueWei.toString(), txHash: sent.hash, tokens };
  } finally {
    store.releaseLease(agent.id, holder);
  }
}
