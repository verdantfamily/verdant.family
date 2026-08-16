import type { Metadata } from "next";

import { Bloom } from "../bloom";
import { SiteFooter } from "../footer";
import { INSTANT_FEE_PERCENTS } from "../lib/instant";
import { Sweep } from "./sweep";

/**
 * Collecting Agen's own share.
 *
 * Unlisted: no link in the navigation and `noindex` below. Not because it is dangerous to reach
 * — `claimPlatform()` pays an immutable treasury, so a stranger pressing the button would be
 * donating gas to pay Agen, and `/metrics` already publishes the same revenue figures — but
 * because it is an operator's screen and does not belong in a product's navigation.
 *
 * `Bloom`'s `active` is deliberately omitted, which is what leaves every navigation item
 * unhighlighted rather than adding a key nothing links to.
 */

export const metadata: Metadata = {
  title: "treasury — agen.space",
  description: "What Agen has earned across every Instant market, and the button that collects it.",
  // A page nothing links to is one a crawler can still find through a share or a referrer, and
  // this has no reason to appear in a search result.
  robots: { index: false, follow: false },
};

/** A fee share as a percentage. Two places, because 0.50% is not 0.5%. */
function rate(percent: number): string {
  return `${percent.toFixed(2)}%`;
}

export default function Treasury() {
  return (
    <div className="ax-page">
      <Bloom centred>
        <h1>Treasury</h1>
        <p>
          Agen&rsquo;s {rate(INSTANT_FEE_PERCENTS.platform)} of every trade, as each market&rsquo;s
          vault has credited it. Read from the vaults themselves, and claimable in one
          transaction.
        </p>
      </Bloom>

      <main className="ax-wrap">
        <section className="ax-section ax-reveal">
          <div className="ax-section-head">
            <h2>Unclaimed</h2>
            <span className="ax-tag">{rate(INSTANT_FEE_PERCENTS.platform)} of every trade</span>
          </div>

          <Sweep />
        </section>

        <SiteFooter />
      </main>
    </div>
  );
}
