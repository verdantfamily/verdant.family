/**
 * Trading an Agen market: one path, for every market and every caller.
 *
 * Buying, selling and a creator's opening buy are the same transaction to a different
 * pool key with a different direction, and they go through `AgenRouter` because that is
 * the only route that can tell a hook which wallet is trading. A market that does not
 * care is unaffected by travelling it; a market that does cannot be traded any other way.
 *
 * ## Nobody passes a trader
 *
 * There is no parameter for one, here or on the contract. The router reads `msg.sender`,
 * so the identity a hook sees is the address that signed — which is what makes it worth
 * anything. A helper that accepted a trader would be offering to lie about it.
 *
 * ## Quoting goes through the router too
 *
 * Uniswap's `V4Quoter` calls the pool as itself with empty hook data, so a market that
 * authenticates its route refuses to be quoted by it — and those are exactly the markets
 * this exists for. `quoteAgenTrade` calls `AgenRouter.quote`, which runs the real path
 * and throws the answer back, so the number includes whatever the hook did, including a
 * fee that depends on who is asking.
 */

import {
  decodeErrorResult,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { agenRouterAbi } from "../abi/index.js";
import type { PoolKey } from "../markets/pool.js";
// The mid-price arithmetic, shared rather than rewritten: price impact means the same
// thing however the quote was obtained, and two implementations of it would eventually
// disagree by a basis point in front of a trader.
import { INTERNAL } from "./trade.js";

/** Native ether, which is always an Agen pool's `currency0`. */
const NATIVE = "0x0000000000000000000000000000000000000000";

const BPS = 10_000n;

export interface AgenSwapCall {
  readonly to: Address;
  readonly data: Hex;
  /** Non-zero only when the input is ether, which means only on a buy. */
  readonly value: bigint;
}

export interface AgenTradeQuote {
  /** Units of the output currency: tokens on a buy, ether on a sell. */
  readonly amountOut: bigint;
  /** What the pool actually consumed. Below `amountIn` when the band ran out. */
  readonly amountSpent: bigint;
  /** The floor to send with the trade, given the caller's tolerance. */
  readonly minAmountOut: bigint;
  /**
   * How much worse than the pool's mid price this executes, in basis points, fee
   * included — and on a market whose fee depends on the trader, *their* fee.
   *
   * Zero when no `sqrtPriceX96` was supplied to compare against, and never negative: a
   * quote better than mid means the two were read at different moments, and reporting
   * that as a negative impact would read as a bonus.
   */
  readonly priceImpactBps: number;
}

interface TradeShape {
  readonly router: Address;
  readonly poolKey: PoolKey;
  readonly amountIn: bigint;
  /** A market's own hook data. Empty for almost every market. */
  readonly extra?: Hex;
}

/**
 * A buy: ether in, the launched token out.
 *
 * The token is always `currency1` in an Agen pool, so a buy is always `zeroForOne` and
 * the ether travels as the transaction's value.
 */
export function buildAgenBuy({
  router,
  poolKey,
  amountIn,
  minAmountOut,
  extra = "0x",
}: TradeShape & { readonly minAmountOut: bigint }): AgenSwapCall {
  return {
    to: router,
    data: encodeFunctionData({
      abi: agenRouterAbi,
      functionName: "swap",
      args: [poolKey, true, amountIn, minAmountOut, extra],
    }),
    value: amountIn,
  };
}

/**
 * A sell: the launched token in, ether out.
 *
 * The router pulls the token from the seller straight to the pool manager, so the seller
 * must have approved the router for `amountIn` first. It is an ordinary ERC-20 allowance
 * to the router, not Permit2 — the router never holds the tokens, so there is nothing for
 * a stale allowance to be spent on by anybody else.
 */
export function buildAgenSell({
  router,
  poolKey,
  amountIn,
  minAmountOut,
  extra = "0x",
}: TradeShape & { readonly minAmountOut: bigint }): AgenSwapCall {
  return {
    to: router,
    data: encodeFunctionData({
      abi: agenRouterAbi,
      functionName: "swap",
      args: [poolKey, false, amountIn, minAmountOut, extra],
    }),
    value: 0n,
  };
}

/**
 * What a trade would return, asked of the route it will take.
 *
 * Simulated as `trader`, because the hook is told who is trading and may answer
 * differently for different people — a streak's next buy being free is a quote, not a
 * detail. A sell additionally needs that trader's allowance already in place, for the
 * same reason: quoting a transaction that could not be sent would be quoting a different
 * one from the one on offer.
 *
 * Returns `null` where the market declined to quote. That is a real answer rather than an
 * error: a hook may refuse a trade for reasons of its own — a cooldown, a phase, a wallet
 * it will not serve — and an interface should say the trade is unavailable rather than
 * that something broke.
 *
 * ## Why the trader is funded for the simulation
 *
 * A buy carries its ether as `value`, and a node checks that the sender can cover it
 * *before* running anything — so quoting a buy larger than the connected wallet's balance
 * came back as a JSON-RPC error with no revert data to read, indistinguishable here from a
 * market that refused. The interface then reported "no route for that size" about a pool
 * that would have filled it perfectly, and the size it suggested trying was smaller for
 * the wrong reason: the wallet, not the market.
 *
 * The balance is overridden for the call instead. Nothing else about the trader is
 * changed, so a hook that answers differently per address still sees the real one, and a
 * sell still needs the real allowance. A quote is a question about the market, and the
 * only honest way to ask it is with the asker's ability to pay taken out of the answer —
 * whether they can afford it is a separate question, asked against their real balance
 * where the answer can say so.
 *
 * `stateOverride` is not universal. A node that rejects it is retried without one, which
 * restores exactly the previous behaviour rather than failing the quote outright.
 */
export async function quoteAgenSwap(
  client: PublicClient,
  {
    router,
    poolKey,
    zeroForOne,
    amountIn,
    trader,
    extra = "0x",
    slippageBps = 100,
    sqrtPriceX96 = 0n,
  }: TradeShape & {
    readonly zeroForOne: boolean;
    /** Whose trade this would be. The hook is told, so the answer can depend on it. */
    readonly trader: Address;
    readonly slippageBps?: number;
    /** The pool's current price, to measure impact against. Omit to skip it. */
    readonly sqrtPriceX96?: bigint;
  },
): Promise<AgenTradeQuote | null> {
  const call = {
    account: trader,
    to: router,
    data: encodeFunctionData({
      abi: agenRouterAbi,
      functionName: "quote",
      args: [poolKey, zeroForOne, amountIn, extra],
    }),
    // Ether only travels on a buy.
    value: zeroForOne ? amountIn : 0n,
  } as const;

  /**
   * Enough to cover the value and leave room for gas at any price the node assumes.
   *
   * Only for a buy: a sell sends no value, so its quote never depended on the seller's
   * ether and overriding it would change a condition the trade does not have.
   */
  const funded = zeroForOne
    ? [{ address: trader, balance: amountIn + 10n ** 18n }]
    : undefined;

  let error: unknown;
  try {
    await client.call(funded === undefined ? call : { ...call, stateOverride: funded });
  } catch (thrown) {
    error = thrown;

    // A node that will not take an override says so before running anything, so there is
    // no revert to read. Ask again the old way rather than reporting a refusal.
    if (funded !== undefined && readQuoteResult(thrown) === null && rejectedOverride(thrown)) {
      try {
        await client.call(call);
      } catch (retried) {
        error = retried;
      }
    }
  }

  if (error !== undefined) {
    const result = readQuoteResult(error);
    if (result === null) return null;

    const tolerance = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));

    const reference = INTERNAL.midOutput(sqrtPriceX96, zeroForOne, amountIn);
    const impact =
      reference === 0n || result.amountOut >= reference
        ? 0
        : Number(((reference - result.amountOut) * BPS) / reference);

    return {
      amountOut: result.amountOut,
      amountSpent: result.amountSpent,
      minAmountOut: (result.amountOut * (BPS - tolerance)) / BPS,
      priceImpactBps: impact,
    };
  }

  // `quote` always reverts. Returning normally means something is answering at that
  // address which is not an AgenRouter, and treating the absence of a revert as a
  // successful quote of zero would put a zero in front of a trader.
  return null;
}

/**
 * Whether a node refused the override itself, rather than the contract refusing the
 * trade.
 *
 * Matched on the message because there is no code for it: an unsupported third parameter
 * comes back as an invalid-params error or as a plain complaint about the field, and both
 * are distinguishable from a revert by the absence of any revert data — which the caller
 * has already checked before asking this.
 */
function rejectedOverride(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /state ?override|invalid params|-32602|not supported|unsupported/i.test(message);
}

/** What ether would buy. See `quoteAgenSwap`. */
export async function quoteAgenBuy(
  client: PublicClient,
  input: TradeShape & { readonly trader: Address; readonly slippageBps?: number },
): Promise<AgenTradeQuote | null> {
  return quoteAgenSwap(client, { ...input, zeroForOne: true });
}

/** What tokens would fetch. Needs the seller's allowance in place; see `quoteAgenSwap`. */
export async function quoteAgenSell(
  client: PublicClient,
  input: TradeShape & { readonly trader: Address; readonly slippageBps?: number },
): Promise<AgenTradeQuote | null> {
  return quoteAgenSwap(client, { ...input, zeroForOne: false });
}

/**
 * The answer, dug out of a revert.
 *
 * viem wraps a call's revert several layers deep and the shape differs between transports,
 * so this walks the causes rather than reaching for a known field. Anything that is not a
 * `QuoteResult` — a hook's own refusal, a malformed pool, a node that dropped the call —
 * is not an answer, and is reported as no quote rather than guessed at.
 */
function readQuoteResult(error: unknown): { amountOut: bigint; amountSpent: bigint } | null {
  for (const data of revertData(error)) {
    try {
      const decoded = decodeErrorResult({ abi: agenRouterAbi, data });
      if (decoded.errorName !== "QuoteResult") continue;

      const [amountOut, amountSpent] = decoded.args as readonly [bigint, bigint];
      return { amountOut, amountSpent };
    } catch {
      // Not this layer's error. Keep walking.
    }
  }

  return null;
}

/** Every hex payload attached to an error or to anything that caused it. */
function revertData(error: unknown): readonly Hex[] {
  const found: Hex[] = [];

  for (let at: unknown = error, depth = 0; at !== undefined && at !== null && depth < 10; depth += 1) {
    const node = at as { data?: unknown; raw?: unknown; cause?: unknown };

    for (const candidate of [node.data, node.raw]) {
      if (typeof candidate === "string" && candidate.startsWith("0x") && candidate.length > 2) {
        found.push(candidate as Hex);
      }
    }

    at = node.cause;
  }

  return found;
}

/** Whether a pool's input currency needs an allowance before it can be traded. */
export function needsApproval(poolKey: PoolKey, zeroForOne: boolean): boolean {
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  return currencyIn.toLowerCase() !== NATIVE;
}
