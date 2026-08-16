/**
 * The one place an agent key is unlocked.
 *
 * Callers hand over unsigned calldata that has already been built by Instant or
 * Programmable helpers. This module checks the destination, decrypts the key for
 * the duration of the send, and forgets it. There is no "sign this hex" export.
 *
 * Signing is pinned to Robinhood Chain 4663. The caller cannot choose a chain,
 * a factory, a router, or an extra destination.
 */

import { createWalletClient, http, type Address, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { instant as instantFees } from "@verdant/sdk";

import { chain } from "../chain";
import { readInstantMarket } from "../instant-markets";
import { publicClient } from "../onchain";
import { assertApprovedTarget, type UnsignedTx } from "./allowlist";
import { AgentError } from "./errors";
import { AGENT_SIGNING_CHAIN_ID, assertMainnetSigning } from "./mainnet";
import type { AgentStore } from "./store";
import { unlockWallet } from "./wallets";

export interface SendResult {
  readonly hash: Hex;
  readonly receipt: TransactionReceipt;
}

export async function sendApproved(
  store: AgentStore,
  agentId: string,
  tx: UnsignedTx,
): Promise<SendResult> {
  assertMainnetSigning();
  assertApprovedTarget(tx.to);
  return signAndSend(store, agentId, tx);
}

/**
 * Claim Instant creator fees. The vault is not on the static allowlist; it is
 * accepted only when the Instant registry names it as this token's splitter.
 */
export async function sendProvenInstantClaim(
  store: AgentStore,
  agentId: string,
  token: Address,
): Promise<SendResult> {
  assertMainnetSigning();

  const market = await readInstantMarket(token);
  if (market === null) {
    throw new AgentError(
      "PERMISSION_UNAPPROVED_CONTRACT",
      "That token is not an Instant market on this deployment, so its vault cannot be called.",
      { permission: "approvedContractsOnly", requested: token },
    );
  }

  const call = instantFees.buildInstantClaimCreator({ vault: market.vault });
  if (call.to.toLowerCase() !== market.vault.toLowerCase()) {
    throw new AgentError(
      "PERMISSION_UNAPPROVED_CONTRACT",
      "The claim transaction did not target the registry vault.",
      { permission: "approvedContractsOnly", requested: call.to },
    );
  }

  return signAndSend(store, agentId, call);
}

/**
 * Return an agent's ETH to the person who owns it.
 *
 * This is the one signed call that leaves the contract allowlist, and it is worth
 * being explicit about why that is safe rather than hoping the surrounding code
 * keeps it so. The destination is not a parameter. It is read from the agent's own
 * row, inside this function, immediately before signing — so there is no argument
 * a caller can pass, and no bug in a route handler that can redirect it. The only
 * address this function can ever pay is the owner already recorded on the agent.
 *
 * `externalTransfers` stays false throughout. That permission governs what the
 * *agent* may do, and this is not the agent acting: it is the owner taking their
 * own funds back, which is a right that has to survive the agent being paused,
 * broken, or refusing.
 *
 * Value is the balance minus a gas allowance, so the wallet is left empty rather
 * than left unable to pay for the transaction that empties it.
 */
export async function sendOwnerRecovery(
  store: AgentStore,
  agentId: string,
): Promise<SendResult & { readonly valueWei: bigint; readonly to: Address }> {
  assertMainnetSigning();

  const agent = store.getAgent(agentId);
  if (agent === null) {
    throw new AgentError("AGENT_NOT_FOUND", "No such agent.");
  }

  const client = publicClient();
  const balance = await client.getBalance({ address: agent.walletAddress });
  const gasPrice = await client.getGasPrice();

  // A plain transfer is 21000 gas. The margin covers the price moving between
  // this read and the transaction landing; too little and the send reverts, too
  // much and a little ETH is stranded. Stranded is the cheaper mistake.
  const fee = gasPrice * 21_000n * 2n;
  if (balance <= fee) {
    throw new AgentError(
      "RECOVERY_BLOCKED",
      "This wallet does not hold enough to cover the transfer out of it.",
      { details: { balanceWei: balance.toString(), feeWei: fee.toString() } },
    );
  }

  const valueWei = balance - fee;
  const sent = await signAndSend(store, agentId, {
    to: agent.ownerAddress,
    data: "0x",
    value: valueWei,
  });

  return { ...sent, valueWei, to: agent.ownerAddress };
}

async function signAndSend(
  store: AgentStore,
  agentId: string,
  tx: UnsignedTx,
): Promise<SendResult> {
  const wallet = store.getWallet(agentId);
  if (wallet === null) {
    throw new AgentError("CONFIG_MISSING", "This agent has no signing identity.");
  }

  const key = unlockWallet(wallet);
  try {
    const account = privateKeyToAccount(key);
    if (account.address.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new AgentError("CONFIG_MISSING", "This agent wallet could not be unlocked correctly.");
    }

    const client = createWalletClient({
      account,
      chain,
      transport: http(),
    });

    if (chain.id !== AGENT_SIGNING_CHAIN_ID) {
      throw new AgentError(
        "WRONG_CHAIN",
        `Agent signing is restricted to chain ${String(AGENT_SIGNING_CHAIN_ID)}.`,
      );
    }

    const hash = await client.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value,
      chain,
    });

    const receipt = await publicClient().waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new AgentError("VALIDATION_FAILED", "The transaction reverted.", {
        details: { hash },
      });
    }

    return { hash, receipt };
  } finally {
    void key;
  }
}
