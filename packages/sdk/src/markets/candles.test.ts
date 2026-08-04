import { describe, expect, it } from "vitest";

import {
  CANDLE_INTERVALS,
  bucketStart,
  fill,
  intervalSeconds,
  isCandleInterval,
  windowStart,
  type Candle,
} from "./candles.js";

/** A traded bucket, with only the fields a given assertion is about spelled out. */
function traded(start: number, prices: { open: bigint; high?: bigint; low?: bigint; close: bigint }): Candle {
  return {
    start,
    open: prices.open,
    high: prices.high ?? (prices.open > prices.close ? prices.open : prices.close),
    low: prices.low ?? (prices.open < prices.close ? prices.open : prices.close),
    close: prices.close,
    volumeQuote: 1_000n,
    volumeToken: 2_000n,
    trades: 1,
    traded: true,
  };
}

describe("the intervals", () => {
  it("are ascending, so a selector can render them in order", () => {
    const seconds = CANDLE_INTERVALS.map((entry) => entry.seconds);
    expect(seconds).toEqual([...seconds].sort((a, b) => a - b));
  });

  it("each divide into the one above, so a client may aggregate upwards", () => {
    for (let index = 1; index < CANDLE_INTERVALS.length; index++) {
      const below = CANDLE_INTERVALS[index - 1]!.seconds;
      const above = CANDLE_INTERVALS[index]!.seconds;
      expect(above % below).toBe(0);
    }
  });

  it("admit only their own names", () => {
    expect(isCandleInterval("5m")).toBe(true);
    expect(isCandleInterval("1s")).toBe(false);
    expect(isCandleInterval("30m")).toBe(false);
    expect(isCandleInterval("")).toBe(false);
  });

  it("resolve to seconds", () => {
    expect(intervalSeconds("1m")).toBe(60);
    expect(intervalSeconds("4h")).toBe(14_400);
    expect(intervalSeconds("1w")).toBe(604_800);
  });
});

describe("bucketStart", () => {
  it("floors to the interval", () => {
    expect(bucketStart(59, 60)).toBe(0);
    expect(bucketStart(60, 60)).toBe(60);
    expect(bucketStart(61, 60)).toBe(60);
  });

  it("agrees with integer division, which is what the SQL does", () => {
    for (const timestamp of [0, 1, 299, 300, 301, 1_785_651_082]) {
      expect(bucketStart(timestamp, 300)).toBe(Math.trunc(timestamp / 300) * 300);
    }
  });
});

describe("windowStart", () => {
  it("reaches back count buckets, inclusive of the last", () => {
    // Three one-minute buckets ending at 600 are 480, 540 and 600.
    expect(windowStart(620, 60, 3)).toBe(480);
  });

  it("treats a single bucket as the current one", () => {
    expect(windowStart(620, 60, 1)).toBe(600);
  });
});

describe("fill", () => {
  const anchor = { at: 1_000, price: 100n };

  it("carries the previous close across a quiet bucket, flat and with no volume", () => {
    const series = fill([traded(1_020, { open: 100n, close: 120n })], {
      seconds: 60,
      since: 1_020,
      until: 1_160,
      anchor,
    });

    expect(series.map((candle) => candle.start)).toEqual([1_020, 1_080, 1_140]);

    const quiet = series[1]!;
    expect(quiet.traded).toBe(false);
    expect([quiet.open, quiet.high, quiet.low, quiet.close]).toEqual([120n, 120n, 120n, 120n]);
    expect(quiet.volumeQuote).toBe(0n);
    expect(quiet.trades).toBe(0);
  });

  it("marks a bucket somebody traded in, so a flat candle is distinguishable from a quiet one", () => {
    // A real trade can leave price exactly where it was, and then the only difference
    // between it and an invented candle is this flag and the volume.
    const series = fill([traded(1_020, { open: 120n, close: 120n })], {
      seconds: 60,
      since: 1_020,
      until: 1_080,
      anchor,
    });

    expect(series[0]!.traded).toBe(true);
    expect(series[0]!.volumeQuote).toBeGreaterThan(0n);
    expect(series[1]!.traded).toBe(false);
  });

  it("starts a market that has never traded at the price it launched at", () => {
    const series = fill([], { seconds: 60, since: 1_000, until: 1_120, anchor });

    expect(series).toHaveLength(3);
    expect(series.every((candle) => candle.close === 100n)).toBe(true);
    expect(series.every((candle) => !candle.traded)).toBe(true);
  });

  it("draws nothing before the market existed", () => {
    const series = fill([], { seconds: 60, since: 700, until: 1_120, anchor });

    // 660 and 720 and 840 are buckets that ended before the pool was initialised at
    // 1 000; a flat line there would be a price nothing ever quoted.
    expect(series[0]!.start).toBe(960);
    expect(series.map((candle) => candle.start)).toEqual([960, 1_020, 1_080]);
  });

  it("carries a close from before the window rather than the launch price", () => {
    const series = fill(
      [traded(600, { open: 100n, close: 300n }), traded(660, { open: 300n, close: 400n })],
      { seconds: 60, since: 720, until: 780, anchor: { at: 0, price: 100n } },
    );

    expect(series.map((candle) => candle.close)).toEqual([400n, 400n]);
  });

  it("returns nothing when the window is inverted", () => {
    expect(fill([], { seconds: 60, since: 1_200, until: 600, anchor })).toEqual([]);
  });

  it("leaves an observed bucket exactly as the chain reported it", () => {
    const observed = traded(1_020, { open: 100n, high: 500n, low: 90n, close: 120n });
    const series = fill([observed], { seconds: 60, since: 1_020, until: 1_020, anchor });

    expect(series).toEqual([observed]);
  });

  it("has no anchor to fall back on and no trades, so draws nothing", () => {
    expect(fill([], { seconds: 60, since: 0, until: 600, anchor: undefined })).toEqual([]);
  });
});
