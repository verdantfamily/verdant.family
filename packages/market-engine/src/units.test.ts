import { describe, expect, it } from "vitest";

import {
  MAX_FEE_PPM,
  PPM_ONE,
  PPM_PER_PERCENT,
  feeOf,
  formatPercent,
  percentToPpm,
  ppmToPercent,
  shareOf,
  supplyPercentToTokens,
} from "./units.js";

describe("percentToPpm", () => {
  it("converts the rates prompts actually state", () => {
    expect(percentToPpm("2")).toBe(20_000);
    expect(percentToPpm("0.5")).toBe(5_000);
    expect(percentToPpm("4")).toBe(40_000);
    expect(percentToPpm("1.25")).toBe(12_500);
    expect(percentToPpm("100")).toBe(PPM_ONE);
    expect(percentToPpm("0")).toBe(0);
  });

  /*
   * The reason rates travel as strings.
   *
   * `2.675 * 10_000` is 26749.999999999996 in IEEE 754, and 0.29 * 10_000 is
   * 2899.9999999999995. Rounding hides both until some other rate rounds the other way
   * and a market charges a rate nobody wrote. Reading the decimal digits directly is
   * exact for every input a person can type.
   */
  it("is exact where floating point is not", () => {
    expect(percentToPpm("2.675")).toBe(26_750);
    expect(percentToPpm("0.29")).toBe(2_900);
    expect(percentToPpm("8.31")).toBe(83_100);
    expect(percentToPpm("0.07")).toBe(700);
  });

  it("accepts exactly one ppm, which is four decimal places", () => {
    expect(percentToPpm("0.0001")).toBe(1);
  });

  it("refuses a rate finer than one ppm rather than rounding it", () => {
    // Rounding here would be choosing a rate on the creator's behalf.
    expect(percentToPpm("0.00001")).toBeNull();
    expect(percentToPpm("1.234567")).toBeNull();
  });

  it("refuses anything that is not a plain decimal", () => {
    expect(percentToPpm("")).toBeNull();
    expect(percentToPpm("half")).toBeNull();
    expect(percentToPpm("2%")).toBeNull();
    expect(percentToPpm("-1")).toBeNull();
    expect(percentToPpm("1e2")).toBeNull();
    expect(percentToPpm("0x2")).toBeNull();
  });

  it("tolerates surrounding whitespace and nothing else", () => {
    expect(percentToPpm("  2  ")).toBe(20_000);
    expect(percentToPpm("2 5")).toBeNull();
  });
});

describe("ppmToPercent", () => {
  it("round-trips every rate the engine will encode", () => {
    for (let ppm = 0; ppm <= MAX_FEE_PPM; ppm += 7) {
      expect(percentToPpm(ppmToPercent(ppm))).toBe(ppm);
    }
  });

  it("trims to what a person would write", () => {
    expect(ppmToPercent(20_000)).toBe("2");
    expect(ppmToPercent(5_000)).toBe("0.5");
    expect(ppmToPercent(1)).toBe("0.0001");
    expect(ppmToPercent(0)).toBe("0");
  });

  it("formats with the sign for a card", () => {
    expect(formatPercent(40_000)).toBe("4%");
    expect(formatPercent(5_000)).toBe("0.5%");
  });
});

describe("rounding", () => {
  /*
   * Both round down, and the direction is the whole point.
   *
   * A fee rounding up charges a rate that was never published. A share rounding up pays
   * out more than was collected, which is the one arithmetic mistake a splitter must be
   * unable to make. The remainder those roundings leave is dealt with explicitly by
   * `distribute`.
   */
  it("takes a fee no larger than the rate states", () => {
    // 1 wei at 2% is 0.02 wei, which is nothing rather than one.
    expect(feeOf(1n, 20_000)).toBe(0n);
    expect(feeOf(100n, 20_000)).toBe(2n);
    expect(feeOf(99n, 20_000)).toBe(1n);
  });

  it("never pays a share larger than the share states", () => {
    expect(shareOf(10n, 333_333)).toBe(3n);
    expect(shareOf(1n, 500_000)).toBe(0n);
  });

  it("charges nothing at a zero rate and everything at a whole one", () => {
    expect(feeOf(12_345n, 0)).toBe(0n);
    expect(feeOf(12_345n, PPM_ONE)).toBe(12_345n);
  });

  it("does not overflow at amounts a real market reaches", () => {
    const supply = 1_000_000_000n * 10n ** 18n;
    expect(feeOf(supply, MAX_FEE_PPM)).toBe(supply / 10n);
  });
});

describe("supplyPercentToTokens", () => {
  const supply = 1_000_000_000n * 10n ** 18n;

  it("resolves the thresholds prompts state", () => {
    expect(supplyPercentToTokens(supply, PPM_PER_PERCENT)).toBe(supply / 100n);
    expect(supplyPercentToTokens(supply, 2 * PPM_PER_PERCENT)).toBe(supply / 50n);
  });

  it("rounds down, so 'at least 1%' admits the exact 1% trade", () => {
    // The boundary every prompt mentioning a percentage is really asking about.
    const oddSupply = 1_000_000_007n;
    const threshold = supplyPercentToTokens(oddSupply, PPM_PER_PERCENT);
    expect(threshold).toBe(10_000_000n);
    expect(threshold * 100n <= oddSupply).toBe(true);
  });
});
