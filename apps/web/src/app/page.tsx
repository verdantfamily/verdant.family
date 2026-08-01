import Link from "next/link";

import { Explore } from "../components/explore";
import { Badge, Notice } from "../components/primitives";
import { FeedUnavailableError, fetchMarkets, type Listing } from "../lib/feed";

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

  return (
    <div className="pb-10">
      <section className="aurora px-6 pb-16 pt-20">
        <div className="mx-auto max-w-3xl text-center">
          <Badge tone="accent">Uniswap v4 · Robinhood Chain</Badge>

          <h1 className="display mt-6 text-[2.75rem] text-ink sm:text-[4rem]">
            Launch a token that
            <br />
            keeps its promises.
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-[1.05rem] leading-relaxed text-ink-muted">
            Fixed supply, minted once. The swap fee written into the pool at creation and
            editable by nobody, including us. The launch position handed to a contract with
            no early-release path. Pair against ether or a tokenized equity.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/launch"
              className="inline-flex h-12 items-center rounded-full bg-ink px-7 text-[0.95rem] font-medium text-ink-inverse shadow-card transition hover:bg-ink/90 active:scale-[0.985]"
            >
              Launch a token
            </Link>
            <Link
              href="/docs"
              className="inline-flex h-12 items-center rounded-full border border-border bg-surface px-7 text-[0.95rem] font-medium text-ink shadow-card transition hover:border-border-strong hover:shadow-lift backdrop-blur-xl"
            >
              How it works
            </Link>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-6">
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
          <Explore markets={listing.markets} at={listing.at} />
        ) : null}
      </div>
    </div>
  );
}
