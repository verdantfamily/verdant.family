/**
 * The app's one door to the indexer.
 *
 * Everything on a token page that needs *history* comes through here: the candle series
 * behind the chart, the rolling day's volume, the change since yesterday, the trade
 * count. None of it can be read from the chain at a block — a pool knows its price now
 * and has no memory of what it was an hour ago — so an indexer is not an optimisation
 * for these figures, it is the only source.
 *
 * The figures that *can* be read from a block are deliberately not here. Price, market
 * cap and liquidity come from `lib/onchain.ts`, straight from the pool, and they keep
 * working when this module cannot answer. That split is the reason a token page degrades
 * to "no history yet" rather than to a blank page.
 *
 * ## An unreachable feed is a value, not an exception
 *
 * The indexer is a separate service that can be down, redeploying, or — right now, on a
 * fresh install — simply not running. Every function here resolves to `null` in that
 * case rather than throwing, because the alternative is a market page that 500s over a
 * chart. The caller renders a dash and says why.
 *
 * The one thing this must never do is make an absent feed look like an answer. A market
 * with no indexer and a market with genuinely no trades both have no candles, and only
 * the second one may be described to a reader as "nothing has traded yet". So
 * `feedConfigured` is exported separately: it distinguishes "we did not ask" from "we
 * asked and there is nothing".
 */

import "server-only";

import { candles } from "@verdant/sdk";

/**
 * Where the indexer is.
 *
 * Unset in development and on any deployment that has not been given one, which is a
 * supported state rather than a misconfiguration — see the module note. Ponder's default
 * port is the fallback so a locally-running indexer is found without ceremony.
 */
const FEED_URL = process.env.AGEN_FEED_URL?.trim() ?? "";

/** Whether this deployment has been told where the indexer is at all. */
export const feedConfigured: boolean = FEED_URL !== "";

/**
 * How long a page render may reuse a response.
 *
 * Five seconds, which is a few blocks on this chain. The chart polls a route that opts
 * out of this entirely, because a chart is the one thing on the page whose whole job is
 * to be current.
 */
const REVALIDATE_SECONDS = 5;

/**
 * Long enough for a cold indexer, short enough not to hold a page render hostage.
 *
 * Without this a feed that accepts connections and then never answers would hang the
 * server component until Next's own timeout, and a token page would take thirty seconds
 * to tell a reader that its chart is empty.
 */
const TIMEOUT_MS = 4_000;

// --- what the routes return -----------------------------------------------------

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
  };
  readonly allTime: { readonly high: string; readonly low: string };
}

// --- what the app works with ----------------------------------------------------

export interface CandleSeries {
  readonly interval: candles.CandleInterval;
  readonly seconds: number;
  /** Chain time the series was computed at, and the right-hand edge of the chart. */
  readonly at: number;
  readonly candles: readonly candles.Candle[];
}

export interface MarketStats {
  readonly at: number;
  readonly day: {
    /** Wei, like every other amount here. */
    readonly volumeQuote: bigint;
    readonly trades: number;
    readonly changePercent: number | null;
  };
  /** Quote-per-token at 36 decimals, the scale the candle prices use. */
  readonly allTime: { readonly high: bigint; readonly low: bigint };
}

/**
 * Ask the indexer, and treat every failure as an absence.
 *
 * Deliberately swallows: a 404 (this market has not been indexed yet, which is normal in
 * the seconds after a launch), a refused connection (no indexer), a timeout, and a
 * malformed body. Each of those means the same thing to every caller — there is no
 * history to show — and distinguishing them at the call site would produce four branches
 * that render the same dash.
 */
async function get<T>(path: string, fresh: boolean): Promise<T | null> {
  if (!feedConfigured) return null;

  try {
    const response = await fetch(`${FEED_URL}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(fresh ? { cache: "no-store" } : { next: { revalidate: REVALIDATE_SECONDS } }),
    });

    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/**
 * A market's price history, already gapless.
 *
 * The indexer returns the buckets it observed plus the price entering the window, and
 * the filling happens here through `candles.fill`, so a chart receives one point per
 * interval and no holes. A bucket nobody traded in still has a price — a constant-
 * function pool holds whatever the last trade left it at — so a flat filled candle is
 * the truth about the pool rather than an interpolation of it.
 *
 * `id` is a pool id or a token address; the indexer accepts either.
 */
export async function fetchCandles(
  id: string,
  interval: candles.CandleInterval,
  limit = 240,
  fresh = false,
): Promise<CandleSeries | null> {
  const raw = await get<RawCandles>(
    `/agen/markets/${id}/candles?interval=${interval}&limit=${String(limit)}`,
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

/** The rolling day and the all-time extremes the stat band shows. */
export async function fetchMarketStats(id: string, fresh = false): Promise<MarketStats | null> {
  const raw = await get<RawStats>(`/agen/markets/${id}/stats`, fresh);
  if (raw === null) return null;

  return {
    at: raw.at,
    day: {
      volumeQuote: BigInt(raw.day.volumeQuote),
      trades: raw.day.trades,
      changePercent: raw.day.changePercent,
    },
    allTime: { high: BigInt(raw.allTime.high), low: BigInt(raw.allTime.low) },
  };
}
