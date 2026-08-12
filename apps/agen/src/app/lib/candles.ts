/**
 * A candle series on the wire, and the arithmetic a chart needs to draw one.
 *
 * Two boundaries have to agree about this shape: the server component that renders a
 * token page hands the chart its first series as a prop, and the chart then polls a route
 * for later ones. Prices are `bigint` — a token that has just launched can be worth
 * 10^-14 of an ether, and a float loses the tail that distinguishes one price from the
 * next — and neither JSON nor a React server payload carries a bigint, so both crossings
 * are decimal strings that are widened back here.
 *
 * `traded` crosses too rather than being inferred from a zero volume on arrival. A real
 * trade can move nothing measurable; only the indexer knows whether a bucket was observed
 * or filled forward.
 *
 * Adapted from the same module in `apps/web`. The reasoning it encodes — why the ranges
 * are spans rather than bucket widths, why an axis needs two numbers rather than one — is
 * not specific to that app, and a second set of answers arrived at independently would be
 * a second set of bugs.
 */

import type { candles } from "@verdant/sdk";

import type { CandleSeries } from "./feed";

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
 * Not derived from the bucket width, which is the reasoning that looks right and is not.
 * That asks "how long until a new bucket appears", which on a five-minute chart is five
 * minutes — so a trade lands and the line sits still. What actually changes when somebody
 * trades is the close of the bucket already on screen, and that happens on every swap no
 * matter how wide the bucket is.
 *
 * A second, matching the figures beside the chart so the two cannot visibly disagree.
 */
export const POLL_MILLISECONDS = 1_000;

/**
 * How much history a reader is asking for, and what to bucket it into.
 *
 * The control picks a *span* — "the last hour" — because that is what a person means and
 * what every exchange offers. The indexer's parameters are the other pair, a width and a
 * count, so each range names the two that produce it. The widths leave enough points to
 * look like a line and few enough that the series is small.
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
export const DEFAULT_RANGE: ChartRange = CHART_RANGES[2]!;

/**
 * The range covering a market's whole life.
 *
 * Computed rather than fixed, because "everything" is an hour for a market launched this
 * morning and a year for one launched last year, and no single interval serves both:
 * one-minute buckets over a year is half a million points, and daily buckets over a
 * morning is one. This walks from the finest interval up and takes the first that covers
 * the age within the ceiling.
 */
export function allRangeFor(
  ageSeconds: number,
  intervals: readonly candles.IntervalDescriptor[],
  most = 600,
): ChartRange {
  const age = Math.max(ageSeconds, 60);

  for (const entry of intervals) {
    const needed = Math.ceil(age / entry.seconds);
    if (needed <= most) {
      return {
        id: "all",
        label: "ALL",
        interval: entry.id,
        // At least a handful, so a market minutes old draws a line rather than a dot.
        buckets: Math.max(needed, 5),
      };
    }
  }

  return { id: "all", label: "ALL", interval: "1w", buckets: most };
}

/** 10^36, the scale the indexer's prices arrive at. */
const PRICE_SCALE = 10 ** 36;

/**
 * A price as a float, for a canvas and for nothing a reader sees.
 *
 * The chart library takes numbers, and at these magnitudes a double has far more
 * precision than a pixel needs. Every price a reader *reads* is formatted from the
 * integer instead.
 */
export function asFloat(price: bigint): number {
  return Number(price) / PRICE_SCALE;
}

/**
 * How a price axis is written: its step, and how many digits that step needs.
 *
 * Two numbers rather than one because they are the same decision. The library asks for
 * the smallest move it should distinguish, and no fixed value serves both a market priced
 * in billionths and one priced in units — a step near a hundredth of the visible range
 * gives about ten labelled lines at any magnitude. But a label rounded to three
 * significant digits when the step is finer prints the same string twice, so the digit
 * count is derived from the step rather than fixed.
 *
 * Nothing here produces exponential notation. `2.3e-9` on the axis of a page whose
 * heading reads `0.00000000228` is two notations for one number.
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
    // Capped: a range narrow enough to want fifteen digits is a range whose labels
    // would not fit beside the chart.
    significant: Math.min(Math.max(magnitude - step + 1, 3), 9),
    minMove: Math.min(10 ** step, 1),
  };
}

/**
 * A market capitalisation, as a compact string.
 *
 * The chart draws a capitalisation rather than a price per token, for the reason every
 * launchpad does: a price here is `0.00000000209` and no axis can be labelled with a
 * column of those. Supply is fixed for the life of an Agen token — the generated ERC20
 * has no mint function — so the two curves are the same shape and the conversion is one
 * multiplication.
 */
export function compactEth(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";

  if (value >= 1_000) {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(value);
  }
  if (value < 0.001) return value.toPrecision(3);

  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/**
 * A time on the horizontal axis and in the chart's footer.
 *
 * UTC, stated, rather than the reader's zone. A market page is read beside an explorer
 * and a block timestamp, and those are in UTC — a footer silently in Central European
 * Summer Time makes a reader think the chart disagrees with the chain.
 */
export function formatInstant(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 16)} UTC`;
}
