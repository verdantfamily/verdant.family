/**
 * The indexing functions.
 *
 * Two of Uniswap's events and one of Instant's. `src/instant.ts` holds the market handler
 * and the swap body; this file owns the `PoolManager` registrations, because v4 emits
 * every pool's events from one contract and Ponder allows one handler per event.
 *
 * ## A launch is one transaction, and its events arrive in a fixed order
 *
 * `InstantFactory.create` initialises the pool, mints the locked position, registers the
 * market and then emits `MarketCreated`, so the PoolManager's `Initialize` always precedes
 * it and any first buy comes after both. That order is a property of the factory's code
 * rather than a coincidence of log indices, which is what makes it safe to rely on:
 * `poolInit` is written first and read a moment later by the handler that creates the
 * market row.
 */

import { ponder } from "ponder:registry";
import { poolInit } from "ponder:schema";

// Also registers `InstantFactory:MarketCreated`, as a side effect of being imported.
import { indexInstantSwap } from "./instant";

/**
 * The opening price of every pool this indexer sees.
 *
 * Not filtered to Instant's hook, though it could be. The market handler needs this row to
 * already exist when `MarketCreated` arrives later in the same transaction, and filtering
 * on a configured hook address would make a misconfigured hook look like a chain where
 * nobody launched anything — the failure this indexer is least able to notice. A row that
 * no factory event ever claims is eight columns and is never read.
 */
ponder.on("PoolManager:Initialize", async ({ event, context }) => {
  await context.db.insert(poolInit).values({
    id: event.args.id,
    sqrtPriceX96: event.args.sqrtPriceX96,
    tick: event.args.tick,
    timestamp: Number(event.block.timestamp),
    blockNumber: event.block.number,
    fee: event.args.fee,
    tickSpacing: event.args.tickSpacing,
    hooks: event.args.hooks,
  });
});

/**
 * Every swap on the chain, of which this keeps Instant's.
 *
 * `Swap` carries its pool as an indexed argument but the set of Instant pool ids is only
 * known as markets are created, and a log filter cannot be extended after the fact — so
 * the filtering is here rather than in the configuration, and a pool this service has
 * never heard of is dropped.
 */
ponder.on("PoolManager:Swap", async ({ event, context }) => {
  await indexInstantSwap({ event, context });
});
