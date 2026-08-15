import Link from "next/link";

import type { MarketSummary } from "../lib/markets";
import { eth, marketCapUsd } from "../lib/format";
import { TokenArt } from "./art";
import { Spark } from "./spark";

/**
 * The Instant token that is currently worth the most.
 *
 * A catalogue with nothing at the top of it is a list. This is the one card that is
 * allowed to be larger than the others, and it is chosen by a number rather than by
 * editorial: the highest market cap on the Instant shelf, or nothing if nothing is
 * trading yet. A vacant gold frame would be worse than no section.
 */
export function spotlightOf(markets: readonly MarketSummary[]): MarketSummary | null {
  let best: MarketSummary | null = null;

  for (const market of markets) {
    if (market.kind !== "instant") continue;
    const cap = market.trading?.marketCap;
    if (cap === undefined) continue;
    if (best === null || cap > (best.trading?.marketCap ?? 0)) best = market;
  }

  return best;
}

function cap(ethValue: number | null | undefined, usdPerEth: number | null): string {
  return marketCapUsd(ethValue, usdPerEth) ?? eth(ethValue);
}

export function Spotlight({
  market,
  usdPerEth,
}: {
  readonly market: MarketSummary;
  readonly usdPerEth: number | null;
}) {
  return (
    <section className="ax-shelf ax-reveal">
      <div className="ax-shelf-head">
        <h3>Spotlight</h3>
      </div>

      <Link className="ax-spot" href={`/markets/${market.id}`}>
        <span className="ax-spot-who">
          <span className="ax-art">
            <TokenArt market={market} size={88} />
          </span>

          <span className="ax-spot-id">
            <span className="ax-spot-name">{market.name}</span>
            <span className="ax-spot-tic">${market.symbol}</span>
          </span>

          <span className="ax-spot-cap">
            <b className="ax-num">{cap(market.trading?.marketCap, usdPerEth)}</b>
            <span>market cap</span>
          </span>
        </span>

        <span className="ax-spot-chart">
          <Spark points={market.spark} area />
        </span>
      </Link>
    </section>
  );
}
