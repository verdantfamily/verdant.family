import type { Metadata } from "next";
import Link from "next/link";

import { ConnectButton } from "../../components/connect-button";
import { Card, Notice, PageHeading } from "../../components/primitives";

export const metadata: Metadata = {
  title: "Profile",
  description: "The markets you launched and the fees waiting to be claimed.",
};

/**
 * What a creator sees about their own markets.
 *
 * Everything on this page is derivable from data the interface already has — the indexer
 * records the creator of every market and every claim against every splitter — so it needs
 * an address and nothing else. No signature, no server-side session, no account. Connecting
 * a wallet here is an act of identification, not of authorisation, and the page says so:
 * claiming a fee is a transaction, and that is the write path's job.
 *
 * Which is why the sections below are described rather than stubbed. A skeleton that
 * animates forever suggests loading; a list of what will appear, and what it will be read
 * from, is honest about the order things are being built in.
 */
export default function ProfilePage() {
  return (
    <div className="pb-16">
      <section className="aurora px-6 pb-14 pt-20">
        <PageHeading
          title="Your launches, in one place"
          lede="Connect a wallet to see the markets you created, the fees your share has earned and what is waiting to be claimed."
        >
          <ConnectButton size="large" label="Connect wallet" />
          <Link
            href="/launch"
            className="inline-flex h-12 items-center rounded-full border border-border bg-surface px-7 text-[0.95rem] font-medium text-ink shadow-card transition hover:border-border-strong hover:shadow-lift backdrop-blur-xl"
          >
            Launch a token
          </Link>
        </PageHeading>
      </section>

      <div className="mx-auto max-w-4xl space-y-6 px-6">
        <div className="grid gap-6 sm:grid-cols-3">
          {[
            {
              title: "Markets you created",
              body: "Every market whose creator matches your address, newest first, with the fee in force and what it has traded.",
              source: "indexer · market.creator",
            },
            {
              title: "Fees waiting for you",
              body: "Your share of what the locked positions have collected but nobody has claimed yet, per market and in total.",
              source: "chain · FeeSplitter.claimable",
            },
            {
              title: "Allocations still vesting",
              body: "What your vesting contracts hold, what has been released, and when the next release becomes possible.",
              source: "chain · TokenVesting.releasable",
            },
          ].map((section) => (
            <Card key={section.title}>
              <h2 className="text-[0.95rem] font-semibold tracking-tight text-ink">
                {section.title}
              </h2>
              <p className="mt-2 text-[0.82rem] leading-relaxed text-ink-muted">{section.body}</p>
              <p className="numeric mt-4 border-t border-border pt-3 text-[0.7rem] text-ink-muted">
                {section.source}
              </p>
            </Card>
          ))}
        </div>

        <Notice title="Why this page is empty rather than loading">
          Reading your launches needs only an address, and the indexer already keys markets by
          creator — but claiming a fee and releasing an allocation are transactions, and those
          two are not wired up yet. Launching and trading are: both are signed from the pages
          that show them. Rather than list balances you could not act on here, this page waits
          for the part that lets you act.
        </Notice>

        <Card>
          <h2 className="text-[0.95rem] font-semibold tracking-tight text-ink">
            You do not need this page to check any of it
          </h2>
          <p className="mt-2 text-[0.82rem] leading-relaxed text-ink-muted">
            Every number it would show is on the chain and readable without us. Each market page
            lists its splitter, its locker and its vesting contract, and each is verified source
            on the explorer — so what is claimable can be read from the splitter directly, by
            anyone, whether or not this interface is running.
          </p>
          <Link
            href="/docs/verify"
            className="mt-4 inline-flex text-[0.82rem] font-medium text-accent underline decoration-accent-ring underline-offset-4 transition hover:text-accent-strong"
          >
            How to read it yourself
          </Link>
        </Card>
      </div>
    </div>
  );
}
