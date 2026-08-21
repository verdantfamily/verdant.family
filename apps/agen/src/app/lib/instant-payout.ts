import "server-only";

/**
 * Paying a creator their fees without asking them for a transaction.
 *
 * The second half of a walletless launch, and without it the first half is a promise with a
 * footnote. Somebody who launched from the form with no wallet named an address for their 1.00%
 * and has no way to send anything — so `InstantFeeVault.claimCreator` would sit uncalled, with
 * the money earned, accounted for, and stuck one transaction away from them.
 *
 * ## Why this can be an open endpoint
 *
 * `claimCreator` pays the vault's `creator`, which the factory fixed when the market was created
 * and nothing can change. So the call has exactly one possible destination and the sender cannot
 * influence it. Anyone may press this for anyone: the worst a stranger can do is pay Agen's gas
 * to move a creator's money to the creator.
 *
 * That makes authentication pointless here — there is nothing to authorise — and it makes the
 * only real question an economic one.
 *
 * ## What is actually being guarded
 *
 * Not the money. The gas. A market with two pounds of accrued fees is not worth a transaction to
 * settle, and a loop of such calls is a way to drain the sponsor wallet without ever stealing
 * anything. So the guard is a ratio rather than an allowlist: the amount being moved must be
 * worth substantially more than the cost of moving it, and a vault that was just settled waits
 * before it can be settled again.
 *
 * Both numbers are deliberately about the platform's exposure and not about the creator's
 * patience. A creator who wants their fees sooner than the threshold allows can still claim them
 * themselves from the market page with any wallet, exactly as before — this path is the one that
 * exists for people who have none.
 */

import { getAddress, isAddress, type Address, type Hex } from "viem";

import { instant as instantSdk } from "@verdant/sdk";

import { INSTANT_ADDRESSES } from "./chain";
import { readInstantVault } from "./instant-vault";
import { publicClient } from "./onchain";
import { XError } from "./x/errors";
import { sendSponsoredToVault, sponsorProblems } from "./x/sponsor";

/**
 * How many times over the moved amount must exceed the cost of moving it.
 *
 * Twenty, which on this chain is a very small amount of ether against a very small gas bill, and
 * is chosen for the shape rather than the figure: it means a settled market has always paid for
 * its own settlement many times over, so no volume of calls can turn this into a drain. A lower
 * number would still be safe per call and would make a flood of dust claims worth attempting.
 */
const DEFAULT_MIN_MULTIPLE = 20n;

/** How long a vault waits after being settled, so nothing can loop it. */
const DEFAULT_COOLDOWN_SECONDS = 600;

/**
 * When each vault was last settled at Agen's expense.
 *
 * In memory and per process, which is honest about what it is — a restart forgives everyone and a
 * second container has its own allowance. It is not the limit that makes this safe: the ratio
 * above is, and it holds in every process at once because it is arithmetic about the chain's own
 * state rather than a count of requests. This only stops the pointless case of the same vault
 * being settled twice in a row, where the second call reverts anyway.
 */
const settled = new Map<string, number>();

export function forgetPayoutCooldowns(): void {
  settled.clear();
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export interface PayoutLimits {
  readonly minMultiple: bigint;
  readonly cooldownSeconds: number;
}

export function payoutLimits(): PayoutLimits {
  return {
    minMultiple: BigInt(integer("AGEN_PAYOUT_MIN_MULTIPLE", Number(DEFAULT_MIN_MULTIPLE))),
    cooldownSeconds: integer("AGEN_PAYOUT_COOLDOWN_SECONDS", DEFAULT_COOLDOWN_SECONDS),
  };
}

export function payoutDisabled(): boolean {
  return process.env.AGEN_PAYOUT_DISABLED === "1";
}

/** What is missing before Agen can settle a vault on somebody's behalf. */
export function payoutProblems(): readonly string[] {
  const problems: string[] = [];
  if (payoutDisabled()) problems.push("Agen is not settling fees on this deployment.");
  if (INSTANT_ADDRESSES === null) problems.push("Instant is not configured on this deployment.");
  problems.push(...sponsorProblems());
  return problems;
}

export interface CreatorPayout {
  readonly vault: Address;
  /** The immutable address the vault paid. Read from the chain, not from a request. */
  readonly recipient: Address;
  /** What was owed before the call, in wei. What arrived, since the vault pays all of it. */
  readonly amountWei: bigint;
  readonly txHash: Hex;
}

/**
 * What a market owes its creator, and what it would cost Agen to hand it over.
 *
 * Read together because the decision is their ratio, and read before anything is signed: a claim
 * against an empty ledger reverts with `NothingToClaim`, which would spend gas to fail.
 */
export async function readPayoutStanding(vault: Address): Promise<{
  readonly owedWei: bigint;
  readonly costWei: bigint;
}> {
  const client = publicClient();

  const [outstanding, gasPrice] = await Promise.all([
    instantSdk.readInstantOutstanding(client, { vault }),
    client.getGasPrice(),
  ]);

  /*
   * A flat figure rather than an estimate, and on purpose.
   *
   * `estimateGas` on a claim that is about to be refused would revert, and estimating against a
   * vault whose balance is below the threshold is work done to reach a foregone conclusion. A
   * claim is a transfer and a couple of storage writes; this is comfortably above it, which is
   * the safe direction to be wrong in when the number is a floor on what must be moved.
   */
  const costWei = gasPrice * 120_000n;

  return { owedWei: outstanding.creator, costWei };
}

/**
 * Settle a market's creator fees, paid for by Agen.
 *
 * Takes a token rather than a vault, because the vault is proven from the registry inside
 * `sendSponsoredToVault` and a caller that could name the contract could name any contract.
 */
export async function payOutCreator(token: string): Promise<CreatorPayout> {
  const blocked = payoutProblems();
  if (blocked.length > 0) {
    throw new XError("CONFIG_MISSING", blocked[0] ?? "Fees cannot be settled here.");
  }

  if (!isAddress(token, { strict: false })) {
    throw new XError("VALIDATION_FAILED", "That is not a token address.");
  }

  const wanted = getAddress(token);
  const config = payoutLimits();

  const last = settled.get(wanted.toLowerCase());
  if (last !== undefined && Date.now() - last < config.cooldownSeconds * 1_000) {
    throw new XError("COOLDOWN", "This market's fees were just settled. Try again shortly.");
  }

  /*
   * Resolved here to read what is owed, and resolved again inside the send, which is the copy that
   * decides what gets signed. One extra call, and it buys the property that this module's reads can
   * never influence the sponsor key's target: it does not pass an address along, it passes a token.
   */
  const vault = await readInstantVault(wanted);
  const { owedWei, costWei } = await readPayoutStanding(vault);

  if (owedWei === 0n) {
    throw new XError("VALIDATION_FAILED", "This market has no creator fees waiting.");
  }

  if (owedWei < costWei * config.minMultiple) {
    throw new XError(
      "VALIDATION_FAILED",
      "There is not enough waiting yet to be worth a transaction. It keeps accruing — nothing " +
        "is lost, and this will work once there is more.",
      { details: { owedWei: owedWei.toString(), costWei: costWei.toString() } },
    );
  }

  const recipient = await instantSdk.readInstantFeeRecipient(publicClient(), { vault });

  const sent = await sendSponsoredToVault({ token: wanted }, (proven) =>
    instantSdk.buildInstantClaimCreator({ vault: proven }),
  );

  settled.set(wanted.toLowerCase(), Date.now());

  return {
    vault: sent.vault,
    recipient: getAddress(recipient),
    amountWei: owedWei,
    txHash: sent.hash,
  };
}