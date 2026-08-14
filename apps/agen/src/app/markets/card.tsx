import Link from "next/link";

import { INSTANT_FEE_PERCENTS } from "../lib/instant";
import type { MarketSummary } from "../lib/markets";
import { eth } from "../lib/format";
import { TokenArt } from "./art";
import { Spark } from "./spark";

/**
 * A token, as a card on the shelf.
 *
 * The art is the token's own — its machine if it was compiled, its picture if it was
 * launched through Instant. See `TokenArt` for why those are different things rather than
 * two styles of the same thing.
 */
export function TokenCard({ market }: { readonly market: MarketSummary }) {
  return (
    <Link className="ax-tcard" href={`/markets/${market.id}`}>
      <span className="ax-art">
        <TokenArt market={market} size={132} />
      </span>

      <span className="ax-tcard-line">
        <span className="ax-tcard-tic">${market.symbol}</span>
        <span className="ax-tcard-val ax-num">{eth(market.trading?.marketCap)}</span>
      </span>

      <span className="ax-tcard-name">{market.name}</span>

      <Spark />
    </Link>
  );
}

/** The same token, given the top of the page. */
export function FeatureCard({ market }: { readonly market: MarketSummary }) {
  const trading = market.trading;

  return (
    <Link className="ax-feature" href={`/markets/${market.id}`}>
      <span className="ax-art">
        <TokenArt market={market} size={172} />
      </span>

      <span className="ax-feature-id">
        <span className="ax-feature-tic">${market.symbol}</span>
        <span className="ax-feature-name">{market.name}</span>

        <span className="ax-figs">
          <span className="ax-fig ax-num">{eth(trading?.marketCap)}</span>
          <span className="ax-fig ax-num">
            {trading?.volume24h === undefined || trading.volume24h === null
              ? "no volume yet"
              : `${eth(trading.volume24h)} vol.`}
          </span>
          {/* What is worth saying about each, which is not the same sentence. A rule
              count is the interesting fact about a compiled market and a meaningless one
              about a standardised market, where the fee is the fact. */}
          <span className="ax-fig">
            {market.kind === "programmable"
              ? `${String(market.mechanics.ruleCount)} ${market.mechanics.ruleCount === 1 ? "rule" : "rules"}`
              : `${INSTANT_FEE_PERCENTS.total.toFixed(2)}% fee`}
          </span>
        </span>
      </span>

      <Spark />
    </Link>
  );
}
