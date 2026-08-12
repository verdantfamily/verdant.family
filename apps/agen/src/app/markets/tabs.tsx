"use client";

import { useState } from "react";

import type { MarketSummary } from "../lib/markets";
import { MarketCard } from "./card";

/**
 * Discovery, filtered.
 *
 * Every tab here is computed from data that exists. There is deliberately no "trending"
 * tab: trending means by volume, no Agen market has traded, and a tab that is permanently
 * empty teaches people the product is dead. It appears when the first market goes live
 * and has volume to rank — see the `live` tab, which is hidden the same way.
 *
 * Filtering happens in the browser over the markets the server already sent. That is the
 * right call at this size and the wrong one at a thousand markets, at which point this
 * becomes a server round trip with the tab in the URL.
 */
type Key = "new" | "unique" | "live";

export function MarketTabs({ markets }: { readonly markets: readonly MarketSummary[] }) {
  const live = markets.filter((market) => market.phase === "live");

  const tabs: readonly { readonly key: Key; readonly label: string; readonly of: readonly MarketSummary[] }[] = [
    {
      key: "new",
      label: "new",
      of: [...markets].sort((left, right) => right.createdAt - left.createdAt),
    },
    {
      key: "unique",
      label: "unique",
      of: [...markets].sort(
        (left, right) => right.mechanics.noveltyScore - left.mechanics.noveltyScore,
      ),
    },
    ...(live.length === 0
      ? []
      : [{ key: "live" as const, label: "live", of: live }]),
  ];

  const [active, setActive] = useState<Key>("new");
  const showing = tabs.find((tab) => tab.key === active) ?? tabs[0]!;

  return (
    <section className="shelf" id="discover">
      <header className="shelf-head">
        <div className="tabs-row" role="tablist" aria-label="market categories">
          {tabs.map((tab) => (
            <button
              type="button"
              role="tab"
              key={tab.key}
              aria-selected={tab.key === active}
              className={tab.key === active ? "on" : ""}
              onClick={() => {
                setActive(tab.key);
              }}
            >
              {tab.label}
              <span className="tab-count">{String(tab.of.length)}</span>
            </button>
          ))}
        </div>

        <span className="shelf-note-inline">
          {live.length === 0 ? "ranked by volume once markets trade" : null}
        </span>
      </header>

      <div className="grid">
        {showing.of.slice(0, 8).map((market) => (
          <MarketCard market={market} key={market.id} />
        ))}
      </div>
    </section>
  );
}
