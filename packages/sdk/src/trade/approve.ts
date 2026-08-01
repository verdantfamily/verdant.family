/**
 * Letting the Universal Router spend an ERC-20 quote asset.
 *
 * The router does not hold allowances of its own. It pulls tokens through Permit2,
 * which means an ERC-20 input needs **two** approvals and they are not
 * interchangeable:
 *
 *  1. the token's own `approve`, naming **Permit2** as spender — one standing
 *     approval per token, which most wallets on this chain will already have; and
 *  2. Permit2's `approve`, naming **the router** as spender, with an amount and an
 *     expiry.
 *
 * A trader who does only the first gets a revert inside `SETTLE_ALL`, at the point
 * the router tries to pull the input, which is late and reads as a broken swap
 * rather than a missing approval. So `readPermit2Allowance` exists to be asked
 * before the swap is offered.
 *
 * None of this applies to an ether-quoted market: v4 holds ether directly, the input
 * is paid by the transaction's `value`, and there is nothing to approve. That is the
 * one respect in which the ether path is genuinely simpler rather than merely
 * different.
 *
 * The signature-based path — `permit`, one EIP-712 signature instead of a
 * transaction — is deliberately absent. It needs a signer and a nonce read, and this
 * module builds unsigned calls; adding it would make every caller decide between two
 * flows before they have a working one.
 */

import { EXTERNAL_ADDRESSES } from "@verdant/config";
import type { Address, PublicClient } from "viem";
import { encodeFunctionData, erc20Abi } from "viem";

import { permit2Abi } from "../abi/index.js";
import type { UnsignedCall } from "../launch/create.js";

/**
 * The canonical Permit2, verified present with identical bytecode on both 4663 and
 * 46630 (V1 in docs/verification.md). A constant rather than a parameter, unlike
 * Verdant's own addresses: it is the same address on every chain Permit2 is deployed
 * to, and a build that took it as an argument would invite somebody to pass a
 * different one.
 */
export const PERMIT2: Address = EXTERNAL_ADDRESSES.permit2;

/** `type(uint160).max`, which Permit2 reads as an unlimited approval. */
export const UNLIMITED_PERMIT2_AMOUNT = (1n << 160n) - 1n;

/**
 * Permit2's record of what a spender may take.
 *
 * The amount is a `bigint` and the two `uint48` fields are `number`s, which is the
 * same split `../models/schedule.js` makes: a balance is a chain quantity and gets
 * the wide type, a timestamp in seconds is exact in a `number` until the year 285
 * million and is treated as one everywhere in this package.
 */
export interface Permit2Allowance {
  /** `uint160` base units. Unlimited when equal to `UNLIMITED_PERMIT2_AMOUNT`. */
  readonly amount: bigint;
  /** The chain timestamp the approval stops being valid at. Seconds. */
  readonly expiration: number;
  /** Permit2's nonce for this triple. Only the signature path consumes it. */
  readonly nonce: number;
}

/**
 * What Permit2 currently lets `spender` take of `token` from `owner`.
 *
 * Both fields have to be checked against, not just the amount: an approval large
 * enough but expired is spent exactly as an approval of zero is, and the two are
 * indistinguishable from the amount alone.
 */
export async function readPermit2Allowance(
  client: PublicClient,
  {
    owner,
    token,
    spender,
  }: {
    readonly owner: Address;
    readonly token: Address;
    /** The Universal Router, for a swap. */
    readonly spender: Address;
  },
): Promise<Permit2Allowance> {
  const [amount, expiration, nonce] = await client.readContract({
    address: PERMIT2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [owner, token, spender],
  });

  return { amount, expiration, nonce };
}

/**
 * The token's own `approve`, whose spender should be `PERMIT2`.
 *
 * `spender` is a parameter rather than fixed to `PERMIT2` because this is a plain
 * ERC-20 approval and pretending otherwise would hide what the transaction is. It
 * being Permit2 is the caller's decision to make explicitly.
 */
export function buildErc20Approval({
  token,
  spender,
  amount,
}: {
  readonly token: Address;
  readonly spender: Address;
  readonly amount: bigint;
}): UnsignedCall {
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    }),
    value: 0n,
  };
}

/**
 * Permit2's `approve`, whose spender is the Universal Router.
 *
 * `expiration` is an absolute chain timestamp and is required, because Permit2 reads
 * zero as "valid for this block only" — a default of zero would produce an approval
 * that appears to have been granted and is spent by the time the next transaction
 * lands. There is no safe value for this package to invent, for the same reason the
 * swap builder will not invent a deadline: the only clock available here is the
 * reader's, and it is not the chain's.
 */
export function buildPermit2Approval({
  token,
  spender,
  amount,
  expiration,
}: {
  readonly token: Address;
  /** The Universal Router. */
  readonly spender: Address;
  /** `uint160`. `UNLIMITED_PERMIT2_AMOUNT` for an unlimited approval. */
  readonly amount: bigint;
  /** An absolute chain timestamp in seconds. `uint48`. */
  readonly expiration: number;
}): UnsignedCall {
  return {
    to: PERMIT2,
    data: encodeFunctionData({
      abi: permit2Abi,
      functionName: "approve",
      args: [token, spender, amount, expiration],
    }),
    value: 0n,
  };
}
