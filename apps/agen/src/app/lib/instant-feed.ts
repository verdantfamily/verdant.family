import "server-only";

/**
 * The Instant indexer, which is a different service from the Programmable one.
 *
 * A separate module from `lib/feed.ts` rather than a `kind` parameter threaded through it,
 * because the two address different routes over different tables on different hosts, and
 * the Programmable ones are in service. Adding a branch inside `fetchCandles` would put
 * every Programmable chart one typo away from asking the wrong indexer, in exchange for
 * saving a file.
 *
 * ## Its own address, and its own transport
 *
 * `AGEN_INSTANT_FEED_URL`, with no fallback to `AGEN_FEED_URL`. The two indexers hold
 * different tables and answer different paths: pointing this at the Programmable one would
 * not degrade, it would 404 every request while looking configured. An unset variable is a
 * supported state — the pages render dashes, exactly as they do when the Programmable feed
 * is unset — and it is the honest one for a build that has not been told where the Instant
 * indexer lives.
 *
 * The fifteen lines of transport below are therefore a deliberate second copy rather than
 * an import from `lib/feed.ts`. They were shared while there was one indexer and one URL;
 * there are now two of each, so the thing that was worth centralising no longer exists.
 *
 * ## The mapping below is also deliberately a second copy
 *
 * `fetchInstantCandles` repeats the bigint conversion that `fetchCandles` does, rather
 * than both calling a helper extracted from one of them. Extracting it would mean editing
 * the function every Programmable chart already depends on to save fourteen lines here.
 * The shapes are the same because both routes serve the same contract, and if that ever
 * stops being true this copy is what lets the two diverge without a negotiation.
 */

import { candles } from "@verdant/sdk";

import type { CandleSeries, MarketStats } from "./feed";

/** Where the Instant indexer is. Empty when this build has not been told. */
const INSTANT_FEED_URL = process.env.AGEN_INSTANT_FEED_URL?.trim() ?? "";

/** Whether this deployment has been told where the Instant indexer is at all. */
export const instantFeedConfigured: boolean = INSTANT_FEED_URL !== "";

/** Five seconds, which is a few blocks on this chain. The chart route opts out. */
const REVALIDATE_SECONDS = 5;

/** Long enough for a cold indexer, short enough not to hold a page render hostage. */
const TIMEOUT_MS = 4_000;

/**
 * One request, and null for every way it can fail.
 *
 * No indexer configured, a refusal, a timeout, an unreachable host, a malformed body: each
 * means the same thing to every caller — there is no history to show — and distinguishing
 * them at the call site would produce five branches that render the same dash.
 */
async function ask<T>(path: string, fresh = false): Promise<T | null> {
  if (!instantFeedConfigured) return null;

  try {
    const response = await fetch(`${INSTANT_FEED_URL}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(fresh ? { cache: "no-store" } : { next: { revalidate: REVALIDATE_SECONDS } }),
    });

    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

interface RawCandles {
  readonly interval: candles.CandleInterval;
  readonly seconds: number;
  readonly at: number;
  readonly since: number;
  readonly anchor: { readonly at: number; readonly price: string };
  readonly candles: readonly {
    readonly start: number;
    readonly open: string;
    readonly high: string;
    readonly low: string;
    readonly close: string;
    readonly volumeQuote: string;
    readonly volumeToken: string;
    readonly trades: number;
  }[];
}

interface RawStats {
  readonly at: number;
  readonly window: number;
  readonly day: {
    readonly since: number;
    readonly volumeQuote: string;
    readonly volumeToken: string;
    readonly trades: number;
    readonly changePercent: number | null;
    /**
     * The Boost split, optional because an older indexer does not send it.
     *
     * Optional rather than required, and it matters which: this app and the indexer deploy
     * separately, so a build of the site can be newer than the feed answering it. An absent
     * field then means "this feed cannot tell Boost apart", and the reader below falls back to
     * treating all volume as organic — which is exactly right for a feed indexed before Boost
     * existed, since none of it was a buyback.
     */
    readonly organicVolumeQuote?: string;
    readonly boostVolumeQuote?: string;
    readonly boostBuybacks?: number;
  };
  readonly allTime: { readonly high: string; readonly low: string };
}

interface RawSwaps {
  readonly poolId: string;
  readonly at: number;
  readonly total: number;
  readonly swaps: readonly {
    readonly id: string;
    readonly sender: string;
    readonly buy: boolean;
    readonly quoteAmount: string;
    readonly tokenAmount: string;
    readonly price: string;
    readonly timestamp: number;
    readonly transactionHash: string;
  }[];
}

/** One trade in an Instant market, in the units the page shows. */
export interface InstantTrade {
  readonly id: string;
  readonly at: number;
  /**
   * Whoever called the PoolManager, which for almost every trade is a router rather than
   * the person. Reported as observed: the alternative is decoding hook data the Instant
   * hook does not read, and naming a trader this cannot see would be an invention.
   */
  readonly sender: string;
  readonly side: "buy" | "sell";
  /** Ether, as a float. Wei divided once here rather than at three call sites. */
  readonly ether: number;
  /** Whole tokens. */
  readonly tokens: number;
  readonly txHash: string;
}

/**
 * An Instant market's price history, already gapless.
 *
 * The indexer returns the buckets it observed plus the price entering the window, and the
 * filling happens here through `candles.fill`, so a chart receives one point per interval
 * and no holes. A bucket nobody traded in still has a price — a constant-function pool
 * holds whatever the last trade left it at — so a flat filled candle is the truth about
 * the pool rather than an interpolation of it.
 *
 * `id` is a pool id or a token address; the indexer accepts either.
 */
export async function fetchInstantCandles(
  id: string,
  interval: candles.CandleInterval,
  limit = 240,
  fresh = false,
): Promise<CandleSeries | null> {
  const raw = await ask<RawCandles>(
    `/instant/markets/${id}/candles?interval=${interval}&limit=${String(limit)}`,
    fresh,
  );
  if (raw === null) return null;

  const observed = raw.candles.map((candle) => ({
    start: candle.start,
    open: BigInt(candle.open),
    high: BigInt(candle.high),
    low: BigInt(candle.low),
    close: BigInt(candle.close),
    volumeQuote: BigInt(candle.volumeQuote),
    volumeToken: BigInt(candle.volumeToken),
    trades: candle.trades,
    traded: true,
  }));

  return {
    interval: raw.interval,
    seconds: raw.seconds,
    at: raw.at,
    candles: candles.fill(observed, {
      seconds: raw.seconds,
      since: raw.since,
      until: raw.at,
      anchor: { at: raw.anchor.at, price: BigInt(raw.anchor.price) },
    }),
  };
}

/** The rolling day and the all-time extremes an Instant market page shows. */
export async function fetchInstantStats(
  id: string,
  fresh = false,
): Promise<MarketStats | null> {
  const raw = await ask<RawStats>(`/instant/markets/${id}/stats`, fresh);
  if (raw === null) return null;

  return {
    at: raw.at,
    day: {
      volumeQuote: BigInt(raw.day.volumeQuote),
      // Absent means the feed predates Boost, in which case no volume was a buyback and the
      // total *is* the organic figure. Defaulting the other way round would report zero
      // activity for every market on an older feed.
      organicVolumeQuote: BigInt(raw.day.organicVolumeQuote ?? raw.day.volumeQuote),
      boostVolumeQuote: BigInt(raw.day.boostVolumeQuote ?? "0"),
      boostBuybacks: raw.day.boostBuybacks ?? 0,
      trades: raw.day.trades,
      changePercent: raw.day.changePercent,
    },
    allTime: { high: BigInt(raw.allTime.high), low: BigInt(raw.allTime.low) },
  };
}

interface RawMetrics {
  readonly at: number;
  readonly markets: number;
  readonly creators: number;
  readonly trades: number;
  readonly volume: {
    readonly quote: string;
    readonly boostQuote: string;
    readonly organicQuote: string;
  };
  readonly fees: {
    readonly creator: string;
    readonly platform: string;
    readonly total: string;
  };
  readonly boost: {
    readonly marketsEnabled: number;
    readonly spentQuote: string;
    readonly sunkToken: string;
    readonly buybacks: number;
  };
  readonly day: {
    readonly volumeQuote: string;
    readonly organicVolumeQuote: string;
    readonly trades: number;
  };
  readonly lastLaunchAt: number | null;
}

/**
 * Everything Instant has done, in wei and whole counts.
 *
 * Amounts stay `bigint` all the way to the formatter. A total volume in wei is around 10^18
 * before anybody has traded much, and the moment it becomes a `number` the low digits are
 * gone — which does not matter for a headline figure and matters a great deal for the
 * identity a reader might check, that the creator's share is exactly twice the platform's.
 */
export interface InstantMetrics {
  /** Chain time the figures were computed at, not the reader's clock. */
  readonly at: number;
  readonly markets: number;
  readonly creators: number;
  readonly trades: number;

  /** Every swap in every Instant pool. */
  readonly volumeQuote: bigint;
  /** The part of it that was a Boost buyback: a market spending its own fees. */
  readonly boostVolumeQuote: bigint;
  /** The subtraction, which is the figure a "how busy is this" reading wants. */
  readonly organicVolumeQuote: bigint;

  /**
   * Fees as the vaults credited them — earned, not withdrawn.
   *
   * Claimed-only figures would fall when a creator withdrew, which would describe their
   * banking rather than what the protocol produced.
   */
  readonly feesCreator: bigint;
  readonly feesPlatform: bigint;
  readonly feesTotal: bigint;

  readonly boostMarkets: number;
  readonly boostSpentQuote: bigint;
  readonly boostSunkToken: bigint;
  readonly boostBuybacks: number;

  readonly dayVolumeQuote: bigint;
  readonly dayOrganicVolumeQuote: bigint;
  readonly dayTrades: number;

  readonly lastLaunchAt: number | null;
}

/**
 * The platform's totals, or null when there is no feed to ask.
 *
 * Null rather than a zeroed object, and the distinction is the whole reason this returns an
 * option: zeroes would render as a launchpad where nothing has ever happened, which is a
 * confident false statement. A page with no feed shows dashes instead.
 */
export async function fetchInstantMetrics(): Promise<InstantMetrics | null> {
  const raw = await ask<RawMetrics>("/instant/metrics");
  if (raw === null) return null;

  return {
    at: raw.at,
    markets: raw.markets,
    creators: raw.creators,
    trades: raw.trades,

    volumeQuote: BigInt(raw.volume.quote),
    boostVolumeQuote: BigInt(raw.volume.boostQuote),
    organicVolumeQuote: BigInt(raw.volume.organicQuote),

    feesCreator: BigInt(raw.fees.creator),
    feesPlatform: BigInt(raw.fees.platform),
    feesTotal: BigInt(raw.fees.total),

    boostMarkets: raw.boost.marketsEnabled,
    boostSpentQuote: BigInt(raw.boost.spentQuote),
    boostSunkToken: BigInt(raw.boost.sunkToken),
    boostBuybacks: raw.boost.buybacks,

    dayVolumeQuote: BigInt(raw.day.volumeQuote),
    dayOrganicVolumeQuote: BigInt(raw.day.organicVolumeQuote),
    dayTrades: raw.day.trades,

    lastLaunchAt: raw.lastLaunchAt,
  };
}

/**
 * An Instant market's trades, newest first.
 *
 * Empty rather than null when the feed cannot answer, because the caller renders a list
 * and the difference between "no indexer" and "no trades" is already carried by
 * `feedConfigured` on the page around it.
 *
 * There is no fee on a row. `InstantHook` overrides the pool's LP fee to zero and takes
 * its 1.50% from the ether leg, so the fee v4 reports is zero and printing it would tell
 * a reader the trade was free. The rate is a constant of the deployment; the page states
 * it once.
 */
export async function fetchInstantTrades(
  id: string,
  limit = 50,
): Promise<readonly InstantTrade[]> {
  const raw = await ask<RawSwaps>(
    `/instant/markets/${id}/swaps?limit=${String(limit)}`,
  );
  if (raw === null) return [];

  return raw.swaps.map((swap) => ({
    id: swap.id,
    at: swap.timestamp,
    sender: swap.sender,
    side: swap.buy ? ("buy" as const) : ("sell" as const),
    ether: Number(swap.quoteAmount) / 1e18,
    tokens: Number(swap.tokenAmount) / 1e18,
    txHash: swap.transactionHash,
  }));
}
