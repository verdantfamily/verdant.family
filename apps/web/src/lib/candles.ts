import { candles } from "@verdant/sdk";

import type { CandleSeries } from "./feed";

/**
 * A candle series, on the wire.
 *
 * Two boundaries need this shape and they must agree about it: the server component
 * that renders a market page hands the chart its first series as a prop, and the chart
 * then polls a route for later ones. Prices are `bigint` — a price on this chain can be
 * 10^-14 of an ether, and a float loses its tail — and neither JSON nor a React server
 * payload carries one, so both cross as decimal strings and are widened back here.
 *
 * `traded` crosses too, rather than being inferred from a zero volume on arrival. A real
 * trade can move nothing measurable; only the indexer knows whether a bucket was
 * observed or filled, and the chart draws the two differently.
 */
export interface SerializedCandle {
  readonly start: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volumeQuote: string;
  readonly volumeToken: string;
  readonly trades: number;
  readonly traded: boolean;
}

export interface SerializedSeries {
  readonly interval: candles.CandleInterval;
  readonly seconds: number;
  readonly at: number;
  readonly candles: readonly SerializedCandle[];
}

export function serializeSeries(series: CandleSeries): SerializedSeries {
  return {
    interval: series.interval,
    seconds: series.seconds,
    at: series.at,
    candles: series.candles.map((candle) => ({
      start: candle.start,
      open: candle.open.toString(),
      high: candle.high.toString(),
      low: candle.low.toString(),
      close: candle.close.toString(),
      volumeQuote: candle.volumeQuote.toString(),
      volumeToken: candle.volumeToken.toString(),
      trades: candle.trades,
      traded: candle.traded,
    })),
  };
}

export function parseSeries(raw: SerializedSeries): CandleSeries {
  return {
    interval: raw.interval,
    seconds: raw.seconds,
    at: raw.at,
    candles: raw.candles.map((candle) => ({
      start: candle.start,
      open: BigInt(candle.open),
      high: BigInt(candle.high),
      low: BigInt(candle.low),
      close: BigInt(candle.close),
      volumeQuote: BigInt(candle.volumeQuote),
      volumeToken: BigInt(candle.volumeToken),
      trades: candle.trades,
      traded: candle.traded,
    })),
  };
}

/**
 * How often to ask for a series, whatever it is bucketed at.
 *
 * A constant, and it used to be a tenth of the bucket width floored at five seconds. That
 * reasoning was about the wrong thing. It asked "how long until a new bucket appears",
 * which on a five-minute chart is five minutes and gave a thirty-second poll — so a trade
 * landed and the line sat still for half a minute, which is exactly the complaint.
 *
 * What actually changes when somebody trades is the *close of the bucket already on
 * screen*, and that happens on every swap no matter how wide the bucket is. So the rate
 * that matters is how often trades arrive, which has nothing to do with the interval. Two
 * seconds is under the threshold where a person reads the delay as lag, and it matches the
 * trade tape beside the chart — the two would visibly disagree if the tape showed a swap
 * the line had not moved for yet.
 *
 * A second, matching the band of figures under the chart so the two cannot visibly
 * disagree — a market cap that had moved above a line that had not would be worse than
 * both being a beat behind. It is still far slower than the chain, which produces a block
 * roughly every hundred milliseconds; what bounds this is politeness to the indexer
 * rather than anything about how live it looks.
 *
 * The cost is one small request a second per open market page. The response is a few
 * hundred buckets of six numbers, and the query behind it is a grouped scan over an index
 * that already exists.
 */
export const POLL_MILLISECONDS = 1_000;

/**
 * How much history a reader is asking for, and what to bucket it into.
 *
 * The chart's control picks a *span* — "the last hour" — rather than a bucket width, which
 * is what a person means by the question and what every exchange's chart offers. The
 * indexer's parameters are the other pair, a width and a count, so each range names the
 * two that produce it. The widths are chosen to leave enough points to look like a line
 * and few enough that the series is small.
 */
export interface ChartRange {
  readonly id: string;
  readonly label: string;
  readonly interval: candles.CandleInterval;
  readonly buckets: number;
}

export const CHART_RANGES: readonly ChartRange[] = [
  { id: "5m", label: "5M", interval: "1m", buckets: 5 },
  { id: "1h", label: "1H", interval: "1m", buckets: 60 },
  { id: "6h", label: "6H", interval: "5m", buckets: 72 },
  { id: "1d", label: "1D", interval: "5m", buckets: 288 },
];

/** The range the chart opens on, and the one the server renders. */
export const DEFAULT_RANGE: ChartRange = CHART_RANGES[3]!;

/**
 * The range that covers a market's whole life.
 *
 * Computed rather than fixed, because "everything" is a day for a market launched this
 * morning and a year for one launched last year, and a single interval cannot serve both:
 * one-minute buckets over a year is half a million points, and daily buckets over a
 * morning is one. So this walks from the finest interval up and takes the first that
 * covers the age within the bucket ceiling — the finest resolution that fits.
 */
export function allRangeFor(ageSeconds: number, most = 600): ChartRange {
  const age = Math.max(ageSeconds, 60);

  for (const entry of candles.CANDLE_INTERVALS) {
    const needed = Math.ceil(age / entry.seconds);
    if (needed <= most) {
      return {
        id: "all",
        label: "ALL",
        interval: entry.id,
        // At least a handful, so a market minutes old still draws a line rather than a dot.
        buckets: Math.max(needed, 5),
      };
    }
  }

  // Older than a week times the ceiling. Weekly buckets, as many as allowed.
  return { id: "all", label: "ALL", interval: "1w", buckets: most };
}

/** 10^36, the scale `quotePerToken` returns prices at. */
const PRICE_SCALE = 10 ** 36;

/**
 * A price as a float, for a canvas and for nothing a reader sees.
 *
 * `lightweight-charts` takes numbers, and at these magnitudes a double has far more
 * precision than a pixel needs. Every price a reader *reads* is formatted from the
 * integer instead.
 */
export function asFloat(price: bigint): number {
  return Number(price) / PRICE_SCALE;
}

/** And back, so an axis can be labelled by the same function as the rest of the page. */
export function asPrice(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.round(value * PRICE_SCALE));
}

/**
 * How a price axis is written: its step, and how many digits that step needs.
 *
 * Two numbers rather than one because they are the same decision. The library asks for
 * the smallest move it should distinguish, and no fixed value serves both a market priced
 * in billionths and one priced in units — a step near a hundredth of the visible range
 * gives about ten labelled lines at any magnitude. But a label rounded to three
 * significant digits when the step is finer than that prints the same string twice, so
 * the digit count is derived from the step rather than fixed: enough to tell one gridline
 * from the next, and never fewer than the three shown elsewhere.
 *
 * There is no exponential form anywhere in this. `2.3e-9` on the axis of a page whose
 * heading reads `0.00000000228` is two notations for one number, and a reader would have
 * to convert between them to check that the chart agrees with the price above it.
 */
export interface AxisScale {
  readonly significant: number;
  readonly minMove: number;
}

export function axisScaleFor(values: readonly number[]): AxisScale {
  const fallback = { significant: 3, minMove: 1e-12 };
  if (values.length === 0) return fallback;

  const low = Math.min(...values);
  const high = Math.max(...values);
  const largest = Math.max(Math.abs(low), Math.abs(high));
  if (largest === 0 || !Number.isFinite(largest)) return fallback;

  const magnitude = Math.floor(Math.log10(largest));
  const range = high - low;
  const step = range > 0 ? Math.floor(Math.log10(range)) - 1 : magnitude - 2;

  return {
    // Capped, because a range narrow enough to want fifteen digits is a range whose
    // labels would not fit beside the chart.
    significant: Math.min(Math.max(magnitude - step + 1, 3), 9),
    minMove: Math.min(10 ** step, 1),
  };
}
