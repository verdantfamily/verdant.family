"use client";

/**
 * The last screen: five decisions and a button.
 *
 * Everything a generated market is — how many contracts, which of them holds value, what
 * the hook's permission bits have to spell, where CREATE2 will put each one — has already
 * been decided by the time anybody reaches this page, and none of it is a decision a
 * creator makes. So none of it is here. What is left is genuinely theirs: what the token
 * looks like, what it should be worth when it opens, whether they want the first buy, and
 * where the fees go.
 *
 * ## What is deliberately absent
 *
 * No tick. No liquidity range, position, or pool terminology. No manifest, no salt, no
 * component list. A creator launching a token is not choosing a price curve, and a form
 * that asked them to would be asking them to ratify a decision they have no way to
 * evaluate — which is worse than not asking, because it moves the responsibility without
 * moving the understanding.
 *
 * The opening valuation went the same way, and it was the last of them. It was a field
 * with a default of ten ether, which meant it was a question nobody had a method for
 * answering: a token that has never traded has no price to discover, so the number typed
 * was either the default or a guess. Worse, it made two Agen markets incomparable — a
 * market cap on the explore page said as much about what its creator typed as about what
 * anybody paid. Every Agen market now opens at `AGEN_LAUNCH.valuationWei` across
 * `AGEN_LAUNCH.supplyTokens`, and the figure is shown back rather than asked for.
 *
 * ## The initial buy is not always offered
 *
 * Some markets refuse trades that do not arrive through their own route — it is how they
 * know who is trading — and the factory's buy comes from the factory. The build works
 * this out from the compiled contract and says so; the field is absent rather than
 * present and failing. See `supportsAtomicDevBuy` in the compiler.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther, isAddress } from "viem";
import { useAccount, useSendTransaction, useSwitchChain, useWaitForTransactionReceipt } from "wagmi";

import { AGEN_LAUNCH } from "@verdant/config";
import { agen } from "@verdant/sdk";

import { AGEN_ADDRESSES, CHAIN_ID, EXPLORER_URL, chain, shortAddress } from "../lib/chain";
import { rememberedImage } from "./remembered-image";
import type { PublicJob } from "../lib/builds";

interface Prepared {
  readonly transaction: { readonly to: string; readonly data: string; readonly value: string };
  readonly market: {
    readonly token: string;
    readonly hook: string;
    readonly initialTick: number;
    readonly valuationWei: string;
    readonly contracts: number;
  };
  readonly initialBuy?: {
    readonly router: `0x${string}`;
    readonly amountWei: string;
    readonly poolKey: {
      readonly currency0: `0x${string}`;
      readonly currency1: `0x${string}`;
      readonly fee: number;
      readonly tickSpacing: number;
      readonly hooks: `0x${string}`;
    };
  };
}

/** Three or four significant figures of ether, which is all this needs to say. */
function ether(wei: string): string {
  const value = Number(formatEther(BigInt(wei)));
  if (value >= 100) return value.toFixed(0);
  if (value >= 1) return value.toFixed(2);
  return value.toPrecision(3);
}

export function Launch({ job }: { readonly job: PublicJob }) {
  const { address, chainId, status } = useAccount();
  const switchChain = useSwitchChain();
  const send = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: send.data });

  const [devBuy, setDevBuy] = useState("");

  /**
   * The picture chosen on the create screen, read back by job id.
   *
   * In an effect rather than in `useState`'s initialiser because `localStorage` does not
   * exist while this renders on the server, and reading it during the first client render
   * would make that render disagree with the server's.
   */
  const [image, setImage] = useState("");
  useEffect(() => {
    setImage(rememberedImage(job.id) ?? "");
  }, [job.id]);
  const [feeReceiver, setFeeReceiver] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);

  const launch = job.launch;
  const connected = status === "connected" && address !== undefined;
  const wrongNetwork = connected && chainId !== CHAIN_ID;

  // Where the fees go, defaulted to whoever is launching. Typed only by somebody who
  // wants it elsewhere, which is a real case — a multisig, a splitter — and a rare one.
  const payTo = feeReceiver.trim() === "" ? (address ?? "") : feeReceiver.trim();
  const payToIsAddress = payTo !== "" && isAddress(payTo, { strict: false });

  const buyIsAmount = devBuy.trim() === "" || /^\d*\.?\d+$/.test(devBuy.trim());

  const blocked = useMemo(() => {
    if (!AGEN_ADDRESSES.ok) {
      return `Agen is not deployed on ${chain.name} yet, so there is nothing to launch through.`;
    }
    if (launch === null) return "This build was not cleared, so it cannot be launched.";
    if (!connected) return "Connect a wallet to launch.";
    if (wrongNetwork) return null;
    if (!buyIsAmount) return "The initial buy is not an amount.";
    if (!payToIsAddress) return "The fee receiver is not an address.";
    return null;
  }, [launch, connected, wrongNetwork, buyIsAmount, payToIsAddress]);

  const go = useCallback(async () => {
    setPreparing(true);
    setError(null);

    try {
      const response = await fetch(`/api/markets/${job.id}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          creator: address,
          feeReceiver: payTo,
          devBuy: devBuy.trim() === "" ? "0" : devBuy.trim(),
          ...(image.trim() === "" ? {} : { metadataURI: image.trim() }),
        }),
      });

      const body = (await response.json()) as Prepared & { error?: string };

      if (!response.ok) {
        setError(body.error ?? "The launch could not be prepared.");
        return;
      }

      // The one thing worth re-checking in the browser. Everything else in the response
      // is opaque bytes either way, but the destination is not, and a launch sent
      // somewhere other than the factory this page is configured for is a launch that
      // has gone wrong between here and the server.
      if (
        !AGEN_ADDRESSES.ok ||
        body.transaction.to.toLowerCase() !== AGEN_ADDRESSES.addresses.factory.toLowerCase()
      ) {
        setError("The prepared launch is addressed somewhere other than Agen's factory.");
        return;
      }

      setPrepared(body);

      send.sendTransaction({
        to: body.transaction.to as `0x${string}`,
        data: body.transaction.data as `0x${string}`,
        value: BigInt(body.transaction.value),
        chainId: CHAIN_ID,
      });
    } catch {
      setError("The launch could not be prepared. The server did not answer.");
    } finally {
      setPreparing(false);
    }
  }, [job.id, address, payTo, devBuy, image, send]);

  /**
   * Tell the server what the chain did.
   *
   * Until this lands, the market exists on chain and nowhere else: the build's own page
   * would go on calling it unlaunched, because a build has no way to notice a
   * transaction. The server re-reads the receipt and takes every field from the logs, so
   * this is a nudge rather than a report — the worst a lost request can do is leave the
   * page behind the chain until the indexer catches up.
   */
  const hash = send.data;
  useEffect(() => {
    if (!receipt.isSuccess || hash === undefined) return;

    void fetch(`/api/markets/${job.id}/launched`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash: hash }),
    }).catch(() => {
      // Recorded from the chain by the indexer either way. Nothing to tell the creator:
      // their market was created, which is what they were waiting for.
    });
  }, [receipt.isSuccess, hash, job.id]);

  if (receipt.isSuccess && prepared !== null) {
    return <Launched job={job} prepared={prepared} hash={send.data!} />;
  }

  const waiting = preparing || send.isPending || receipt.isLoading;

  return (
    <section className="launch-panel">
      <h2>Ready to launch</h2>

      <div className="launch-fields">
        {/*
          Shown rather than asked for. The picture was chosen on the create screen, beside
          the name and the ticker, which is where somebody deciding what their token is
          called is already thinking about what it looks like. Asking again here would be
          asking the same question twice and inviting two different answers.

          The field is still here when there is no picture, because this is the last
          moment it can be added — the address is written into the token's metadata by
          the transaction below and is fixed from then on.
        */}
        <div className="field">
          <span className="field-label">token image</span>

          {image === "" ? (
            <p className="field-note">
              No picture was added. {job.symbol} launches without one, and it cannot be
              added afterwards — go back to the first step if you want to choose one.
            </p>
          ) : (
            <div className="launch-image">
              {/* Not next/image: this is an API route serving an upload, and there is
                  nothing for the optimiser to do with it. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image} alt={`${job.symbol} token image`} />
              <p className="field-note">Recorded with the market when it is created.</p>
            </div>
          )}
        </div>

        {/*
          Offered on every market now, which it was not before.
          It used to be taken away from about half of them: the launch bought on the
          creator's behalf from inside the factory, so a hook that authenticates its route
          or reads the trader saw a contract rather than a person and reverted the whole
          launch. Routing it through AgenRouter makes it an ordinary buy by the creator,
          which every market accepts, at the cost of a second signature.
        */}
        <div className="field">
          <label htmlFor="buy">your first buy</label>
          <div className="field-amount">
            <input
              id="buy"
              value={devBuy}
              inputMode="decimal"
              placeholder="0"
              onChange={(event) => {
                setDevBuy(event.currentTarget.value);
              }}
            />
            <span>{chain.nativeCurrency.symbol}</span>
          </div>
          <p className="field-note">
            Bought for you immediately after the market is created, as a second
            transaction, so the market credits it to you the same way it will credit
            anybody else. Optional.
          </p>
        </div>

        <div className="field">
          <label htmlFor="fees">fee receiver</label>
          <input
            id="fees"
            value={feeReceiver}
            placeholder={address ?? "your wallet"}
            onChange={(event) => {
              setFeeReceiver(event.currentTarget.value);
            }}
          />
          <p className="field-note">
            Where this market&apos;s trading fees are paid. Fixed for the life of the
            market. Defaults to your wallet.
          </p>
        </div>

        <div className="field field-static">
          <span className="field-label">network</span>
          <span className="field-value">{chain.name}</span>
        </div>
      </div>

      {/*
        The same decisions, read back in one block immediately above the button.
        A form is a set of things to fill in and a summary is a thing to check, and the
        moment before an irreversible transaction is the moment to be checking rather
        than filling in — particularly for the fee receiver, which defaults to a wallet
        the creator never typed and is fixed for the life of the market.
      */}
      <dl className="launch-check">
        <div>
          <dt>Token</dt>
          <dd>{job.name}</dd>
        </div>
        <div>
          <dt>Ticker</dt>
          <dd>${job.symbol}</dd>
        </div>
        <div>
          <dt>Opening valuation</dt>
          {/* Read back rather than chosen. Every Agen market opens here, which is what
              makes two of them comparable on a page that lists both. */}
          <dd>
            {formatEther(AGEN_LAUNCH.valuationWei)} {chain.nativeCurrency.symbol}
          </dd>
        </div>
        <div>
          <dt>Fee receiver</dt>
          <dd className="mono">{payToIsAddress ? shortAddress(payTo) : "—"}</dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>{chain.name}</dd>
        </div>
      </dl>

      {wrongNetwork ? (
        <button
          type="button"
          className="primary primary-large"
          disabled={switchChain.isPending}
          onClick={() => {
            switchChain.mutate({ chainId: CHAIN_ID });
          }}
        >
          {switchChain.isPending ? "waiting for your wallet…" : `switch to ${chain.name}`}
        </button>
      ) : (
        <button
          type="button"
          className="primary primary-large"
          disabled={blocked !== null || waiting}
          onClick={() => void go()}
        >
          {send.isPending
            ? "confirm in your wallet…"
            : receipt.isLoading
              ? "creating the market…"
              : preparing
                ? "preparing…"
                : "Launch token"}
        </button>
      )}

      {blocked === null ? null : <p className="build-blocked">{blocked}</p>}
      {error === null ? null : <p className="notice">{error}</p>}

      {send.error !== null && !isRejection(send.error) ? (
        <p className="notice">{send.error.message}</p>
      ) : null}
      {receipt.isError ? (
        <p className="notice">
          The transaction was sent but did not go through. Nothing was created, and the
          market can be launched again.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The creator's opening buy, once the market exists.
 *
 * Its own transaction, and its own component, because the two things it is between are
 * not equally important. The market is created and permanent by the time this renders;
 * the buy is optional and may fail. So nothing here is allowed to imply the launch is
 * unfinished — a failure states plainly that the token is live and only the buy did not
 * happen, with the way to do it again being the ordinary trade panel.
 *
 * It routes through `AgenRouter` like any other buy, which is the entire reason this is
 * a second transaction rather than part of the launch. The hook sees the creator as the
 * trader, so a streak, a counter or a reward credits them exactly as it would credit
 * anybody buying a minute later.
 */
function InitialBuy({
  buy,
  symbol,
  marketHref,
}: {
  readonly buy: NonNullable<Prepared["initialBuy"]>;
  readonly symbol: string;
  readonly marketHref: string;
}) {
  const send = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: send.data });

  const amount = BigInt(buy.amountWei);

  const go = useCallback(() => {
    const call = agen.buildAgenBuy({
      router: buy.router,
      poolKey: {
        currency0: buy.poolKey.currency0,
        currency1: buy.poolKey.currency1,
        fee: buy.poolKey.fee,
        tickSpacing: buy.poolKey.tickSpacing,
        hooks: buy.poolKey.hooks,
      },
      amountIn: amount,
      // No floor. The creator is buying from liquidity that was created moments ago at a
      // price nobody has moved, and a bound set here would be a number the interface
      // invented rather than one they chose.
      minAmountOut: 0n,
    });

    send.sendTransaction({ to: call.to, data: call.data, value: call.value, chainId: CHAIN_ID });
  }, [buy, amount, send]);

  // Fire once, without asking. The creator already said they wanted this on the form
  // before they signed the launch; making them press a second button would be asking the
  // same question twice.
  useEffect(() => {
    if (send.data === undefined && !send.isPending && send.error === null) go();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  if (receipt.isSuccess) {
    return (
      <p className="launch-step launch-step-done">
        2/2 · Your opening buy of {ether(buy.amountWei)} {chain.nativeCurrency.symbol} went
        through.
      </p>
    );
  }

  const failed = receipt.isError || (send.error !== null && !isRejection(send.error));

  if (failed || (send.error !== null && isRejection(send.error))) {
    return (
      <div className="launch-step launch-step-failed">
        <p>
          Your token is live. The opening buy did not go through
          {isRejection(send.error ?? new Error("")) ? " — you declined it" : ""}, and nothing
          about the market was affected by that.
        </p>
        <p>
          You can buy the same way anybody else does, on{" "}
          <a href={marketHref}>the ${symbol} page</a>.
        </p>
      </div>
    );
  }

  return (
    <p className="launch-step">
      2/2 · Buying {ether(buy.amountWei)} {chain.nativeCurrency.symbol} of ${symbol}
      {send.isPending ? " — confirm in your wallet…" : "…"}
    </p>
  );
}

function Launched({
  job,
  prepared,
  hash,
}: {
  readonly job: PublicJob;
  readonly prepared: Prepared;
  readonly hash: `0x${string}`;
}) {
  return (
    <section className="launch-panel launch-done">
      <h2>
        {job.name} is live <span className="ticker">${job.symbol}</span>
      </h2>

      {prepared.initialBuy === undefined ? null : (
        <InitialBuy
          buy={prepared.initialBuy}
          symbol={job.symbol}
          marketHref={`/markets/${job.id}`}
        />
      )}

      <dl className="launch-summary">
        <div>
          <dt>opened at</dt>
          <dd>
            {ether(prepared.market.valuationWei)} {chain.nativeCurrency.symbol}
          </dd>
        </div>
        <div>
          <dt>token</dt>
          <dd className="mono">{shortAddress(prepared.market.token)}</dd>
        </div>
        <div>
          <dt>contracts deployed</dt>
          <dd>{String(prepared.market.contracts + 1)}</dd>
        </div>
      </dl>

      <p className="launch-links">
        {/* The only link that matters now: the market is tradable and this is where. */}
        <a className="launch-go" href={`/markets/${job.id}`}>
          trade ${job.symbol}
        </a>

        {EXPLORER_URL === undefined ? null : (
          <>
            <a href={`${EXPLORER_URL}/tx/${hash}`} target="_blank" rel="noreferrer">
              transaction
            </a>
            <a
              href={`${EXPLORER_URL}/address/${prepared.market.token}`}
              target="_blank"
              rel="noreferrer"
            >
              token
            </a>
          </>
        )}
      </p>
    </section>
  );
}

/** A declined request is not an error worth reporting: they did it a second ago. */
function isRejection(error: Error): boolean {
  return /user rejected|user denied|rejected the request/i.test(error.message);
}
