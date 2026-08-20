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

import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { instant as instantFees, trade as sdkTrade } from "@verdant/sdk";

import { AGEN_ROUTER, chain } from "../chain";
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
 * Let the router move one Instant token, so the agent can sell it.
 *
 * A sell is the one trade that cannot be done with the allowlist as it stands. Ether is
 * paid as transaction value, so a buy calls nothing but the router; a token has to be
 * pulled, which needs `approve` sent *to the token* — an address that is not, and should
 * not be, on a list of Agen contracts.
 *
 * So this is an exception, and it is built to be a narrow one rather than a hole. Three
 * things are true of every call it can produce, none of which a caller can influence:
 *
 *   - the destination is a token the Instant registry names as one of its markets, proven
 *     by reading the registry here rather than asserted by the caller;
 *   - the calldata is built in this function, so the selector is `approve` and nothing
 *     else — there is no path from a caller's bytes to a signature;
 *   - the spender is the canonical `AGEN_ROUTER` read from configuration, so an approval
 *     cannot be granted to an address that arrived as an argument.
 *
 * What an approval can cost is also worth being exact about, because "unlimited" sounds
 * like the dangerous choice and is not the interesting risk here. It lets the router move
 * that one token from this wallet, and the router's only function is to swap through the
 * pool the key names. It cannot reach ether, cannot reach another token, and cannot send
 * anywhere: the proceeds of a swap return to `msg.sender`, which is the agent.
 */
export async function sendProvenTokenApproval(
  store: AgentStore,
  agentId: string,
  token: Address,
): Promise<SendResult & { readonly spender: Address }> {
  assertMainnetSigning();

  if (AGEN_ROUTER === null) {
    throw new AgentError(
      "CONFIG_MISSING",
      "No Agen router is configured on this deployment, so a token cannot be approved for trading.",
    );
  }

  const market = await readInstantMarket(token);
  if (market === null) {
    throw new AgentError(
      "PERMISSION_UNAPPROVED_CONTRACT",
      "That token is not an Instant market on this deployment, so it cannot be approved.",
      { permission: "approvedContractsOnly", requested: token },
    );
  }

  const call = sdkTrade.buildErc20Approval({
    token: market.token,
    spender: AGEN_ROUTER,
    amount: sdkTrade.UNLIMITED_PERMIT2_AMOUNT,
  });

  // The registry's address for the token, not the argument, is what gets called. Equal in
  // every ordinary case; a mismatch means the two disagree about what this token is, and
  // signing under that disagreement is not something to do quietly.
  if (call.to.toLowerCase() !== market.token.toLowerCase()) {
    throw new AgentError(
      "PERMISSION_UNAPPROVED_CONTRACT",
      "The approval transaction did not target the registry's token.",
      { permission: "approvedContractsOnly", requested: call.to },
    );
  }

  const sent = await signAndSend(store, agentId, call);
  return { ...sent, spender: AGEN_ROUTER };
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

/**
 * Return one of an agent's tokens to the person who owns it.
 *
 * The ether sweep alone left an owner short of what they were told they could withdraw. An
 * agent that has bought and launched holds most of its value in tokens, and those cannot be
 * moved by the agent — `externalTransfers` is false — nor by the owner, who does not have the
 * key. Recovering the ether and stranding the portfolio is not a withdrawal.
 *
 * It is safe for the same reason `sendOwnerRecovery` is, and deliberately by the same means
 * rather than by new ones. The destination is not a parameter: it is read from the agent's row
 * inside this function. The calldata is built here, so the selector is `transfer` and the
 * recipient is that owner — a caller supplies the token and nothing else. And the amount is
 * the whole balance, read now, because a partial sweep would leave a remainder that needs
 * another mechanism to collect.
 *
 * Unlike the approval path this does not check the token against the Instant registry. That
 * check exists there to stop the *agent* being talked into calling an arbitrary contract; here
 * the only reachable effect is moving a balance to the owner's address, which is the owner's
 * to move whatever the token is — and an agent can end up holding a token that the registry
 * does not know, if somebody sent it one.
 *
 * A zero balance is reported, not thrown. The caller sweeps a list of tokens the agent has
 * touched at some point, and most of the time some of them are ones it has since sold out of:
 * that is an ordinary nothing-to-do, and making it an exception would mean a withdrawal whose
 * result is littered with failures that are not failures.
 */
export async function sendOwnerTokenRecovery(
  store: AgentStore,
  agentId: string,
  token: Address,
): Promise<{ readonly hash: Hex | null; readonly amount: bigint; readonly to: Address }> {
  assertMainnetSigning();

  const agent = store.getAgent(agentId);
  if (agent === null) {
    throw new AgentError("AGENT_NOT_FOUND", "No such agent.");
  }

  const amount = await publicClient().readContract({
    abi: erc20Abi,
    address: token,
    functionName: "balanceOf",
    args: [agent.walletAddress],
  });

  if (amount === 0n) return { hash: null, amount: 0n, to: agent.ownerAddress };

  const sent = await signAndSend(store, agentId, {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [agent.ownerAddress, amount],
    }),
    value: 0n,
  });

  return { ...sent, amount, to: agent.ownerAddress };
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
