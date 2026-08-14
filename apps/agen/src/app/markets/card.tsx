import Link from "next/link";

import type { MarketSummary } from "../lib/markets";
import { eth, marketCapUsd } from "../lib/format";
import { TokenArt } from "./art";
import { Spark } from "./spark";

/**
 * A market capitalisation, in dollars where a rate was obtained and in ether where it
 * was not.
 *
 * The fallback is the point: a dollar sign anywhere on this site means a live rate was
 * actually fetched, so a source being down produces a figure in the unit the market is
 * really quoted in rather than a stale or invented one.
 */
function cap(ethValue: number | null | undefined, usdPerEth: number | null): string {
  return marketCapUsd(ethValue, usdPerEth) ?? eth(ethValue);
}

/**
 * A token, as a card on the shelf.
 *
 * The art is the token's own — its machine if it was compiled, its picture if it was
 * launched through Instant. See `TokenArt` for why those are different things rather than
 * two styles of the same thing.
 */
export function TokenCard({
  market,
  usdPerEth = null,
}: {
  readonly market: MarketSummary;
  readonly usdPerEth?: number | null;
}) {
  return (
    <Link className="ax-tcard" href={`/markets/${market.id}`}>
      <span className="ax-art">
        <TokenArt market={market} size={132} />
      </span>

      <span className="ax-tcard-line">
        <span className="ax-tcard-tic">${market.symbol}</span>
        <span className="ax-tcard-val ax-num">{cap(market.trading?.marketCap, usdPerEth)}</span>
      </span>

      <span className="ax-tcard-name">{market.name}</span>

      <Spark points={market.spark} />
    </Link>
  );
}

/*
 * There was a `FeatureCard` here, for the one token given the top of the page.
 *
 * It went with the Trending section it was the only user of, and the "1.50% fee" chip it
 * carried went with it. Every Instant market charges the same 1.50%, so a chip repeating
 * it on every card said nothing about any particular token while taking the place of
 * something that would have. The fee is stated where it is a decision — the launch review,
 * before a creator signs — and where it is about to be paid, on the trade panel.
 */
