import type { Metadata } from "next";
import Link from "next/link";

import { Card, PageHeading } from "../../components/primitives";
import { Launches } from "../../components/profile/launches";

export const metadata: Metadata = {
  title: "Profile",
  description: "The markets you launched and the fees waiting to be claimed.",
};

/**
 * What a creator sees about their own markets.
 *
 * Everything here needs an address and nothing else — no signature, no server-side
 * session, no account. Connecting a wallet is an act of identification rather than of
 * authorisation: the list is public indexer data keyed by creator, and the balances are
 * reads of contracts anybody can read. The one thing that does require the wallet is the
 * claim, which is a transaction the splitter will only accept from the address it pays.
 */
export default function ProfilePage() {
  return (
    <div className="pb-16">
      <section className="px-6 pb-10 pt-20">
        <PageHeading
          title="Your launches, in one place"
          lede="The markets you created, what each one charges, and your share of the fees they have earned."
        />
      </section>

      <div className="mx-auto max-w-5xl space-y-6 px-4 sm:px-6">
        <Launches />

        <Card>
          <h2 className="text-[0.95rem] font-semibold tracking-tight text-ink">
            How a fee reaches you
          </h2>
          <p className="mt-2 text-[0.82rem] leading-relaxed text-ink-muted">
            A swap pays your market&apos;s fee to the Uniswap position, where it stays until
            somebody realises it. The locker&apos;s{" "}
            <code className="rounded bg-surface-sunken px-1 py-0.5 text-ink">collect()</code>{" "}
            moves it to the splitter, and the splitter divides it — your share, and the
            protocol&apos;s — and holds each until its owner comes for it. Nothing is ever
            sent to you automatically, by design: a contract that pushed funds could be made
            to push them somewhere else.
          </p>
          <p className="mt-3 text-[0.82rem] leading-relaxed text-ink-muted">
            This means your share of a fee is not the whole fee. At the default split you
            keep 90% of what your market charges, so a 1% market earns you 0.9% of what
            trades through it and the protocol 0.1%. Each card above states the two rates
            side by side rather than only the one a swapper sees.
          </p>
          <Link
            href="/docs/fees"
            className="mt-4 inline-flex text-[0.82rem] font-medium text-accent underline decoration-accent-ring underline-offset-4 transition hover:text-accent-strong"
          >
            Creator fees, in full
          </Link>
        </Card>
      </div>
    </div>
  );
}
