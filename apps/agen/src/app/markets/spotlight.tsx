import Link from "next/link";

import type { MarketSummary } from "../lib/markets";
import { eth, marketCapUsd } from "../lib/format";
import { TokenArt } from "./art";
import { Spark } from "./spark";

/**
 * The tokens held at the top of the shelf, by name rather than by size.
 *
 * In order, left to right. Empty means the largest market caps win, which is the ordinary
 * state and the one this file was written for. An address here is a deliberate exception —
 * the house saying this is a token worth looking at this week — and it is one line each so
 * that taking one back is one line too.
 *
 * Editorial in the honest sense: it changes which tokens are shown, never what is said
 * about them. Each card reads the same figures from the same feed whichever token fills it.
 *
 * Currently: Aaa Cat, the most traded market on the shelf, and Agen, the platform's own
 * token launched 2026-08-17.
 */
const SPOTLIT: readonly string[] = [
  "0x6c58d6f67f728a74158e31fa1b6b497967e4786f",
  "0x11e1553f59bb42834dc23b1b9d23c885273d3d97",
];

/** How many frames the section has. Two, side by side. */
const FRAMES = 2;

/** Whether a market can fill a frame: Instant, and far enough along to have figures. */
function eligible(market: MarketSummary): boolean {
  return market.kind === "instant" && market.trading?.marketCap !== undefined;
}

/**
 * The tokens the Spotlight shows, in the order it shows them.
 *
 * The named ones first, each if it is here and trading; then the largest market caps not
 * already picked, until the frames are full; then however many fewer than that exist.
 *
 * A catalogue with nothing at the top of it is a list, so these cards are the ones allowed
 * to be larger than the others — but a vacant gold frame would be worse than no section,
 * and an empty one naming a token that has not traded yet would be worse still. So a pick
 * has to earn its frame on the same terms the market-cap rule does, and when it cannot —
 * delisted, not launched, not yet indexed — the frame goes to the next largest market
 * rather than showing a hole where the house's choice was meant to be.
 */
export function spotlightOf(markets: readonly MarketSummary[]): readonly MarketSummary[] {
  const chosen: MarketSummary[] = [];
  const taken = new Set<string>();

  const take = (market: MarketSummary): void => {
    chosen.push(market);
    taken.add(market.id.toLowerCase());
  };

  for (const wanted of SPOTLIT) {
    const found = markets.find(
      (market) => market.id.toLowerCase() === wanted.toLowerCase() && eligible(market),
    );
    if (found !== undefined && !taken.has(found.id.toLowerCase())) take(found);
  }

  const byCap = markets
    .filter((market) => eligible(market) && !taken.has(market.id.toLowerCase()))
    .sort((left, right) => (right.trading?.marketCap ?? 0) - (left.trading?.marketCap ?? 0));

  for (const market of byCap) {
    if (chosen.length >= FRAMES) break;
    take(market);
  }

  return chosen.slice(0, FRAMES);
}

function cap(ethValue: number | null | undefined, usdPerEth: number | null): string {
  return marketCapUsd(ethValue, usdPerEth) ?? eth(ethValue);
}

/**
 * The section, with one card per frame.
 *
 * `ax-spots` is a two-up grid that becomes one column when there is not room for two, and a
 * single card left alone in it fills the row rather than sitting in half of one — so a shelf
 * where only one market has traded still looks composed rather than truncated.
 */
export function Spotlight({
  markets,
  usdPerEth,
}: {
  readonly markets: readonly MarketSummary[];
  readonly usdPerEth: number | null;
}) {
  if (markets.length === 0) return null;

  return (
    <section className="ax-shelf ax-reveal">
      <div className="ax-shelf-head">
        <h3>Spotlight</h3>
      </div>

      <div className="ax-spots">
        {markets.map((market) => (
          <Link className="ax-spot" href={`/markets/${market.id}`} key={market.id}>
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
        ))}
      </div>
    </section>
  );
}
