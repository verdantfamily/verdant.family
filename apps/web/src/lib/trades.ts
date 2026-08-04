import type { HolderPage, Swap, TradeHistory } from "./feed";

/**
 * Trades, on the wire.
 *
 * The same boundary the candle series crosses, for the same reason and in a module of
 * its own rather than beside the component that reads it: the market page is a server
 * component and serialising is its job, so the function cannot live in a `"use client"`
 * file. Amounts cross as decimal strings because JSON has no integer wide enough for wei.
 */
export interface SerializedSwap extends Omit<Swap, "quoteAmount" | "tokenAmount" | "sqrtPriceX96"> {
  readonly quoteAmount: string;
  readonly tokenAmount: string;
  readonly sqrtPriceX96: string;
}

export interface SerializedHistory {
  /** Chain time the rows were read at, which is what their ages are measured against. */
  readonly at: number;
  /** Every trade the market has, so a pager can draw itself before it has them all. */
  readonly total: number;
  readonly offset: number;
  readonly swaps: readonly SerializedSwap[];
}

export function serializeHistory(history: TradeHistory): SerializedHistory {
  return {
    at: history.at,
    total: history.total,
    offset: history.offset,
    swaps: history.swaps.map((swap) => ({
      ...swap,
      quoteAmount: swap.quoteAmount.toString(),
      tokenAmount: swap.tokenAmount.toString(),
      sqrtPriceX96: swap.sqrtPriceX96.toString(),
    })),
  };
}

/** One page of holders, on the wire. Balances are wei and cross as decimal strings. */
export interface SerializedHolder {
  readonly address: `0x${string}`;
  readonly balance: string;
}

export interface SerializedHolders {
  readonly totalSupply: string;
  readonly total: number;
  readonly offset: number;
  readonly holders: readonly SerializedHolder[];
}

export function serializeHolders(page: HolderPage): SerializedHolders {
  return {
    totalSupply: page.totalSupply.toString(),
    total: page.total,
    offset: page.offset,
    holders: page.holders.map((holder) => ({
      address: holder.address,
      balance: holder.balance.toString(),
    })),
  };
}
