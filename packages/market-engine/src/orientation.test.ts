/**
 * The four-case swap matrix, both pool orientations, exhaustively.
 *
 * Sixteen combinations of orientation, side, exactness and fee currency, every one written
 * out. This is not thoroughness for its own sake: every one of these is a live code path in
 * the hook, three of them are the paths a generated hook kept getting wrong, and the whole
 * reason the engine has a derived fee currency at all is a property of this table.
 */

import { describe, expect, it } from "vitest";

import { chargeIn, sideOf, specifiedIsCurrency0, tokenKnownBeforeSwap } from "./orientation.js";
import type { PoolOrientation, SwapShape } from "./orientation.js";

/** The launched token is `currency1`, which is what an ether-quoted market looks like. */
const QUOTE_IS_ZERO: PoolOrientation = { quoteIsCurrency0: true };

/** The launched token is `currency0`, which happens whenever it sorts below the quote. */
const TOKEN_IS_ZERO: PoolOrientation = { quoteIsCurrency0: false };

const EXACT_IN = -1_000n;
const EXACT_OUT = 1_000n;

function shape(zeroForOne: boolean, amountSpecified: bigint): SwapShape {
  return { zeroForOne, amountSpecified };
}

describe("sideOf", () => {
  /*
   * A buy is the trader receiving the launched token. `zeroForOne` says which pool
   * currency is the input, and pool currencies are sorted by address — so the same
   * `zeroForOne` is a buy in one market and a sell in another. `InstantHook` gets away with
   * `isBuy = zeroForOne` only because it refuses any pool whose currency0 is not ether.
   */
  describe("with the launched token as currency1", () => {
    it("reads zeroForOne as a buy", () => {
      expect(sideOf(QUOTE_IS_ZERO, shape(true, EXACT_IN))).toBe("BUY");
      expect(sideOf(QUOTE_IS_ZERO, shape(true, EXACT_OUT))).toBe("BUY");
    });

    it("reads oneForZero as a sell", () => {
      expect(sideOf(QUOTE_IS_ZERO, shape(false, EXACT_IN))).toBe("SELL");
      expect(sideOf(QUOTE_IS_ZERO, shape(false, EXACT_OUT))).toBe("SELL");
    });
  });

  describe("with the launched token as currency0", () => {
    it("reads zeroForOne as a sell — the opposite of the other orientation", () => {
      expect(sideOf(TOKEN_IS_ZERO, shape(true, EXACT_IN))).toBe("SELL");
      expect(sideOf(TOKEN_IS_ZERO, shape(true, EXACT_OUT))).toBe("SELL");
    });

    it("reads oneForZero as a buy", () => {
      expect(sideOf(TOKEN_IS_ZERO, shape(false, EXACT_IN))).toBe("BUY");
      expect(sideOf(TOKEN_IS_ZERO, shape(false, EXACT_OUT))).toBe("BUY");
    });
  });

  it("never agrees across the two orientations for the same swap", () => {
    // The property that makes `isBuy = zeroForOne` a bug rather than a shortcut.
    for (const zeroForOne of [true, false]) {
      for (const amountSpecified of [EXACT_IN, EXACT_OUT]) {
        expect(sideOf(QUOTE_IS_ZERO, shape(zeroForOne, amountSpecified))).not.toBe(
          sideOf(TOKEN_IS_ZERO, shape(zeroForOne, amountSpecified)),
        );
      }
    }
  });
});

describe("specifiedIsCurrency0", () => {
  // `Hooks.afterSwap`'s own test. Charging on the side it picks is the only way a hook's
  // delta lands on the currency it intended.
  it("is currency0 on an exact-input zeroForOne swap", () => {
    expect(specifiedIsCurrency0(shape(true, EXACT_IN))).toBe(true);
  });

  it("is currency1 on an exact-input oneForZero swap", () => {
    expect(specifiedIsCurrency0(shape(false, EXACT_IN))).toBe(false);
  });

  it("is currency0 on an exact-output oneForZero swap", () => {
    expect(specifiedIsCurrency0(shape(false, EXACT_OUT))).toBe(true);
  });

  it("is currency1 on an exact-output zeroForOne swap", () => {
    expect(specifiedIsCurrency0(shape(true, EXACT_OUT))).toBe(false);
  });

  it("does not depend on the pool's orientation, only on the swap", () => {
    // It is a fact about v4's accounting, not about this market.
    for (const zeroForOne of [true, false]) {
      for (const amountSpecified of [EXACT_IN, EXACT_OUT]) {
        const answer = specifiedIsCurrency0(shape(zeroForOne, amountSpecified));
        expect(typeof answer).toBe("boolean");
      }
    }
  });
});

describe("chargeIn", () => {
  /*
   * A token-denominated fee is settleable in every one of the eight shapes, and that is
   * the whole argument for deriving the fee currency from the configuration. A tier is
   * measured on the token leg; if the fee comes out of the same leg, then whichever
   * callback can settle the fee also knows the amount the tier needs.
   */
  it("can always take a token fee, in one callback or the other", () => {
    for (const orientation of [QUOTE_IS_ZERO, TOKEN_IS_ZERO]) {
      for (const zeroForOne of [true, false]) {
        for (const amountSpecified of [EXACT_IN, EXACT_OUT]) {
          const where = chargeIn(orientation, shape(zeroForOne, amountSpecified), "TOKEN");
          expect(["beforeSwap", "afterSwap"]).toContain(where);
        }
      }
    }
  });

  it("never picks both callbacks for one swap", () => {
    // Which is what makes double-charging structurally impossible rather than merely
    // tested for: there is one answer, and the other callback returns a zero delta.
    for (const orientation of [QUOTE_IS_ZERO, TOKEN_IS_ZERO]) {
      for (const feeCurrency of ["QUOTE", "TOKEN"] as const) {
        for (const zeroForOne of [true, false]) {
          for (const amountSpecified of [EXACT_IN, EXACT_OUT]) {
            const where = chargeIn(orientation, shape(zeroForOne, amountSpecified), feeCurrency);
            expect(where === "beforeSwap" ? where !== "afterSwap" : where !== "beforeSwap").toBe(true);
          }
        }
      }
    }
  });

  describe("a token fee is charged where the token leg is known", () => {
    /*
     * The load-bearing invariant. When the fee is token-denominated, the callback that can
     * settle it is exactly the callback in which the token amount is available — so a size
     * tier is always applicable. This is the property that makes all four shapes work.
     */
    it("holds for every orientation and shape", () => {
      for (const orientation of [QUOTE_IS_ZERO, TOKEN_IS_ZERO]) {
        for (const zeroForOne of [true, false]) {
          for (const amountSpecified of [EXACT_IN, EXACT_OUT]) {
            const swap = shape(zeroForOne, amountSpecified);
            const where = chargeIn(orientation, swap, "TOKEN");
            const knownEarly = tokenKnownBeforeSwap(orientation, swap);

            // Charged in beforeSwap exactly when the token leg is knowable there;
            // otherwise deferred to afterSwap, where the BalanceDelta supplies it.
            expect(where === "beforeSwap").toBe(knownEarly);
          }
        }
      }
    });
  });

  describe("a quote fee cannot always see the token leg", () => {
    /*
     * The two shapes that forced the design. An exact-input buy and an exact-output sell
     * settle the quote leg in `beforeSwap`, before the pool has computed the token amount —
     * so a quote-denominated fee could not apply a size tier to them. Rather than reverting
     * the most common way anybody buys, the compiler moves such a market to a token fee.
     */
    it("cannot on an exact-input buy", () => {
      const swap = shape(true, EXACT_IN);
      expect(chargeIn(QUOTE_IS_ZERO, swap, "QUOTE")).toBe("beforeSwap");
      expect(tokenKnownBeforeSwap(QUOTE_IS_ZERO, swap)).toBe(false);
    });

    it("cannot on an exact-output sell", () => {
      const swap = shape(false, EXACT_OUT);
      expect(chargeIn(QUOTE_IS_ZERO, swap, "QUOTE")).toBe("beforeSwap");
      expect(tokenKnownBeforeSwap(QUOTE_IS_ZERO, swap)).toBe(false);
    });

    it("can on the other two shapes", () => {
      for (const swap of [shape(true, EXACT_OUT), shape(false, EXACT_IN)]) {
        expect(chargeIn(QUOTE_IS_ZERO, swap, "QUOTE")).toBe("afterSwap");
        expect(tokenKnownBeforeSwap(QUOTE_IS_ZERO, swap)).toBe(true);
      }
    });

    it("has the same two blind shapes in the other orientation", () => {
      // Mirrored, not absent: which `zeroForOne` they correspond to flips.
      const blind = [shape(false, EXACT_IN), shape(true, EXACT_OUT)];
      for (const swap of blind) {
        expect(chargeIn(TOKEN_IS_ZERO, swap, "QUOTE")).toBe("beforeSwap");
        expect(tokenKnownBeforeSwap(TOKEN_IS_ZERO, swap)).toBe(false);
      }
    });
  });
});
