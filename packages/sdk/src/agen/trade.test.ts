import { describe, expect, it } from "vitest";

import { INTERNAL, priceFromSqrt } from "./trade.js";

/**
 * The fixed-point handling, which is the only part of this module that can be wrong
 * without a chain. Everything else is the quoter's answer passed through.
 */
describe("priceFromSqrt", () => {
  it("is one when the pool is at parity", () => {
    // sqrt(1) in Q96 is exactly 2^96, so amount1/amount0 is one and so is its
    // reciprocal.
    expect(priceFromSqrt(INTERNAL.Q96)).toBeCloseTo(1, 12);
  });

  it("inverts the pool's ratio, because the token is currency1", () => {
    // A pool holding four tokens per unit of quote prices a token at a quarter of a
    // unit of quote. sqrt(4) = 2.
    expect(priceFromSqrt(INTERNAL.Q96 * 2n)).toBeCloseTo(0.25, 12);
  });

  it("survives the magnitudes a real launch opens at", () => {
    // A hundred million tokens against ten ether is 1e7 tokens per ether, which is
    // where a naive Number(a)/Number(b) starts losing digits.
    const tokensPerQuote = 10_000_000;
    const sqrt = BigInt(Math.round(Math.sqrt(tokensPerQuote) * 2 ** 48)) * (1n << 48n);

    expect(priceFromSqrt(sqrt)).toBeCloseTo(1 / tokensPerQuote, 15);
  });

  it("reports nothing rather than infinity for a pool that was never opened", () => {
    expect(priceFromSqrt(0n)).toBe(0);
  });
});

describe("midOutput", () => {
  const { midOutput, Q96 } = INTERNAL;

  it("buys at the pool's ratio", () => {
    // Parity: one wei of quote buys one wei of token.
    expect(midOutput(Q96, true, 10n ** 18n)).toBe(10n ** 18n);
  });

  it("sells at its reciprocal", () => {
    expect(midOutput(Q96 * 2n, false, 4n * 10n ** 18n)).toBe(10n ** 18n);
  });

  it("is zero for an unopened pool, so impact is reported as unknown rather than total", () => {
    expect(midOutput(0n, true, 10n ** 18n)).toBe(0n);
  });
});
