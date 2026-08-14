import Link from "next/link";

import type { MarketSummary } from "../lib/markets";
import { age, eth, percent } from "../lib/format";
import { TokenArt } from "./art";

/**
 * A token, as one entry in the index.
 *
 * Four columns: the machine, who it is, what it does, and what it is worth. The third of
 * those is the one no other launchpad has, so it gets the widest measure on the row and
 * is set at reading size rather than shrunk into a caption.
 */
export function TokenRow({
  market,
  now,
  index,
}: {
  readonly market: MarketSummary;
  readonly now: number;
  /** Staggers the entrance so the list assembles rather than appearing. */
  readonly index: number;
}) {
  const trading = market.trading;
  const change = trading?.change24hPercent ?? null;
  const live = market.phase === "live";

  return (
    <Link
      className="ax-row ax-rise"
      href={`/markets/${market.id}`}
      style={{ ["--i" as string]: String(index) }}
    >
      <span className="ax-row-art">
        <TokenArt market={market} size={74} />
      </span>

      <span className="ax-row-id">
        <span className="ax-row-tic">${market.symbol}</span>
        <span className="ax-row-name">{market.name}</span>

        {/* What the chips can truthfully say depends on the product. A compiled market is
            described by its rules and what it keeps between them; a standardised one has
            neither to report, and its distinguishing fact is that it is standard. */}
        <span className="ax-chips">
          {market.kind === "programmable" ? (
            <>
              <span className="ax-chip">
                {market.mechanics.ruleCount} {market.mechanics.ruleCount === 1 ? "rule" : "rules"}
              </span>
              {market.mechanics.stateCount > 0 ? <span className="ax-chip">stateful</span> : null}
              {market.mechanics.hasPhases ? <span className="ax-chip">evolves</span> : null}
            </>
          ) : (
            <span className="ax-chip">instant</span>
          )}
          <span className="ax-chip">{age(market.createdAt, now)} old</span>
        </span>
      </span>

      <span className="ax-row-rule">{market.headline}</span>

      <span className="ax-row-fig">
        <span className="ax-row-val ax-num">{eth(trading?.marketCap)}</span>
        {change === null ? (
          <span className="ax-row-sub">{live ? "market cap" : "not launched"}</span>
        ) : (
          <span className={change >= 0 ? "ax-row-sub ax-up ax-num" : "ax-row-sub ax-down ax-num"}>
            {percent(change)}
          </span>
        )}
      </span>
    </Link>
  );
}
