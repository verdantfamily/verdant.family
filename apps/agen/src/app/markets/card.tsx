import Link from "next/link";

import type { MarketSummary } from "../lib/markets";
import { eth, percent } from "../lib/format";

/**
 * A token, as a card.
 *
 * Four things and a picture: the art, the ticker against the market cap, the project's
 * name, and the shape of its price. That is the whole card, and the restraint is the
 * design — a grid of cards is read by scanning one column at a time, so every extra
 * field costs the reader more than it tells them.
 *
 * ## Why the art is the biggest element
 *
 * Because it is the only part that differs between tokens at a glance. The figures are
 * all formatted alike by design, the names are all short, and a wall of identical grey
 * text is unnavigable. Until a launch records an image the tile carries the symbol's
 * monogram on black, which is honest about being a placeholder in a way a stock graphic
 * is not.
 *
 * ## The figures are dashes
 *
 * Nothing is deployed, so market cap and change have no source. `usdCompact(undefined)`
 * returns an em dash, and the row keeps its shape rather than collapsing — a card that
 * grows a figure the day the first token trades is a card whose layout was a guess. The
 * sparkline frame is present and empty for the same reason, and it is empty rather than
 * drawn, because a plausible line is indistinguishable from a real one.
 */
export function MarketCard({
  market,
}: {
  readonly market: MarketSummary;
  /** Kept so the server and client agree on the clock when ages return to the card. */
  readonly now: number;
}) {
  const trading = market.trading;
  const change = trading?.change24hPercent ?? null;

  return (
    <Link className="token-card" href={`/markets/${market.id}`}>
      <div className="tc-art" aria-hidden="true">
        <span className="tc-monogram">{market.symbol.slice(0, 2)}</span>
      </div>

      <div className="tc-line">
        <span className="tc-ticker">${market.symbol}</span>
        <span className="tc-cap">{eth(trading?.marketCap)}</span>
      </div>

      <div className="tc-line tc-line-sub">
        <span className="tc-name">{market.name}</span>
        {change === null ? null : (
          <span className={change >= 0 ? "tc-change up" : "tc-change down"}>
            {percent(change)}
          </span>
        )}
      </div>

      <div className="tc-spark" aria-hidden="true">
        <span className="tc-spark-flat" />
      </div>
    </Link>
  );
}
