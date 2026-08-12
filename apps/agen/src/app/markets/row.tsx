import Link from "next/link";

import type { MarketSummary } from "../lib/markets";
import { Status, age, gist } from "./card";

/**
 * A market, as a row.
 *
 * The same information as the card at roughly a fifth of the height, for the shelf where
 * the point is to scan twenty of them rather than look at four. It is a list of links
 * rather than a `<table>` because there is no tabular relationship between the columns —
 * they are one object's fields, aligned.
 */
export function MarketRow({ market }: { readonly market: MarketSummary }) {
  return (
    <Link className="row" href={`/markets/${market.id}`}>
      <span className="row-mark" aria-hidden="true">
        {market.symbol.slice(0, 2)}
      </span>

      <span className="row-identity">
        <span className="row-ticker">${market.symbol}</span>
        <span className="row-name">{market.name}</span>
      </span>

      <span className="row-mechanic">{gist(market.mechanics.headline)}</span>

      <span className="row-status">
        <Status market={market} />
      </span>

      <span className="row-rules">
        {String(market.mechanics.ruleCount)}{" "}
        {market.mechanics.ruleCount === 1 ? "rule" : "rules"}
      </span>

      <span className="row-age">{age(market.createdAt)}</span>
    </Link>
  );
}

/** The column titles above a list of rows. Presentational; the rows are links, not cells. */
export function RowHeadings() {
  return (
    <div className="row row-headings" aria-hidden="true">
      <span className="row-mark" />
      <span className="row-identity">token</span>
      <span className="row-mechanic">market mechanic</span>
      <span className="row-status">status</span>
      <span className="row-rules">rules</span>
      <span className="row-age">created</span>
    </div>
  );
}
