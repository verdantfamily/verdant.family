import "server-only";

/**
 * An X account's own wallet.
 *
 * Launching from X costs the person nothing, so until now the bot only ever spent Agen's
 * money and there was nothing to hold on anybody's behalf. Buying is the opposite: the ether
 * is theirs, which means there has to be an account that is theirs, and a tweet is not a
 * signature — there is no key on the other end of a mention to sign anything with. So Agen
 * holds one for them.
 *
 * ## This is custody, and it is built to be given back
 *
 * A wallet here is a private key Agen can decrypt. That is worth being blunt about, because
 * everything else in this file follows from it:
 *
 *   - The key is generated, encrypted and signed with by the agent layer — the same
 *     {@link createIsolatedWallet}, the same master key, the same allowlisted signer that can
 *     only reach Agen's own router and factories. There is no second wallet system and no
 *     path from a tweet to an arbitrary transaction.
 *   - Nothing can move ether *out* except the person it belongs to. The router pays
 *     `msg.sender`, so a buy and a sell only change what the wallet is holding, and the one
 *     call that pays a third party — recovery — pays the owner address on the row and takes
 *     it from nowhere else.
 *   - The owner starts as an address nobody has the key to. A wallet is created the first
 *     time somebody asks to buy, which is long before Agen knows which address is theirs, and
 *     the honest value for "not known yet" is one that cannot be withdrawn to rather than
 *     Agen's own. It becomes their real address when they prove one — see
 *     {@link linkXWalletOwner} — and withdrawal works from that moment.
 *
 * ## What bounds a trade
 *
 * The balance, and gas. The per-trade and daily caps that bound an autonomous agent are set
 * far above any plausible deposit here on purpose: those exist to stop a model spending an
 * owner's treasury faster than the owner can watch, and this wallet has no model deciding
 * anything — a person named an amount in a post. Their own balance is the limit they set by
 * funding it, which is why {@link spendableWei} is what callers check and it subtracts a gas
 * reserve rather than pretending a full-balance trade could be mined.
 */

import { randomBytes } from "node:crypto";

import { getAddress, type Address } from "viem";

import { publicClient } from "../onchain";
import { agentStore, type AgentStore } from "../agents/store";
import type { AgentPermissions, AgentRecord } from "../agents/types";
import { createIsolatedWallet } from "../agents/wallets";
import { XError } from "./errors";
import { xStore, type XStore, type XWalletRow } from "./store";

/**
 * The owner of a wallet whose person has not proved an address yet.
 *
 * The burn address, chosen because the property that matters is that no key exists for it.
 * Recovery pays `agents.owner_address` and the route that triggers it demands a signature
 * from that address, so a wallet owned by this one cannot be withdrawn from by anybody —
 * including Agen. A placeholder that Agen controlled would be a placeholder that quietly
 * made every unclaimed deposit Agen's.
 */
export const UNCLAIMED_OWNER: Address = "0x000000000000000000000000000000000000dEaD";

/**
 * Gas units a swap is allowed to want.
 *
 * A router swap through a v4 pool with a hook on it, plus room for the approval a first sell
 * needs. Generous on purpose: it is subtracted from the balance to decide what is spendable,
 * so being wrong high refuses a trade that would just have fit, and being wrong low sends a
 * transaction that runs out of gas after the person was told it would work.
 */
const GAS_UNITS_PER_TRADE = 1_500_000n;

/**
 * Caps set above any balance, so the balance is the cap.
 *
 * Not `DEFAULT_PERMISSIONS`: those bound what an autonomous agent may spend of its owner's
 * treasury per day, and applying them here would mean telling somebody who deposited 0.5 ETH
 * that they may spend 0.02 of it because of a limit they never agreed to. Launching and
 * claiming are off because this wallet does neither — X launches are sponsored and their fees
 * go to a seat, not here.
 */
export function xWalletPermissions(): AgentPermissions {
  const ceiling = 1_000_000_000_000_000_000_000_000n; // 1,000,000 ETH
  return {
    instantAllowed: false,
    programmableAllowed: false,
    maxEthPerLaunchWei: 0n,
    maxLaunchesPerDay: 0,
    maxEthPerDayWei: ceiling,
    maxEthPerTradeWei: ceiling,
    maxCreatorBuyWei: 0n,
    canClaimCreatorFees: false,
    externalTransfers: false,
    approvedContractsOnly: true,
  };
}

export interface XWallet {
  readonly row: XWalletRow;
  readonly agent: AgentRecord;
  /** Whether this call is what brought it into existence. */
  readonly created: boolean;
}

export interface WalletDeps {
  readonly store?: XStore;
  readonly agents?: AgentStore;
}

/**
 * A username for a row nobody will ever see.
 *
 * `agents.username` is unique and not null, and these rows are excluded from every listing,
 * so this only has to be deterministic and collision-free. X ids are decimal integers, and
 * base 36 of the same integer is shorter, still unique, and fits the column's 20-character
 * shape without truncation — which is the property that matters, because a truncated id
 * would eventually collide and hand two people one wallet.
 */
export function walletUsername(xUserId: string): string {
  if (/^\d+$/.test(xUserId)) return `xw${BigInt(xUserId).toString(36)}`;
  // Not a number: only seen in tests and in whatever X does next. Hex of the bytes keeps it
  // reversible-ish and, more importantly, keeps it one-to-one.
  return `xw${Buffer.from(xUserId, "utf8").toString("hex").slice(0, 16)}`;
}

/**
 * This account's wallet, making one if this is the first time.
 *
 * Idempotent, and the ordering inside is what makes it safe when two mentions from the same
 * person are handled at once. The agent row goes in first and the mapping second: the mapping
 * is the unique key, so the loser of the race discovers it lost *after* writing a row that
 * nothing references — an unused encrypted key whose address was never told to anybody. The
 * other order would publish an address before the key behind it was stored.
 */
export function xWalletFor(
  xUserId: string,
  xUsername: string,
  deps: WalletDeps = {},
): XWallet {
  if (xUserId.trim() === "") {
    throw new XError("VALIDATION_FAILED", "An X id is needed to find a wallet.");
  }

  const store = deps.store ?? xStore();
  const agents = deps.agents ?? agentStore();

  const existing = store.walletFor(xUserId);
  if (existing !== null) return { row: existing, agent: agentOf(agents, existing), created: false };

  const id = randomBytes(16).toString("hex");
  const wallet = createIsolatedWallet(id);
  const at = Math.floor(Date.now() / 1000);

  agents.insertAgent({
    agent: {
      id,
      username: walletUsername(xUserId),
      name: `@${xUsername}`,
      description: "Trading wallet for an X account.",
      imageUrl: null,
      ownerAddress: UNCLAIMED_OWNER,
      walletAddress: wallet.address,
      status: "active",
      kind: "x_wallet",
      createdAt: at,
      updatedAt: at,
    },
    wallet: wallet.record,
    permissions: xWalletPermissions(),
  });

  const claimed = store.claimWallet({ xUserId, agentId: id, address: wallet.address });
  if (!claimed.inserted) {
    // Another handler got there first. Its wallet is the account's wallet; the row written
    // above is left behind deliberately rather than deleted, because deleting a key is the
    // one operation that could destroy funds if this reasoning is ever wrong.
    return { row: claimed.row, agent: agentOf(agents, claimed.row), created: false };
  }

  agents.recordActivity({
    agentId: id,
    type: "agent_created",
    payload: { kind: "x_wallet", xUserId, wallet: wallet.address },
  });

  return { row: claimed.row, agent: agentOf(agents, claimed.row), created: true };
}

/**
 * Point a wallet at the address that may empty it.
 *
 * Called when an account has proved which address is theirs — today that is the seat claim,
 * where a signed-in X identity names a wallet and then signs the seat handover from it. It is
 * an update rather than a one-time write because people change wallets, and the same X
 * identity that can redirect its fee stream is the identity that can redirect this.
 *
 * Silent when the account has no wallet: most creators launch and never trade, and a claim
 * should not fail because there was nothing to link.
 */
export function linkXWalletOwner(
  xUserId: string,
  owner: Address,
  deps: WalletDeps = {},
): AgentRecord | null {
  const store = deps.store ?? xStore();
  const agents = deps.agents ?? agentStore();

  const row = store.walletFor(xUserId);
  if (row === null) return null;

  const next = getAddress(owner);
  const agent = agentOf(agents, row);
  if (agent.ownerAddress.toLowerCase() === next.toLowerCase()) return agent;

  const updated = agents.setOwnerAddress(row.agentId, next);
  agents.recordActivity({
    agentId: row.agentId,
    type: "agent_updated",
    payload: { kind: "x_wallet", owner: next, xUserId },
  });
  return updated;
}

/** Whether this wallet has an address that could withdraw from it. */
export function isClaimed(agent: AgentRecord): boolean {
  return agent.ownerAddress.toLowerCase() !== UNCLAIMED_OWNER.toLowerCase();
}

export interface Spendable {
  readonly balanceWei: bigint;
  readonly gasReserveWei: bigint;
  /** What a trade may actually spend. Zero when gas alone would not fit. */
  readonly spendableWei: bigint;
}

/**
 * What this wallet can spend right now, gas included.
 *
 * The gas reserve is the whole point. A wallet holding exactly the amount somebody asked to
 * spend cannot make the trade, and finding that out from a failed transaction — after being
 * told the buy was going through — is the worst version of this feature. So the reserve is
 * priced at the current gas price and subtracted before anything is promised.
 */
export async function spendableWei(address: Address): Promise<Spendable> {
  const client = publicClient();

  let balanceWei: bigint;
  let gasPrice: bigint;
  try {
    [balanceWei, gasPrice] = await Promise.all([
      client.getBalance({ address }),
      client.getGasPrice(),
    ]);
  } catch (cause) {
    throw new XError("X_UNAVAILABLE", "The chain could not be read, so the wallet is unknown.", {
      retryable: true,
      details: { cause: cause instanceof Error ? cause.message : String(cause) },
    });
  }

  const gasReserveWei = gasPrice * GAS_UNITS_PER_TRADE;
  return {
    balanceWei,
    gasReserveWei,
    spendableWei: balanceWei > gasReserveWei ? balanceWei - gasReserveWei : 0n,
  };
}

function agentOf(agents: AgentStore, row: XWalletRow): AgentRecord {
  const agent = agents.getAgent(row.agentId);
  if (agent === null) {
    // The mapping names a wallet whose key is gone. Never expected, and not something to
    // paper over by making a new one: a new wallet would have a new address, and the old one
    // may be holding somebody's deposit.
    throw new XError("CONFIG_MISSING", "That wallet's key is missing from this deployment.", {
      details: { agentId: row.agentId, address: row.address },
    });
  }
  return agent;
}
