import Link from "next/link";

import type { MarketSummary } from "../lib/markets";

/**
 * A market, as a card.
 *
 * A launchpad card with its priorities inverted. Everywhere else the price is the
 * headline because the price is the product; here the mechanic is, so the sentence
 * describing what this market actually does gets the largest type on the card and the
 * figures sit underneath in the space a price would normally take.
 *
 * When a market is not trading, that space says so once rather than showing dashes where
 * numbers will eventually be. Dashes read as "loading", and a visitor waits for them.
 */

/** Rough is fine and precise is misleading: a build is minutes old, not seconds. */
export function age(createdAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);

  const units: readonly [number, string][] = [
    [86_400, "d"],
    [3_600, "h"],
    [60, "m"],
  ];

  for (const [size, suffix] of units) {
    if (seconds >= size) return `${String(Math.floor(seconds / size))}${suffix} ago`;
  }

  return "just now";
}

/**
 * The mechanic, shortened to fit a card.
 *
 * Some generated headlines are a full paragraph with the rule's own parentheticals in
 * them, which is right on the market page and unreadable at card size. The first sentence
 * is almost always the mechanic; the rest is qualification. Cut there and mark the cut,
 * rather than clipping mid-word and leaving the reader to guess whether anything is
 * missing.
 */
export function gist(headline: string): string {
  const trimmed = headline.trim();
  if (trimmed.length <= 120) return trimmed;

  const stop = trimmed.indexOf(". ");
  if (stop > 40 && stop < 200) return `${trimmed.slice(0, stop + 1)}`;

  return `${trimmed.slice(0, 150).trimEnd()}…`;
}

function compact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

/** Built and cleared, or actually trading. One word, and it is never decoration. */
export function Status({ market }: { readonly market: MarketSummary }) {
  const live = market.phase === "live";
  return (
    <span className={live ? "status status-live" : "status status-ready"}>
      <span className="status-dot" aria-hidden="true" />
      {live ? "live" : "deployment-ready"}
    </span>
  );
}

export function MarketCard({ market }: { readonly market: MarketSummary }) {
  const { mechanics, trading } = market;

  return (
    <Link className="card" href={`/markets/${market.id}`}>
      <div className="card-head">
        {/*
          No token image yet: nothing in the launch flow uploads one. A generated monogram
          is honest about being a placeholder in a way a stock graphic is not.
        */}
        <span className="card-mark" aria-hidden="true">
          {market.symbol.slice(0, 2)}
        </span>

        <div className="card-identity">
          <span className="card-ticker">${market.symbol}</span>
          <span className="card-name">{market.name}</span>
        </div>

        <span className="card-age">{age(market.createdAt)}</span>
      </div>

      {/* The reason anybody would look twice at this token. */}
      <p className="card-mechanic">{gist(mechanics.headline)}</p>

      <div className="card-tags">
        <span>
          {String(mechanics.ruleCount)} {mechanics.ruleCount === 1 ? "rule" : "rules"}
        </span>
        <span>
          {String(market.contractCount)} {market.contractCount === 1 ? "contract" : "contracts"}
        </span>
        {mechanics.hasPhases ? <span>phases</span> : null}
        {mechanics.hasExternalDependencies ? <span>external data</span> : null}
      </div>

      <div className="card-foot">
        <Status market={market} />

        {trading === undefined ? null : (
          <dl className="card-figures">
            <div>
              <dt>mcap</dt>
              <dd>${compact(trading.marketCapUsd)}</dd>
            </div>
            <div>
              <dt>vol 24h</dt>
              <dd>${compact(trading.volume24hUsd)}</dd>
            </div>
          </dl>
        )}
      </div>
    </Link>
  );
}
