import { formatCompact, formatFeeRate, formatPrice, quotePerToken } from "@verdant/ui";
import Link from "next/link";

import type { Market } from "../lib/feed";
import { describeQuote, formatQuoteAmount } from "../lib/quote";
import { Countdown } from "./countdown";
import { ModelBadge, TokenAvatar } from "./primitives";

/**
 * One market in the listing.
 *
 * What a card has to answer, in order: what is it, what does it cost to trade, and is
 * that about to change. The fee is given the same visual weight as the price because on
 * this protocol it is the distinguishing fact — every market here has a schedule, and
 * which stage it is on is the thing a trader is deciding against.
 *
 * There is no percentage-change figure. It would need a price from a fixed time ago, and
 * the honest options are the launch price (which makes every card a story about launch
 * day forever) or a rolling window (which needs a candle table the indexer does not
 * keep). A number that looks like 24-hour change but is not would be worse than its
 * absence.
 */
export function MarketCard({ market, at }: { readonly market: Market; readonly at: number }) {
  const quote = describeQuote(market.quote);
  const price = quotePerToken(market.sqrtPriceX96, quote.decimals);
  const transition = market.fee.nextTransitionAt;

  return (
    <Link
      href={`/market/${market.poolId}`}
      className="group flex flex-col justify-between rounded-card border border-border bg-surface p-5 shadow-card backdrop-blur-xl transition duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift"
    >
      <div className="flex items-start gap-3">
        <TokenAvatar symbol={market.symbol} />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="numeric truncate text-[1rem] font-semibold text-ink">
              {market.symbol}
            </span>
            <ModelBadge model={market.model} />
          </div>
          <div className="mt-0.5 truncate text-[0.82rem] text-ink-muted">{market.name}</div>
          {/* The pair, because a price is meaningless without it: 0.42 of an ether and
              0.42 of a share of NVIDIA are different claims, and the two markets sit
              side by side in this grid. */}
          <div className="numeric mt-1 truncate text-[0.7rem] text-ink-muted">
            {market.symbol} / {quote.symbol}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="numeric text-[1rem] font-semibold text-accent">
            {formatFeeRate(market.fee.ppm)}
          </div>
          <div className="text-[0.7rem] text-ink-muted">fee now</div>
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-3">
        <div>
          <dt className="text-[0.7rem] text-ink-muted">Price</dt>
          <dd className="numeric mt-0.5 text-[0.85rem] text-ink" title={`${quote.symbol} per ${market.symbol}`}>
            {formatPrice(price)}
          </dd>
        </div>
        <div>
          <dt className="text-[0.7rem] text-ink-muted">Volume</dt>
          <dd className="numeric mt-0.5 text-[0.85rem] text-ink">
            {formatQuoteAmount(market.volumeQuote, quote, 3)}
          </dd>
        </div>
        <div>
          <dt className="text-[0.7rem] text-ink-muted">Supply</dt>
          <dd className="numeric mt-0.5 text-[0.85rem] text-ink">
            {formatCompact(market.totalSupply)}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-[0.75rem]">
        <span className="text-ink-muted">
          {market.swapCount} {market.swapCount === 1 ? "trade" : "trades"}
        </span>

        {/* "Never changes" and "will not change again" are different claims, and only
            the first is true of a single-stage market. A laddered market that has run
            through its last stage has a fee that is now fixed, but it was not always —
            saying otherwise misdescribes what its creator committed to. */}
        {transition === null ? (
          <span className="text-ink-muted">
            {market.fee.stageCount === 1 ? "fee never changes" : "final stage"}
          </span>
        ) : (
          <span className="text-ink-muted">
            next{" "}
            {formatFeeRate(market.stages[market.fee.stageIndex + 1]?.feePpm ?? market.fee.ppm)} in{" "}
            <Countdown anchorAt={at} targetAt={transition} className="text-accent" />
          </span>
        )}
      </div>
    </Link>
  );
}
