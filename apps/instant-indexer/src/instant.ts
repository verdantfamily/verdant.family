/**
 * Instant markets, as the chain reports them.
 *
 * The indexing logic, unchanged from when it lived beside Verdant's and Agen's in the
 * shared indexer. What changed is the address space around it: this is now its own service
 * with its own database, so these tables cannot be confused with the Programmable ones and
 * a deploy of this cannot re-index those.
 *
 * ## Why the fee is not in the swap rows
 *
 * `InstantHook` overrides the pool's LP fee to zero on every swap and takes its 1.50%
 * from the ether leg instead, so the `fee` the PoolManager reports is zero and the fee a
 * trader actually paid appears nowhere in the `Swap` event. That is stored as observed
 * rather than corrected: the rate is a constant of the deployment — `InstantFees`, 1.50%
 * total — so any consumer that needs it knows it without this table guessing. See
 * ADR-014.
 */

import { ponder } from "ponder:registry";
import { instantMarket, instantSwap, poolInit } from "ponder:schema";
import { abi } from "@verdant/sdk";
import { erc20Abi } from "viem";

ponder.on("InstantFactory:MarketCreated", async ({ event, context }) => {
  const poolId = event.args.poolId;
  const token = event.args.token;

  /**
   * The pool, opened seconds ago in this same transaction.
   *
   * `InstantFactory.create` initialises the pool and then emits this event, so the row is
   * always there. Its absence means the PoolManager being watched is not the one this
   * factory used, which would produce markets with no price and no fee — so it throws
   * rather than defaulting, because that state is indistinguishable from a working
   * indexer until somebody tries to trade.
   */
  const opened = await context.db.find(poolInit, { id: poolId });
  if (opened === null) {
    throw new Error(
      `Instant market ${poolId} has no Initialize event. The PoolManager address is ` +
        `wrong, in which case no Instant market will ever index correctly.`,
    );
  }

  /**
   * What the token calls itself, and where its document is.
   *
   * `metadataURI` is the whole of an Instant market's description: the picture, the text
   * and the creator's links are fields in a JSON document at that address, and the token
   * carries only the address. It is read here so a consumer has it without a second call,
   * and it is not followed here — fetching somebody's URL inside an indexing function
   * would make backfill depend on a web server being up.
   */
  const [name, symbol, decimals, totalSupply, metadataURI] = await Promise.all([
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
    context.client.readContract({
      abi: abi.verdantTokenAbi,
      address: token,
      functionName: "metadataURI",
      cache: "immutable",
    }),
  ]);

  await context.db.insert(instantMarket).values({
    id: poolId,
    token,
    // The shared hook, taken from the pool the factory opened rather than from
    // configuration, so this row describes the market that exists rather than the
    // deployment this indexer was pointed at.
    hook: opened.hooks,
    creator: event.args.creator,
    vault: event.args.vault,

    fee: opened.fee,
    tickSpacing: opened.tickSpacing,

    name,
    symbol,
    decimals,
    totalSupply,
    metadataURI,

    locker: event.args.locker,
    positionTokenId: event.args.positionTokenId,
    positionLiquidity: event.args.liquidity,

    createdAt: Number(event.block.timestamp),
    createdAtBlock: event.block.number,
    createdTx: event.transaction.hash,

    // The opening price, and the current one. They differ already if the creator bought
    // in the same transaction — Instant's first buy happens after this event — and the
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
});

/**
 * The argument Ponder hands a `PoolManager:Swap` handler.
 *
 * The type is generated per event from the configuration and cannot be written out by
 * hand, so it is recovered from the signature of the handler it belongs to.
 */
type SwapHandler = Parameters<Parameters<typeof ponder.on<"PoolManager:Swap">>[1]>[0];

/**
 * A swap in an Instant market's pool.
 *
 * A function rather than a registration, because `src/index.ts` owns the `PoolManager`
 * handlers: v4 emits every pool's swaps from one contract and Ponder allows one handler
 * per event, so the entry point has to be in one place even in a service that indexes
 * nothing else.
 *
 * Returns whether the pool was one of Instant's. Nothing in this service acts on the
 * answer any more — a pool that is not Instant's is simply somebody else's — but the
 * signature is unchanged from when the shared indexer used it to tell "handled" from "not
 * mine", and a caller that wants to count what it skipped still can.
 */
export async function indexInstantSwap({ event, context }: SwapHandler): Promise<boolean> {
  const existing = await context.db.find(instantMarket, { id: event.args.id });
  if (existing === null) return false;

  // The deltas are the swapper's, not the pool's. Instant's launch token is always
  // `currency1`, because ether is the zero address and every token sorts above it, so a
  // negative `amount0` is the trader paying ether: a buy.
  //
  // Worth stating because v4's own docstring on this event says "the delta of the
  // currency0 balance of the pool", which is the opposite. The code emits
  // `delta.amount0()` from the value it then accounts against `msg.sender`, so the comment
  // is wrong and the code is what matters. Reading the comment is how the Verdant handler
  // was first written, and it labelled every buy a sell.
  const buy = event.args.amount0 < 0n;
  const quoteAmount = event.args.amount0 < 0n ? -event.args.amount0 : event.args.amount0;
  const tokenAmount = event.args.amount1 < 0n ? -event.args.amount1 : event.args.amount1;

  await context.db.insert(instantSwap).values({
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

  await context.db.update(instantMarket, { id: event.args.id }).set((row) => ({
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
