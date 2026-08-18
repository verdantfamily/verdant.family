import Link from "next/link";

import type { MarketSummary } from "../lib/markets";
import { eth, marketCapUsd } from "../lib/format";
import { TokenArt } from "./art";
import { Spark } from "./spark";

/**
 * The token held at the top of the shelf, by name rather than by size.
 *
 * Empty means the largest market cap wins, which is the ordinary state and the one this
 * file was written for. An address here is a deliberate exception — the house saying this
 * is the token worth looking at this week — and it is one line so that taking it back is
 * one line too.
 *
 * Editorial in the honest sense: it changes which token is shown, never what is said about
 * it. The card below reads the same figures from the same feed whichever token fills it.
 *
 * Currently: Agen, the platform's own token, launched 2026-08-17.
 */
const SPOTLIT = "0x11e1553f59bb42834dc23b1b9d23c885273d3d97";

/** Whether a market can fill the frame: Instant, and far enough along to have figures. */
function eligible(market: MarketSummary): boolean {
  return market.kind === "instant" && market.trading?.marketCap !== undefined;
}

/**
 * The token the Spotlight shows.
 *
 * The chosen one if it is here and trading; otherwise the Instant token that is currently
 * worth the most; otherwise nothing.
 *
 * A catalogue with nothing at the top of it is a list, so this card is the one allowed to
 * be larger than the others — but a vacant gold frame would be worse than no section, and
 * an empty one naming a token that has not traded yet would be worse still. So the pick
 * has to earn the frame on the same terms the market-cap rule does, and when it cannot —
 * delisted, not launched, not yet indexed — the shelf falls back to the number rather than
 * showing a hole where the house's choice was meant to be.
 */
export function spotlightOf(markets: readonly MarketSummary[]): MarketSummary | null {
  const chosen = markets.find(
    (market) => market.id.toLowerCase() === SPOTLIT.toLowerCase() && eligible(market),
  );
  if (chosen !== undefined) return chosen;

  let best: MarketSummary | null = null;

  for (const market of markets) {
    if (!eligible(market)) continue;
    if (best === null || (market.trading?.marketCap ?? 0) > (best.trading?.marketCap ?? 0)) {
      best = market;
    }
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
