import { describe, expect, it } from "vitest";

import { areaChart, chartValues, shareAlt, shareDescription, shareTitle } from "./og-card";

describe("what a shared token link says", () => {
  it("leads with the ticker, then the name", () => {
    expect(shareTitle("VECST", "Vector Stag")).toBe("$VECST — Vector Stag");
  });

  it("uses the creator's sentence when they wrote one", () => {
    expect(
      shareDescription({
        headline: "A standard Instant token.",
        name: "Vector Stag",
        symbol: "VECST",
        marketCap: null,
      }),
    ).toBe("A standard Instant token.");
  });

  it("appends the capitalisation when one was measured", () => {
    expect(
      shareDescription({
        headline: "A standard Instant token.",
        name: "Vector Stag",
        symbol: "VECST",
        marketCap: "$14.7k",
      }),
    ).toBe("A standard Instant token. Market cap $14.7k.");
  });

  it("puts a stop before the capitalisation when the creator did not", () => {
    expect(
      shareDescription({
        headline: "A standard Instant token",
        name: "Vector Stag",
        symbol: "VECST",
        marketCap: "$14.7k",
      }),
    ).toBe("A standard Instant token. Market cap $14.7k.");
  });

  it("falls back to the name, not a brand slogan, when the creator wrote nothing", () => {
    expect(
      shareDescription({
        headline: "   ",
        name: "Vector Stag",
        symbol: "VECST",
        marketCap: "$14.7k",
      }),
    ).toBe("Vector Stag ($VECST) on agen.space. Market cap $14.7k.");
  });

  it("names the image after the token", () => {
    expect(shareAlt("VECST", "Vector Stag")).toBe("$VECST — Vector Stag on agen.space");
  });
});

describe("which closes a share card draws", () => {
  const PRICE = 10n ** 36n;

  it("refuses a series nobody has traded", () => {
    expect(
      chartValues([
        { close: PRICE, traded: false },
        { close: PRICE, traded: false },
      ]),
    ).toBeUndefined();
  });

  it("refuses a single observation, which is not a line", () => {
    expect(chartValues([{ close: PRICE, traded: true }])).toBeUndefined();
  });

  it("starts one bucket before the first trade and caps the quiet tail", () => {
    const values = chartValues([
      { close: 1n * PRICE, traded: false },
      { close: 2n * PRICE, traded: true },
      { close: 3n * PRICE, traded: true },
      { close: 3n * PRICE, traded: false },
      { close: 3n * PRICE, traded: false },
      { close: 3n * PRICE, traded: false },
      { close: 3n * PRICE, traded: false },
    ]);

    // Run-up, the two trades, then a tail no longer than that active span — not the
    // whole remaining flat, which would make a quiet market look like a ruler.
    expect(values?.slice(0, 3)).toEqual([1, 2, 3]);
    expect(values?.length).toBeGreaterThan(3);
    expect(values?.length).toBeLessThan(7);
  });
});

describe("the line a share card draws", () => {
  it("will not invent a path from one point, or from a broken number", () => {
    expect(areaChart([1], 100, 40)).toBeNull();
    expect(areaChart([1, Number.NaN], 100, 40)).toBeNull();
  });

  it("draws a flat series through the middle rather than dividing by zero", () => {
    const drawn = areaChart([4, 4, 4], 100, 40);
    expect(drawn).not.toBeNull();
    expect(drawn!.line).toMatch(/^M/);
    expect(drawn!.lastY).toBeCloseTo(18 + (40 - 18 - 10) / 2, 5);
    expect(drawn!.rising).toBe(true);
    expect(drawn!.stroke).toBe("#17c06b");
  });

  it("colours a rise green and a fall red, from the window not the last tick", () => {
    const up = areaChart([1, 2, 3], 90, 40);
    const down = areaChart([3, 2, 1], 90, 40);

    expect(up?.rising).toBe(true);
    expect(up?.stroke).toBe("#17c06b");
    expect(down?.rising).toBe(false);
    expect(down?.stroke).toBe("#b4232a");
  });

  it("puts the last point on the right edge, so the card ends on the live price", () => {
    const drawn = areaChart([1, 2, 4], 90, 40);
    expect(drawn?.lastX).toBe(90);
    expect(drawn?.lastY).toBeLessThan(18 + 2);
  });

  it("closes the fill against the bottom of the box", () => {
    const drawn = areaChart([1, 2], 80, 40);
    expect(drawn?.area).toContain("L 80.00 40.00 L 0 40.00 Z");
  });
});
