/**
 * Reading and claiming an Instant market's fees.
 *
 * ## The path a fee takes, and why it is shorter than Verdant's
 *
 * A Verdant fee accrues inside the locked Uniswap position and reaches a recipient in two
 * transactions: `PositionLocker.collect()` realises it into the market's `FeeSplitter`,
 * and only then may `claim()` divide what arrived. That is why `fees/claim.ts` has to
 * simulate a collection to answer the simple question of what a creator has earned.
 *
 * Instant has neither step. The pool's LP fee is **zero**, so the position accrues
 * nothing and there is nothing to collect; the 1.50% is taken by the hook from the ether
 * leg of every swap and credited to the market's `InstantFeeVault` as it happens. So:
 *
 *  - **`claimable` is what you have earned.** No simulation, no `needsCollect`, no gap
 *    between what the contract reports and what the market has made.
 *  - **One transaction, and it is the claim.** `PositionLocker.collect()` still exists on
 *    an Instant market and is correctly inert. Calling it is harmless and pointless.
 *  - **Ether, always.** There is no token side to report. An Instant creator never
 *    accrues a balance of the token they launched, which is the whole reason the hook
 *    exists (ADR-014).
 *
 * The creator and the platform draw from independent ledgers through separate functions,
 * so neither can block or front the other, and a reverting recipient cannot break the
 * other's claim.
 *
 * Nothing here signs or sends. The reads take a client; the writes return calldata.
 */

import type { Address, PublicClient } from "viem";
import { encodeFunctionData } from "viem";

import { instantFeeVaultAbi } from "../abi/index.js";
import type { UnsignedCall } from "../launch/create.js";

/**
 * What an Instant market still owes, both ledgers at once.
 *
 * In wei. Both figures are already earned and already in the vault's accounting — this is
 * not a projection, and no transaction has to happen first for it to be true.
 */
export interface InstantOutstanding {
  /** The creator's 1.00% of every trade, less what they have already taken. */
  readonly creator: bigint;
  /** The platform's 0.50%, less what the treasury has already taken. */
  readonly platform: bigint;
}

export async function readInstantOutstanding(
  client: PublicClient,
  { vault }: { readonly vault: Address },
): Promise<InstantOutstanding> {
  const [creator, platform] = await client.readContract({
    address: vault,
    abi: instantFeeVaultAbi,
    functionName: "outstanding",
  });

  return { creator, platform };
}

/**
 * What one address may take from this vault, in wei.
 *
 * Returns zero for an address that is neither the creator's fee recipient nor the
 * treasury, which is the contract's own answer rather than an error — so this is safe to
 * call for any connected wallet without first establishing who it is.
 */
export async function readInstantClaimable(
  client: PublicClient,
  {
    vault,
    recipient,
  }: {
    readonly vault: Address;
    readonly recipient: Address;
  },
): Promise<bigint> {
  return client.readContract({
    address: vault,
    abi: instantFeeVaultAbi,
    functionName: "claimable",
    args: [recipient],
  });
}

/**
 * Who this market's creator share belongs to.
 *
 * **Not** the address that launched the market. The factory passes `params.feeRecipient`
 * into the vault, and a creator may name a treasury, a multisig or a partner instead of
 * themselves — so the registry's `creator`, which is whoever sent the launch transaction,
 * is the wrong address to attribute earnings to. The vault is the authority, and it is
 * the only one.
 */
export async function readInstantFeeRecipient(
  client: PublicClient,
  { vault }: { readonly vault: Address },
): Promise<Address> {
  return client.readContract({
    address: vault,
    abi: instantFeeVaultAbi,
    functionName: "creator",
  });
}

/**
 * Pay the creator everything the vault owes them.
 *
 * Callable by anyone, because there is nothing to protect: the destination is an
 * immutable fixed when the market was created, so this transaction cannot be aimed at
 * somebody else's share no matter who sends it. A creator whose fee recipient is a
 * contract that cannot receive ether is the one case this fails, and it fails without
 * touching the platform's ledger.
 *
 * It **reverts** with `NothingToClaim` when the balance is zero, which is why a caller
 * should read the outstanding amount first rather than offering a button that spends gas
 * to fail.
 */
export function buildInstantClaimCreator({ vault }: { readonly vault: Address }): UnsignedCall {
  return {
    to: vault,
    data: encodeFunctionData({ abi: instantFeeVaultAbi, functionName: "claimCreator" }),
    value: 0n,
  };
}

/** The same, for the platform's half-percent. Independent of the creator's ledger. */
export function buildInstantClaimPlatform({ vault }: { readonly vault: Address }): UnsignedCall {
  return {
    to: vault,
    data: encodeFunctionData({ abi: instantFeeVaultAbi, functionName: "claimPlatform" }),
    value: 0n,
  };
}
