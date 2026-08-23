/**
 * Buy versus sell, which leg is which, and where a fee can actually be taken.
 *
 * The single most error-prone corner of a v4 hook, isolated here so there is one
 * definition of each question and the Solidity mirrors this file line for line.
 *
 * ## Side is defined by the token, never by `zeroForOne`
 *
 * A buy is the trader receiving the launched token. `zeroForOne` says which pool currency
 * is the input, and pool currencies are sorted by address — so the same `zeroForOne` means
 * a buy in one market and a sell in another, depending on which side of the pair the
 * launched token happened to sort onto. `InstantHook` can say `isBuy = zeroForOne` only
 * because it refuses any pool whose `currency0` is not ether. The engine supports equity
 * quotes too, so it cannot.
 *
 *   isBuy = (zeroForOne == quoteIsCurrency0)
 *
 * ## Which callback can charge, and in what
 *
 * v4 gives a hook two chances and each can only move one currency:
 *
 *  - `beforeSwap`'s `BeforeSwapDelta` specified component lands on the swap's **specified**
 *    currency — the input on an exact-input swap, the output on an exact-output one.
 *  - `afterSwap`'s returned `int128` lands on the **unspecified** currency.
 *
 * So a fee denominated in some currency can only be taken in whichever of the two
 * callbacks that currency happens to be settled by:
 *
 *   specifiedIsCurrency0 = ((amountSpecified < 0) == zeroForOne)
 *
 * That expression is `Hooks.afterSwap`'s own test, which is why charging on the side it
 * picks is the only way a hook's delta lands where it intended.
 *
 * ## Why the fee currency is a property of the configuration
 *
 * This is the constraint that decided a design question, and it is worth stating plainly
 * because it is not obvious until the table is written out.
 *
 * A size tier is measured on the **token** leg — "a sell of at least 1% of supply" is a
 * statement about tokens and means something else entirely in ether. A fee is a percentage
 * of some leg. For the tier to be evaluable at the moment the fee is charged, the leg the
 * fee is taken from has to be knowable at the same time as the token leg.
 *
 * With the fee on the **quote** leg, two of the four shapes break:
 *
 * | side | kind          | quote is    | fee charged in | token leg known there? |
 * |------|---------------|-------------|----------------|------------------------|
 * | buy  | exact input   | specified   | `beforeSwap`   | **no**                 |
 * | buy  | exact output  | unspecified | `afterSwap`    | yes                    |
 * | sell | exact input   | unspecified | `afterSwap`    | yes                    |
 * | sell | exact output  | specified   | `beforeSwap`   | **no**                 |
 *
 * An exact-input buy and an exact-output sell would have to charge before the pool has
 * computed the token amount, so no tier could be applied. The alternatives were all worse
 * than the one chosen: reverting those two shapes removes the most common way anybody buys;
 * guessing the token amount from the pool price abandons exactness; charging a worst-case
 * rate and refunding lands the refund in the wrong currency.
 *
 * With the fee on the **token** leg, all four shapes work, because the fee leg and the
 * tier leg are the same leg — whichever callback can settle it also knows the amount.
 *
 * So the compiler decides: a market with size tiers collects in the launched token, and a
 * market without them collects in the quote asset. It is deterministic, it is fixed at
 * launch, it is in the commitment hash, and the review card states it outright. What it is
 * not is invisible — which is the property that matters, because a creator paid in a
 * different asset than they expected is a creator who was not told.
 */

import type { FeeCurrency, Side } from "./spec.js";

/** Where the launched token and the quote asset sit in a pool's sorted pair. */
export interface PoolOrientation {
  /** Whether the quote asset is `currency0`. The launched token is the other one. */
  readonly quoteIsCurrency0: boolean;
}

/** How a swap was priced. */
export interface SwapShape {
  readonly zeroForOne: boolean;
  /** Negative for exact input, positive for exact output, as v4 encodes it. */
  readonly amountSpecified: bigint;
}

/** A buy is the trader receiving the launched token. Never `zeroForOne` alone. */
export function sideOf(orientation: PoolOrientation, shape: SwapShape): Side {
  return shape.zeroForOne === orientation.quoteIsCurrency0 ? "BUY" : "SELL";
}

/** Whether the swap named its amount in `currency0`. `Hooks.afterSwap`'s own test. */
export function specifiedIsCurrency0(shape: SwapShape): boolean {
  return (shape.amountSpecified < 0n) === shape.zeroForOne;
}

/** Whether the fee's currency is the one the swap named an amount for. */
export function feeCurrencyIsSpecified(
  orientation: PoolOrientation,
  shape: SwapShape,
  feeCurrency: FeeCurrency,
): boolean {
  const feeIsCurrency0 =
    feeCurrency === "QUOTE" ? orientation.quoteIsCurrency0 : !orientation.quoteIsCurrency0;

  return specifiedIsCurrency0(shape) === feeIsCurrency0;
}

/**
 * Which callback has to take the fee.
 *
 * `beforeSwap` when the fee's currency is the specified one, `afterSwap` otherwise. There
 * is no third option and no market where both apply, which is what makes double-charging
 * structurally impossible rather than merely tested for.
 */
export function chargeIn(
  orientation: PoolOrientation,
  shape: SwapShape,
  feeCurrency: FeeCurrency,
): "beforeSwap" | "afterSwap" {
  return feeCurrencyIsSpecified(orientation, shape, feeCurrency) ? "beforeSwap" : "afterSwap";
}

/**
 * Whether the token leg is knowable in `beforeSwap`.
 *
 * True when the token is the specified currency, because then its amount *is*
 * `amountSpecified`. Used to decide where a trade ceiling is enforced: in `beforeSwap`
 * where possible, so a refused trade costs the trader as little gas as v4 allows, and in
 * `afterSwap` otherwise, where reverting still reverts the whole swap.
 */
export function tokenKnownBeforeSwap(orientation: PoolOrientation, shape: SwapShape): boolean {
  const tokenIsCurrency0 = !orientation.quoteIsCurrency0;
  return specifiedIsCurrency0(shape) === tokenIsCurrency0;
}
