/**
 * Reading a launched Agen market off the chain.
 *
 * Everything an interface needs to show a market that exists — where it is, what it is
 * priced at, how deep it is, and what a trade would return — starting from one address:
 * the registry the factory writes into.
 *
 * ## Why the chain and not the indexer
 *
 * Both, for different questions. History is the indexer's job: volume over a day, a
 * candle, the last twenty trades. But whether a market exists, what its pool is, and
 * what it costs to trade right now are questions with an answer that must not lag, and a
 * feed that is thirty seconds behind is thirty seconds of quoting a price nobody can
 * get. Those are read here, from the registry and the PoolManager, and they are correct
 * at the block they were read at or they revert.
 *
 * ## The pool key is derived, not stored
 *
 * `AgenMarketRegistry.Market` records the pool id but not the key that hashes to it, so
 * the key is rebuilt from the market's own fields and the fee. That leaves one thing to
 * get right — the fee, which is either the dynamic flag or a fixed value the build chose
 * — and one way to prove it: hash the key and compare with the recorded id.
 * `agenPoolKeyFor` does the first and `poolKeyMatches` does the second, so an interface
 * never quotes against a pool it merely believes in.
 */

import { DYNAMIC_FEE_FLAG, TICK_SPACING } from "@verdant/config";
import type { Address, Hex, PublicClient } from "viem";
import { getAddress } from "viem";

import { agenMarketRegistryAbi, stateViewAbi } from "../abi/index.js";
import { NATIVE_CURRENCY, poolIdOf, type PoolKey } from "../markets/pool.js";

export { NATIVE_CURRENCY };

/**
 * The grid every Agen pool is created on.
 *
 * The same spacing Verdant uses and `AgenCurve.TICK_SPACING` in Solidity — Agen differs
 * in how it spreads liquidity across that grid, not in the grid. Re-exported under its
 * own name so a reader here does not have to know that the two systems agree.
 */
export const AGEN_TICK_SPACING: number = TICK_SPACING;

/**
 * `AgenMarketRegistry.Market`, as the registry recorded it at creation.
 *
 * A snapshot, in the strict sense: the registry is append-only and has no owner, so
 * every field here is what was true in the transaction that created the market and
 * cannot have been revised since.
 */
export interface AgenMarketRecord {
  readonly creator: Address;
  readonly token: Address;
  readonly hook: Address;
  readonly poolId: Hex;
  /** `currency0`. The zero address is ether, which is what every market opens against. */
  readonly quoteAsset: Address;
  /** Binds the market to the description its creator approved. */
  readonly specificationHash: Hex;
  /** Binds it to the exact sources that were compiled and tested. */
  readonly implementationHash: Hex;
  readonly metadataURI: string;
  /** Seconds. */
  readonly createdAt: number;
  readonly createdAtBlock: bigint;
}

/** What `AgenMarketRegistry.componentsAt` returns, with the role decoded. */
export interface AgenComponent {
  readonly address: Address;
  readonly role: number;
  readonly codeHash: Hex;
}

/** The pool, right now. */
export interface PoolState {
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  /**
   * The pool's *stored* fee, which on a market whose hook overrides per swap is not what
   * anybody pays. Kept because it is the honest answer to "what does slot0 say" and
   * ignored everywhere a trader is shown a cost.
   */
  readonly storedLpFee: number;
  readonly liquidity: bigint;
}

/** Raw tuple shapes, as viem decodes the structs. */
interface RawMarket {
  readonly creator: Address;
  readonly token: Address;
  readonly hook: Address;
  readonly poolId: Hex;
  readonly quoteAsset: Address;
  readonly specificationHash: Hex;
  readonly implementationHash: Hex;
  readonly metadataURI: string;
  readonly createdAt: bigint;
  readonly createdAtBlock: bigint;
}

function toRecord(raw: RawMarket): AgenMarketRecord {
  return {
    creator: getAddress(raw.creator),
    token: getAddress(raw.token),
    hook: getAddress(raw.hook),
    poolId: raw.poolId,
    quoteAsset: getAddress(raw.quoteAsset),
    specificationHash: raw.specificationHash,
    implementationHash: raw.implementationHash,
    metadataURI: raw.metadataURI,
    createdAt: Number(raw.createdAt),
    createdAtBlock: raw.createdAtBlock,
  };
}

/**
 * The pool key for a market.
 *
 * `AgenFactory.poolKeyFor` is the same five lines in Solidity, and the ordering is not a
 * choice: the launched token is always `currency1`, which is what makes `zeroForOne`
 * mean "buy" for every generated market. There is deliberately no sort here — a sort
 * would silently accept the inverted market the factory exists to reject.
 */
export function agenPoolKeyFor({
  quoteAsset,
  token,
  lpFee,
  hook,
}: {
  readonly quoteAsset: Address;
  readonly token: Address;
  /** `DYNAMIC_FEE_FLAG` when the hook sets the fee, otherwise the fixed hundredths of a bip. */
  readonly lpFee: number;
  readonly hook: Address;
}): PoolKey {
  return {
    currency0: quoteAsset,
    currency1: token,
    fee: lpFee,
    tickSpacing: AGEN_TICK_SPACING,
    hooks: hook,
  };
}

/**
 * Whether this key is the pool the registry recorded.
 *
 * The one check that turns a derived key into a known one. Worth making before a quote
 * is shown or a swap is signed: a key with the wrong fee hashes to a pool that does not
 * exist, and a swap against a pool that does not exist does not fail informatively — it
 * reverts inside the router, which reads to a trader as a broken market.
 */
export function poolKeyMatches(key: PoolKey, poolId: Hex): boolean {
  return poolIdOf(key).toLowerCase() === poolId.toLowerCase();
}

/**
 * The pool key for a market, given the fee the build chose, checked against the record.
 *
 * The fee is the only field that cannot be recovered from the registry, so it is passed
 * in — from the build that launched the market, or from the PoolManager's `Initialize`
 * event, which carries it. `null` means the candidate fee was wrong, and the caller
 * should say the market cannot be traded rather than trade against a guess.
 */
export function agenPoolKeyOf(market: AgenMarketRecord, lpFee: number): PoolKey | null {
  const key = agenPoolKeyFor({
    quoteAsset: market.quoteAsset,
    token: market.token,
    lpFee,
    hook: market.hook,
  });
  return poolKeyMatches(key, market.poolId) ? key : null;
}

/**
 * The pool key, without being told the fee.
 *
 * Every Agen market is one of two things: dynamic-fee, or a fixed fee the hook demanded
 * at initialisation. The first covers almost all of them and the second is a short list,
 * so trying the flag and then the candidates costs nothing and removes a parameter the
 * caller would otherwise have to carry from the build all the way to the trade panel.
 *
 * Returns `null` when no candidate hashes to the recorded pool, which means the market
 * was created with a fee outside this set and the caller genuinely does not know its
 * pool.
 */
export function resolveAgenPoolKey(
  market: AgenMarketRecord,
  candidates: readonly number[] = [DYNAMIC_FEE_FLAG, 0, 100, 500, 3_000, 10_000],
): PoolKey | null {
  for (const fee of candidates) {
    const key = agenPoolKeyOf(market, fee);
    if (key !== null) return key;
  }
  return null;
}

/** How many markets have been launched through this registry. */
export async function readAgenMarketCount(
  client: PublicClient,
  registry: Address,
): Promise<number> {
  const count = await client.readContract({
    address: registry,
    abi: agenMarketRegistryAbi,
    functionName: "count",
  });
  return Number(count);
}

/** Whether this token is a market this registry deployed. */
export async function isAgenMarket(
  client: PublicClient,
  registry: Address,
  token: Address,
): Promise<boolean> {
  return client.readContract({
    address: registry,
    abi: agenMarketRegistryAbi,
    functionName: "isAgenMarket",
    args: [token],
  });
}

/**
 * A market by its token.
 *
 * Returns `null` for a token the registry does not know, because "this token was not
 * launched here" is an ordinary answer to an ordinary question — an interface asks it of
 * every address somebody pastes — and the registry reverts rather than returning an
 * empty struct.
 */
export async function readAgenMarketByToken(
  client: PublicClient,
  registry: Address,
  token: Address,
): Promise<AgenMarketRecord | null> {
  try {
    const raw = await client.readContract({
      address: registry,
      abi: agenMarketRegistryAbi,
      functionName: "marketByToken",
      args: [token],
    });
    return toRecord(raw as unknown as RawMarket);
  } catch {
    return null;
  }
}

/** A page of markets, newest first, as the registry pages them. */
export async function readAgenMarketPage(
  client: PublicClient,
  registry: Address,
  { offset = 0, limit = 50 }: { readonly offset?: number; readonly limit?: number } = {},
): Promise<readonly AgenMarketRecord[]> {
  const raw = await client.readContract({
    address: registry,
    abi: agenMarketRegistryAbi,
    functionName: "page",
    args: [BigInt(offset), BigInt(limit)],
  });

  return (raw as unknown as readonly RawMarket[]).map(toRecord);
}

/** Every contract in a market, including the locker the factory deployed. */
export async function readAgenComponents(
  client: PublicClient,
  registry: Address,
  index: number,
): Promise<readonly AgenComponent[]> {
  const raw = await client.readContract({
    address: registry,
    abi: agenMarketRegistryAbi,
    functionName: "componentsAt",
    args: [BigInt(index)],
  });

  return (raw as unknown as readonly { addr: Address; role: number; codeHash: Hex }[]).map(
    (component) => ({
      address: getAddress(component.addr),
      role: component.role,
      codeHash: component.codeHash,
    }),
  );
}

/**
 * The pool's price and depth, in one round trip.
 *
 * A pool that has never been initialised answers zero for both, which is how a caller
 * tells "launched" from "launched and open" without a second question.
 */
export async function readPoolState(
  client: PublicClient,
  stateView: Address,
  poolId: Hex,
): Promise<PoolState> {
  const [slot0, liquidity] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] },
      { address: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId] },
    ],
  });

  const [sqrtPriceX96, tick, , storedLpFee] = slot0;

  return {
    sqrtPriceX96,
    tick,
    storedLpFee,
    liquidity,
  };
}
