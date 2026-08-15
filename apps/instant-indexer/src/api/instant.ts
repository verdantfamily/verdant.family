/**
 * The feed for Instant markets.
 *
 * Unchanged from when these routes were mounted beside Verdant's and Agen's in the shared
 * indexer, and still under `/instant` for the reason `src/api/index.ts` gives: the prefix
 * is what the app already asks for, and it keeps `/markets/0x…` and `/instant/markets/0x…`
 * distinguishable now that they are served by different hosts.
 *
 * ## Simpler than the other two, and that is the product
 *
 * The Verdant routes exist to derive a fee, a stage and a countdown from a stored ladder.
 * The Agen routes serve a fee that was observed, because a generated hook decides one per
 * swap. Instant has neither problem: the rate is 1.50%, fixed in `InstantFees` and
 * enforced by a hook shared across every market, so nothing here computes or reports a
 * fee at all. A consumer that needs it reads the constant.
 *
 * That is also why `feePpm` does not appear on a swap. The hook overrides the pool's LP
 * fee to zero and takes its cut from the ether leg, so the number v4 reports is zero and
 * publishing it would invite a reader to conclude Instant is free.
 *
 * ## Prices are in ether
 *
 * For every Instant market, without exception — the factory hard-codes `currency0` to the
 * zero address. `quotePerToken` inverts the pool's square-root price because
 * `sqrtPriceX96` prices currency0 in currency1, and the launched token is always
 * currency1.
 */

import { db } from "ponder:api";
import { boostBuyback, instantMarket, instantSwap } from "ponder:schema";
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
 * Every Instant market is quoted in the native currency, which v4 addresses as the zero
 * address and which has no contract to ask.
 */
const QUOTE_DECIMALS = 18;

type MarketRow = typeof instantMarket.$inferSelect;

/**
 * One market by pool id or by token address.
 *
 * Both, because the interface addresses an Instant market by its token — it has no build
 * id to use instead — while everything internal carries a pool id. A route that worked
 * for one and 404ed on the other would be a bug nobody could see from the URL.
 */
async function findMarket(id: string): Promise<MarketRow | undefined> {
  const key = id.toLowerCase() as `0x${string}`;
  const rows = await db
    .select()
    .from(instantMarket)
    .where(key.length === 66 ? eq(instantMarket.id, key) : eq(instantMarket.token, key))
    .limit(1);

  return rows[0];
}

function price(sqrtPriceX96: bigint | string | null): string {
  return quotePerToken(BigInt(sqrtPriceX96 ?? 0n), QUOTE_DECIMALS).toString();
}

/**
 * A market as a client wants it.
 *
 * `bigint` becomes a decimal string throughout. JSON has no integer wide enough for wei,
 * and a `number` would silently round a supply of 10^27.
 */
function present(row: MarketRow) {
  return {
    poolId: row.id,
    token: row.token,
    hook: row.hook,
    creator: row.creator,
    /** Where the creator's ether accrues, and the address they claim from. */
    vault: row.vault,

    /** What an interface needs to rebuild the pool key and quote a trade. */
    fee: row.fee,
    tickSpacing: row.tickSpacing,

    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    totalSupply: row.totalSupply.toString(),
    /** The document holding the picture, the description and the creator's links. */
    metadataURI: row.metadataURI,

    locker: row.locker,
    positionTokenId: row.positionTokenId.toString(),
    positionLiquidity: row.positionLiquidity.toString(),

    createdAt: row.createdAt,
    createdAtBlock: row.createdAtBlock.toString(),
    createdTx: row.createdTx,

    price: price(row.sqrtPriceX96),
    launchPrice: price(row.initialSqrtPriceX96),
    sqrtPriceX96: row.sqrtPriceX96.toString(),
    tick: row.tick,
    liquidity: row.liquidity.toString(),

    /**
     * Total volume, and the two parts it divides into.
     *
     * `volumeQuote` is every swap in the pool, which is what the chain says and what this feed
     * has always reported. `boostVolumeQuote` is the part of it that was a Boost buyback, and
     * `organicVolumeQuote` is the subtraction — served rather than left to the caller so that
     * every consumer subtracts the same way.
     *
     * The distinction is not pedantry. A Boosted market's buybacks are its own creator's fees
     * being spent in its own pool, so counting them as volume would present a market as busier
     * than the interest in it warrants — which is the same thing a launchpad must not do with a
     * wash trade, arrived at by a legitimate route.
     */
    swapCount: row.swapCount,
    volumeQuote: row.volumeQuote.toString(),
    volumeToken: row.volumeToken.toString(),
    organicVolumeQuote: (row.volumeQuote - row.boostVolumeQuote).toString(),
    organicVolumeToken: (row.volumeToken - row.boostVolumeToken).toString(),
    boostVolumeQuote: row.boostVolumeQuote.toString(),
    boostVolumeToken: row.boostVolumeToken.toString(),
    lastSwapAt: row.lastSwapAt,

    /**
     * What this market has earned, as its vault credited it. Accrued, not claimed.
     *
     * `feeEtherLeg` is the ether the fee was charged against, and the two shares are what
     * the vault split it into — all three from `InstantFeeVault.Accrued` rather than from a
     * rate applied to volume, so a consumer can check the split without knowing the rate.
     */
    fees: {
      etherLeg: row.feeEtherLegQuote.toString(),
      creator: row.feesCreatorQuote.toString(),
      platform: row.feesPlatformQuote.toString(),
      total: (row.feesCreatorQuote + row.feesPlatformQuote).toString(),
    },

    /**
     * Agen Boost, as of the last event this feed saw.
     *
     * `boostEscrow` is null for every market that cannot be Boosted, which is every market
     * launched before Boost existed — the vault's recipient is immutable, so that null is
     * permanent rather than pending.
     *
     * `boostSunkToken` is **not** a reduction in `totalSupply` above. Instant tokens have no
     * `burn`, so the total never moves and a circulating supply is the difference between the
     * two. `circulatingSupply` is served for the same reason `organicVolumeQuote` is: so no
     * consumer has to know that and get it wrong.
     */
    boost: {
      escrow: row.boostEscrow,
      capable: row.boostEscrow !== null,
      enabled: row.boostEnabled,
      locked: row.boostLocked,
      spentQuote: row.boostSpentQuote.toString(),
      /** Whether this market's platform 0.50% is captured, which decides 1.50% or 1.00%. */
      platformCaptured: row.boostPlatformCaptured,
      /** Agen's 0.50%, routed by the fee architecture. A guarantee, not a gift. */
      agenRoutedQuote: row.boostAgenRoutedQuote.toString(),
      /** Ether contributed from outside either fee stream. A gift, not a guarantee. */
      agenDonatedQuote: row.boostAgenDonatedQuote.toString(),
      sunkToken: row.boostSunkToken.toString(),
      count: row.boostCount,
      lastBoostAt: row.lastBoostAt,
    },
    circulatingSupply: (row.totalSupply - row.boostSunkToken).toString(),
  };
}

/**
 * Mounted by the module that owns the helpers rather than defining its own.
 *
 * Two implementations of "what time does the chain think it is" would eventually be two
 * answers, and every response here carries one.
 */
export function instantRoutes({
  chainNow,
  bounded,
  offsetOf,
  defaultLimit,
  maxLimit,
}: {
  readonly chainNow: () => Promise<number>;
  readonly bounded: (raw: string | undefined, fallback: number, most: number) => number;
  readonly offsetOf: (raw: string | undefined) => number;
  readonly defaultLimit: number;
  readonly maxLimit: number;
}): Hono {
  const instant = new Hono();

  instant.get("/markets", async (c) => {
    const limit = bounded(c.req.query("limit"), defaultLimit, maxLimit);
    const offset = offsetOf(c.req.query("offset"));

    const rows = await db
      .select()
      .from(instantMarket)
      .orderBy(desc(instantMarket.createdAt))
      .limit(limit)
      .offset(offset);

    const total = await db.select({ rows: count() }).from(instantMarket);

    return c.json({
      markets: rows.map(present),
      total: Number(total[0]?.rows ?? 0),
      limit,
      offset,
    });
  });

  /**
   * Everything Instant has done, as one row of totals.
   *
   * Summed in the database rather than by paging `/markets` and adding it up in a client,
   * which is not an optimisation: a caller that adds up a page gets the totals for a page,
   * and the default page is twenty-five markets. A figure labelled "total volume" that
   * silently means "volume of the most recent twenty-five" is the kind of wrong that only
   * shows up once there are twenty-six.
   *
   * ## Accrued, not claimed
   *
   * `fees.creator` is what creators have earned, whether or not they have pressed the
   * button. Claimed-only figures would go down when somebody withdrew, which describes
   * treasury operations rather than what the protocol produced.
   *
   * ## Volume is split three ways for the reason `present` gives
   *
   * A Boost buyback is a real trade with real price impact, so it belongs in the pool's
   * own total — and it is a market spending its own fees, so it is not demand. Both
   * figures are served, along with the subtraction, so that no consumer has to decide
   * which one "volume" meant.
   */
  instant.get("/metrics", async (c) => {
    const at = await chainNow();
    const since = at - DAY_SECONDS;

    const [totals, creators, day, dayBoost, burns] = await Promise.all([
      db
        .select({
          markets: count(),
          trades: sum(instantMarket.swapCount),
          volumeQuote: sum(instantMarket.volumeQuote),
          volumeToken: sum(instantMarket.volumeToken),
          boostVolumeQuote: sum(instantMarket.boostVolumeQuote),
          boostVolumeToken: sum(instantMarket.boostVolumeToken),
          feeEtherLeg: sum(instantMarket.feeEtherLegQuote),
          feesCreator: sum(instantMarket.feesCreatorQuote),
          feesPlatform: sum(instantMarket.feesPlatformQuote),
          boostSpentQuote: sum(instantMarket.boostSpentQuote),
          boostSunkToken: sum(instantMarket.boostSunkToken),
          boostCount: sum(instantMarket.boostCount),
          lastLaunchAt: max(instantMarket.createdAt),
        })
        .from(instantMarket),

      // Distinct rather than a row count: one creator with six markets is one creator, and
      // conflating the two would make "creators" a synonym for "markets".
      db
        .select({ creators: sql<number>`count(distinct ${instantMarket.creator})` })
        .from(instantMarket),

      db
        .select({
          volumeQuote: sum(instantSwap.quoteAmount),
          trades: count(),
        })
        .from(instantSwap)
        .where(gte(instantSwap.timestamp, since)),

      db
        .select({ volumeQuote: sum(boostBuyback.etherSpent), count: count() })
        .from(boostBuyback)
        .where(gte(boostBuyback.timestamp, since)),

      // How many markets have Boost on right now, which is a different question from how
      // many have ever bought back.
      db
        .select({ boosting: count() })
        .from(instantMarket)
        .where(eq(instantMarket.boostEnabled, true)),
    ]);

    const all = totals[0];
    const asText = (value: unknown): string => BigInt(String(value ?? 0)).toString();

    return c.json({
      at,
      markets: Number(all?.markets ?? 0),
      creators: Number(creators[0]?.creators ?? 0),
      trades: Number(all?.trades ?? 0),

      volume: {
        quote: asText(all?.volumeQuote),
        token: asText(all?.volumeToken),
        boostQuote: asText(all?.boostVolumeQuote),
        boostToken: asText(all?.boostVolumeToken),
        organicQuote: notBelowZero(all?.volumeQuote, all?.boostVolumeQuote),
        organicToken: notBelowZero(all?.volumeToken, all?.boostVolumeToken),
      },

      fees: {
        etherLeg: asText(all?.feeEtherLeg),
        creator: asText(all?.feesCreator),
        platform: asText(all?.feesPlatform),
        total: (
          BigInt(asText(all?.feesCreator)) + BigInt(asText(all?.feesPlatform))
        ).toString(),
      },

      boost: {
        marketsEnabled: Number(burns[0]?.boosting ?? 0),
        spentQuote: asText(all?.boostSpentQuote),
        sunkToken: asText(all?.boostSunkToken),
        buybacks: Number(all?.boostCount ?? 0),
      },

      day: {
        since,
        volumeQuote: asText(day[0]?.volumeQuote),
        boostVolumeQuote: asText(dayBoost[0]?.volumeQuote),
        organicVolumeQuote: notBelowZero(day[0]?.volumeQuote, dayBoost[0]?.volumeQuote),
        trades: Number(day[0]?.trades ?? 0),
        boostBuybacks: Number(dayBoost[0]?.count ?? 0),
      },

      lastLaunchAt: all?.lastLaunchAt ?? null,
    });
  });

  instant.get("/markets/:id", async (c) => {
    const row = await findMarket(c.req.param("id"));
    if (row === undefined) return c.json({ error: "no such market" }, 404);

    return c.json(present(row));
  });

  instant.get("/markets/:id/swaps", async (c) => {
    const row = await findMarket(c.req.param("id"));
    if (row === undefined) return c.json({ error: "no such market" }, 404);

    const limit = bounded(c.req.query("limit"), defaultLimit, maxLimit);
    const offset = offsetOf(c.req.query("offset"));

    const [rows, total, at] = await Promise.all([
      db
        .select()
        .from(instantSwap)
        .where(eq(instantSwap.poolId, row.id))
        // By position in the chain rather than by timestamp: blocks here are sub-second,
        // so many trades share a timestamp and only this order is the order they happened
        // in. It is also what makes paging stable.
        .orderBy(desc(instantSwap.blockNumber), desc(instantSwap.logIndex))
        .limit(limit)
        .offset(offset),
      db
        .select({ rows: count() })
        .from(instantSwap)
        .where(eq(instantSwap.poolId, row.id)),
      chainNow(),
    ]);

    return c.json({
      poolId: row.id,
      /** Chain time, so a reader's "2m ago" is measured against the sequencer's clock. */
      at,
      total: Number(total[0]?.rows ?? 0),
      limit,
      offset,
      swaps: rows.map((entry) => ({
        id: entry.id,
        /** Whoever called the PoolManager. A router for almost every trade. */
        sender: entry.sender,
        buy: entry.buy,
        /** The signed deltas as v4 emitted them, so a consumer can check `buy`. */
        amount0: entry.amount0.toString(),
        amount1: entry.amount1.toString(),
        quoteAmount: entry.quoteAmount.toString(),
        tokenAmount: entry.tokenAmount.toString(),
        price: price(entry.sqrtPriceX96),
        timestamp: entry.timestamp,
        transactionHash: entry.transactionHash,
      })),
    });
  });

  instant.get("/markets/:id/stats", async (c) => {
    const row = await findMarket(c.req.param("id"));
    if (row === undefined) return c.json({ error: "no such market" }, 404);

    const at = await chainNow();
    const since = at - DAY_SECONDS;

    const [day, extremes, entering, boostDay] = await Promise.all([
      db
        .select({
          volumeQuote: sum(instantSwap.quoteAmount),
          volumeToken: sum(instantSwap.tokenAmount),
          trades: count(),
        })
        .from(instantSwap)
        .where(and(eq(instantSwap.poolId, row.id), gte(instantSwap.timestamp, since))),

      db
        .select({
          lowestSqrt: min(instantSwap.sqrtPriceX96),
          highestSqrt: max(instantSwap.sqrtPriceX96),
        })
        .from(instantSwap)
        .where(eq(instantSwap.poolId, row.id)),

      // The price entering the window, which is what a 24h change is measured from.
      // Ordered by position in the chain rather than by timestamp: this chain puts many
      // blocks in one second and the last of them set the price.
      db
        .select({ sqrtPriceX96: instantSwap.sqrtPriceX96 })
        .from(instantSwap)
        .where(
          and(
            eq(instantSwap.poolId, row.id),
            sql`${instantSwap.timestamp} < ${since}`,
          ),
        )
        .orderBy(desc(instantSwap.blockNumber), desc(instantSwap.logIndex))
        .limit(1),

      /*
       * The Boost buybacks inside the same window.
       *
       * Summed from `boost_buyback` rather than by filtering `instant_swap`, because the two
       * cannot be told apart there: a buyback reaches the pool through `AgenRouter` exactly as
       * a trader's buy does, so the swap row's `sender` is the router in both cases. The escrow's
       * own event is the only place the distinction exists.
       */
      db
        .select({
          volumeQuote: sum(boostBuyback.etherSpent),
          volumeToken: sum(boostBuyback.tokensBought),
          count: count(),
        })
        .from(boostBuyback)
        .where(and(eq(boostBuyback.token, row.token), gte(boostBuyback.timestamp, since))),
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
        /*
         * Three figures, because a Boosted market's volume is not all demand.
         *
         * `volumeQuote` is every swap, which is what the chain says. `boostVolumeQuote` is the
         * part that was the creator's own fees being spent in their own pool. `organic` is the
         * subtraction, and it is the one a "most active" ranking should use — otherwise a market
         * that Boosts hard outranks one people are actually buying.
         *
         * Clamped at zero rather than allowed negative. The two sources are different tables and
         * a backfill can have one ahead of the other for a few blocks; a negative volume is
         * never a truer answer than zero.
         */
        volumeQuote: (day[0]?.volumeQuote ?? 0).toString(),
        volumeToken: (day[0]?.volumeToken ?? 0).toString(),
        boostVolumeQuote: (boostDay[0]?.volumeQuote ?? 0).toString(),
        boostVolumeToken: (boostDay[0]?.volumeToken ?? 0).toString(),
        organicVolumeQuote: notBelowZero(day[0]?.volumeQuote, boostDay[0]?.volumeQuote),
        organicVolumeToken: notBelowZero(day[0]?.volumeToken, boostDay[0]?.volumeToken),
        boostBuybacks: Number(boostDay[0]?.count ?? 0),
        trades: Number(day[0]?.trades ?? 0),
        /** Percent, or null when the market has never traded and there is nothing to compare. */
        changePercent:
          then === 0 || row.swapCount === 0 ? null : ((now - then) / then) * 100,
      },
      allTime: {
        high: price(lowest ?? row.initialSqrtPriceX96),
        low: price(highest ?? row.initialSqrtPriceX96),
      },
    });
  });

  instant.get("/markets/:id/candles", async (c) => {
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

    // Interpolated rather than bound, because it appears in `GROUP BY` where Postgres has
    // no context to infer a parameter's type. It is one of seven constants, checked above.
    const step = sql.raw(String(seconds));
    const bucket = sql<number>`((${instantSwap.timestamp} / ${step}) * ${step})`;

    const [buckets, before] = await Promise.all([
      db
        .select({
          start: bucket.as("start"),
          // First and last by position in the chain, which is why `logIndex` is stored:
          // two swaps in one block are ordered by it and by nothing else available here.
          openSqrt: sql<string>`(array_agg(${instantSwap.sqrtPriceX96} ORDER BY ${instantSwap.blockNumber} ASC, ${instantSwap.logIndex} ASC))[1]`,
          closeSqrt: sql<string>`(array_agg(${instantSwap.sqrtPriceX96} ORDER BY ${instantSwap.blockNumber} DESC, ${instantSwap.logIndex} DESC))[1]`,
          lowestSqrt: min(instantSwap.sqrtPriceX96),
          highestSqrt: max(instantSwap.sqrtPriceX96),
          volumeQuote: sum(instantSwap.quoteAmount),
          volumeToken: sum(instantSwap.tokenAmount),
          trades: count(),
        })
        .from(instantSwap)
        .where(and(eq(instantSwap.poolId, row.id), gte(instantSwap.timestamp, since)))
        .groupBy(bucket)
        .orderBy(bucket),

      db
        .select({
          sqrtPriceX96: instantSwap.sqrtPriceX96,
          timestamp: instantSwap.timestamp,
        })
        .from(instantSwap)
        .where(
          and(
            eq(instantSwap.poolId, row.id),
            sql`${instantSwap.timestamp} < ${since}`,
          ),
        )
        .orderBy(desc(instantSwap.blockNumber), desc(instantSwap.logIndex))
        .limit(1),

      /*
       * The Boost buybacks inside the same window.
       *
       * Summed from `boost_buyback` rather than by filtering `instant_swap`, because the two
       * cannot be told apart there: a buyback reaches the pool through `AgenRouter` exactly as
       * a trader's buy does, so the swap row's `sender` is the router in both cases. The escrow's
       * own event is the only place the distinction exists.
       */
      db
        .select({
          volumeQuote: sum(boostBuyback.etherSpent),
          volumeToken: sum(boostBuyback.tokensBought),
          count: count(),
        })
        .from(boostBuyback)
        .where(and(eq(boostBuyback.token, row.token), gte(boostBuyback.timestamp, since))),
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

  return instant;
}

/**
 * A difference that cannot be negative.
 *
 * The total and the Boost figure come from two tables, and during a backfill one can be ahead of
 * the other by a few blocks — which would otherwise produce a negative organic volume. Zero is
 * wrong by less.
 */
function notBelowZero(total: unknown, part: unknown): string {
  const whole = BigInt(String(total ?? 0));
  const taken = BigInt(String(part ?? 0));
  return (whole > taken ? whole - taken : 0n).toString();
}
