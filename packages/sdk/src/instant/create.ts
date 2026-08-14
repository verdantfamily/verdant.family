/**
 * The Instant launch transaction: `InstantFactory.create`, as calldata.
 *
 * `InstantLaunchParams` is a field-for-field twin of `InstantFactory.CreateParams`, and
 * the field *order* is part of that: the struct is ABI-encoded positionally, so the two
 * same-typed fields at the end — `initialBuyAmount` and `initialBuyMinTokens` — would
 * transpose without complaint and launch a market nobody asked for. The order below is
 * the Solidity's order, and `create.test.ts` decodes the calldata back and demands the
 * struct it started with.
 *
 * ## Why this is not `launch.LaunchParams` with fields left out
 *
 * Because the fields are not left out — they do not exist. Verdant's struct has eighteen
 * fields because a Verdant market has eighteen decisions in it; Instant's has seven
 * because the rest are constants of the factory, enforced on chain rather than defaulted
 * by an interface. The supply, the opening tick, the quote asset, the fee schedule, the
 * creator allocation and the vesting are not parameters a caller may set to the Instant
 * value: there is nowhere to put them. See ADR-014.
 */

import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";

import { instantFactoryAbi } from "../abi/index.js";
import type { UnsignedCall } from "../launch/create.js";

/**
 * Everything a creator chooses about an Instant market. Everything else is fixed.
 *
 * Five of the seven are the token's name and links. The other two are the fee recipient
 * and the size of the first buy.
 */
export interface InstantLaunchParams {
  readonly name: string;
  readonly symbol: string;
  /** Off-chain metadata location. May be empty. Never mutable for an Instant token. */
  readonly metadataURI: string;
  /**
   * Where the creator's ether fees accrue.
   *
   * Not necessarily the launching wallet: a creator may name a multisig or a partner, and
   * it is fixed for the life of the market, which is why the factory asks rather than
   * defaulting to `msg.sender`.
   */
  readonly feeRecipient: Address;
  /** The creator's chosen salt, namespaced by their address by the factory. */
  readonly salt: Hex;
  /**
   * Wei to spend on the market immediately, sent as the transaction's value.
   *
   * The launch performs this buy in the same transaction that opens the pool, which is
   * what stops somebody else taking the opening price first. Zero is allowed and means
   * the pool opens one-sided and nothing is bought.
   */
  readonly initialBuyAmount: bigint;
  /**
   * The floor on tokens that buy must deliver. The whole launch reverts if the pool
   * cannot meet it.
   */
  readonly initialBuyMinTokens: bigint;
}

/** `create(params)` as calldata, against the generated Instant factory ABI. */
export function encodeInstantCreate(params: InstantLaunchParams): Hex {
  return encodeFunctionData({
    abi: instantFactoryAbi,
    functionName: "create",
    args: [params],
  });
}

/**
 * The Instant launch transaction.
 *
 * `value` is always the first buy, because an Instant market is always quoted in ether
 * and the factory reverts unless `msg.value` equals `initialBuyAmount` exactly. There is
 * no approval to obtain and no equity-quoted case to branch on — the simplification is
 * the product.
 *
 * Minting the position needs no ether at all: the launch position is one-sided, holding
 * only the token, so a creator who sets `initialBuyAmount` to zero launches without
 * spending anything beyond gas.
 */
export function buildInstantCreate({
  factory,
  params,
}: {
  readonly factory: Address;
  readonly params: InstantLaunchParams;
}): UnsignedCall {
  return {
    to: factory,
    data: encodeInstantCreate(params),
    value: params.initialBuyAmount,
  };
}
