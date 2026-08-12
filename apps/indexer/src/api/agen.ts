/**
 * The feed for generated markets.
 *
 * Mounted beside the Verdant routes rather than merged into them, because the two
 * answer different questions with different fields: a Verdant market's page asks what
 * stage its fee schedule is in, and a generated market has no schedule to be in a stage
 * of — its fee is whatever its hook decided on the last swap, which is a number this
 * has observed rather than one it can derive.
 *
 * That difference is the whole reason there is no derivation layer here. The Verdant
 * routes exist to compute the fee, the stage and the countdown from a stored ladder;
 * these serve what was seen, plus the aggregations that are pure functions of it —
 * a day's volume, a candle, a change over a window. Nothing here is predicted.
 *
 * ## Prices are in the quote asset
 *
 * Which is ether for every market Agen creates. `quotePerToken` inverts the pool's
 * square-root price, because `sqrtPriceX96` prices currency0 in currency1 and a
 * generated market's currency1 is always its own token — the factory refuses a token
 * that does not sort above the quote asset, which is what makes that true for every
 * market rather than most of them.
 */

import { db } from "ponder:api";
import { agenComponent, agenMarket, agenSwap } from "ponder:schema";
import { candles as candleLib } from "@verdant/sdk";
import { quotePerToken } from "@verdant/ui";
import { Hono } from "hono";
import { and, count, desc, eq, gte, max, min, sql, sum } from "ponder";

const DEFAULT_CANDLES = 240;
const MAX_CANDLES = 1_000;
const DAY_SECONDS = 86_400;

/**
 * Ether's decimals.
 *
 * Every Agen market is quoted in the native currency, which v4 addresses as the zero
 * address and which has no contract to ask. Named rather than inlined so the one place
 * this assumption lives is visible if a market is ever quoted in something else.
 */
const QUOTE_DECIMALS = 18;

type MarketRow = typeof agenMarket.$inferSelect;

/**
 * One market by pool id or by token address.
 *
 * Both, because a link arriving from an explorer carries a token and a link from the
 * trade panel carries a pool, and a route that worked for one and 404ed on the other
 * would be a bug nobody could see from the URL.
 */
async function findMarket(id: string): Promise<MarketRow | undefined> {
  const key = id.toLowerCase() as `0x${string}`;
  const rows = await db
    .select()
    .from(agenMarket)
    .where(
      key.length === 66 ? eq(agenMarket.id, key) : eq(agenMarket.token, key),
    )
    .limit(1);

  return rows[0];
}

function price(sqrtPriceX96: bigint | string | null): string {
  return quotePerToken(BigInt(sqrtPriceX96 ?? 0n), QUOTE_DECIMALS).toString();
}

/**
 * A market as a client wants it.
 *
 * `bigint` becomes a decimal string throughout. JSON has no integer wide enough for
 * wei, and a `number` would silently round a supply of 10^15 tokens.
 */
function present(row: MarketRow) {
  return {
    poolId: row.id,
    index: row.marketIndex,
    token: row.token,
    hook: row.hook,
    creator: row.creator,
    quoteAsset: row.quoteAsset,

    /** What an interface needs to rebuild the pool key and quote a trade. */
    fee: row.fee,
    tickSpacing: row.tickSpacing,

    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    totalSupply: row.totalSupply.toString(),
    metadataURI: row.metadataURI,

    /** Both hashes, so a reader can check the market against what it was built from. */
    specificationHash: row.specificationHash,
    implementationHash: row.implementationHash,

    locker: row.locker,
    firstPositionId: row.firstPositionId.toString(),
    supplyLocked: row.supplyLocked.toString(),

    createdAt: row.createdAt,
    createdAtBlock: row.createdAtBlock.toString(),
    createdTx: row.createdTx,

    price: price(row.sqrtPriceX96),
    launchPrice: price(row.initialSqrtPriceX96),
    sqrtPriceX96: row.sqrtPriceX96.toString(),
    tick: row.tick,
    liquidity: row.liquidity.toString(),

    swapCount: row.swapCount,
    volumeQuote: row.volumeQuote.toString(),
    volumeToken: row.volumeToken.toString(),
    lastSwapAt: row.lastSwapAt,
  };
}

/**
 * Mounted by the module that owns the shared helpers rather than defining its own.
 *
 * Two implementations of "what time does the chain think it is" would eventually be two
 * answers, and every response on both halves of this API carries one.
 */
export function agenRoutes({
  chainNow,
  bounded,
  offsetOf,
  defaultLimit,
  maxLimit,
}: {
  readonly chainNow: () => Promise<number>;
  readonly bounded: (
    raw: string | undefined,
    fallback: number,
    most: number,
  ) => number;
  readonly offsetOf: (raw: string | undefined) => number;
  readonly defaultLimit: number;
  readonly maxLimit: number;
}): Hono {
  const agen = new Hono();

  agen.get("/markets", async (c) => {
    const limit = bounded(c.req.query("limit"), defaultLimit, maxLimit);
    const offset = offsetOf(c.req.query("offset"));

    const rows = await db
      .select()
      .from(agenMarket)
      .orderBy(desc(agenMarket.createdAt))
      .limit(limit)
      .offset(offset);

    const total = await db.select({ rows: count() }).from(agenMarket);

    return c.json({
      markets: rows.map(present),
      total: Number(total[0]?.rows ?? 0),
      limit,
      offset,
    });
  });

  agen.get("/markets/:id", async (c) => {
    const row = await findMarket(c.req.param("id"));
    if (row === undefined) return c.json({ error: "no such market" }, 404);

    const components = await db
      .select()
      .from(agenComponent)
      .where(eq(agenComponent.poolId, row.id));

    return c.json({
      ...present(row),
      components: components.map((component) => ({
        address: component.id,
        role: component.role,
        codeHash: component.codeHash,
      })),
    });
  });

  agen.get("/markets/:id/swaps", async (c) => {
    const row = await findMarket(c.req.param("id"));
    if (row === undefined) return c.json({ error: "no such market" }, 404);

    const limit = bounded(c.req.query("limit"), defaultLimit, maxLimit);
    const offset = offsetOf(c.req.query("offset"));

    const rows = await db
      .select()
      .from(agenSwap)
      .where(eq(agenSwap.poolId, row.id))
      .orderBy(desc(agenSwap.blockNumber), desc(agenSwap.logIndex))
      .limit(limit)
      .offset(offset);

    return c.json({
      poolId: row.id,
      swaps: rows.map((entry) => ({
        id: entry.id,
        /** Whoever called the PoolManager. A router for almost every trade. */
        sender: entry.sender,
        buy: entry.buy,
        quoteAmount: entry.quoteAmount.toString(),
        tokenAmount: entry.tokenAmount.toString(),
        price: price(entry.sqrtPriceX96),
        /**
         * The rate this swap was actually charged, which for a generated market is the
         * hook's own decision at that moment rather than the pool's stored fee. It is
         * the most interesting number in the row: it is the mechanic, observed.
         */
        feePpm: entry.feePpm,
        timestamp: entry.timestamp,
        transactionHash: entry.transactionHash,
      })),
      limit,
      offset,
    });
  });

  agen.get("/markets/:id/stats", async (c) => {
    const row = await findMarket(c.req.param("id"));
    if (row === undefined) return c.json({ error: "no such market" }, 404);

    const at = await chainNow();
    const since = at - DAY_SECONDS;

    const [day, extremes, entering] = await Promise.all([
      db
        .select({
          volumeQuote: sum(agenSwap.quoteAmount),
          volumeToken: sum(agenSwap.tokenAmount),
          trades: count(),
        })
        .from(agenSwap)
        .where(
          and(eq(agenSwap.poolId, row.id), gte(agenSwap.timestamp, since)),
        ),

      db
        .select({
          lowestSqrt: min(agenSwap.sqrtPriceX96),
          highestSqrt: max(agenSwap.sqrtPriceX96),
        })
        .from(agenSwap)
        .where(eq(agenSwap.poolId, row.id)),

      // The price entering the window, which is what a 24h change is measured from.
      // Ordered by position in the chain rather than by timestamp: this chain puts many
      // blocks in one second and the last of them set the price.
      db
        .select({ sqrtPriceX96: agenSwap.sqrtPriceX96 })
        .from(agenSwap)
        .where(
          and(
            eq(agenSwap.poolId, row.id),
            sql`${agenSwap.timestamp} < ${since}`,
          ),
        )
        .orderBy(desc(agenSwap.blockNumber), desc(agenSwap.logIndex))
        .limit(1),
    ]);

    // A market younger than the window has no "24 hours ago" to compare against, so its
    // launch price is the reference. That is the honest baseline: the change since it
    // opened, which is the only change it has had.
    const opened = entering[0]?.sqrtPriceX96 ?? row.initialSqrtPriceX96;
    const then = Number(price(opened));
    const now = Number(price(row.sqrtPriceX96));

    /**
     * Sorted the way a price is, not the way a square root is.
     *
     * `sqrtPriceX96` prices currency0 in currency1, and the token is currency1 — so the
     * *highest* price a market reached is its *smallest* recorded square root. Getting
     * this backwards produces a high below the low, which reads as data rather than as a
     * bug.
     */
    const lowest = extremes[0]?.lowestSqrt ?? null;
    const highest = extremes[0]?.highestSqrt ?? null;

    return c.json({
      poolId: row.id,
      at,
      window: DAY_SECONDS,
      day: {
        since,
        volumeQuote: (day[0]?.volumeQuote ?? 0).toString(),
        volumeToken: (day[0]?.volumeToken ?? 0).toString(),
        trades: Number(day[0]?.trades ?? 0),
        /** Percent, or null when the market has never traded and there is nothing to compare. */
        changePercent:
          then === 0 || row.swapCount === 0
            ? null
            : ((now - then) / then) * 100,
      },
      allTime: {
        high: price(lowest ?? row.initialSqrtPriceX96),
        low: price(highest ?? row.initialSqrtPriceX96),
      },
    });
  });

  agen.get("/markets/:id/candles", async (c) => {
    const row = await findMarket(c.req.param("id"));
    if (row === undefined) return c.json({ error: "no such market" }, 404);

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

    const at = await chainNow();
    const since = candleLib.windowStart(at, seconds, limit);

    // Interpolated rather than bound, because it appears in `GROUP BY` where Postgres
    // has no context to infer a parameter's type. It is one of seven constants, checked
    // above.
    const step = sql.raw(String(seconds));
    const bucket = sql<number>`((${agenSwap.timestamp} / ${step}) * ${step})`;

    const [buckets, before] = await Promise.all([
      db
        .select({
          start: bucket.as("start"),
          openSqrt: sql<string>`(array_agg(${agenSwap.sqrtPriceX96} ORDER BY ${agenSwap.blockNumber} ASC, ${agenSwap.logIndex} ASC))[1]`,
          closeSqrt: sql<string>`(array_agg(${agenSwap.sqrtPriceX96} ORDER BY ${agenSwap.blockNumber} DESC, ${agenSwap.logIndex} DESC))[1]`,
          lowestSqrt: min(agenSwap.sqrtPriceX96),
          highestSqrt: max(agenSwap.sqrtPriceX96),
          volumeQuote: sum(agenSwap.quoteAmount),
          volumeToken: sum(agenSwap.tokenAmount),
          trades: count(),
        })
        .from(agenSwap)
        .where(and(eq(agenSwap.poolId, row.id), gte(agenSwap.timestamp, since)))
        .groupBy(bucket)
        .orderBy(bucket),

      db
        .select({
          sqrtPriceX96: agenSwap.sqrtPriceX96,
          timestamp: agenSwap.timestamp,
        })
        .from(agenSwap)
        .where(
          and(
            eq(agenSwap.poolId, row.id),
            sql`${agenSwap.timestamp} < ${since}`,
          ),
        )
        .orderBy(desc(agenSwap.blockNumber), desc(agenSwap.logIndex))
        .limit(1),
    ]);

    const entering = before[0];

    return c.json({
      poolId: row.id,
      interval,
      seconds,
      at,
      since,
      /**
       * The price entering the window, so a client can fill a gap forward rather than
       * drawing a hole. Only this side can see the trades outside the window.
       */
      anchor:
        entering === undefined
          ? { at: row.createdAt, price: price(row.initialSqrtPriceX96) }
          : { at: entering.timestamp, price: price(entering.sqrtPriceX96) },
      candles: buckets.map((bucketRow) => ({
        start: Number(bucketRow.start),
        open: price(bucketRow.openSqrt),
        // The reciprocal again: the highest price in a bucket is its smallest root.
        high: price(bucketRow.lowestSqrt),
        low: price(bucketRow.highestSqrt),
        close: price(bucketRow.closeSqrt),
        volumeQuote: (bucketRow.volumeQuote ?? 0).toString(),
        volumeToken: (bucketRow.volumeToken ?? 0).toString(),
        trades: Number(bucketRow.trades),
      })),
    });
  });

  return agen;
}
