import { MARKET_MODELS, MODELS } from "@verdant/config";
import { formatCompact } from "@verdant/ui";

import type { Market } from "../lib/feed";
import { CopyPill } from "./copy-pill";
import { TokenDescription, TokenLinks } from "./token-document";

/**
 * What this market is, above everything you can do with it.
 *
 * One line: what the token says about itself on the left, the supply in the middle, and
 * the ways out on the right. Everything that is provenance rather than identity — who
 * launched it, when, whether the metadata is frozen — lives in the contracts tab, because
 * this bar is read once on arrival and that material is read when somebody is checking.
 *
 * ## Why there is no "burned" figure here
 *
 * The screener layout this follows leads with one, and for most tokens it is the single
 * most load-bearing number on the page: supply that has left circulation cannot come
 * back, so it changes what every other figure means. A Verdant token cannot burn.
 * `VerdantToken` exposes no burn function, and OpenZeppelin's `_transfer` rejects the
 * zero address, so `transfer(0x0, n)` reverts rather than destroying anything. There is
 * no mint either.
 *
 * A "Burned: 0" row would therefore be a permanent zero dressed up as a measurement — it
 * would read as "none yet". What is true and worth the space is the stronger claim
 * underneath it: the supply is the supply, for good, and no governance action changes
 * that. So the slot says so.
 *
 * ## Why there is no Dexscreener or GeckoTerminal pill
 *
 * Neither indexes chain 4663. A pill that always lands on "token not found" is worse than
 * an absent one — it reads as the market being unlisted rather than the aggregator not
 * being there — so the row carries the links that resolve and stops.
 */
export function AboutBar({ market }: { readonly market: Market }) {
  const modelId = MARKET_MODELS[market.model];
  const model = modelId === undefined ? undefined : MODELS[modelId];

  return (
    <section className="rounded-panel border border-border bg-surface px-5 py-4 shadow-card backdrop-blur-xl">
      <h2 className="text-[0.95rem] font-semibold tracking-tight text-ink">About</h2>

      <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        {/* Resolved in the browser from whatever the creator put on chain, falling back to
            the model's own words — which come from the register, so a market page and the
            create flow describe a mechanism identically. */}
        <div className="min-w-0 flex-1">
          <TokenDescription uri={market.metadataURI} fallback={model?.mechanism ?? null} />
        </div>

        <div className="shrink-0 lg:px-6 lg:text-center">
          <p className="text-[0.68rem] text-ink-muted">Supply</p>
          <p className="numeric mt-0.5 text-[1.15rem] leading-none text-ink">
            {formatCompact(market.totalSupply)}{" "}
            <span className="text-[0.8rem] text-ink-muted">{market.symbol}</span>
          </p>
          <p className="mt-1 text-[0.7rem] text-ink-muted">no mint, no burn, no owner</p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 lg:justify-end">
          <TokenLinks uri={market.metadataURI} />

          {/* Copies rather than navigates. An address is wanted for pasting far more often
              than for reading, and the explorer is one click away from every address
              elsewhere on this page. */}
          <CopyPill value={market.token} label="Contract" title={market.token}>
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              className="size-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.75" />
              <path d="M10.25 5.75V4.25A1.5 1.5 0 0 0 8.75 2.75H4.25A1.5 1.5 0 0 0 2.75 4.25v4.5a1.5 1.5 0 0 0 1.5 1.5h1.5" />
            </svg>
          </CopyPill>

          {/* A v4 pool id is a hash of the pool key rather than an address, so no explorer
              has a page for one — copying is the only useful thing to do with it, and it
              is what every other tool addresses this market by. */}
          <CopyPill value={market.poolId} label="Pool" title={market.poolId}>
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              className="size-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            >
              <ellipse cx="8" cy="4.5" rx="5" ry="2" />
              <path d="M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7" />
              <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
            </svg>
          </CopyPill>
        </div>
      </div>
    </section>
  );
}
