/**
 * The launch transaction: `VerdantFactory.create`, as calldata.
 *
 * `LaunchParams` is a field-for-field twin of `VerdantFactory.CreateParams`, and
 * the field *order* is part of that: the struct is ABI-encoded positionally, so a
 * pair of same-typed fields transposed here — `vestingCliff` and `vestingDuration`,
 * say, or `initialBuyAmount` and `initialBuyMinTokens` — would encode without
 * complaint and launch a market nobody asked for. The order below is the Solidity's
 * order, and `create.test.ts` decodes the calldata back and demands the struct it
 * started with.
 */

import { BOUNDS } from "@verdant/config";
import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";

import { verdantFactoryAbi } from "../abi/index.js";
import { NATIVE_CURRENCY } from "../markets/pool.js";
import type { Stage } from "../models/schedule.js";

/**
 * Whole tokens to base units, as `LaunchBounds.TOKEN_SCALE` does it.
 *
 * Derived from the one place the decimal count is written rather than as a `1e18`
 * literal, because the token's decimals and this scale are the same fact and a
 * launch encoded against a stale copy of it would mint a supply a millionfold
 * wrong.
 */
export const TOKEN_SCALE: bigint = 10n ** BigInt(BOUNDS.token.decimals);

/**
 * Everything a creator chooses about a market.
 *
 * The twin of `VerdantFactory.CreateParams`. Quantities the chain holds as wide
 * integers are `bigint` here even where a `number` would currently fit — the
 * supply is the obvious one, but `vestingCliff` and `vestingDuration` are `uint64`
 * seconds and there is no reason for the SDK to be the place that decides they are
 * small.
 */
export interface LaunchParams {
  readonly name: string;
  readonly symbol: string;
  /** Off-chain metadata location. May be empty. */
  readonly metadataURI: string;
  /** Whether the creator may edit `metadataURI` later. Immutable once chosen. */
  readonly metadataMutable: boolean;
  /** In whole tokens. The factory scales by `TOKEN_SCALE`. */
  readonly supplyTokens: bigint;
  /** Index into `ModelRegistry`'s models. */
  readonly model: number;
  /**
   * What the market is quoted in: the zero address for native ether, or an ERC-20
   * the registry has admitted. Becomes the pool's `currency0`, which is why the
   * token has to sort above it — see `./salt.js`.
   */
  readonly quoteAsset: Address;
  /** The fee schedule, offsets measured from the pool's initialisation. */
  readonly stages: readonly Stage[];
  /** The tick the pool opens at, and the top of the locked position's range. */
  readonly initialTick: number;
  /** Share of supply withheld from the position for the creator. */
  readonly creatorAllocationBps: number;
  /** Seconds before any of the creator's allocation is releasable. */
  readonly vestingCliff: bigint;
  /** Seconds over which it releases. Zero means no vesting contract at all. */
  readonly vestingDuration: bigint;
  /** Where the creator's share of trading fees is paid. */
  readonly feeRecipient: Address;
  /** The creator's chosen salt, namespaced by their address by the factory. */
  readonly salt: Hex;
  /**
   * How much of the quote asset to spend on the market immediately, in the quote
   * asset's own units — wei for an ether-quoted market, base units of the equity
   * otherwise.
   *
   * The launch performs this buy in the same transaction that opens the pool, which
   * is what stops somebody else taking the opening price first. Zero is allowed and
   * means the pool opens one-sided and nothing is bought.
   */
  readonly initialBuyAmount: bigint;
  /**
   * The floor on tokens that buy must deliver. The whole launch reverts if the pool
   * cannot meet it, so a creator can bound what they accept rather than discovering
   * it afterwards.
   */
  readonly initialBuyMinTokens: bigint;
}

/**
 * An unsigned call, as the three fields a wallet needs.
 *
 * Deliberately not viem's `TransactionRequest`: this is the whole of what the SDK
 * knows. Gas, nonce and fees belong to whoever sends it, and a builder that
 * guessed at them would be guessing about a chain it has not read.
 */
export interface UnsignedCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/**
 * A launch. Carries ether only when the market is quoted in ether and the creator
 * asked for a first buy. See `buildCreate`.
 */
export interface CreateCall extends UnsignedCall {
  readonly value: bigint;
}

/** `create(params)` as calldata, against the generated factory ABI. */
export function encodeCreate(params: LaunchParams): Hex {
  return encodeFunctionData({
    abi: verdantFactoryAbi,
    functionName: "create",
    args: [params],
  });
}

/**
 * The launch transaction.
 *
 * `value` is the creator's first buy when the market is quoted in ether, and zero
 * otherwise. Those are the only two possibilities and the factory enforces both: an
 * ether-quoted launch reverts unless `msg.value` equals `initialBuyAmount` exactly,
 * and an equity-quoted one reverts on any value at all, because there is nothing in
 * such a market that ether can pay for.
 *
 * Minting the position still needs none of the quote asset — the initial position is
 * one-sided, holding only the token — so a creator who sets `initialBuyAmount` to zero
 * launches without holding any of it. What the buy funds is the market's other side,
 * bought in the same transaction so that nobody else can take the opening price first.
 *
 * An equity-quoted buy is pulled by the factory rather than sent to it, so the creator
 * needs an ERC-20 approval to the factory for `initialBuyAmount` before this call. An
 * ether-quoted one needs no approval of any kind.
 */
export function buildCreate({
  factory,
  params,
}: {
  readonly factory: Address;
  readonly params: LaunchParams;
}): CreateCall {
  const quoteIsNative =
    params.quoteAsset.toLowerCase() === NATIVE_CURRENCY.toLowerCase();

  return {
    to: factory,
    data: encodeCreate(params),
    value: quoteIsNative ? params.initialBuyAmount : 0n,
  };
}
