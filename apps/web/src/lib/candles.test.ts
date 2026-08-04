import { formatPrice } from "@verdant/ui";
import { describe, expect, it } from "vitest";

import { allRangeFor, asFloat, asPrice, axisScaleFor } from "./candles";

/** What the chart does with a scale: label the gridlines it implies. */
function labels(from: number, scale: { significant: number; minMove: number }, count: number) {
  return Array.from({ length: count }, (_, index) =>
    formatPrice(asPrice(from + index * scale.minMove), {
      significant: scale.significant,
      round: true,
    }),
  );
}

describe("the price axis", () => {
  it("keeps a launch-priced market to three digits", () => {
    // A market opening around 2 × 10^-9 ether and moving a tenth of that.
    const scale = axisScaleFor([2.08e-9, 2.18e-9, 2.28e-9]);

    expect(scale.significant).toBe(3);
    expect(labels(2.08e-9, scale, 3)).toEqual([
      "0.00000000208",
      "0.00000000209",
      "0.0000000021",
    ]);
  });

  it("spends more digits when the range is narrower than three of them", () => {
    // A tenth of a percent of the price. Three digits would print one label repeatedly.
    const scale = axisScaleFor([2.28e-9, 2.2801e-9]);

    expect(scale.significant).toBeGreaterThan(3);
    expect(new Set(labels(2.28e-9, scale, 6)).size).toBe(6);
  });

  it("gives every gridline its own label, at every magnitude a market can have", () => {
    // The property the digit count exists for. Two adjacent gridlines that print the
    // same string are an axis that appears to have stopped counting.
    for (const price of [4.7, 0.015, 1.2e-4, 2.3e-9, 8e-14]) {
      for (const spread of [0.5, 0.05, 0.001]) {
        const scale = axisScaleFor([price, price * (1 + spread)]);
        const drawn = labels(price, scale, 8);
        expect(new Set(drawn).size, `${price} ± ${spread}: ${drawn.join(" ")}`).toBe(8);
      }
    }
  });

  it("does not divide by a range of nothing", () => {
    // Every bucket at the same price, which is what an untraded market looks like.
    const scale = axisScaleFor([2.28e-9, 2.28e-9, 2.28e-9]);

    expect(scale.significant).toBe(3);
    expect(scale.minMove).toBeGreaterThan(0);
    expect(labels(2.28e-9, scale, 2)).toEqual(["0.00000000228", "0.00000000229"]);
  });

  it("has an answer for a series that is not there yet", () => {
    expect(axisScaleFor([])).toEqual({ significant: 3, minMove: 1e-12 });
    expect(axisScaleFor([0])).toEqual({ significant: 3, minMove: 1e-12 });
  });

  it("never labels a price in exponential notation", () => {
    for (const price of [8e-15, 2.3e-9, 4.7, 12_000]) {
      const scale = axisScaleFor([price, price * 1.1]);
      expect(labels(price, scale, 4).join(" ")).not.toMatch(/e/i);
    }
  });
});

describe("prices across the canvas boundary", () => {
  it("survives the round trip at the magnitudes a launch produces", () => {
    // Not exact — a double cannot hold 36 digits — but far inside what a pixel or a
    // three-digit label can distinguish.
    for (const price of [2_082_761_744_365_514_988_817_566_792n, 10n ** 36n, 1n]) {
      const back = asPrice(asFloat(price));
      const error = back > price ? back - price : price - back;
      expect(Number(error) / Number(price)).toBeLessThan(1e-12);
    }
  });

  it("refuses to invent a price from a number that is not one", () => {
    expect(asPrice(0)).toBe(0n);
    expect(asPrice(-1)).toBe(0n);
    expect(asPrice(Number.NaN)).toBe(0n);
    expect(asPrice(Number.POSITIVE_INFINITY)).toBe(0n);
  });
});

describe("the range that covers a market's whole life", () => {
  it("takes the finest bucket that still fits inside the ceiling", () => {
    // Two hours old: 120 one-minute buckets, comfortably inside 600.
    expect(allRangeFor(2 * 60 * 60)).toMatchObject({ interval: "1m", buckets: 120 });

    // Two days old. One-minute buckets would need 2 880, so it steps up until one fits —
    // five-minute buckets need 576, which does.
    expect(allRangeFor(2 * 24 * 60 * 60)).toMatchObject({ interval: "5m", buckets: 576 });

    // A year. Everything finer than a day overflows.
    expect(allRangeFor(365 * 24 * 60 * 60).interval).toBe("1d");
  });

  it("draws a line rather than a dot for a market minutes old", () => {
    // Three minutes is three one-minute buckets, and three points barely register as a
    // line. The floor asks for a few more, which are filled forward from the launch price.
    expect(allRangeFor(180).buckets).toBe(5);
  });

  it("never asks for more buckets than the caller allows", () => {
    for (const age of [60, 3_600, 86_400, 30 * 86_400, 4_000 * 86_400]) {
      expect(allRangeFor(age).buckets).toBeLessThanOrEqual(600);
    }
  });
});
