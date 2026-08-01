/**
 * What a swap would return, asked of Uniswap's own quoter.
 *
 * The quoter is the only correct source for this on a Verdant pool. The pool's
 * stored `slot0.lpFee` is written once at initialisation and never updated, because
 * the fee is a `beforeSwap` override — so anything that derived a price from stored
 * state would quote stage 0's fee forever, and would do it silently. V12 in
 * docs/verification.md establishes that `V4Quoter` executes the hook and agrees with
 * an executed swap to the wei, which is what makes it the answer here.
 */

import type { Address, PublicClient } from "viem";

import { v4QuoterAbi } from "../abi/index.js";
import type { PoolKey } from "../markets/pool.js";

/** The quoter's answer. */
export interface Quote {
  /** Units of the output currency, in its own base units. */
  readonly amountOut: bigint;
  /**
   * The quoter's own estimate of the swap's gas. Carried through because it is
   * returned, not because the SDK interprets it: it is measured inside an
   * `unlock` callback and is not a substitute for estimating the transaction.
   */
  readonly gasEstimate: bigint;
}

/**
 * The output of an exact-input single-hop swap.
 *
 * `zeroForOne` is the direction in the pool's own terms, and for a Verdant pool
 * that reads simply: `currency1` is always the launch token (ADR-008), so
 * `zeroForOne: true` is a buy — quote asset in, launch token out — and `false` is
 * a sell.
 *
 * ## Why this is a simulation and not a read
 *
 * `quoteExactInputSingle` is `nonpayable`. It has to be: it takes the PoolManager's
 * lock, performs the swap, and reverts to unwind it, recovering the result from the
 * revert data. That is a state-mutating call shape even though nothing is ever
 * written, so it goes through `simulateContract` — `readContract` would refuse it.
 * A quote therefore costs an `eth_call` and never a transaction.
 */
export async function quoteExactIn(
  client: PublicClient,
  {
    quoter,
    poolKey,
    zeroForOne,
    exactAmount,
  }: {
    readonly quoter: Address;
    readonly poolKey: PoolKey;
    readonly zeroForOne: boolean;
    /** Units of the input currency. `uint128` on the wire. */
    readonly exactAmount: bigint;
  },
): Promise<Quote> {
  const { result } = await client.simulateContract({
    address: quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey,
        zeroForOne,
        exactAmount,
        // No Verdant hook reads hook data, and passing some would change the
        // quote's gas without changing its result. Empty, as the swap builder
        // also sends.
        hookData: "0x",
      },
    ],
  });

  const [amountOut, gasEstimate] = result;
  return { amountOut, gasEstimate };
}
