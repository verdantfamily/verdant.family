import { describe, expect, it } from "vitest";

import {
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
  sqrtPriceAtTickOrNull,
  sqrtPriceX96AtTick,
} from "./tick.js";

/**
 * The four pinned values.
 *
 * These are not our numbers: they are the constants Uniswap's own libraries assert, so a
 * transliteration that reproduces all four — the identity at tick zero and both
 * extremes — is composing the magic constants in the right order and shifting the right
 * way. A single wrong constant or a shift in the wrong direction misses at least one.
 */
describe("sqrtPriceX96AtTick", () => {
  it("is exactly 2 ** 96 at tick zero", () => {
    expect(sqrtPriceX96AtTick(0)).toBe(2n ** 96n);
    expect(sqrtPriceX96AtTick(0)).toBe(79228162514264337593543950336n);
  });

  it("matches Uniswap at both extremes", () => {
    expect(sqrtPriceX96AtTick(MIN_TICK)).toBe(MIN_SQRT_PRICE);
    expect(sqrtPriceX96AtTick(MAX_TICK)).toBe(MAX_SQRT_PRICE);
  });

  it("matches Uniswap either side of zero", () => {
    expect(sqrtPriceX96AtTick(1)).toBe(79232123823359799118286999568n);
    expect(sqrtPriceX96AtTick(-1)).toBe(79224201403219477170569942574n);
  });

  it("rises monotonically with the tick", () => {
    let previous = sqrtPriceX96AtTick(-600_000);
    for (const tick of [-100_000, -1_000, -200, 0, 200, 1_000, 100_000, 600_000]) {
      const current = sqrtPriceX96AtTick(tick);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });

  /**
   * A tick spaced by 200 is what this protocol actually uses, so the spacing the factory
   * enforces is exercised rather than only the round numbers.
   */
  it("agrees with itself on the spacing the protocol uses", () => {
    for (let tick = -4_000; tick <= 4_000; tick += 200) {
      const price = sqrtPriceX96AtTick(tick);
      expect(price).toBeGreaterThan(0n);
      expect(price).toBe(sqrtPriceX96AtTick(tick));
    }
  });

  it("refuses a tick outside the pool's range", () => {
    expect(() => sqrtPriceX96AtTick(MAX_TICK + 1)).toThrow(RangeError);
    expect(() => sqrtPriceX96AtTick(MIN_TICK - 1)).toThrow(RangeError);
    expect(() => sqrtPriceX96AtTick(1.5)).toThrow(RangeError);
  });

  it("reports an out-of-range tick as null when asked not to throw", () => {
    expect(sqrtPriceAtTickOrNull(MAX_TICK + 1)).toBeNull();
    expect(sqrtPriceAtTickOrNull(0)).toBe(2n ** 96n);
  });
});
