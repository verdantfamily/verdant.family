"use client";

import Link from "next/link";
import { useAccount } from "wagmi";

import type { MarketSummary } from "../lib/markets";
import { TokenRow } from "../markets/row";
import { Wallet } from "../wallet";

/**
 * What this wallet has made.
 *
 * The filtering happens here rather than on the server because the server has no idea who
 * is looking — a wallet connection is a fact the browser holds. So the page ships every
 * market it knows about and this narrows the list once an address exists.
 *
 * That is affordable while a catalogue is tens of markets and would not be at thousands;
 * the honest fix at that size is an indexed `creator` query, and the note is here so that
 * whoever hits the wall knows the shape of it.
 */
export function Portfolio({
  markets,
  now,
  usdPerEth = null,
}: {
  readonly markets: readonly MarketSummary[];
  readonly now: number;
  readonly usdPerEth?: number | null;
}) {
  const { address, status } = useAccount();

  if (status === "connecting" || status === "reconnecting") {
    return <p className="ax-invite-note">Looking for your wallet…</p>;
  }

  /*
   * The same control as the one in the bar, deliberately.
   *
   * A second button that opened the same dialog would be a second implementation of
   * connecting — and connecting is four states, two failure modes and a chain switch.
   * This renders the real one and lets the stylesheet make it the size the empty page
   * needs, so there is one connect flow in the product and always will be.
   */
  if (address === undefined) {
    return (
      <section className="ax-invite">
        <p className="ax-invite-note">Connect your wallet to load your profile</p>
        <div className="ax-invite-act">
          <Wallet />
        </div>
      </section>
    );
  }

  const mine = markets.filter(
    (market) => market.creator?.toLowerCase() === address.toLowerCase(),
  );

  if (mine.length === 0) {
    return (
      <section className="ax-invite">
        <p className="ax-invite-note">This wallet has not created a token yet.</p>
        <Link className="ax-cta" href="/launch">
          Create a token
        </Link>
      </section>
    );
  }

  return (
    <section className="ax-section ax-reveal">
      <div className="ax-section-head">
        <h2>Created by you</h2>
        <span className="ax-tag">{mine.length}</span>
      </div>

      <div className="ax-index" style={{ marginTop: "8px" }}>
        {mine.map((market, position) => (
          <TokenRow
            market={market}
            now={now}
            index={position}
            usdPerEth={usdPerEth}
            key={market.id}
          />
        ))}
      </div>
    </section>
  );
}
