"use client";

import { MARKET_MODELS } from "@verdant/config";
import { impliedValueInQuote } from "@verdant/ui";
import { useMemo, useState } from "react";

import type { Market } from "../lib/feed";
import { Segmented } from "./form";
import { MarketCard } from "./market-card";

/**
 * The market list, with the reader's ordering.
 *
 * Newest is the default, and that is the load-bearing part: the default ordering is the
 * one nobody chose, so it must not rank. Volume-first as a default would be a
 * recommendation made by us on the strength of recent trading, which is the easiest
 * signal on a launchpad to manufacture. Offered as a control the reader operates
 * deliberately, the same sort is just a question they asked.
 *
 * Sorting and searching happen here, over the page of markets already fetched, rather
 * than as query parameters to the indexer. That is honest for as long as a page holds
 * every market — while it does, a client sort is instant and cannot disagree with what is
 * on screen. When the list outgrows one page this has to move server-side, and the seam
 * is `ORDERINGS`: each entry is a comparator the indexer would have to reproduce.
 */

type Ordering = "newest" | "oldest" | "value" | "volume" | "cheapest";

const ORDERINGS: readonly { readonly value: Ordering; readonly label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "value", label: "Implied value" },
  { value: "volume", label: "Volume" },
  { value: "cheapest", label: "Lowest fee" },
];

function compare(ordering: Ordering, a: Market, b: Market): number {
  switch (ordering) {
    case "newest":
      return b.createdAt - a.createdAt;
    case "oldest":
      return a.createdAt - b.createdAt;
    case "volume":
      // Compared as raw quote-asset amounts, which is only meaningful because every
      // reviewed quote asset carries 18 decimals — an equity priced in cents against a
      // market priced in ether would need a rate this app has no oracle for, and the
      // ordering says so by being an ordering of comparable magnitudes rather than of
      // value.
      return a.volumeQuote === b.volumeQuote ? 0 : a.volumeQuote > b.volumeQuote ? -1 : 1;
    case "cheapest":
      return a.fee.ppm - b.fee.ppm;
    case "value": {
      // Implied value, not market capitalisation. It is the pool's own price multiplied
      // by supply, in whatever the market is quoted in — no oracle, no dollars, and no
      // float: `impliedValueInQuote` stays in base units the whole way. It says what the
      // pool implies the supply is worth at the current price, which is not what it
      // would fetch if sold, and for markets quoted in different assets it is not a
      // comparison of value either.
      const left = impliedValueInQuote(a.totalSupply, a.sqrtPriceX96);
      const right = impliedValueInQuote(b.totalSupply, b.sqrtPriceX96);
      return left === right ? 0 : left > right ? -1 : 1;
    }
  }
}

export function Explore({
  markets,
  at,
  usdPerEth,
}: {
  readonly markets: readonly Market[];
  readonly at: number;
  /** Dollars per ether, or `null` when no price could be had. Display only. */
  readonly usdPerEth: number | null;
}) {
  const [query, setQuery] = useState("");
  const [ordering, setOrdering] = useState<Ordering>("newest");
  const [model, setModel] = useState<"all" | string>("all");

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return [...markets]
      .filter((market) => {
        if (model !== "all" && MARKET_MODELS[market.model] !== model) return false;
        if (needle === "") return true;
        return (
          market.symbol.toLowerCase().includes(needle) ||
          market.name.toLowerCase().includes(needle) ||
          market.token.toLowerCase() === needle ||
          market.poolId.toLowerCase() === needle ||
          market.quote.symbol.toLowerCase() === needle
        );
      })
      .sort((a, b) => compare(ordering, a, b));
  }, [markets, query, ordering, model]);

  return (
    <div>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-sm">
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          >
            <circle cx="7" cy="7" r="4.25" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, ticker, token or pool id"
            aria-label="Search markets"
            /* Sunken and blurred, because unlike every other field in the app this one
               sits straight on the page rather than inside a card: there is nothing above
               the photograph for it to borrow. The lift shadow it used to carry is gone —
               a well does not cast one. */
            className="w-full rounded-full border border-border bg-surface-sunken py-2.5 pl-10 pr-4 text-[0.9rem] text-ink backdrop-blur-xl transition placeholder:text-ink-faint hover:border-border-strong focus:border-accent-ring focus:outline-none"
          />
        </div>

        {/* On a phone the two controls do not fit on one line, so rather than wrap into a
            tall block they become a single edge-to-edge strip that scrolls sideways —
            `-mx-4 px-4` bleeds it to the screen edges the page's own padding leaves. On a
            wider screen they wrap normally and the strip behaviour is switched off. */}
        <div className="-mx-4 flex items-center gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:gap-3 sm:overflow-visible sm:px-0 sm:pb-0 [&::-webkit-scrollbar]:hidden">
          <Segmented
            size="small"
            wrap={false}
            value={model}
            onChange={setModel}
            options={[
              { value: "all", label: "All fees" },
              { value: "fixed", label: "Fixed" },
              { value: "progressive", label: "Scheduled" },
            ]}
          />
          <Segmented
            size="small"
            wrap={false}
            value={ordering}
            onChange={setOrdering}
            options={ORDERINGS}
          />
        </div>
      </div>

      <div className="mt-6 flex items-baseline justify-between">
        <p className="text-[0.8rem] text-ink-muted">
          {shown.length} {shown.length === 1 ? "market" : "markets"}
          {shown.length === markets.length ? "" : ` of ${markets.length}`}
        </p>
      </div>

      {shown.length === 0 ? (
        <div className="mt-4 rounded-card border border-border bg-surface p-10 text-center shadow-card backdrop-blur-xl">
          <p className="text-[0.9rem] font-medium text-ink">Nothing matches that.</p>
          <p className="mt-1.5 text-[0.82rem] text-ink-muted">
            Search by ticker, by name, or paste a token address.
          </p>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((market, index) => (
            <MarketCard
              // The key carries the ordering as well as the market, so re-sorting
              // remounts the tiles and they stagger into their new places. Keyed by pool
              // id alone, React would move the existing nodes and the grid would rearrange
              // itself instantly and silently.
              key={`${ordering}:${market.poolId}`}
              market={market}
              at={at}
              usdPerEth={usdPerEth}
              index={index}
            />
          ))}
        </div>
      )}
    </div>
  );
}
