import { impliedValueInQuote, shortenAddress } from "@verdant/ui";
import Link from "next/link";

import type { Market } from "../lib/feed";
import { describeQuote, formatQuoteAmount } from "../lib/quote";
import { formatUsd, usdValueOf } from "../lib/usd";
import { TokenAvatar } from "./primitives";
import { TimeAgo } from "./time-ago";

/**
 * One market as a listing tile: the token's face first, then who it is and what the pool
 * implies it is worth.
 *
 * The logo leads because on a listing that is how a token is recognised at a glance. Below
 * it, the name and ticker say what it is, the market cap says how far it has run, the
 * address is there for a reader who wants to copy it into a wallet or a bot, and the age
 * ticks so a fresh launch reads as fresh.
 *
 * The figure labelled "MC" is the pool's price times supply — the launchpad convention's
 * market cap. It is shown in dollars, converted from ether at a spot price fetched off
 * chain, because that is the unit people read a market cap in. Two things stay true of it:
 * the rate comes from a third party rather than from 4663, and it is an *implied* value —
 * the pool's price times supply, not what that supply would fetch if it were sold. A
 * market quoted in a tokenized equity has no rate to convert through, so it keeps its own
 * unit rather than being run through a price this app does not have.
 */
/**
 * How far into the stagger a tile may be pushed.
 *
 * Eight, times fifty milliseconds, is four tenths of a second for the last card that
 * waits at all. Beyond that the delay stops reading as choreography and starts reading as
 * a page that has not finished loading — and a listing can hold sixty of these.
 */
const STAGGER_LIMIT = 8;
const STAGGER_STEP_MS = 50;

export function MarketCard({
  market,
  at,
  usdPerEth,
  index = 0,
}: {
  readonly market: Market;
  readonly at: number;
  /** Dollars per ether, or `null` when no price could be had. */
  readonly usdPerEth: number | null;
  /** Position in the grid, which decides when this tile arrives. */
  readonly index?: number;
}) {
  const quote = describeQuote(market.quote);
  const marketCap = impliedValueInQuote(market.totalSupply, market.sqrtPriceX96);
  const usd = usdValueOf(marketCap, quote, usdPerEth);

  return (
    <Link
      href={`/market/${market.poolId}`}
      style={{ animationDelay: `${Math.min(index, STAGGER_LIMIT) * STAGGER_STEP_MS}ms` }}
      className="tile-in group flex flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card backdrop-blur-xl transition duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift"
    >
      <div className="aspect-square w-full overflow-hidden">
        <TokenAvatar symbol={market.symbol} uri={market.metadataURI} size="card" />
      </div>

      <div className="flex flex-1 flex-col p-3.5">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0">
            <p className="truncate text-[0.95rem] font-semibold leading-tight text-ink">
              {market.name}
            </p>
            <p className="numeric mt-0.5 truncate text-[0.8rem] text-ink-muted">
              ${market.symbol}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="numeric text-[0.95rem] font-semibold text-ink">
              {usd === null ? formatQuoteAmount(marketCap, quote, 2) : formatUsd(usd)}
            </p>
            <p className="text-[0.6rem] font-medium uppercase tracking-wider text-ink-muted">
              MC
            </p>
          </div>
        </div>

        <div className="mt-3.5 flex items-center justify-between gap-2 border-t border-border pt-2.5 text-[0.72rem]">
          <span className="numeric truncate text-ink-muted" title={market.token}>
            {shortenAddress(market.token)}
          </span>
          <TimeAgo
            anchorAt={at}
            createdAt={market.createdAt}
            className="numeric shrink-0 text-accent"
          />
        </div>
      </div>
    </Link>
  );
}
