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

/** One point as the chart library takes it: a second, and a value in series units. */
export interface ChartPoint {
  readonly time: number;
  readonly value: number;
}

/**
 * How a poll differs from what the chart already holds.
 *
 * The chart is refetched every second and the answer is nearly always the same buckets
 * with one number changed — the close of the bucket in progress, which every swap moves.
 * Telling that case apart from a genuine change of window is what lets the common one be
 * applied with the library's `update`, which moves the tip of the line and disturbs
 * nothing else. Handing it all to `setData` instead is not wrong about the data and is
 * visibly wrong to look at: the series is replaced, so the crosshair's marker blinks and
 * the framing has to be re-established a second after the reader chose their own.
 *
 * `from` is the index the tail starts at, so a caller updates `points.slice(from)`. It
 * includes the last point the chart already had, because that point is the live bucket and
 * its value is exactly what usually moved.
 *
 * A redraw is called for when a bucket has fallen off the front, when the series is a
 * different one, or when any completed bucket's value disagrees — the last of which should
 * not happen and is not quietly tolerated, since a bucket that has closed and then changed
 * means the history was revised and the whole line should be replaced rather than patched.
 */
export type SeriesDelta =
  | { readonly kind: "tail"; readonly from: number }
  | { readonly kind: "redraw" };

export function seriesDelta(
  held: readonly ChartPoint[] | null,
  next: readonly ChartPoint[],
): SeriesDelta {
  // Nothing drawn yet, or a series that has shrunk: neither can be reached by appending.
  if (held === null || held.length === 0 || next.length < held.length) return { kind: "redraw" };

  for (let at = 0; at < held.length; at += 1) {
    const old = held[at]!;
    const now = next[at];

    // A bucket has rolled off the front, so every index has shifted.
    if (now === undefined || now.time !== old.time) return { kind: "redraw" };

    // Completed buckets must agree. The last one held is the live bucket and may move.
    const completed = at < held.length - 1;
    if (completed && now.value !== old.value) return { kind: "redraw" };
  }

  return { kind: "tail", from: held.length - 1 };
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
 * A timeframe the reader can choose, and what it asks the feed for.
 *
 * The candle width, not a span. This used to offer spans — "the last hour", "the last
 * day" — which is what a person means in conversation and turned out to be the wrong
 * control here: it produced labels like `5M` and `1H` that look exactly like candle
 * widths, so a strip reading `5M 1H 6H 1D` was four windows dressed as four intervals and
 * nobody could tell which. Every exchange's chart offers the width, so this does too.
 *
 * `id` is the interval itself, which is why there is no separate field for it: the
 * timeframe *is* the interval, and giving it a second identity is how the two drifted
 * apart before.
 *
 * Only widths `@verdant/sdk` defines and the feed will answer for. A week is left out
 * rather than shown empty — no market on this chain is old enough for one weekly candle
 * to be a line — and nothing here offers a width the feed would refuse.
 */
export interface ChartFrame {
  readonly id: candles.CandleInterval;
  readonly label: string;
  /**
   * How many buckets to ask for.
   *
   * Enough to draw a line at any width rather than tuned per width, because the point of
   * choosing a width is to see the same number of them at a different resolution. A young
   * market simply has fewer, which is the truth about it and looks like it.
   */
  readonly buckets: number;
}

export const CHART_FRAMES: readonly ChartFrame[] = [
  { id: "1m", label: "1m", buckets: 120 },
  { id: "5m", label: "5m", buckets: 120 },
  { id: "15m", label: "15m", buckets: 120 },
  { id: "1h", label: "1h", buckets: 120 },
  { id: "4h", label: "4h", buckets: 120 },
  { id: "1d", label: "1d", buckets: 90 },
];

/**
 * The width the chart opens on, and the one the server renders.
 *
 * Five minutes: fine enough that a market trading today has a shape, coarse enough that
 * a market trading for a week still fits in one screen of buckets.
 */
export const DEFAULT_FRAME: ChartFrame = CHART_FRAMES[1]!;

/**
 * What the token page asks for before the browser has chosen anything.
 *
 * Kept under the old name because the page reads `.interval` and `.buckets` from it, and
 * a frame's interval is its id.
 */
export const DEFAULT_RANGE: {
  readonly interval: candles.CandleInterval;
  readonly buckets: number;
} = { interval: DEFAULT_FRAME.id, buckets: DEFAULT_FRAME.buckets };

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
