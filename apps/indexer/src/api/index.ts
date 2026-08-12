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
import { claim, feeCollection, holder, market, swap } from "ponder:schema";
import { candles as candleLib, pool, schedule } from "@verdant/sdk";
import { quotePerToken } from "@verdant/ui";
import { Hono } from "hono";
import { and, count, desc, eq, gt, gte, max, min, sql, sum } from "ponder";

import { agentForMarket, agentRoutes } from "./agents";

const app = new Hono();

/** How many markets a listing returns when the caller does not say. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * How many buckets a candle series returns. Higher than the market limit because a
 * bucket is six numbers rather than a whole market, and a chart wants a screen of them.
 */
const DEFAULT_CANDLES = 240;
const MAX_CANDLES = 1_000;

/**
 * How far into a list a caller may skip.
 *
 * A cap rather than none, because `OFFSET n` makes the database walk and discard n rows:
 * the work grows with the page number while the response stays the same size, which is
 * the shape of a query someone can point at this and leave running. Ten thousand is far
 * past any page a person scrolls to and still cheap on the indexes below.
 */
const MAX_OFFSET = 10_000;

/** How long "24h" is, in the chain's own seconds. */
const DAY_SECONDS = 86_400;

/** A caller's number, or the default, held inside a range. */
function bounded(raw: string | undefined, fallback: number, most: number): number {
  const requested = Number(raw ?? fallback);
  if (!Number.isFinite(requested)) return fallback;
  return Math.min(Math.max(Math.trunc(requested), 1), most);
}

/**
 * A caller's page position.
 *
 * Separate from `bounded` because zero is the right answer here and an invalid one
 * there: a limit of nothing is a request for no rows, while an offset of nothing is
 * the first page and is what every caller that does not paginate means.
 */
function offsetOf(raw: string | undefined): number {
  const requested = Number(raw ?? 0);
  if (!Number.isFinite(requested)) return 0;
  return Math.min(Math.max(Math.trunc(requested), 0), MAX_OFFSET);
}

/* `Math.min`/`Math.max` take numbers, and a sqrt price does not survive being one. */
function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * One market by pool id or by token address, for the routes that need the row itself.
 *
 * The same either-or `/markets/:id` accepts, because a link that works on one route
 * and 404s on the next is worse than one that never worked.
 */
async function findMarket(id: string): Promise<MarketRow | undefined> {
  const key = id.toLowerCase() as `0x${string}`;
  const rows = await db
    .select()
    .from(market)
    .where(key.length === 66 ? eq(market.id, key) : eq(market.token, key))
    .limit(1);

  return rows[0];
}

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

/**
 * Newest markets first, optionally only one creator's.
 *
 * The filter is on `creator`, which is whoever sent the launch transaction — the same
 * thing the `creatorIdx` index exists for. Note that it is *not* necessarily who the fees
 * belong to: a launch may name a different `feeRecipient`, and only the market's splitter
 * knows that address. A caller building a creator's page wants this list and then a read
 * per market against the chain, which is the split of work the two sources support.
 */
app.get("/markets", async (c) => {
  const limit = bounded(c.req.query("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  const creator = c.req.query("creator")?.toLowerCase();

  // Anything that is not an address matches nothing, rather than being ignored — a typo
  // that silently returned every market would look like the filter had worked.
  const where =
    creator === undefined ? undefined : eq(market.creator, creator as `0x${string}`);

  const [rows, at] = await Promise.all([
    (where === undefined
      ? db.select().from(market)
      : db.select().from(market).where(where)
    )
      .orderBy(desc(market.createdAt))
      .limit(limit),
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
  const row = await findMarket(c.req.param("id"));
  if (row === undefined) return c.json({ error: "no such market" }, 404);

  const [at, launchedBy] = await Promise.all([chainNow(), agentForMarket(row.id)]);

  /**
   * Who launched it, where that was an agent.
   *
   * Null for every market a person created, which is nearly all of them, and that null
   * is what keeps a human market's response exactly as it was. An agent-created market
   * is otherwise an ordinary market — same factory, same schedule, same splitter — so
   * this is one added field and nothing else changes.
   *
   * On the detail endpoint only. The listing would need a join per row to carry it, and
   * a card that wants attribution can follow the market it is already linking to.
   */
  return c.json({ ...present(row, at), launchedByAgent: launchedBy });
});

/**
 * A market's trades, newest first.
 *
 * `feePpm` on each row is what the pool reported charging, so a client can check the
 * schedule against history rather than taking this API's word for the current fee.
 */
app.get("/markets/:id/swaps", async (c) => {
  const poolId = c.req.param("id").toLowerCase() as `0x${string}`;
  const limit = bounded(c.req.query("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  const offset = offsetOf(c.req.query("offset"));

  const [rows, total, at] = await Promise.all([
    db
      .select()
      .from(swap)
      .where(eq(swap.poolId, poolId))
      // By position in the chain rather than by timestamp: blocks here are sub-second, so
      // many trades share a timestamp and only this order is the order they happened in.
      // It is also what makes paging stable — a timestamp sort would shuffle rows that
      // share a second between one page and the next.
      .orderBy(desc(swap.blockNumber), desc(swap.logIndex))
      .limit(limit)
      .offset(offset),
    db.select({ rows: count() }).from(swap).where(eq(swap.poolId, poolId)),
    chainNow(),
  ]);

  return c.json({
    poolId,
    /** Chain time, so a reader's "2m ago" is measured against the sequencer's clock. */
    at,
    /**
     * Every trade this market has, not the number returned. A pager needs to know how
     * many pages there are before it can draw itself, and `market.swapCount` is the same
     * number by a different route — counting here keeps the two from disagreeing if one
     * is ever backfilled without the other.
     */
    total: Number(total[0]?.rows ?? 0),
    offset,
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
 * Who holds a market's token, largest first.
 *
 * Balances come from `Transfer`, so this is every address the token has reached rather
 * than a list of people: a router mid-trade, the splitter holding uncollected fees and
 * a vesting contract are all holders by this definition, and calling them anything else
 * would mean this endpoint deciding which addresses count. It reports what it observed
 * and leaves that judgement to the reader, who can see the addresses.
 *
 * `balance > 0` is the filter because a row is left at zero rather than deleted when an
 * address sells out — "held once, holds none now" is worth keeping and is not a holder.
 */
app.get("/markets/:id/holders", async (c) => {
  const row = await findMarket(c.req.param("id"));
  if (row === undefined) return c.json({ error: "no such market" }, 404);

  const limit = bounded(c.req.query("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  const offset = offsetOf(c.req.query("offset"));
  const held = and(eq(holder.token, row.token), gt(holder.balance, 0n));

  const [rows, total] = await Promise.all([
    db
      .select()
      .from(holder)
      .where(held)
      // Ties broken by address so a page boundary does not shuffle two equal balances
      // between requests, which would drop or repeat a row across pages.
      .orderBy(desc(holder.balance), holder.address)
      .limit(limit)
      .offset(offset),
    db.select({ rows: count() }).from(holder).where(held),
  ]);

  return c.json({
    poolId: row.id,
    token: row.token,
    /** Sent along so a share of supply can be worked out without a second request. */
    totalSupply: row.totalSupply.toString(),
    decimals: row.decimals,
    total: Number(total[0]?.rows ?? 0),
    offset,
    holders: rows.map((entry) => ({
      address: entry.address,
      balance: entry.balance.toString(),
    })),
  });
});

/**
 * The figures a market page leads with that are not on the market row.
 *
 * Two aggregates over the swap table, computed on request for the same reason the
 * candles are: they are functions of the trades, and a maintained copy is a second
 * answer that drifts. The all-time total on `market` is not one of these — it is a
 * running sum the handlers keep, and a rolling window cannot be kept that way without
 * something firing when a trade ages out of it, which nothing does.
 *
 * ## The high comes from the smallest number
 *
 * The same inversion the candles route explains: currency0 is the quote asset, so a
 * token's price is the reciprocal of `sqrtPriceX96` and its highest price is the
 * *smallest* square root ever recorded. The launch price takes part in both extremes,
 * because the pool opened there and that is part of its history — without it a market
 * that has only fallen would report its high as its best trade rather than its launch.
 */
app.get("/markets/:id/stats", async (c) => {
  const row = await findMarket(c.req.param("id"));
  if (row === undefined) return c.json({ error: "no such market" }, 404);

  const poolId = row.id;
  const at = await chainNow();
  const since = at - DAY_SECONDS;

  const [day, extremes, holders] = await Promise.all([
    db
      .select({
        volumeQuote: sum(swap.quoteAmount),
        volumeToken: sum(swap.tokenAmount),
        trades: count(),
      })
      .from(swap)
      .where(and(eq(swap.poolId, poolId), gte(swap.timestamp, since))),

    db
      .select({ lowestSqrt: min(swap.sqrtPriceX96), highestSqrt: max(swap.sqrtPriceX96) })
      .from(swap)
      .where(eq(swap.poolId, poolId)),

    db
      .select({ rows: count() })
      .from(holder)
      .where(and(eq(holder.token, row.token), gt(holder.balance, 0n))),
  ]);

  const lowestSqrt = extremes[0]?.lowestSqrt ?? null;
  const highestSqrt = extremes[0]?.highestSqrt ?? null;
  const launch = row.initialSqrtPriceX96;

  const highSqrt = lowestSqrt === null ? launch : bigMin(BigInt(lowestSqrt), launch);
  const lowSqrt = highestSqrt === null ? launch : bigMax(BigInt(highestSqrt), launch);

  const asPrice = (sqrtPriceX96: bigint) =>
    quotePerToken(sqrtPriceX96, row.quoteDecimals).toString();

  return c.json({
    poolId,
    at,
    /** The width of the window below, so a client labels it from the response. */
    window: DAY_SECONDS,
    day: {
      since,
      volumeQuote: (day[0]?.volumeQuote ?? 0).toString(),
      volumeToken: (day[0]?.volumeToken ?? 0).toString(),
      trades: Number(day[0]?.trades ?? 0),
    },
    allTime: {
      high: asPrice(highSqrt),
      low: asPrice(lowSqrt),
    },
    /** Here rather than only on `/holders`, so a page can label the tab without
        fetching a list it is not showing yet. */
    holders: Number(holders[0]?.rows ?? 0),
  });
});

/**
 * A market's price history, in buckets.
 *
 * ## Derived here, and only here
 *
 * The swap table is the observation and this is the aggregation over it — computed on
 * request rather than maintained as rows, because a candle is a pure function of the
 * swaps in its window and a stored copy is a second answer that can drift from the
 * first. The cost is one grouped scan over an index that already exists.
 *
 * ## Why the highs come from the lowest number
 *
 * `sqrtPriceX96` is the price of *currency0 in currency1*, and a Verdant market's
 * currency0 is its quote asset while currency1 is the launch token. So the token's
 * price is the reciprocal, and the highest price a bucket reached is the *smallest*
 * square root in it. Getting this backwards produces a chart whose wicks point the
 * wrong way and whose body is inverted, which looks like data rather than like a bug —
 * hence `quotePerToken` doing the conversion once, here, for every consumer.
 *
 * ## What the anchor is for
 *
 * A window with no trades in it is still a window with a price: the pool held whatever
 * the last trade left it at. `anchor` is that price — the final swap before the window,
 * or the launch price if there was none — and the client fills forward from it. Sent
 * rather than assumed, because only this side can see the trades outside the window.
 */
app.get("/markets/:id/candles", async (c) => {
  const poolId = c.req.param("id").toLowerCase() as `0x${string}`;

  const interval = c.req.query("interval") ?? "5m";
  if (!candleLib.isCandleInterval(interval)) {
    return c.json(
      {
        error: `unknown interval "${interval}"`,
        intervals: candleLib.CANDLE_INTERVALS.map((entry) => entry.id),
      },
      400,
    );
  }

  const seconds = candleLib.intervalSeconds(interval);
  const limit = bounded(c.req.query("limit"), DEFAULT_CANDLES, MAX_CANDLES);

  const rows = await db.select().from(market).where(eq(market.id, poolId)).limit(1);
  const row = rows[0];
  if (row === undefined) return c.json({ error: "no such market" }, 404);

  const at = await chainNow();
  const since = candleLib.windowStart(at, seconds, limit);

  // Integer division, which is the floor for a timestamp and is what `bucketStart`
  // does in TypeScript. The interval is interpolated as a literal rather than bound as
  // a parameter because it appears in `GROUP BY`, where Postgres has no context to
  // infer a parameter's type from; it is one of seven constants, checked above.
  const step = sql.raw(String(seconds));
  const bucket = sql<number>`((${swap.timestamp} / ${step}) * ${step})`;

  const [buckets, before] = await Promise.all([
    db
      .select({
        start: bucket.as("start"),
        // First and last by position in the chain, which is why `logIndex` is stored:
        // two swaps in one block are ordered by it and by nothing else available here.
        openSqrt: sql<string>`(array_agg(${swap.sqrtPriceX96} ORDER BY ${swap.blockNumber} ASC, ${swap.logIndex} ASC))[1]`,
        closeSqrt: sql<string>`(array_agg(${swap.sqrtPriceX96} ORDER BY ${swap.blockNumber} DESC, ${swap.logIndex} DESC))[1]`,
        lowestSqrt: min(swap.sqrtPriceX96),
        highestSqrt: max(swap.sqrtPriceX96),
        volumeQuote: sum(swap.quoteAmount),
        volumeToken: sum(swap.tokenAmount),
        trades: count(),
      })
      .from(swap)
      .where(and(eq(swap.poolId, poolId), gte(swap.timestamp, since)))
      .groupBy(bucket)
      .orderBy(bucket),

    // The price entering the window. Ordered by position in the chain rather than by
    // timestamp, because a chain with sub-second blocks puts many blocks in one second
    // and the last of them is the one that set the price.
    db
      .select({ sqrtPriceX96: swap.sqrtPriceX96, timestamp: swap.timestamp })
      .from(swap)
      .where(and(eq(swap.poolId, poolId), sql`${swap.timestamp} < ${since}`))
      .orderBy(desc(swap.blockNumber), desc(swap.logIndex))
      .limit(1),
  ]);

  const price = (sqrtPriceX96: string | bigint | null): string =>
    quotePerToken(BigInt(sqrtPriceX96 ?? 0n), row.quoteDecimals).toString();

  const entering = before[0];

  return c.json({
    poolId,
    interval,
    seconds,
    /** Chain time, so a client fills forward to the same edge this counted to. */
    at,
    since,
    anchor: entering === undefined
      ? { at: row.initTime, price: price(row.initialSqrtPriceX96) }
      : { at: entering.timestamp, price: price(entering.sqrtPriceX96) },
    candles: buckets.map((bucketRow) => ({
      start: Number(bucketRow.start),
      open: price(bucketRow.openSqrt),
      high: price(bucketRow.lowestSqrt),
      low: price(bucketRow.highestSqrt),
      close: price(bucketRow.closeSqrt),
      volumeQuote: (bucketRow.volumeQuote ?? 0).toString(),
      volumeToken: (bucketRow.volumeToken ?? 0).toString(),
      trades: Number(bucketRow.trades),
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

/**
 * The agent endpoints.
 *
 * Mounted rather than written here, and given this module's own `chainNow`, `bounded`
 * and `offsetOf`. Two implementations of "what time does the chain think it is" would
 * eventually be two answers, and every response on both halves carries one.
 */
app.route(
  "/",
  agentRoutes({ chainNow, bounded, offsetOf, defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT }),
);

export default app;
