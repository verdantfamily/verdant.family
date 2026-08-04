/**
 * Price history in fixed intervals, and the one thing that makes it honest.
 *
 * ## Why an AMM may be forward-filled, and an order book may not
 *
 * A candle series over a market that trades rarely has holes in it, and the usual
 * treatment of a hole is a lie in one direction or the other: connect across it and
 * the chart shows a price gliding between two trades, leave it empty and the chart
 * shows a market whose price was unknown. Neither happened.
 *
 * What happened is that the pool's price sat exactly where the last trade left it.
 * A constant-function pool has a price at every instant, not only at the instants
 * somebody traded, and that price is a function of its reserves — which nothing but a
 * trade can change. So a filled candle here is not interpolation and not a
 * placeholder: it is the price the pool would have quoted throughout, flat, open
 * equal to close, with no volume. That is why `fill` exists and why it sets `traded`
 * to false — a reader who wants to know whether anybody actually traded in a bucket
 * must be able to tell, and a zero volume alone would not say it.
 *
 * ## Why the intervals are a closed set
 *
 * Because the indexer groups by them in SQL. An interval that arrived from a query
 * string as a number would be a number in a `GROUP BY`, and the set of buckets a
 * caller could ask the database to compute would be unbounded. Seven named intervals
 * are enough to read a market at every scale that a chain with sub-second blocks
 * offers, and each is a whole multiple of the one below it, so a client may aggregate
 * upwards from what it already has.
 */

/** The intervals a candle series can be asked for. */
export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

export interface IntervalDescriptor {
  readonly id: CandleInterval;
  /** What a control shows for it. */
  readonly label: string;
  readonly seconds: number;
}

/**
 * In ascending order, which is the order a selector should offer them in.
 *
 * A week is 604 800 seconds from the Unix epoch, which was a Thursday, so weekly
 * buckets here begin on Thursdays rather than on Mondays. Stated rather than
 * corrected: a market days old has no weekly candles worth aligning, and an offset
 * that made Monday the boundary would have to be applied identically in SQL and in
 * every client or the two would disagree about which bucket a trade fell in.
 */
export const CANDLE_INTERVALS: readonly IntervalDescriptor[] = [
  { id: "1m", label: "1m", seconds: 60 },
  { id: "5m", label: "5m", seconds: 300 },
  { id: "15m", label: "15m", seconds: 900 },
  { id: "1h", label: "1h", seconds: 3_600 },
  { id: "4h", label: "4h", seconds: 14_400 },
  { id: "1d", label: "1D", seconds: 86_400 },
  { id: "1w", label: "1W", seconds: 604_800 },
];

const BY_ID = new Map(CANDLE_INTERVALS.map((entry) => [entry.id, entry]));

export function isCandleInterval(value: string): value is CandleInterval {
  return BY_ID.has(value as CandleInterval);
}

export function intervalSeconds(interval: CandleInterval): number {
  const found = BY_ID.get(interval);
  if (found === undefined) throw new Error(`unknown interval ${interval}`);
  return found.seconds;
}

/** The start of the bucket a timestamp falls in. */
export function bucketStart(timestamp: number, seconds: number): number {
  return Math.floor(timestamp / seconds) * seconds;
}

/**
 * One bucket.
 *
 * Prices are units of the market's quote asset per whole token, scaled the way
 * `quotePerToken` scales them, and are therefore only comparable within one market.
 * They are `bigint` because a price on this chain can be 10^-14 of an ether and a
 * float would quietly lose the low digits of it.
 */
export interface Candle {
  /** Bucket start, in seconds. */
  readonly start: number;
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
  /** In the quote asset's smallest unit, both directions summed. */
  readonly volumeQuote: bigint;
  readonly volumeToken: bigint;
  readonly trades: number;
  /** False for a bucket `fill` invented from the previous close. */
  readonly traded: boolean;
}

/**
 * A gapless series, from the observed buckets and the price in force before them.
 *
 * `since` is where the series should start and `until` where it should end — both
 * bucket starts are derived from them, so a caller passes chain time rather than doing
 * the arithmetic.
 *
 * `anchor` is the price the pool held entering the window: the last trade before it,
 * or the launch price for a market that has not traded since. It is what makes a
 * window that contains no trades drawable at all, and it must come from the same
 * source as the buckets — an anchor from one market and buckets from another would
 * draw a step that nothing did.
 *
 * Observed buckets are copied through untouched. Everything between them is the
 * previous close, flat.
 */
export function fill(
  observed: readonly Candle[],
  {
    seconds,
    since,
    until,
    anchor,
  }: {
    readonly seconds: number;
    readonly since: number;
    readonly until: number;
    readonly anchor: { readonly at: number; readonly price: bigint } | undefined;
  },
): readonly Candle[] {
  const first = bucketStart(since, seconds);
  const last = bucketStart(until, seconds);
  if (last < first) return [];

  const byStart = new Map(observed.map((candle) => [candle.start, candle]));

  // Where the line starts. A bucket before the window carries its close forward, and
  // failing that the anchor does — but only if it was already in force by then,
  // because a flat line before a market existed is a price nothing ever quoted.
  const earlier = observed.filter((candle) => candle.start < first);
  let carried =
    earlier.length > 0
      ? earlier[earlier.length - 1]!.close
      : anchor !== undefined && anchor.at <= first + seconds
        ? anchor.price
        : undefined;

  const series: Candle[] = [];
  for (let start = first; start <= last; start += seconds) {
    const found = byStart.get(start);
    if (found !== undefined) {
      series.push(found);
      carried = found.close;
      continue;
    }

    // A bucket the market did not exist for yet is left out rather than flattened
    // backwards from a price that came later.
    if (carried === undefined) {
      if (anchor === undefined || anchor.at > start + seconds - 1) continue;
      carried = anchor.price;
    }

    series.push({
      start,
      open: carried,
      high: carried,
      low: carried,
      close: carried,
      volumeQuote: 0n,
      volumeToken: 0n,
      trades: 0,
      traded: false,
    });
  }

  return series;
}

/**
 * How far back a series of `count` buckets reaches from `until`.
 *
 * One place rather than three: the API uses it to bound a query, the interface uses
 * it to ask for a window, and a chart that asked for a different span than the one it
 * was given would draw a line that stops short of its own axis.
 */
export function windowStart(until: number, seconds: number, count: number): number {
  return bucketStart(until, seconds) - seconds * Math.max(count - 1, 0);
}
