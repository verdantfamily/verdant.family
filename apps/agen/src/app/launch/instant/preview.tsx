"use client";

/**
 * The last thing between a draft and a market.
 *
 * A card showing the token as it will appear, and one green button. Everything the
 * creator typed is on the form behind it; what this adds is the moment of looking at the
 * thing itself — the picture, the name, the ticker, the links — before signing for
 * something that cannot be edited afterwards.
 *
 * ## The work happens on open, not on the button
 *
 * Storing the metadata document and mining the salt both have to happen before the
 * transaction can be encoded, and both depend on what was typed. Doing them while the
 * creator is reading the card means the green button is immediate when they reach it,
 * and — more importantly — that a failure to prepare is discovered here rather than
 * after a wallet has already opened.
 *
 * The order is forced: the document's address is a constructor argument of the token, so
 * it has to exist before the salt can be mined against it, and the salt decides the
 * address the launch lands on.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { erc20Abi, formatEther, parseEventLogs, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain, useWaitForTransactionReceipt } from "wagmi";

import { abi, instant as instantSdk, launch as launchSdk } from "@verdant/sdk";

import { CHAIN_ID, EXPLORER_URL, INSTANT_ADDRESSES, chain, shortAddress } from "../../lib/chain";
import { INSTANT_FEE_PERCENTS, absoluteUrl, instantParams, type Derived } from "../../lib/instant";

interface Prepared {
  readonly salt: Hex;
  readonly token: Address;
  readonly metadataURI: string;
}

interface Created {
  readonly poolId: Hex;
  readonly token: Address;
  readonly bought: bigint;
  readonly hash: Hex;
}

export function Preview({
  derived,
  description,
  onClose,
}: {
  readonly derived: Derived;
  readonly description: string;
  readonly onClose: () => void;
}) {
  const { address, chainId, status } = useAccount();
  const client = usePublicClient();
  const switchChain = useSwitchChain();
  const send = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: send.data });

  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const connected = status === "connected" && address !== undefined;
  const wrongNetwork = connected && chainId !== CHAIN_ID;
  const settled = created !== null;

  // Escape closes it, and the page behind must not scroll under it. The scrollbar's
  // width is given back as padding or the whole layout jumps sideways as it opens.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeRef.current();
    };

    const gap = window.innerWidth - document.documentElement.clientWidth;
    const { overflow, paddingRight } = document.body.style;
    document.body.style.overflow = "hidden";
    if (gap > 0) document.body.style.paddingRight = `${String(gap)}px`;

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
    };
  }, []);

  /** Store the document, then mine the address it is part of. */
  useEffect(() => {
    if (client === undefined || INSTANT_ADDRESSES === null || address === undefined) return;
    if (derived.image === null) return;

    let live = true;

    void (async () => {
      try {
        const response = await fetch("/api/metadata", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: derived.name,
            symbol: derived.symbol,
            description,
            image: derived.image,
            links: derived.links,
          }),
        });

        const body = (await response.json()) as { url?: string; error?: string };
        if (!response.ok || typeof body.url !== "string") {
          if (live) setError(body.error ?? "The token details could not be saved.");
          return;
        }

        // Against the configured origin, not the one this tab happens to be on. The same
        // app answers on more than one hostname — `agen.space` and `www.agen.space` both
        // reach it — and this string is written into the token with `metadataMutable`
        // false, so whichever host the creator arrived through is the host every wallet
        // and explorer will ask forever. `siteOriginProblem` has already refused the
        // launch if that origin is missing or local, so this cannot be null here.
        const metadataURI = absoluteUrl(body.url);
        if (metadataURI === null) {
          if (live) setError("This build has no public address, so the token details cannot be recorded.");
          return;
        }

        const identity = {
          name: derived.name,
          symbol: derived.symbol,
          supplyTokens: derived.supplyTokens,
          metadataURI,
          metadataMutable: false as const,
          creator: address,
        };

        const initCodeHash = await launchSdk.readTokenInitCodeHash(client, {
          deployer: INSTANT_ADDRESSES.deployer,
          ...identity,
        });

        const mined = launchSdk.mineTokenSalt({
          deployer: INSTANT_ADDRESSES.deployer,
          creator: address,
          initCodeHash,
          // Ether. Every candidate clears it, so this returns on the first.
          above: "0x0000000000000000000000000000000000000000",
        });

        if (!live) return;
        setPrepared({ salt: mined.salt, token: mined.token, metadataURI });
      } catch {
        if (live) setError("The chain did not answer, so this launch could not be prepared.");
      }
    })();

    return () => {
      live = false;
    };
  }, [client, address, derived, description]);

  /** Read the receipt rather than trusting the request that produced it. */
  useEffect(() => {
    if (!receipt.isSuccess || receipt.data === undefined || send.data === undefined) return;
    if (address === undefined) return;

    const [event] = parseEventLogs({
      abi: abi.instantFactoryAbi,
      eventName: "MarketCreated",
      logs: receipt.data.logs,
    });

    if (event === undefined) {
      setError("The transaction went through but did not create a market.");
      return;
    }

    // What the creator actually received, summed from the token's own transfers rather
    // than from the amount they asked to spend. A partial fill is refunded by the
    // factory, so the two can legitimately differ.
    const bought = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.data.logs })
      .filter(
        (log) =>
          log.address.toLowerCase() === event.args.token.toLowerCase() &&
          log.args.to.toLowerCase() === address.toLowerCase(),
      )
      .reduce((total, log) => total + log.args.value, 0n);

    setCreated({ poolId: event.args.poolId, token: event.args.token, bought, hash: send.data });
  }, [receipt.isSuccess, receipt.data, send.data, address]);

  const go = useCallback(() => {
    if (prepared === null || INSTANT_ADDRESSES === null) return;

    setError(null);

    try {
      const call = instantSdk.buildInstantCreate({
        factory: INSTANT_ADDRESSES.factory,
        params: instantParams({ derived, metadataURI: prepared.metadataURI, salt: prepared.salt }),
      });

      send.sendTransaction({ to: call.to, data: call.data, value: call.value, chainId: CHAIN_ID });
    } catch {
      setError("This launch could not be encoded. Go back and check the details.");
    }
  }, [derived, prepared, send]);

  const waiting = send.isPending || receipt.isLoading;

  const label = wrongNetwork
    ? switchChain.isPending
      ? "waiting for your wallet…"
      : `Switch to ${chain.name}`
    : !connected
      ? "Connect a wallet"
      : send.isPending
        ? "confirm in your wallet…"
        : receipt.isLoading
          ? "creating the market…"
          : prepared === null
            ? "preparing…"
            : "Launch";

  return (
    <div
      className="ax-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`launch ${derived.name}`}
      onClick={(event) => {
        // Only the scrim itself, and never once a market exists behind it.
        if (event.target === event.currentTarget && !waiting) onClose();
      }}
    >
      <div className="ax-preview">
        <div className="ax-preview-head">
          <span className="ax-preview-art">
            {derived.image === null ? null : <img src={derived.image} alt="" />}
          </span>

          <span className="ax-preview-id">
            <strong>{derived.name}</strong>
            <em>${derived.symbol}</em>
          </span>

          <span className="ax-preview-links">
            {derived.links.x === undefined ? null : (
              <a href={derived.links.x} target="_blank" rel="noreferrer" aria-label="X">
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.22-6.82-5.96 6.82H1.68l7.73-8.84L1.25 2.25h6.82l4.71 6.23zm-1.16 17.52h1.84L7.01 4.13H5.03z"
                  />
                </svg>
              </a>
            )}
            {derived.links.website === undefined ? null : (
              <a href={derived.links.website} target="_blank" rel="noreferrer" aria-label="Website">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
                  <circle cx="12" cy="12" r="9.2" />
                  <path d="M3 12h18M12 2.8c2.4 2.5 3.6 5.6 3.6 9.2s-1.2 6.7-3.6 9.2c-2.4-2.5-3.6-5.6-3.6-9.2s1.2-6.7 3.6-9.2z" />
                </svg>
              </a>
            )}
            {derived.links.telegram === undefined ? null : (
              <a href={derived.links.telegram} target="_blank" rel="noreferrer" aria-label="Telegram">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
                  <path d="M21.5 3.2 2.8 10.4c-.7.3-.7 1.2 0 1.4l4.7 1.5 1.8 5.5c.2.6 1 .8 1.4.3l2.6-2.7 4.7 3.5c.5.4 1.2.1 1.4-.5l3-15c.1-.7-.6-1.3-1.3-1z" strokeLinejoin="round" />
                  <path d="m7.5 13.3 11-7.6-8.2 8.9" strokeLinejoin="round" />
                </svg>
              </a>
            )}
          </span>
        </div>

        <p className="ax-preview-fee">
          <b>{INSTANT_FEE_PERCENTS.creator.toFixed(2)}% of every trade is yours, in ETH.</b>{" "}
          This market charges {INSTANT_FEE_PERCENTS.total.toFixed(2)}% on each swap, for the
          life of the market, and {INSTANT_FEE_PERCENTS.platform.toFixed(2)}% of the trade
          goes to Agen. There is no other fee: the pool itself charges nothing on top.
        </p>

        {settled ? (
          <div className="ax-preview-done">
            <p className="ax-preview-live">
              {derived.name} is live{created.bought > 0n ? ` — you hold ${formatEther(created.bought)} $${derived.symbol}` : ""}.
            </p>

            <dl className="ax-preview-facts">
              <div>
                <dt>token</dt>
                <dd className="mono">{shortAddress(created.token)}</dd>
              </div>
              <div>
                <dt>market</dt>
                <dd className="mono">{shortAddress(created.poolId)}</dd>
              </div>
            </dl>

            {/*
              The token, not the pool. `/markets/[id]` tells the two products apart by the
              shape of the id — forty hex digits is an Instant token, a uuid is a build —
              so a sixty-four-digit pool id matches neither and the page a creator lands on
              one second after paying for their launch is a 404. The pool id is still worth
              showing above; it is just not an address this route answers to.
            */}
            <a className="ax-launch" href={`/markets/${created.token}`}>
              Trade ${derived.symbol}
            </a>

            {EXPLORER_URL === undefined ? null : (
              <p className="ax-preview-away">
                <a href={`${EXPLORER_URL}/tx/${created.hash}`} target="_blank" rel="noreferrer">
                  transaction
                </a>
                <a href={`${EXPLORER_URL}/address/${created.token}`} target="_blank" rel="noreferrer">
                  token
                </a>
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="ax-launch"
            disabled={!wrongNetwork && (!connected || prepared === null || waiting)}
            onClick={() => {
              if (wrongNetwork) {
                switchChain.mutate({ chainId: CHAIN_ID });
                return;
              }
              go();
            }}
          >
            {label}
          </button>
        )}

        {error === null ? null : <p className="ax-preview-note">{error}</p>}
        {send.error !== null && !isRejection(send.error) ? (
          <p className="ax-preview-note">{send.error.message}</p>
        ) : null}
        {receipt.isError ? (
          <p className="ax-preview-note">
            The transaction was sent but did not go through. Nothing was created, and the
            token can be launched again.
          </p>
        ) : null}

        {settled ? null : (
          <button type="button" className="ax-preview-back" onClick={onClose} disabled={waiting}>
            Back
          </button>
        )}
      </div>
    </div>
  );
}

/** A declined request is not an error worth reporting: they did it a second ago. */
function isRejection(error: Error): boolean {
  return /user rejected|user denied|rejected the request/i.test(error.message);
}
