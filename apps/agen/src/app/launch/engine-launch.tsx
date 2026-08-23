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
import { useCallback, useEffect, useState } from "react";
import { isAddress } from "viem";
import {
  useAccount,
  useSendTransaction,
  useSignMessage,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from "wagmi";

import type { PublicJob } from "../lib/builds";
import { CHAIN_ID } from "../lib/chain";

/** What `/api/markets/[id]/launch` answers for an engine build. */
interface PreparedEngineLaunch {
  readonly engineVersion: 1;
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
}: {
  readonly job: PublicJob;
  /** The engine factory this page is configured for. Null where it is not deployed here. */
  readonly factory: string | null;
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
          engineVersion: 1,
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

    void fetch(`/api/markets/${job.id}/launched`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash: hash }),
    }).catch(() => {
      // The indexer reads it from the chain regardless. Nothing to tell the creator: their
      // market was created, which is what they were waiting for.
    });
  }, [receipt.isSuccess, hash, job.id]);

  if (receipt.isSuccess && hash !== undefined) {
    return (
      <section className="review-section">
        <h2 className="review-h2">Launched</h2>
        <p className="engine-card-summary">
          ${job.symbol} is live and trading under the rules above. They cannot be changed.
        </p>
        <p className="engine-card-summary">
          <code>{hash}</code>
        </p>
      </section>
    );
  }

  return (
    <section className="review-section">
      <h2 className="review-h2">Launch</h2>

      <article className="engine-card">
        <label className="engine-question" htmlFor="engine-fee-receiver">
          Who collects the liquidity&apos;s trading fees
        </label>
        <p className="engine-card-summary">
          Separate from the fee split above, which the configuration fixes. Leave it blank to use
          the wallet you launch with.
        </p>
        <input
          className="engine-answer"
          id="engine-fee-receiver"
          onChange={(event) => {
            setFeeReceiver(event.target.value);
          }}
          placeholder={address ?? "0x…"}
          type="text"
          value={feeReceiver}
        />
      </article>

      {wrongNetwork ? (
        <button
          className="engine-submit"
          onClick={() => {
            switchChain.switchChain({ chainId: CHAIN_ID });
          }}
          type="button"
        >
          Switch network
        </button>
      ) : approved ? (
        <button
          className="engine-submit"
          disabled={blocked !== null || preparing || send.isPending}
          onClick={() => void go()}
          type="button"
        >
          {preparing || send.isPending ? "Launching…" : `Launch $${job.symbol}`}
        </button>
      ) : (
        <button
          className="engine-submit"
          disabled={!connected || sign.isPending}
          onClick={() => void approve()}
          type="button"
        >
          {sign.isPending ? "Waiting for your wallet…" : "Approve these rules"}
        </button>
      )}

      {approved ? null : (
        <p className="engine-card-summary">
          A free signature naming the exact configuration. Nothing is sent and nothing is spent;
          Agen will not prepare a transaction without it.
        </p>
      )}

      {blocked === null || wrongNetwork ? null : <p className="deploy-note">{blocked}</p>}
      {error === null ? null : <p className="deploy-note">{error}</p>}
    </section>
  );
}
