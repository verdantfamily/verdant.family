import Link from "next/link";

import type { MarketSummary } from "../lib/markets";
import { eth } from "../lib/format";
import { Machine } from "./machine";
import { Spark } from "./spark";

/**
 * A token, as a card on the shelf.
 *
 * The art is the token's machine — rings and nodes generated from its own rule and state
 * counts — rather than a monogram in a coloured box. Two tokens look alike exactly when
 * they behave alike, which makes the picture identity instead of decoration, and it means
 * a shelf of tokens that have never traded is still a shelf you can tell apart.
 */
export function TokenCard({ market }: { readonly market: MarketSummary }) {
  return (
    <Link className="ax-tcard" href={`/markets/${market.id}`}>
      <span className="ax-art">
        <Machine
          symbol={market.symbol}
          mechanics={market.mechanics}
          size={132}
          live={market.phase === "live"}
        />
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
        <Machine
          symbol={market.symbol}
          mechanics={market.mechanics}
          size={172}
          live={market.phase === "live"}
        />
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
          <span className="ax-fig">
            {market.mechanics.ruleCount}{" "}
            {market.mechanics.ruleCount === 1 ? "rule" : "rules"}
          </span>
        </span>
      </span>

      <Spark />
    </Link>
  );
}
