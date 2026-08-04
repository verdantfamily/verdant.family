import Link from "next/link";

import { Explore } from "../components/explore";
import { Notice } from "../components/primitives";
import { FeedUnavailableError, fetchMarkets, type Listing } from "../lib/feed";
import { fetchUsdPerEth } from "../lib/usd";

/**
 * ## Why this renders per request rather than being cached as HTML
 *
 * Because the alternative was observed to be worse. With incremental regeneration this
 * page is prerendered at build time, and a build has no indexer — CI does not run one,
 * and a deployment pipeline should not need one. So the build succeeded and baked the
 * "the feed is not answering" state into static HTML, which is then what the first
 * visitors after every deploy see, until the first revalidation replaces it.
 *
 * Rendering per request costs a server render of a page that is mostly a list. The feed
 * client still asks for its own response to be reused for a few seconds, so this does
 * not turn one visitor into one indexer query.
 */
export const dynamic = "force-dynamic";

export default async function ExplorePage() {
  // Started before the feed so the two requests overlap. It resolves to `null` rather than
  // rejecting, so a price feed having a bad minute cannot take the listing down with it.
  const usdPromise = fetchUsdPerEth();

  let listing: Listing | null = null;
  let unavailable = false;

  try {
    listing = await fetchMarkets(60);
  } catch (error) {
    // The distinction matters and is why the feed throws two different errors. "No
    // markets yet" is a fact about the protocol; "the feed is down" is a fact about us,
    // and showing the first when the second is true would be a lie about the chain.
    if (error instanceof FeedUnavailableError) unavailable = true;
    else throw error;
  }

  const usdPerEth = await usdPromise;

  return (
    <div className="pb-10">
      {/* The first screen is the photograph and one sentence. No badge, no buttons: the
          header already carries "Launch token", and a hero that says one thing lets the
          background be the thing you notice. */}
      <section className="px-4 pb-24 pt-16 sm:px-6 sm:pb-40 sm:pt-28">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="display text-[2.4rem] leading-[1.06] text-ink sm:text-[3.75rem]">
            Create markets that evolve
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-[0.95rem] leading-relaxed text-ink-muted sm:mt-6 sm:text-[1.1rem]">
            Create fixed-fee, stock paired, and evolving markets powered by Uniswap&apos;s v4
            hooks
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        {unavailable ? (
          <Notice tone="caution" title="The market feed is not answering.">
            This is a problem with our indexer, not with the chain. Markets are unaffected —
            they live in contracts and can be traded through any interface. Try again
            shortly.
          </Notice>
        ) : listing !== null && listing.markets.length === 0 ? (
          <div className="rounded-panel border border-border bg-surface p-12 text-center shadow-card backdrop-blur-xl">
            <h2 className="text-[1.1rem] font-semibold text-ink">No markets yet.</h2>
            <p className="mx-auto mt-2 max-w-sm text-[0.85rem] leading-relaxed text-ink-muted">
              The first one to launch will appear here, with its fee schedule and its locked
              position visible from the moment it exists.
            </p>
            <Link
              href="/launch"
              className="mt-6 inline-flex h-10 items-center rounded-full bg-ink px-5 text-[0.85rem] font-medium text-ink-inverse transition hover:bg-ink/90"
            >
              Launch the first one
            </Link>
          </div>
        ) : listing !== null ? (
          <Explore markets={listing.markets} at={listing.at} usdPerEth={usdPerEth} />
        ) : null}
      </div>
    </div>
  );
}
