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
  }: TradeShape & {
    readonly zeroForOne: boolean;
    /** Whose trade this would be. The hook is told, so the answer can depend on it. */
    readonly trader: Address;
    readonly slippageBps?: number;
  },
): Promise<AgenTradeQuote | null> {
  try {
    await client.call({
      account: trader,
      to: router,
      data: encodeFunctionData({
        abi: agenRouterAbi,
        functionName: "quote",
        args: [poolKey, zeroForOne, amountIn, extra],
      }),
      // Ether only travels on a buy. `eth_call` does not require the account to hold it,
      // which is what lets a quote be shown before a wallet is funded.
      value: zeroForOne ? amountIn : 0n,
    });
  } catch (error) {
    const result = readQuoteResult(error);
    if (result === null) return null;

    const tolerance = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));

    return {
      amountOut: result.amountOut,
      amountSpent: result.amountSpent,
      minAmountOut: (result.amountOut * (BPS - tolerance)) / BPS,
    };
  }

  // `quote` always reverts. Returning normally means something is answering at that
  // address which is not an AgenRouter, and treating the absence of a revert as a
  // successful quote of zero would put a zero in front of a trader.
  return null;
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
