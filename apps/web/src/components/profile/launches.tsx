"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useConnection } from "wagmi";

import type { SerializedLaunch } from "../../app/api/markets/route";
import { CHAIN_ID, chain } from "../../lib/chain";
import { ConnectButton } from "../connect-button";
import { Card, Notice } from "../primitives";
import { ClaimCard } from "./claim-card";

/**
 * A creator's own markets, and their fees.
 *
 * A client component in its entirety, because the question it answers is "what has *this
 * wallet* launched" and a wallet exists only in the browser. There is no session and no
 * account: connecting here identifies, it does not authorise. Every figure below is either
 * public indexer data keyed by an address or a read of a contract anyone could make.
 *
 * The list comes from the indexer, keyed on the address that sent each launch. The money
 * comes from each market's splitter, read from the chain — because what a creator is owed
 * is a fact about a contract's balance, not about our database, and the two could disagree
 * only in the direction of us being wrong.
 */
export function Launches() {
  const { address, status, chainId } = useConnection();
  const connected = status === "connected" && address !== undefined;

  const { data, isPending, isError } = useQuery({
    queryKey: ["launches", address],
    queryFn: async (): Promise<readonly SerializedLaunch[]> => {
      const response = await fetch(`/api/markets?creator=${address ?? ""}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`the feed answered ${response.status}`);
      const body = (await response.json()) as { launches: readonly SerializedLaunch[] };
      return body.launches;
    },
    enabled: connected,
    staleTime: 30_000,
  });

  if (!connected) {
    return (
      <Card>
        <h2 className="text-[0.95rem] font-semibold tracking-tight text-ink">
          Connect a wallet to see your launches
        </h2>
        <p className="mt-2 max-w-xl text-[0.82rem] leading-relaxed text-ink-muted">
          Nothing is stored against an account here. The address is used to ask the indexer
          which markets it created and to read what each market&apos;s splitter owes it —
          both of which anyone could do with the same address.
        </p>
        <div className="mt-4">
          <ConnectButton size="large" label="Connect wallet" />
        </div>
      </Card>
    );
  }

  if (chainId !== CHAIN_ID) {
    return (
      <Notice tone="caution" title="Wrong network">
        Verdant&apos;s markets are on {chain.name}. Switch to it to read what your splitters
        hold and to claim from them.
      </Notice>
    );
  }

  if (isPending) {
    return <p className="text-[0.85rem] text-ink-muted">Looking up your launches…</p>;
  }

  if (isError) {
    return (
      <Notice tone="caution" title="The market feed is not answering.">
        This is a problem with our indexer, not with your markets. They live in contracts,
        and what they owe you is held by their splitters either way.
      </Notice>
    );
  }

  if (data.length === 0) {
    return (
      <Card>
        <h2 className="text-[0.95rem] font-semibold tracking-tight text-ink">
          This wallet has not launched anything yet
        </h2>
        <p className="mt-2 max-w-xl text-[0.82rem] leading-relaxed text-ink-muted">
          Markets are listed here by the address that created them. If you launched from a
          different wallet, connect that one.
        </p>
        <Link
          href="/launch"
          className="mt-4 inline-flex h-10 items-center rounded-full bg-ink px-5 text-[0.85rem] font-medium text-ink-inverse transition hover:bg-ink/90"
        >
          Launch a token
        </Link>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-[0.8rem] text-ink-muted">
        {data.length} {data.length === 1 ? "market" : "markets"}, newest first.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {data.map((launch) => (
          <ClaimCard key={launch.poolId} launch={launch} address={address} />
        ))}
      </div>
    </div>
  );
}
