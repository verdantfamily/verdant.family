/**
 * What a trade against a generated market would actually return.
 *
 * The quoting itself is `../trade/quote.js` — one function, one `eth_call`, Uniswap's
 * own quoter. What this adds is the two numbers a trader reads next to the output and
 * which nothing on chain will tell them: how far the trade moves the price, and the
 * floor to put under it.
 *
 * ## Why the quoter and not arithmetic
 *
 * Because a generated hook can charge whatever its rules say. Every Agen market whose
 * fee is dynamic computes it inside `beforeSwap`, per swap, from state that may include
 * the trade being quoted — a market can legitimately charge a different fee to the
 * hundredth buyer than to the ninety-ninth. Nothing derived from the pool's stored fee
 * or from its liquidity can see that. `V4Quoter` runs the hook, which is why it is the
 * only honest answer here, and why price impact below is measured against the quoter's
 * output rather than computed alongside it.
 *
 * That also means price impact as reported here folds in the fee. It is the difference
 * between what a trader gets and what they would get at the pool's mid price for an
 * infinitesimal trade, which is the number that matters to them, and it is deliberately
 * not split into "slippage" and "fee" — a generated market's fee is not a constant, so
 * the split would be a guess presented as a breakdown.
 */

import type { Address, PublicClient } from "viem";

import { quoteExactIn } from "../trade/quote.js";
import type { PoolKey } from "../markets/pool.js";

/** `2^96`, v4's fixed-point base for a square-root price. */
const Q96 = 1n << 96n;

/** `2^192`, which is what a squared `sqrtPriceX96` has to be divided by. */
const Q192 = 1n << 192n;

const BPS = 10_000n;

export interface AgenQuote {
  /** Units of the output currency. Tokens for a buy, quote asset for a sell. */
  readonly amountOut: bigint;
  /**
   * The floor to put in the swap, given the caller's tolerance. Enforced by the router
   * twice on the way through, and the only protection a trade actually has: see the note
   * in `../trade/swap.js` on why there is no deadline.
   */
  readonly minAmountOut: bigint;
  /**
   * How much worse than the pool's mid price this trade executes, in basis points, fee
   * included. Never negative — a quote better than mid means the mid was read at a
   * different block, and reporting a negative impact would read as a bonus.
   */
  readonly priceImpactBps: number;
  /** The quoter's own gas estimate, carried through rather than interpreted. */
  readonly gasEstimate: bigint;
}

/**
 * The pool's mid price, as quote asset per whole token.
 *
 * v4's price is `amount1 / amount0`, and an Agen pool is always `(quote, token)`, so the
 * raw ratio is *tokens per unit of quote* and the useful direction is its reciprocal.
 * Returned as a float because it is for display and for a market cap, both of which are
 * shown to three significant figures; anything that must be exact should stay in the
 * integer domain and use the quoter.
 *
 * Both currencies have eighteen decimals — ether does, and every generated token is
 * minted with eighteen — so no decimal adjustment appears here. A market quoted in
 * something else would need one, and there is no such market.
 */
export function priceFromSqrt(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 <= 0n) return 0;

  // Scaled before the float conversion rather than after: the ratio is on the order of
  // 1e-9 for a market worth a few ether, and Number(a) / Number(b) on two values of
  // wildly different magnitude loses the precision that matters.
  const tokensPerQuote = Number((sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / Q192) / 1e18;
  return tokensPerQuote === 0 ? 0 : 1 / tokensPerQuote;
}

/**
 * What the pool would return at its mid price, ignoring fees and depth.
 *
 * The reference point for price impact, in the integer domain so that the comparison
 * does not inherit a float's rounding. `zeroForOne` is a buy: quote in, tokens out.
 */
function midOutput(sqrtPriceX96: bigint, zeroForOne: boolean, amountIn: bigint): bigint {
  const squared = sqrtPriceX96 * sqrtPriceX96;
  if (squared === 0n) return 0n;

  return zeroForOne ? (amountIn * squared) / Q192 : (amountIn * Q192) / squared;
}

/**
 * A quote, with the two numbers a trade panel puts under it.
 *
 * `sqrtPriceX96` is the pool's price at the moment of asking — `readPoolState` returns
 * it — and is used only for the impact figure. Passing zero, or omitting it, gives a
 * quote with an impact of zero rather than a wrong one.
 */
export async function quoteAgenTrade(
  client: PublicClient,
  {
    quoter,
    poolKey,
    zeroForOne,
    amountIn,
    sqrtPriceX96 = 0n,
    slippageBps = 100,
  }: {
    readonly quoter: Address;
    readonly poolKey: PoolKey;
    /** `true` buys the token, which is always `currency1`. */
    readonly zeroForOne: boolean;
    readonly amountIn: bigint;
    readonly sqrtPriceX96?: bigint;
    /** Default one percent. */
    readonly slippageBps?: number;
  },
): Promise<AgenQuote> {
  const { amountOut, gasEstimate } = await quoteExactIn(client, {
    quoter,
    poolKey,
    zeroForOne,
    exactAmount: amountIn,
  });

  const tolerance = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  const minAmountOut = (amountOut * (BPS - tolerance)) / BPS;

  const reference = midOutput(sqrtPriceX96, zeroForOne, amountIn);
  const impact =
    reference === 0n || amountOut >= reference
      ? 0
      : Number(((reference - amountOut) * BPS) / reference);

  return { amountOut, minAmountOut, priceImpactBps: impact, gasEstimate };
}

/** Exported for the tests, which check the fixed-point handling rather than the chain. */
export const INTERNAL = { Q96, Q192, midOutput } as const;
