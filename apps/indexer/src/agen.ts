/**
 * Generated markets, as the chain reports them.
 *
 * Agen's launch layer is indexed beside Verdant's rather than inside it, for the same
 * reason the two have separate factories: they share a PoolManager and nothing else. A
 * Verdant market has a shape fixed at its factory's construction and a fee schedule
 * that can be read from one hook; a generated market is however many contracts a
 * mechanic needs and its fee is whatever its own hook decides, per swap, from state
 * nobody can enumerate in advance.
 *
 * ## One event, then one read
 *
 * `MarketDeployed` carries the token, the hook, the pool, the locker, the first
 * position id and the locked supply — everything that only the launch transaction
 * knows. Everything else is read from `AgenMarketRegistry` at that same block, which
 * is cheaper and steadier than following a second event stream to learn facts the
 * registry already holds in one struct.
 *
 * ## Why the pool's fee comes from Uniswap
 *
 * Because the registry does not record it. It stores the pool id, which is a hash of
 * the key, and the one field of that key that is not a constant for Agen is the fee —
 * dynamic for most markets, a fixed rate for the ones whose hook demands one. The
 * PoolManager's `Initialize` announces it, so it is read out of the `poolInit` row
 * written moments earlier in this same transaction. Without it an interface cannot
 * rebuild the key, and without the key it cannot quote a trade.
 */

import { ponder } from "ponder:registry";
import { agenComponent, agenMarket, agenSwap, poolInit } from "ponder:schema";
import { abi } from "@verdant/sdk";
import { erc20Abi } from "viem";

import { AGEN } from "./addresses";

ponder.on("AgenFactory:MarketDeployed", async ({ event, context }) => {
  const poolId = event.args.poolId;
  const token = event.args.token;

  /**
   * The pool, opened seconds ago in this same transaction.
   *
   * `AgenFactory.deployMarket` initialises the pool and then emits this event, so the
   * row is always there. Its absence means the PoolManager being watched is not the
   * one this factory used, which would produce markets with no price and no fee — so
   * it throws rather than defaulting, because that state is indistinguishable from a
   * working indexer until somebody tries to trade.
   */
  const opened = await context.db.find(poolInit, { id: poolId });
  if (opened === null) {
    throw new Error(
      `Agen market ${poolId} has no Initialize event. The PoolManager address is ` +
        `wrong, in which case no generated market will ever index correctly.`,
    );
  }

  // The registry's record: creator, quote asset, both provenance hashes and the
  // metadata URI. Read rather than carried, because the event has three indexed slots
  // and these would not fit in them.
  const record = await context.client.readContract({
    abi: abi.agenMarketRegistryAbi,
    address: AGEN.registry,
    functionName: "marketByToken",
    args: [token],
  });

  const components = await context.client.readContract({
    abi: abi.agenMarketRegistryAbi,
    address: AGEN.registry,
    functionName: "componentsAt",
    args: [event.args.index],
  });

  // What the token calls itself. Every generated token is a plain ERC-20 with
  // eighteen decimals, but they are read rather than assumed: the supply is a real
  // number a page divides by, and a generated contract is not obliged to be ordinary.
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    context.client.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "name",
      cache: "immutable",
    }),
    context.client.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "symbol",
      cache: "immutable",
    }),
    context.client.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "decimals",
      cache: "immutable",
    }),
    context.client.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "totalSupply",
    }),
  ]);

  await context.db.insert(agenMarket).values({
    id: poolId,
    marketIndex: Number(event.args.index),
    token,
    hook: event.args.hook,
    creator: record.creator,
    quoteAsset: record.quoteAsset,

    fee: opened.fee,
    tickSpacing: opened.tickSpacing,

    specificationHash: record.specificationHash,
    implementationHash: record.implementationHash,
    metadataURI: record.metadataURI,

    name,
    symbol,
    decimals,
    totalSupply,

    locker: event.args.locker,
    firstPositionId: event.args.firstTokenId,
    supplyLocked: event.args.supplyLocked,

    createdAt: Number(event.block.timestamp),
    createdAtBlock: event.block.number,
    createdTx: event.transaction.hash,

    // The opening price, and the current one. They differ already if the creator
    // bought in the same transaction — the dev buy happens after this event — and the
    // swap handler moves the second while the first stays put.
    initialSqrtPriceX96: opened.sqrtPriceX96,
    initialTick: opened.tick,
    sqrtPriceX96: opened.sqrtPriceX96,
    tick: opened.tick,
    liquidity: 0n,

    swapCount: 0,
    volumeQuote: 0n,
    volumeToken: 0n,
    lastSwapAt: null,
  });

  // Every contract the market is made of, including the locker the factory deployed
  // rather than generated. An interface listing a market's contracts without it would
  // be describing an incomplete market.
  for (const component of components) {
    await context.db.insert(agenComponent).values({
      id: component.addr,
      poolId,
      role: component.role,
      codeHash: component.codeHash,
    });
  }
});

/**
 * The argument Ponder hands a `PoolManager:Swap` handler.
 *
 * Named the way `src/agents.ts` names its context, and for the same reason: the type
 * is generated per event from the configuration and cannot be written out by hand, so
 * it is recovered from the signature of the handler it belongs to. Taking the whole
 * argument rather than its two members keeps this function callable with exactly what
 * the handler received.
 */
type SwapHandler = Parameters<Parameters<typeof ponder.on<"PoolManager:Swap">>[1]>[0];

/**
 * A swap in a generated market's pool.
 *
 * Called from the shared `PoolManager:Swap` handler rather than registered here: v4
 * emits every pool's swaps from one contract, Ponder allows one handler per event, and
 * the Verdant handler already owns it. This runs when that one does not recognise the
 * pool.
 *
 * Returns whether the pool was one of Agen's, so the caller can tell "handled" from
 * "belongs to neither system".
 */
export async function indexAgenSwap({ event, context }: SwapHandler): Promise<boolean> {
  const existing = await context.db.find(agenMarket, { id: event.args.id });
  if (existing === null) return false;

  // The deltas are the swapper's, not the pool's — the same reading the Verdant
  // handler documents at length, and it holds here for the same reason: the launched
  // token is always `currency1`, which the factory enforces by refusing a token that
  // does not sort above its quote asset. So a negative `amount0` is the trader paying
  // the quote asset, which is a buy.
  const buy = event.args.amount0 < 0n;
  const quoteAmount = event.args.amount0 < 0n ? -event.args.amount0 : event.args.amount0;
  const tokenAmount = event.args.amount1 < 0n ? -event.args.amount1 : event.args.amount1;

  await context.db.insert(agenSwap).values({
    id: `${event.transaction.hash}-${String(event.log.logIndex)}`,
    poolId: event.args.id,
    sender: event.args.sender,
    amount0: event.args.amount0,
    amount1: event.args.amount1,
    buy,
    quoteAmount,
    tokenAmount,
    sqrtPriceX96: event.args.sqrtPriceX96,
    liquidity: event.args.liquidity,
    tick: event.args.tick,
    feePpm: event.args.fee,
    timestamp: Number(event.block.timestamp),
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    transactionHash: event.transaction.hash,
  });

  await context.db.update(agenMarket, { id: event.args.id }).set((row) => ({
    sqrtPriceX96: event.args.sqrtPriceX96,
    tick: event.args.tick,
    liquidity: event.args.liquidity,
    swapCount: row.swapCount + 1,
    volumeQuote: row.volumeQuote + quoteAmount,
    volumeToken: row.volumeToken + tokenAmount,
    lastSwapAt: Number(event.block.timestamp),
  }));

  return true;
}
