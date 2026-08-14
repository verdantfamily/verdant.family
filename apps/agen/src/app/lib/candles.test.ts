import { describe, expect, it } from "vitest";

import { seriesDelta, type ChartPoint } from "./candles";

/**
 * How a live chart applies a poll.
 *
 * The chart asks for its series once a second. What comes back is almost always the same
 * buckets with one number moved — the close of the bucket in progress, which every swap
 * changes — and the difference between recognising that and not recognising it is the
 * difference between a line whose tip moves and a chart that reassembles itself in front
 * of the reader once a second, blinking the crosshair marker and throwing away whatever
 * window they had framed.
 *
 * So this is not a formatting detail. It is the whole of whether the chart is usable while
 * it is live, which is why the decision is a pure function with a test rather than a
 * condition buried in an effect where it can only be checked by watching it.
 */

/** Points as the chart holds them: a bucket start, and a value. */
function points(...pairs: readonly [number, number][]): readonly ChartPoint[] {
  return pairs.map(([time, value]) => ({ time, value }));
}

const HELD = points([60, 10], [120, 11], [180, 12]);

describe("recognising a poll that only moved the live bucket", () => {
  it("calls it a tail when the last value changed", () => {
    // The overwhelmingly common case: somebody traded inside the current bucket.
    const next = points([60, 10], [120, 11], [180, 12.5]);
    expect(seriesDelta(HELD, next)).toEqual({ kind: "tail", from: 2 });
  });

  it("calls it a tail when nothing changed at all", () => {
    // A poll between trades. Updating the one point it names is a no-op on the canvas,
    // which is the correct amount of work to do when nothing happened.
    expect(seriesDelta(HELD, HELD)).toEqual({ kind: "tail", from: 2 });
  });

  it("starts the tail at the live bucket, not after it", () => {
    // `from` has to include the last point already drawn, because that point is the one
    // whose value moved. Starting after it would leave the tip of the line stale — the
    // chart would only ever catch up when a bucket completed.
    const delta = seriesDelta(HELD, points([60, 10], [120, 11], [180, 99]));
    expect(delta).toEqual({ kind: "tail", from: HELD.length - 1 });
  });
});

describe("recognising a poll that appended buckets", () => {
  it("calls it a tail when one new bucket arrived", () => {
    const next = points([60, 10], [120, 11], [180, 12], [240, 13]);
    expect(seriesDelta(HELD, next)).toEqual({ kind: "tail", from: 2 });
  });

  it("calls it a tail when several did, as after a tab was hidden", () => {
    const next = points([60, 10], [120, 11], [180, 12], [240, 13], [300, 14], [360, 15]);
    expect(seriesDelta(HELD, next)).toEqual({ kind: "tail", from: 2 });
  });

  it("still allows the previously-live bucket to have settled", () => {
    // The bucket that was in progress closed at a different value than it was last seen
    // at, and two more arrived. All of it is still an append.
    const next = points([60, 10], [120, 11], [180, 12.9], [240, 13]);
    expect(seriesDelta(HELD, next)).toEqual({ kind: "tail", from: 2 });
  });
});

describe("recognising a poll that has to be redrawn", () => {
  it("redraws when a bucket has rolled off the front", () => {
    // The window is a fixed number of buckets ending now, so this happens once per bucket
    // width. Every index has shifted, so no sequence of appends expresses it.
    const next = points([120, 11], [180, 12], [240, 13]);
    expect(seriesDelta(HELD, next)).toEqual({ kind: "redraw" });
  });

  it("redraws when a completed bucket's value disagrees", () => {
    // History was revised. Patching the tail would leave the chart showing a past this
    // series no longer claims, so the whole line is replaced.
    const next = points([60, 10], [120, 99], [180, 12]);
    expect(seriesDelta(HELD, next)).toEqual({ kind: "redraw" });
  });

  it("redraws when the series got shorter", () => {
    expect(seriesDelta(HELD, points([60, 10], [120, 11]))).toEqual({ kind: "redraw" });
  });

  it("redraws the first series, having nothing to compare against", () => {
    expect(seriesDelta(null, HELD)).toEqual({ kind: "redraw" });
    expect(seriesDelta([], HELD)).toEqual({ kind: "redraw" });
  });

  it("redraws an emptied series rather than naming a tail in nothing", () => {
    expect(seriesDelta(HELD, [])).toEqual({ kind: "redraw" });
  });
});

describe("the shape of a market's first minutes", () => {
  it("takes one redraw and then only tails, as a market opens and trades", () => {
    // A market is launched and then traded into, second by second. Counting the redraws is
    // what this is for: one, at the start. If polling a live market redrew, the chart would
    // be unusable in exactly the situation it matters most.
    let held: readonly ChartPoint[] | null = null;
    let redraws = 0;
    let tails = 0;

    // The opening bucket, then twenty polls that move it, then a bucket boundary.
    const polls: readonly ChartPoint[][] = [
      [...points([60, 1])],
      ...Array.from({ length: 20 }, (_, step) => [...points([60, 1 + (step + 1) / 100])]),
      [...points([60, 1.2], [120, 1.2])],
      [...points([60, 1.2], [120, 1.31])],
    ];

    for (const poll of polls) {
      const delta = seriesDelta(held, poll);
      if (delta.kind === "redraw") redraws += 1;
      else tails += 1;
      held = poll;
    }

    expect(redraws).toBe(1);
    expect(tails).toBe(polls.length - 1);
  });
});
