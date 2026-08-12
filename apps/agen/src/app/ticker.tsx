import Link from "next/link";

import { age } from "./markets/card";
import type { MarketSummary } from "./lib/markets";

/**
 * The strip under the header.
 *
 * Every entry is an event that actually happened: a market finished building, or a
 * market went live. There are no prices on it and no trades, because nothing has traded
 * — and a scrolling strip of invented ticks is the single most effective way to tell a
 * visitor that none of the numbers on a site can be trusted.
 *
 * It renders nothing at all when there is nothing to say, rather than an empty rail.
 */
export function Ticker({ markets }: { readonly markets: readonly MarketSummary[] }) {
  if (markets.length === 0) return null;

  return (
    <div className="ticker">
      <div className="ticker-inner">
        {markets.slice(0, 12).map((market) => (
          <Link className="tick" href={`/markets/${market.id}`} key={market.id}>
            <span className={market.phase === "live" ? "tick-tag tick-live" : "tick-tag"}>
              {market.phase === "live" ? "live" : "built"}
            </span>
            <span className="tick-ticker">${market.symbol}</span>
            <span className="tick-age">{age(market.createdAt)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
