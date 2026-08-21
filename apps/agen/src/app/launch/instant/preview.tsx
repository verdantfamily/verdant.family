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
import Link from "next/link";
import { erc20Abi, formatEther, parseEventLogs, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain, useWaitForTransactionReceipt } from "wagmi";

import { abi, instant as instantSdk, launch as launchSdk } from "@verdant/sdk";

import { BOOST_ADDRESSES, CHAIN_ID, EXPLORER_URL, INSTANT_ADDRESSES, chain, shortAddress } from "../../lib/chain";
import {
  INSTANT_FEE_PERCENTS,
  absoluteUrl,
  instantParams,
  type Derived,
  type InstantDraft,
} from "../../lib/instant";
import { shareDescription, shareTitle } from "../../lib/og-card";

interface Prepared {
  readonly salt: Hex;
  readonly token: Address;
  readonly metadataURI: string;
  /**
   * The address to submit as `feeRecipient`, and whether it needs deploying first.
   *
   * For a Boost-capable launch this is the creator's escrow, whose address is a pure function
   * of their payout address — so it can be named before it exists. It must exist by the time
   * the launch lands, though, because `InstantFeeVault` rejects nothing about a recipient
   * without code and would happily fix an immutable pointing at an empty address. Hence
   * `escrowNeeded`: one extra transaction, once per creator, ever.
   */
  readonly feeRecipient: Address;
  readonly escrowNeeded: boolean;
}

interface Created {
  readonly poolId: Hex;
  readonly token: Address;
  readonly bought: bigint;
  readonly hash: Hex;
}

export function Preview({
  derived,
  draft,
  description,
  onClose,
}: {
  readonly derived: Derived;
  /**
   * The form as it was typed, needed only for a sponsored launch.
   *
   * `derived` is deliberately the resolved, chain-shaped version of the draft, and a sponsored
   * launch needs the unresolved one: the server rebuilds the draft itself and will only accept a
   * logo as the stored path this origin serves, not as the absolute address `derive` turns it into.
   */
  readonly draft: InstantDraft;
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
  /**
   * Which transaction is in flight.
   *
   * `escrow` only ever occurs for a creator's first Boost-capable launch. Everything else goes
   * straight from `idle` to `launching`, which is the whole of what this screen did before.
   */
  const [step, setStep] = useState<"idle" | "escrow" | "launching">("idle");

  const sponsored = draft.sponsored;
  /** In flight on the server, which has no wallet state to read it from. */
  const [sending, setSending] = useState(false);
  /**
   * A sponsored launch that was sent and whose outcome nobody knows.
   *
   * The one failure that must not offer the button again. The transaction may have created the
   * market, so pressing launch a second time is how a creator ends up with two tokens and one
   * of them unmentioned — and the server has already recorded the attempt against this card's
   * name, so it would refuse anyway. Held separately from `error` because it changes what the
   * screen offers rather than only what it says.
   */
  const [stuck, setStuck] = useState(false);

  /**
   * This attempt's name, fixed for as long as the card is open.
   *
   * The server refuses a second launch under the same name, so a creator who presses the button
   * twice, or whose connection drops after the transaction was accepted, gets one market rather
   * than two. Regenerating it per press would defeat exactly the case it exists for; it is
   * per-card because closing and reopening the card is a new launch by intent.
   */
  const [attempt] = useState(() => crypto.randomUUID());

  const connected = status === "connected" && address !== undefined;
  const wrongNetwork = !sponsored && connected && chainId !== CHAIN_ID;
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

  /**
   * Store the document, then mine the address it is part of.
   *
   * Skipped entirely for a sponsored launch. Both halves of this depend on who signs — the salt
   * is mined against `msg.sender` and the document is stored so that address can be written into
   * the token — and for a sponsored launch that is the sponsor wallet, which this side neither
   * knows nor should. The server does the same three steps with the same functions.
   */
  useEffect(() => {
    if (sponsored) return;
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

        /*
         * Where the fees will be sent, resolved before anything is signed.
         *
         * A Boost-capable launch names the creator's escrow. Its address is derived from their
         * payout address, so it is known here whether or not it has been deployed — and
         * `escrowNeeded` is what turns the button into two steps for the one launch in a
         * creator's life that needs them.
         */
        let feeRecipient = derived.feeRecipient!;
        let escrowNeeded = false;

        if (derived.boostCapable && BOOST_ADDRESSES !== null) {
          const escrow = await instantSdk.readEscrowAddress(client, {
            escrowFactory: BOOST_ADDRESSES.escrowFactory,
            owner: derived.feeRecipient!,
          });
          feeRecipient = escrow.escrow;
          escrowNeeded = !escrow.deployed;
        }

        if (!live) return;
        setPrepared({ salt: mined.salt, token: mined.token, metadataURI, feeRecipient, escrowNeeded });
      } catch {
        if (live) setError("The chain did not answer, so this launch could not be prepared.");
      }
    })();

    return () => {
      live = false;
    };
  }, [client, address, derived, description, sponsored]);

  /**
   * Ask the platform to launch it, and take the answer as the outcome.
   *
   * One request, and it returns when the market exists — there is no hash to watch for, because
   * the server waits for the receipt before answering. That makes the failure cases simple except
   * for one: a launch whose transaction was sent and whose fate is unknown comes back as
   * `LAUNCH_INDETERMINATE`, and the only correct response is to stop rather than retry, since
   * retrying is how one form submission becomes two markets. The button is not offered again.
   */
  const launchSponsored = useCallback(async (): Promise<void> => {
    setError(null);
    setSending(true);

    try {
      const response = await fetch("/api/instant/launch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: derived.name,
          symbol: derived.symbol,
          description,
          imageUrl: draft.imageUrl,
          feeReceiver: draft.feeReceiver,
          linkX: draft.linkX,
          website: draft.website,
          telegram: draft.telegram,
          idempotencyKey: attempt,
        }),
      });

      const body = (await response.json()) as {
        token?: Address;
        poolId?: Hex;
        txHash?: Hex;
        error?: string;
        code?: string;
      };

      if (
        !response.ok ||
        body.token === undefined ||
        body.poolId === undefined ||
        body.txHash === undefined
      ) {
        setError(body.error ?? "The launch could not be completed.");
        setStuck(body.code === "LAUNCH_INDETERMINATE");
        return;
      }

      // Nothing bought, because a sponsored launch cannot include a first buy: the amount would
      // be the transaction's value and the platform is what sends it.
      setCreated({ poolId: body.poolId, token: body.token, bought: 0n, hash: body.txHash });

      void fetch("/api/instant/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: body.token }),
      }).catch(() => undefined);
    } catch {
      setError("The launch could not be reached. Nothing was created.");
    } finally {
      setSending(false);
    }
  }, [attempt, derived, description, draft]);

  /** Read the receipt rather than trusting the request that produced it. */
  useEffect(() => {
    if (!receipt.isSuccess || receipt.data === undefined || send.data === undefined) return;
    if (address === undefined || step !== "launching") return;

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
    setStep("idle");

    /*
     * Ask for the token to be source-verified, and do not wait for the answer.
     *
     * An unverified token is one whose holders have to take somebody's word for what it
     * does, and Instant's claim — no mint, no owner, immutable metadata — is only checkable
     * on an explorer showing the source. So this is part of launching rather than something
     * the creator is left to do.
     *
     * Deliberately after `setCreated` and deliberately unawaited. The market exists; the
     * success screen is already correct; the explorer takes up to two minutes to index the
     * block and none of that is worth a creator's attention. Errors are swallowed for the
     * same reason: there is nothing here a creator could act on, and a failed verification
     * has no bearing on a token that is already live and tradable.
     */
    void fetch("/api/instant/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: event.args.token }),
    }).catch(() => undefined);
  }, [receipt.isSuccess, receipt.data, send.data, address, step]);

  const launch = useCallback(() => {
    if (prepared === null || INSTANT_ADDRESSES === null) return;

    setError(null);
    setStep("launching");

    try {
      const call = instantSdk.buildInstantCreate({
        factory: INSTANT_ADDRESSES.factory,
        params: instantParams({
          derived,
          metadataURI: prepared.metadataURI,
          salt: prepared.salt,
          feeRecipient: prepared.feeRecipient,
        }),
      });

      send.sendTransaction({ to: call.to, data: call.data, value: call.value, chainId: CHAIN_ID });
    } catch {
      setError("This launch could not be encoded. Go back and check the details.");
    }
  }, [derived, prepared, send]);

  /**
   * The escrow first, where one is needed, and the launch after it lands.
   *
   * Two transactions rather than one, and only ever for a creator's first Boost-capable launch:
   * the escrow's address is derived from their payout address, so every later launch finds it
   * already there. It has to be a separate transaction because the launch names the address and
   * `InstantFeeVault` makes it immutable — naming an address with no code would produce a market
   * whose fees are permanently unreachable.
   */
  const go = useCallback(() => {
    if (sponsored) {
      void launchSponsored();
      return;
    }

    if (prepared === null) return;

    if (!prepared.escrowNeeded || BOOST_ADDRESSES === null) {
      launch();
      return;
    }

    setError(null);
    setStep("escrow");

    const call = instantSdk.buildDeployEscrow({
      escrowFactory: BOOST_ADDRESSES.escrowFactory,
      owner: derived.feeRecipient!,
    });

    send.sendTransaction({ to: call.to, data: call.data, value: call.value, chainId: CHAIN_ID });
  }, [derived, launch, launchSponsored, prepared, send, sponsored]);

  /**
   * The escrow landed, so the launch that names it can follow.
   *
   * Separate from the receipt handler below because the two transactions produce different
   * events and only the second creates a market. Reading a `MarketCreated` out of an escrow
   * deployment would find none and report a failure for a step that succeeded.
   */
  useEffect(() => {
    if (!receipt.isSuccess || step !== "escrow") return;
    launch();
  }, [receipt.isSuccess, step, launch]);

  const waiting = send.isPending || receipt.isLoading || sending;

  /**
   * A wallet that cannot reach this chain at all, told apart from one that merely has not
   * switched yet.
   *
   * Some wallets carry a fixed list of networks and will not take a new one — Phantom is the
   * common case, whose EVM support is Ethereum, Base, Polygon, Monad and HyperEVM with no
   * way to add anything else. Asked to switch to 4663 they refuse, and asked to sign anyway
   * they fail with a message of their own that reads like the site is broken.
   *
   * There is nothing to fix on this side, so the only useful thing is to say which of the
   * two situations this is. Detected from the switch failing rather than from the wallet's
   * name: a list of wallet names here would be wrong the moment one of them adds the chain.
   */
  const cannotReachChain = switchChain.error !== null;

  const label = sponsored
    ? sending
      ? "creating the market…"
      : "Launch NOW"
    : wrongNetwork
      ? switchChain.isPending
        ? "waiting for your wallet…"
        : `Switch to ${chain.name}`
      : !connected
        ? "Connect a wallet"
        : send.isPending
          ? "confirm in your wallet…"
          : receipt.isLoading
            ? step === "escrow"
              ? "setting up Boost…"
              : "creating the market…"
            : prepared === null
              ? "preparing…"
              : prepared.escrowNeeded
                ? "Set up Boost & Launch"
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

        {/*
          One fact, because one is being decided.
          
          This was a paragraph naming the creator's share, the total, Agen's cut and the
          absence of a pool fee. All of it true, and none of it what somebody weighs at the
          moment before signing — what bears on that is that the trading fee is theirs and
          it arrives in ether. The rest is on the token's own page, where somebody reading
          about the market rather than creating one will look for it.
        */}
        <p className="ax-preview-fee">
          <b>{INSTANT_FEE_PERCENTS.creator.toFixed(2)}% of every trade is yours</b>
          <span>paid in ETH, for the life of the market</span>
        </p>

        {/*
          The address, spelled out at the last moment, because this is the last moment.

          It is the one thing on this card that cannot be corrected afterwards — the vault fixes
          it when the market is created — and it is the one thing nobody was asked to confirm in
          a wallet. A creator who mistyped it has no other chance to notice.
        */}
        {sponsored && !settled && derived.feeRecipient !== null ? (
          <p className="ax-preview-check">
            Agen pays for this launch. Your fees go to{" "}
            <span className="mono">{derived.feeRecipient}</span> and that cannot be changed once
            the market exists — check it now.
          </p>
        ) : null}

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

            <ShareLaunch
              token={created.token}
              name={derived.name}
              symbol={derived.symbol}
              description={description}
            />

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
            disabled={
              sponsored
                ? waiting || stuck
                : !wrongNetwork && (!connected || prepared === null || waiting)
            }
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

        {/*
          Said here rather than left to the wallet, which says "Transaction Error" and
          invites the creator to try again at something that cannot work.
        */}
        {cannotReachChain ? (
          <p className="ax-preview-note">
            This wallet cannot add {chain.name}. Phantom and some others only support the
            networks they ship with. Connect with MetaMask, Rabby, or any wallet that allows
            a custom network, and the launch will work.
          </p>
        ) : null}

        {error === null ? null : <p className="ax-preview-note">{error}</p>}

        {/*
          Said plainly, because the instinct here is to press it again and that is the one thing
          that could produce a second token. The market probably exists; the honest instruction is
          to look rather than to retry.
        */}
        {stuck ? (
          <p className="ax-preview-note">
            The launch was sent and Agen did not hear back in time. Do not try again — check{" "}
            <Link href="/markets">the markets</Link> in a minute, and if nothing appears, tell us.
          </p>
        ) : null}
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

/**
 * The two things a creator does in the minute after launch: tell people, and keep the
 * link. Without them they close the tab and paste a CA into a chat — and the first
 * buyers land on a screener instead of here.
 */
function ShareLaunch({
  token,
  name,
  symbol,
  description,
}: {
  readonly token: string;
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
}) {
  const [copied, setCopied] = useState(false);
  const path = `/markets/${token}`;
  const url = absoluteUrl(path) ?? `https://agen.space${path}`;
  const title = shareTitle(symbol, name);
  const blurb = shareDescription({
    headline: description,
    name,
    symbol,
    marketCap: null,
  });
  const tweet = `https://x.com/intent/tweet?text=${encodeURIComponent(`${title}\n${blurb}`)}&url=${encodeURIComponent(url)}`;

  return (
    <div className="ax-share">
      <a className="ax-share-x" href={tweet} target="_blank" rel="noreferrer">
        Post on X
      </a>
      <button
        type="button"
        className="ax-share-copy"
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            window.setTimeout(() => {
              setCopied(false);
            }, 2_000);
          });
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
