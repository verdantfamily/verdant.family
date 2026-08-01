/**
 * The HTTP surface the interface reads.
 *
 * Ponder already serves GraphQL and SQL over HTTP, and those stay available. These
 * endpoints exist for one reason: **they are where "store what was observed, derive
 * the rest" is carried out.** A market row holds the fee ladder and the pool's init
 * time; it does not hold the fee, the stage, or the countdown, because those change
 * with the clock and nothing on chain fires when they do. GraphQL over that table
 * would hand a client the raw ladder and leave every consumer to derive the fee for
 * itself — which is exactly how the interface and the contract end up disagreeing.
 *
 * So the derivation happens once, here, using `@verdant/sdk`'s schedule twin: the
 * same code, proven equal to `ScheduleLib.sol` against shared vectors.
 *
 * ## Which clock
 *
 * Chain time, not the server's. Fees are a function of `block.timestamp`, and on an
 * Orbit chain the sequencer's clock is not the reader's (V6). Every response carries
 * the block it was computed at, so a client can advance its own countdown from that
 * anchor instead of guessing.
 */

import { db, publicClients } from "ponder:api";
import { claim, feeCollection, market, swap } from "ponder:schema";
import { pool, schedule } from "@verdant/sdk";
import { Hono } from "hono";
import { desc, eq } from "ponder";

const app = new Hono();

/** How many markets a listing returns when the caller does not say. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

type MarketRow = typeof market.$inferSelect;

/**
 * The chain's current timestamp.
 *
 * Read per request rather than cached: the whole point of anchoring to chain time is
 * that it is the chain's, and a cached anchor is a wall clock with extra steps. It
 * is one RPC call against a client Ponder already holds open.
 */
async function chainNow(): Promise<number> {
  const block = await publicClients["robinhood"].getBlock();
  return Number(block.timestamp);
}

/**
 * A market as an API consumer wants it: the stored facts, plus everything the
 * schedule implies at `at`.
 *
 * `bigint` becomes a decimal string. JSON has no integer wide enough for wei, and
 * `number` would silently round a supply of 10^15 tokens. A string is unambiguous
 * and every client can turn it back into whatever it uses.
 */
function present(row: MarketRow, at: number) {
  const config: schedule.ScheduleConfig = {
    model: row.model,
    initTime: row.initTime,
    stages: row.stages,
  };

  return {
    poolId: row.id,
    token: row.token,
    creator: row.creator,
    model: row.model,

    // What the market is quoted in: the other half of the pair, named the way the
    // token below is named. `isNative` is derived here rather than stored, because
    // it is a restatement of the address and a stored copy is a second thing that
    // can disagree with it.
    quote: {
      asset: row.quoteAsset,
      symbol: row.quoteSymbol,
      name: row.quoteName,
      decimals: row.quoteDecimals,
      isNative: row.quoteAsset === pool.NATIVE_CURRENCY,
    },

    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    totalSupply: row.totalSupply.toString(),
    metadataURI: row.metadataURI,
    metadataMutable: row.metadataMutable,

    splitter: row.splitter,
    locker: row.locker,
    vesting: row.vesting,
    positionTokenId: row.positionTokenId.toString(),

    splits: {
      creatorBps: row.creatorBps,
      protocolBps: row.protocolBps,
      reserveBps: row.reserveBps,
    },

    // Stored: the ladder and its anchor.
    schedule: {
      initTime: row.initTime,
      stages: row.stages,
    },

    // Derived, at `at`, by the twin of the contract's own library.
    fee: {
      at,
      ppm: schedule.feeAt(config, at),
      stageIndex: schedule.stageAt(config, at),
      stageCount: row.stages.length,
      nextTransitionAt: schedule.nextTransition(config, at) ?? null,
      secondsToNextTransition:
        schedule.secondsUntilNextTransition(config, at) ?? null,
    },

    pool: {
      initialSqrtPriceX96: row.initialSqrtPriceX96.toString(),
      initialTick: row.initialTick,
      sqrtPriceX96: row.sqrtPriceX96.toString(),
      tick: row.tick,
      liquidity: row.liquidity.toString(),
    },

    activity: {
      swapCount: row.swapCount,
      // In the quote asset's own smallest unit, whatever that asset is. Read it
      // against `quote.decimals` above; there is deliberately no ether equivalent
      // for a stock-paired market, because the chain never quoted one.
      volumeQuote: row.volumeQuote.toString(),
      volumeToken: row.volumeToken.toString(),
      lastSwapAt: row.lastSwapAt,
    },

    createdAt: row.createdAt,
    createdAtBlock: row.createdAtBlock.toString(),
    createdTx: row.createdTx,
  };
}

/** Newest markets first. */
app.get("/markets", async (c) => {
  const requested = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const [rows, at] = await Promise.all([
    db.select().from(market).orderBy(desc(market.createdAt)).limit(limit),
    chainNow(),
  ]);

  return c.json({ at, markets: rows.map((row) => present(row, at)) });
});

/**
 * One market, by pool id or by token address.
 *
 * Both, because a link arriving from an explorer carries a token address while
 * everything internal carries a pool id, and making the caller convert would mean
 * publishing the derivation. The SDK can do it locally; so can this.
 */
app.get("/markets/:id", async (c) => {
  const id = c.req.param("id").toLowerCase();

  const rows = await db
    .select()
    .from(market)
    .where(id.length === 66 ? eq(market.id, id as `0x${string}`) : eq(market.token, id as `0x${string}`))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return c.json({ error: "no such market" }, 404);

  const at = await chainNow();
  return c.json(present(row, at));
});

/**
 * A market's trades, newest first.
 *
 * `feePpm` on each row is what the pool reported charging, so a client can check the
 * schedule against history rather than taking this API's word for the current fee.
 */
app.get("/markets/:id/swaps", async (c) => {
  const poolId = c.req.param("id").toLowerCase() as `0x${string}`;
  const requested = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const rows = await db
    .select()
    .from(swap)
    .where(eq(swap.poolId, poolId))
    .orderBy(desc(swap.timestamp))
    .limit(limit);

  return c.json({
    poolId,
    swaps: rows.map((row) => ({
      id: row.id,
      buy: row.buy,
      // The signed deltas as v4 emitted them, alongside the side derived from them.
      // Exposed rather than kept private so a consumer can check the derivation instead
      // of trusting it — the proof does exactly that.
      amount0: row.amount0.toString(),
      amount1: row.amount1.toString(),
      quoteAmount: row.quoteAmount.toString(),
      tokenAmount: row.tokenAmount.toString(),
      feePpm: row.feePpm,
      sqrtPriceX96: row.sqrtPriceX96.toString(),
      tick: row.tick,
      sender: row.sender,
      timestamp: row.timestamp,
      transactionHash: row.transactionHash,
    })),
  });
});

/**
 * Where a market's fees went.
 *
 * Two different facts, kept apart. A collection means fees left the locked position
 * and reached the splitter, where they wait; a claim means a recipient came and took
 * their share. Merging them would make an unclaimed balance look like a payment,
 * which is the one thing a creator reading this page cares about.
 */
app.get("/markets/:id/fees", async (c) => {
  const poolId = c.req.param("id").toLowerCase() as `0x${string}`;

  const [collections, claims] = await Promise.all([
    db
      .select()
      .from(feeCollection)
      .where(eq(feeCollection.poolId, poolId))
      .orderBy(desc(feeCollection.timestamp))
      .limit(MAX_LIMIT),
    db
      .select()
      .from(claim)
      .where(eq(claim.poolId, poolId))
      .orderBy(desc(claim.timestamp))
      .limit(MAX_LIMIT),
  ]);

  return c.json({
    poolId,
    collections: collections.map((row) => ({
      id: row.id,
      caller: row.caller,
      timestamp: row.timestamp,
      transactionHash: row.transactionHash,
    })),
    claims: claims.map((row) => ({
      id: row.id,
      recipient: row.recipient,
      quoteAmount: row.quoteAmount.toString(),
      tokenAmount: row.tokenAmount.toString(),
      timestamp: row.timestamp,
      transactionHash: row.transactionHash,
    })),
  });
});

export default app;
