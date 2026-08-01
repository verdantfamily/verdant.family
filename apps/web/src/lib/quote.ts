/**
 * Saying what a market is priced in.
 *
 * Every amount on a market surface is denominated in that market's quote asset, and
 * until markets could be quoted in an equity there was nothing to decide: it was ether,
 * so a number followed by "ETH" was always true. It is not any more, and a figure
 * labelled with the wrong asset is worse than an unlabelled one — it tells a reader
 * they are spending something they are not.
 *
 * ## Which symbol is shown, and why it is not always the token's own
 *
 * A market's quote asset arrives from the indexer with the symbol the ERC-20 reports
 * about itself. That is a claim by whoever deployed it, and any contract may claim to
 * be NVDA. `@verdant/config`'s `QUOTE_ASSETS` is the reviewed list — first-party
 * Robinhood equity tokens, each read from the chain at review time — so an asset on it
 * is shown by its ticker, and an asset absent from it is shown by its address.
 *
 * The address is deliberately not a refusal. A market quoted in something unreviewed
 * still exists, still trades, and still belongs in the listing; hiding it would be this
 * interface deciding what the chain contains. What it does instead is decline to repeat
 * an unverified ticker, and say plainly that it has not checked.
 */

import { quoteAssetByAddress } from "@verdant/config";
import { formatAmount, shortenAddress } from "@verdant/ui";

import type { Quote } from "./feed";

/** How a quote asset is named and rendered on screen. */
export interface QuoteDisplay {
  readonly asset: `0x${string}`;
  readonly decimals: number;
  /** What follows an amount: `ETH`, a reviewed ticker, or a shortened address. */
  readonly symbol: string;
  /** For a human: "Ether", "NVIDIA", or the address again where nothing is known. */
  readonly label: string;
  readonly isNative: boolean;
  /** Whether `QUOTE_ASSETS` vouches for this asset. */
  readonly reviewed: boolean;
  /** What the contract calls itself. A claim, and only shown as one. */
  readonly reportedSymbol: string;
}

export function describeQuote(quote: Quote): QuoteDisplay {
  if (quote.isNative) {
    return {
      asset: quote.asset,
      decimals: quote.decimals,
      symbol: "ETH",
      label: "Ether",
      isNative: true,
      // Ether is not on the reviewed list and does not need to be: it is the chain's
      // own gas token and v4 addresses it as the zero address rather than as a
      // contract, so there is nothing to review.
      reviewed: true,
      reportedSymbol: quote.symbol,
    };
  }

  const known = quoteAssetByAddress(quote.asset);
  if (known !== undefined) {
    return {
      asset: quote.asset,
      decimals: quote.decimals,
      symbol: known.symbol,
      label: known.label,
      isNative: false,
      reviewed: true,
      reportedSymbol: quote.symbol,
    };
  }

  const short = shortenAddress(quote.asset);
  return {
    asset: quote.asset,
    decimals: quote.decimals,
    symbol: short,
    label: short,
    isNative: false,
    reviewed: false,
    reportedSymbol: quote.symbol,
  };
}

/**
 * An amount of the quote asset, in its own units and with its own label.
 *
 * Six places by default, matching `formatEther`: quote amounts on a launchpad are
 * routinely small, and a 0.05 trade rendered to two places is a trade that looks like
 * nothing.
 */
export function formatQuoteAmount(
  value: bigint,
  quote: QuoteDisplay,
  places = 6,
): string {
  return `${formatAmount(value, { decimals: quote.decimals, places })} ${quote.symbol}`;
}

/** The pair, as a market is identified by it: `FLOWER / NVDA`. */
export function pairLabel(tokenSymbol: string, quote: QuoteDisplay): string {
  return `${tokenSymbol} / ${quote.symbol}`;
}
