"use client";

/**
 * Approving and launching an engine-v1 market.
 *
 * ## Why not the engine-0 panel
 *
 * That panel is built around a manifest: it reads `job.launch` for the supply and the fee
 * collection mode, checks the deployment addresses against Agen's generated-market factory, and
 * offers an opening buy the factory used to make on the creator's behalf. An engine build has
 * no manifest, launches through a different factory, and its opening buy is an ordinary trade
 * afterwards like anybody else's. Reusing the panel meant rendering a launch button that could
 * never be enabled, which is worse than not rendering one.
 *
 * ## Two signatures, and they are different acts
 *
 * The first is free and binding: a message naming the configuration hash and the commitment.
 * It costs nothing, it can be checked line by line against the screen above it, and the server
 * refuses to prepare a transaction without it. The second is the transaction.
 *
 * The message is *built* here rather than fetched, which matters: a message the server hands
 * over for signing is a message the server chose, and the creator would be approving whatever
 * arrived. Building it from values already on this page means the wallet's dialog can be read
 * against the screen behind it.
 *
 * It is built by calling the one canonical builder, not by restating it. There was a second
 * copy of the text in this file, kept in step with the first by a test that compared source
 * strings — which is a test of two implementations agreeing rather than of there being one.
 * A reworded sentence in either copy would have produced a wallet showing text the server
 * will not verify: every approval failing, and failing silently, since a signature that does
 * not recover is indistinguishable from a wrong wallet. `@verdant/market-compiler/browser`
 * is the entry point that exists for exactly this — pure modules the interface shares with
 * the pipeline — so the browser and the server now sign and check the same bytes because they
 * are the same function.
 *
 * The separation is what makes "the market you were shown is the market you get" enforceable
 * rather than promised. Between the two, the server recomputes the commitment from the stored
 * configuration and refuses if it moved — so a rebuild, a tampered record or a decoder that
 * lost a rule all end here, before a wallet is asked for money.
 *
 * ## What the browser re-checks
 *
 * The destination. Everything else in the response is bytes, but the address is not, and a
 * launch addressed somewhere other than the engine factory this page is configured for has gone
 * wrong between here and the server. That is the same check the engine-0 panel makes, against a
 * different factory.
 */

import { engineApprovalMessage } from "@verdant/market-compiler/browser";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { isAddress } from "viem";
import {
  useAccount,
  useSendTransaction,
  useSignMessage,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from "wagmi";

import type { PublicJob } from "../lib/builds";
import { CHAIN_ID, EXPLORER_URL } from "../lib/chain";

/**
 * What the chain said the launch produced, as `/launched` recorded it.
 *
 * Structural, and every field optional in practice — the card is built to be worth reading
 * with only the transaction hash, because the hash is the one thing it always has.
 */
interface LaunchedRecord {
  readonly token?: string;
  readonly vault?: string;
}

/** What `/api/markets/[id]/launch` answers for an engine build. */
interface PreparedEngineLaunch {
  readonly engineVersion: 1 | 2;
  readonly chainId: number;
  readonly to: `0x${string}`;
  readonly data: `0x${string}`;
  readonly value: string;
  readonly configHash: `0x${string}`;
  readonly implementationHash: `0x${string}`;
  readonly vault: string | null;
  readonly quoteAsset: `0x${string}`;
  readonly quoteIsNative: boolean;
}

export function EngineLaunch({
  job,
  factory,
  secondary = null,
}: {
  readonly job: PublicJob;
  /** The engine factory this page is configured for. Null where it is not deployed here. */
  readonly factory: string | null;
  /** The way back, rendered beside the one action that goes forward. */
  readonly secondary?: ReactNode;
}) {
  const { address, chainId, status } = useAccount();
  const switchChain = useSwitchChain();
  const send = useSendTransaction();
  const sign = useSignMessage();
  const receipt = useWaitForTransactionReceipt({ hash: send.data });

  const [feeReceiver, setFeeReceiver] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvedBy, setApprovedBy] = useState<string | null>(job.approval?.approvedBy ?? null);
  const [launched, setLaunched] = useState<LaunchedRecord | null>(null);

  useEffect(() => {
    setApprovedBy(job.approval?.approvedBy ?? null);
  }, [job.approval?.approvedBy]);

  const engine = job.engine;
  const configHash = engine?.configHash ?? null;
  const implementationHash = engine?.implementationHash ?? null;

  const connected = status === "connected" && address !== undefined;
  const wrongNetwork = connected && chainId !== CHAIN_ID;
  const approved =
    connected && approvedBy !== null && approvedBy.toLowerCase() === address.toLowerCase();

  // Where the locked liquidity's fees go — distinct from the programmable fee recipients the
  // configuration names, which the review above already stated and which nothing here changes.
  const payTo = feeReceiver.trim() === "" ? (address ?? "") : feeReceiver.trim();
  const payToIsAddress = payTo !== "" && isAddress(payTo, { strict: false });

  const blocked = ((): string | null => {
    if (factory === null) {
      return "Agen's market engine is not deployed on this network, so there is nothing to launch through.";
    }
    if (configHash === null || implementationHash === null) {
      return "This build has no configuration to launch.";
    }
    if (!connected) return "Connect a wallet to launch.";
    if (wrongNetwork) return "Switch to the right network to launch.";
    if (!approved) return "Approve these exact market rules first.";
    if (!payToIsAddress) return "The liquidity fee receiver is not an address.";
    return null;
  })();

  const approve = useCallback(async () => {
    if (address === undefined || configHash === null || implementationHash === null) return;

    setError(null);

    try {
      const signature = await sign.signMessageAsync({
        message: engineApprovalMessage({
          jobId: job.id,
          engineVersion: job.engineVersion === 2 ? 2 : 1,
          configHash,
          implementationHash,
          creator: address,
        }),
      });

      const response = await fetch(`/api/markets/${job.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creator: address, signature }),
      });

      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || body.ok !== true) {
        setError(body.error ?? "The market could not be approved.");
        return;
      }

      setApprovedBy(address);
    } catch {
      // A rejected signature is a decision, not a fault. Saying "you declined" back to somebody
      // who just declined is noise; the button is still there.
      setError(null);
    }
  }, [address, configHash, implementationHash, job.id, sign]);

  const go = useCallback(async () => {
    setPreparing(true);
    setError(null);

    try {
      const response = await fetch(`/api/markets/${job.id}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creator: address, feeReceiver: payTo }),
      });

      const body = (await response.json()) as PreparedEngineLaunch & { error?: string };

      if (!response.ok) {
        setError(body.error ?? "The launch could not be prepared.");
        return;
      }

      if (factory === null || body.to.toLowerCase() !== factory.toLowerCase()) {
        setError("The prepared launch is addressed somewhere other than Agen's market engine.");
        return;
      }

      // The commitment the creator signed, against the one the server just built the
      // transaction from. The server checks this too; doing it here as well means a page that
      // has drifted from its own build cannot ask for a signature on the strength of the
      // server agreeing with itself.
      if (body.implementationHash !== implementationHash) {
        setError(
          "This launch does not carry the market rules you approved. Reload and review the " +
            "market again before launching.",
        );
        return;
      }

      send.sendTransaction({
        to: body.to,
        data: body.data,
        value: BigInt(body.value),
        chainId: CHAIN_ID,
      });
    } catch {
      setError("The launch could not be prepared. The server did not answer.");
    } finally {
      setPreparing(false);
    }
  }, [job.id, address, payTo, factory, implementationHash, send]);

  const hash = send.data;
  useEffect(() => {
    if (!receipt.isSuccess || hash === undefined) return;

    /*
     * Recording the launch, and keeping what it answers.
     *
     * The response is the chain's own account of what the transaction did, which is where the
     * token's address comes from — it cannot be known before the launch, and this is the first
     * moment anything on this page can name it. The call was already being made; ignoring the
     * body meant the creator finished a launch on a screen that could not tell them the
     * address of the thing they had just created.
     *
     * A failure here is still a launched market: the indexer reads it from the chain either
     * way. So it falls back to asking, and if that fails too the card renders without the
     * address rather than not rendering.
     */
    const record = async (): Promise<void> => {
      const posted = await fetch(`/api/markets/${job.id}/launched`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash: hash }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);

      const body = posted as { readonly record?: LaunchedRecord } | null;
      if (body?.record !== undefined) {
        setLaunched(body.record);
        return;
      }

      const read = await fetch(`/api/markets/${job.id}/launched`)
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);

      const asked = read as { readonly record?: LaunchedRecord | null } | null;
      if (asked?.record !== undefined && asked.record !== null) setLaunched(asked.record);
    };

    void record();
  }, [receipt.isSuccess, hash, job.id]);

  if (receipt.isSuccess && hash !== undefined) {
    return <Live hash={hash} job={job} record={launched} />;
  }

  /*
   * The one action that goes forward, named for the act it performs.
   *
   * Approving and launching are two different things — the first is free and binding, the
   * second spends — and the button says which one it is about to do rather than reading
   * "Launch" for both. A creator who has not signed yet is not one click from a market, and a
   * button that implies otherwise is the kind of surprise that gets a wallet dialog dismissed.
   */
  const action = wrongNetwork ? (
    <button
      className="ax-rv-go"
      onClick={() => {
        switchChain.switchChain({ chainId: CHAIN_ID });
      }}
      type="button"
    >
      Switch network
    </button>
  ) : approved ? (
    <button
      className="ax-rv-go"
      disabled={blocked !== null || preparing || send.isPending}
      onClick={() => void go()}
      type="button"
    >
      <svg
        viewBox="0 0 20 20"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8.4 11.6c-2.4.8-3.8 2.3-4.4 4.4 2.1-.6 3.6-2 4.4-4.4z" />
        <path d="M11.6 8.4 8.4 11.6 6.2 11a12 12 0 0 1 9.6-7.8A12 12 0 0 1 9 12.8z" />
      </svg>
      {preparing || send.isPending ? "Launching…" : "Launch market"}
    </button>
  ) : (
    <button
      className="ax-rv-go"
      disabled={!connected || sign.isPending}
      onClick={() => void approve()}
      type="button"
    >
      {sign.isPending ? "Waiting for your wallet…" : "Approve these rules"}
    </button>
  );

  return (
    <div className="ax-rv-foot">
      {/*
        Optional, and folded away because it is: left blank it is the wallet launching, which is
        what almost everybody wants. It stays on this screen rather than moving into the details
        drawer because it is an input — the only one here — and an input nobody can see is one
        nobody can fill in.
      */}
      <details className="ax-rv-optional">
        <summary>Who collects the liquidity&apos;s trading fees</summary>

        <p className="ax-rv-note">
          Separate from the fee split above, which the configuration fixes. Leave it blank to use
          the wallet you launch with.
        </p>

        <input
          className="ax-rv-input"
          id="engine-fee-receiver"
          onChange={(event) => {
            setFeeReceiver(event.target.value);
          }}
          placeholder={address ?? "0x…"}
          type="text"
          value={feeReceiver}
        />
      </details>

      <div className="ax-rv-actions">
        <div className="ax-rv-secondary">{secondary}</div>
        {action}
      </div>

      {approved ? null : (
        <p className="ax-rv-note ax-rv-centre">
          Approving is a free signature naming the exact configuration. Nothing is sent and
          nothing is spent; Agen will not prepare a transaction without it.
        </p>
      )}

      {blocked === null || wrongNetwork ? null : <p className="ax-rv-blocked">{blocked}</p>}
      {error === null ? null : <p className="ax-rv-blocked ax-rv-bad">{error}</p>}

      <p className="ax-rv-lock">
        <svg
          viewBox="0 0 20 20"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect height="7.4" rx="1.5" width="10.4" x="4.8" y="9" />
          <path d="M7.3 8.8V7.2a2.7 2.7 0 0 1 5.4 0v1.6" />
        </svg>
        No contract is written until you launch.
      </p>
    </div>
  );
}

function Mark({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function CopyMark() {
  return (
    <Mark>
      <rect height="9.4" rx="2.2" width="9.4" x="7.2" y="7.2" />
      <path d="M12.8 7.2V5.3a1.9 1.9 0 0 0-1.9-1.9H5.3a1.9 1.9 0 0 0-1.9 1.9v5.6a1.9 1.9 0 0 0 1.9 1.9h1.9" />
    </Mark>
  );
}

/**
 * A value that is worth reading and worth having on the clipboard.
 *
 * Shown in full rather than shortened, with the middle elided by the stylesheet: the ends are
 * the part anybody compares against what they were sent, and slicing here would make the
 * value unselectable. The confirmation replaces the value in place instead of arriving as a
 * toast, because a toast for a clipboard write notifies somebody about their own action.
 */
function Copy({ value, of }: { readonly value: string; readonly of: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      aria-label={`Copy the ${of}, ${value}`}
      className="ax-rv-copy"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => {
              setCopied(false);
            }, 1_400);
          },
          () => undefined,
        );
      }}
      title={value}
      type="button"
    >
      <span>{copied ? "Copied to your clipboard" : value}</span>
      <CopyMark />
    </button>
  );
}

function CopyLink({ path }: { readonly path: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className="ax-rv-back"
      onClick={() => {
        void navigator.clipboard.writeText(`${window.location.origin}${path}`).then(
          () => {
            setCopied(true);
            setTimeout(() => {
              setCopied(false);
            }, 1_400);
          },
          () => undefined,
        );
      }}
      type="button"
    >
      <CopyMark />
      {copied ? "Link copied" : "Copy the link"}
    </button>
  );
}

/**
 * The market, launched.
 *
 * This was two lines and a hash, which is the wrong size for the only irreversible thing that
 * happens on this screen — and it withheld the one fact a creator needs next. The token's
 * address does not exist until the transaction lands, so this is the first moment anything can
 * name it, and a screen that finishes a launch without naming it sends somebody to a block
 * explorer to find out what they just made.
 *
 * It takes itself to the middle of the window on mount. The launch bar sits at the end of a
 * long page and the receipt arrives while the creator is looking at their wallet, so without it
 * the outcome appears somewhere off-screen behind the dialog they were reading.
 */
function Live({
  hash,
  job,
  record,
}: {
  readonly hash: string;
  readonly job: PublicJob;
  readonly record: LaunchedRecord | null;
}) {
  const card = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    card.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const token = record?.token ?? null;
  const market = `/markets/${job.id}`;

  return (
    <div className="ax-rv-live" ref={card}>
      <span className="ax-rv-live-mark">
        <Mark>
          <circle cx="10" cy="10" r="7.6" />
          <path d="m6.6 10.2 2.3 2.3 4.5-4.9" />
        </Mark>
      </span>

      <h2>Your programmable market is live</h2>

      <p className="ax-rv-note">
        ${job.symbol} is trading under the rules above. They cannot be changed — the engine that
        runs them has no owner and no setter.
      </p>

      <dl className="ax-rv-live-rows">
        <div>
          <dt className="ax-rv-label">Token contract address</dt>
          <dd>
            {token === null ? (
              <span className="ax-rv-live-wait">Reading it from the chain…</span>
            ) : (
              <Copy of="contract address" value={token} />
            )}
          </dd>
        </div>

        <div>
          <dt className="ax-rv-label">Launch transaction</dt>
          <dd>
            <Copy of="transaction hash" value={hash} />
          </dd>
        </div>
      </dl>

      <div className="ax-rv-live-acts">
        <a className="ax-rv-go" href={market}>
          View your market
          <Mark>
            <path d="M4.2 10h11.6M11.3 5.6l4.5 4.4-4.5 4.4" />
          </Mark>
        </a>

        <CopyLink path={market} />

        {token === null || EXPLORER_URL === undefined ? null : (
          <a
            className="ax-rv-back"
            href={`${EXPLORER_URL}/address/${token}`}
            rel="noreferrer"
            target="_blank"
          >
            <Mark>
              <path d="M11.4 4.2h4.4v4.4M15.4 4.6 9.2 10.8M13.8 11.6v3a1.2 1.2 0 0 1-1.2 1.2H5.4a1.2 1.2 0 0 1-1.2-1.2V7.4a1.2 1.2 0 0 1 1.2-1.2h3" />
            </Mark>
            Token on the explorer
          </a>
        )}

        {EXPLORER_URL === undefined ? null : (
          <a
            className="ax-rv-back"
            href={`${EXPLORER_URL}/tx/${hash}`}
            rel="noreferrer"
            target="_blank"
          >
            <Mark>
              <path d="M11.4 4.2h4.4v4.4M15.4 4.6 9.2 10.8M13.8 11.6v3a1.2 1.2 0 0 1-1.2 1.2H5.4a1.2 1.2 0 0 1-1.2-1.2V7.4a1.2 1.2 0 0 1 1.2-1.2h3" />
            </Mark>
            Transaction
          </a>
        )}
      </div>
    </div>
  );
}
