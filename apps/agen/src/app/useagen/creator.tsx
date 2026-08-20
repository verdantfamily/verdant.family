"use client";

/**
 * Your launches from X, and the handover that makes the fees yours.
 *
 * The one screen in Agen where the person looking at it may have no wallet, no account and no
 * idea that either was ever involved. Everything here follows from that:
 *
 *   - Signing in is with X, not a wallet, because an X account is the only thing they have.
 *   - The markets are listed before any wallet is connected, because they exist and are theirs
 *     regardless — a page that showed nothing until a wallet appeared would look like the
 *     launches had been lost.
 *   - The wallet is asked for once, at the moment it is actually needed, with the reason stated.
 *
 * ## The claim is two signatures and neither is optional
 *
 * Agen signs `offer(wallet)`, which invites an address and moves nothing. The wallet signs
 * `take()`, which moves the seat. So the button below does a round trip to the server, then asks
 * the wallet to sign the call the server handed back. A creator who abandons it halfway has an
 * open invitation and has lost nothing; the fees stay in the vault where only the seat can reach
 * them.
 */

import { useCallback, useEffect, useState } from "react";
import { formatEther, type Address, type Hex } from "viem";
import { useAccount, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";

import { chain } from "../lib/chain";

interface LaunchRow {
  readonly id: string;
  readonly token: string | null;
  readonly name: string | null;
  readonly ticker: string | null;
  readonly status: string;
  readonly createdAt: number;
  readonly sourcePostId: string | null;
  readonly commandPostId: string;
  readonly txHash: string | null;
  readonly xUsername: string;
}

interface Entry {
  readonly record: LaunchRow;
  readonly earnedWei: string;
  readonly claimableWei: string;
  readonly seated: boolean;
}

interface View {
  readonly identity: {
    readonly xUserId: string;
    readonly xUsername: string;
    readonly name: string;
    readonly avatarUrl: string | null;
  };
  readonly seat: {
    readonly seat: string | null;
    readonly deployed: boolean;
    readonly beneficiary: string | null;
    readonly offered: string | null;
    readonly claimed: boolean;
  };
  readonly launches: readonly Entry[];
  readonly totals: {
    readonly launches: number;
    readonly earnedWei: string;
    readonly claimableWei: string;
  };
}

/** Four significant figures of ether, the same as the wallet-side claims list. */
function ether(wei: string): string {
  const value = Number(formatEther(BigInt(wei)));
  if (value === 0) return "0";
  if (value >= 1) return value.toFixed(3);
  return value.toPrecision(3);
}

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function postUrl(username: string, id: string): string {
  return `https://x.com/${username === "" ? "i" : username}/status/${id}`;
}

type Load = { readonly state: "loading" } | { readonly state: "out" } | {
  readonly state: "in";
  readonly view: View;
};

export function Creator() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [reloadAt, setReloadAt] = useState(0);

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const response = await fetch("/api/x/me", { cache: "no-store" });
        if (!live) return;

        if (response.status === 401) {
          setLoad({ state: "out" });
          return;
        }

        const body = (await response.json()) as { ok?: boolean; data?: View };
        if (!live) return;

        // Anything other than a well-formed answer is treated as signed out. There is no useful
        // third state here: a visitor cannot act on "the server is unhappy", and the sign-in
        // button is the correct next step either way.
        setLoad(body.ok === true && body.data !== undefined
          ? { state: "in", view: body.data }
          : { state: "out" });
      } catch {
        if (live) setLoad({ state: "out" });
      }
    })();

    return () => {
      live = false;
    };
  }, [reloadAt]);

  if (load.state === "loading") return null;

  if (load.state === "out") {
    return (
      <section className="ax-section ax-reveal">
        <div className="ax-section-head">
          <h2>Your launches</h2>
        </div>

        <div className="ax-xsignin">
          <p>
            Signing in with X is how Agen knows which launches are yours. It reads your account
            name and nothing else — it cannot post, follow, or read your messages.
          </p>
          <a className="ax-btn ax-btn-dark" href="/api/x/auth/start">
            Sign in with X
          </a>
        </div>
      </section>
    );
  }

  const { view } = load;
  const reload = () => {
    setReloadAt((was) => was + 1);
  };

  return (
    <section className="ax-section ax-reveal">
      <div className="ax-section-head">
        <h2>Your launches</h2>
        <span className="ax-tag">@{view.identity.xUsername}</span>
      </div>

      {view.launches.length === 0 ? (
        <p className="ax-claim-note">
          Nothing yet. Reply to any post on X tagging the bot and it will be here within a minute
          of the market opening.
        </p>
      ) : (
        <>
          <div className="ax-claim-total">
            <span>
              {view.totals.launches === 1 ? "1 market" : `${String(view.totals.launches)} markets`} ·{" "}
              {ether(view.totals.earnedWei)} {chain.nativeCurrency.symbol} earned
            </span>
            <strong>
              {ether(view.totals.claimableWei)} {chain.nativeCurrency.symbol}
            </strong>
          </div>

          <Seat view={view} onDone={reload} />

          <div className="ax-claims">
            {view.launches.map((entry) => (
              <LaunchCard
                key={entry.record.id}
                entry={entry}
                claimed={view.seat.claimed}
                onDone={reload}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The handover.
 *
 * Deliberately one control for every market rather than one per market: a seat is per X account,
 * so a single `take` moves every launch that named it. A per-row claim button would suggest
 * otherwise and leave somebody wondering why the second one did nothing.
 */
function Seat({ view, onDone }: { readonly view: View; readonly onDone: () => void }) {
  const { address } = useAccount();
  const send = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: send.data });

  const [step, setStep] = useState<"idle" | "offering" | "taking" | "done">("idle");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (receipt.isSuccess && step === "taking") {
      setStep("done");
      onDone();
    }
  }, [receipt.isSuccess, step, onDone]);

  const claim = useCallback(async () => {
    if (address === undefined) return;

    setProblem(null);
    setStep("offering");

    try {
      const response = await fetch("/api/x/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: address }),
      });

      const body = (await response.json()) as {
        ok?: boolean;
        data?: {
          readonly alreadyClaimed: boolean;
          readonly take: { readonly to: Address; readonly data: Hex; readonly value: string };
        };
        error?: { readonly message?: string };
      };

      if (body.ok !== true || body.data === undefined) {
        setProblem(body.error?.message ?? "That did not work. Try again in a moment.");
        setStep("idle");
        return;
      }

      if (body.data.alreadyClaimed) {
        setStep("done");
        onDone();
        return;
      }

      setStep("taking");
      send.sendTransaction({
        to: body.data.take.to,
        data: body.data.take.data,
        value: BigInt(body.data.take.value),
      });
    } catch {
      setProblem("Agen could not be reached. Try again in a moment.");
      setStep("idle");
    }
  }, [address, onDone, send]);

  if (view.seat.claimed || step === "done") {
    return (
      <p className="ax-claim-note">
        Your fees pay {view.seat.beneficiary ?? "your wallet"} directly. Collect them market by
        market below — Agen covers the gas, and the money can only reach you.
      </p>
    );
  }

  return (
    <div className="ax-xseat">
      <div className="ax-xseat-say">
        <b>Claim your fees</b>
        <span>
          Your {chain.nativeCurrency.symbol} is waiting in each market&rsquo;s vault. Connect the
          wallet you want it paid to and take the seat — one signature, and it is yours for good.
        </span>
        {problem === null ? null : <em className="ax-xseat-bad">{problem}</em>}
      </div>

      <button
        type="button"
        className="ax-claim-go"
        disabled={address === undefined || step !== "idle"}
        onClick={() => {
          void claim();
        }}
      >
        {address === undefined
          ? "Connect a wallet"
          : step === "offering"
            ? "preparing…"
            : step === "taking"
              ? "confirming…"
              : "Take the seat"}
      </button>
    </div>
  );
}

function LaunchCard({
  entry,
  claimed,
  onDone,
}: {
  readonly entry: Entry;
  readonly claimed: boolean;
  readonly onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const record = entry.record;
  const owed = BigInt(entry.claimableWei);

  const collect = useCallback(async () => {
    setProblem(null);
    setBusy(true);
    try {
      const response = await fetch("/api/x/collect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ launchId: record.id }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: { message?: string } };
      if (body.ok !== true) {
        setProblem(body.error?.message ?? "That did not work.");
      } else {
        onDone();
      }
    } catch {
      setProblem("Agen could not be reached.");
    } finally {
      setBusy(false);
    }
  }, [onDone, record.id]);

  return (
    <div className="ax-xlaunch">
      <div className="ax-xlaunch-id">
        {record.token === null ? (
          <b>${record.ticker ?? "—"}</b>
        ) : (
          <a href={`/markets/${record.token}`}>
            <b>${record.ticker ?? "—"}</b>
          </a>
        )}
        <span>{record.name ?? "—"}</span>
      </div>

      <div className="ax-xlaunch-meta">
        <span>{when(record.createdAt)}</span>
        {record.sourcePostId === null ? null : (
          <a href={postUrl(record.xUsername, record.sourcePostId)} target="_blank" rel="noreferrer">
            source post
          </a>
        )}
        {record.status === "launched" ? null : <em>{record.status}</em>}
      </div>

      <span className="ax-claim-figs">
        <b>
          {ether(entry.claimableWei)} {chain.nativeCurrency.symbol}
        </b>
        <em>{ether(entry.earnedWei)} earned</em>
      </span>

      <button
        type="button"
        className="ax-claim-go"
        disabled={!claimed || owed === 0n || busy}
        onClick={() => {
          void collect();
        }}
        title={
          claimed
            ? undefined
            : "Take the seat first. Until then these fees stay in the market's vault."
        }
      >
        {busy ? "collecting…" : owed === 0n ? "Nothing yet" : "Collect"}
      </button>

      {problem === null ? null : <em className="ax-xseat-bad">{problem}</em>}
    </div>
  );
}
