"use client";

import Link from "next/link";
import { useAccount } from "wagmi";

import type { MarketSummary } from "../lib/markets";
import { TokenRow } from "../markets/row";

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
}: {
  readonly markets: readonly MarketSummary[];
  readonly now: number;
}) {
  const { address, status } = useAccount();

  if (status === "connecting" || status === "reconnecting") {
    return <p className="ax-empty">Looking for your wallet…</p>;
  }

  if (address === undefined) {
    return (
      <p className="ax-empty">
        Connect a wallet to see the tokens you have created. Nothing is signed by
        connecting — it only shows Agen which address you are.
      </p>
    );
  }

  const mine = markets.filter(
    (market) => market.creator?.toLowerCase() === address.toLowerCase(),
  );

  if (mine.length === 0) {
    return (
      <p className="ax-empty">
        This wallet has not created a token yet.{" "}
        <Link href="/launch" style={{ color: "inherit", textDecoration: "underline" }}>
          Describe one
        </Link>{" "}
        and it will appear here.
      </p>
    );
  }

  return (
    <div className="ax-index">
      {mine.map((market, position) => (
        <TokenRow market={market} now={now} index={position} key={market.id} />
      ))}
    </div>
  );
}
