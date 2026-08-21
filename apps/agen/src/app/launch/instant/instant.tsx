"use client";

/**
 * Instant: one screen, then a card to check before signing.
 *
 * There is no build here and nothing to wait for, so there is no progress screen and no
 * step pills — the whole launch is a form and a confirmation. What the form asks for is
 * everything the market cannot be given later: a picture, a name and a ticker, all three
 * written into a token whose metadata is immutable, plus the optional things that only
 * matter at the moment of launch.
 *
 * Supply is not here, and neither is the opening valuation or the fee. Those are
 * constants of the model rather than decisions, and `lib/instant.ts` says why for each.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";

import { BOUNDS } from "@verdant/config";

import { Bloom } from "../../bloom";
import { SiteFooter } from "../../footer";
import { chain } from "../../lib/chain";
import { BOOST_AVAILABLE } from "../../lib/boost";
import {
  INSTANT_FEE_PERCENTS,
  INSTANT_HELD,
  INSTANT_LAUNCHABLE,
  derive,
  emptyDraft,
  validate,
  type InstantDraft,
} from "../../lib/instant";
import { LogoField } from "./logo-field";
import { Preview } from "./preview";

const FIRST_BUY_PRESETS = ["0.01", "0.05", "0.1", "0.5"] as const;

export function Instant() {
  const { address } = useAccount();

  const [draft, setDraft] = useState<InstantDraft>(emptyDraft);
  const [advanced, setAdvanced] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  /**
   * Whether this deployment will pay for a launch.
   *
   * Asked rather than assumed, because the answer depends on a sponsor wallet and its keys — and
   * a toggle offering something the server would refuse is worse than no toggle. Null while the
   * question is outstanding, which renders as absent: a switch that appears a moment late is
   * better than one that appears and then vanishes.
   */
  const [sponsorable, setSponsorable] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;

    void fetch("/api/instant/launch")
      .then((response) => (response.ok ? response.json() : { available: false }))
      .then((body: { available?: boolean }) => {
        if (live) setSponsorable(body.available === true);
      })
      .catch(() => {
        if (live) setSponsorable(false);
      });

    return () => {
      live = false;
    };
  }, []);

  const set = useCallback(<K extends keyof InstantDraft>(key: K, value: InstantDraft[K]) => {
    setDraft((old) => ({ ...old, [key]: value }));
  }, []);

  /**
   * Turning sponsorship on, and clearing what it makes impossible.
   *
   * The three fields it forces are cleared here rather than only ignored downstream, because a
   * creator who typed 0.05 into the first buy and then switched this on must be able to *see*
   * that it is no longer part of the launch. `derive` would have zeroed it either way; a form
   * that silently disagrees with the transaction it is about to make is the problem.
   */
  const setSponsored = useCallback((on: boolean) => {
    setDraft((old) => ({
      ...old,
      sponsored: on,
      useConnectedWallet: on ? false : old.useConnectedWallet,
      boostCapable: on ? false : old.boostCapable,
      initialBuy: on ? "" : old.initialBuy,
    }));
  }, []);

  const problems = validate(draft, address);
  const derived = useMemo(() => derive(draft, address), [draft, address]);
  const ready = problems.length === 0 && derived !== null;

  return (
    <>
      <Bloom active="create" photo="launchbg" centred>
        <h1>Instant launch</h1>
      </Bloom>

      <main className="ax-wrap ax-instant">
        <Link className="ax-back-pill" href="/launch">
          <span aria-hidden="true">←</span> Back
        </Link>

        {INSTANT_LAUNCHABLE ? null : (
          <p className="ax-held">
            <strong>Not open yet.</strong> {INSTANT_HELD}
          </p>
        )}

        {/*
          The mode switch, above everything it changes.

          First on the page because it decides what the rest of the form asks for: with it on
          there is no wallet, so the fee address becomes required, the first buy is gone, and
          Boost is not on offer. Putting it after those fields would mean a creator filling
          them in and then watching them change.
        */}
        {sponsorable === true ? (
          <div className={draft.sponsored ? "ax-now ax-now-on" : "ax-now"}>
            <label className="ax-check ax-check-lead" htmlFor="sponsored">
              <input
                id="sponsored"
                type="checkbox"
                checked={draft.sponsored}
                onChange={(event) => {
                  setSponsored(event.currentTarget.checked);
                }}
              />
              Launch Instant NOW — no wallet needed
            </label>

            <p className="ax-in-note">
              {draft.sponsored
                ? "Agen signs and pays for this launch. You need no wallet, no ETH and nothing " +
                  "to confirm — just an address below for your fees, which is fixed when the " +
                  "market is created and cannot be changed afterwards by anyone."
                : "Agen pays the network fee and submits the launch for you. You keep " +
                  `${INSTANT_FEE_PERCENTS.creator.toFixed(2)}% of every trade, sent to any ` +
                  "address you name."}
            </p>
          </div>
        ) : null}

        <div className="ax-in-row">
          <label className="ax-in" htmlFor="name">
            <span>Token name</span>
            <input
              id="name"
              value={draft.name}
              maxLength={BOUNDS.token.nameLength.max}
              placeholder="King"
              autoComplete="off"
              onChange={(event) => {
                set("name", event.currentTarget.value);
              }}
            />
          </label>

          <label className="ax-in" htmlFor="symbol">
            <span>Token ticker</span>
            <input
              id="symbol"
              value={draft.symbol}
              maxLength={BOUNDS.token.symbolLength.max}
              placeholder="KING"
              autoComplete="off"
              onChange={(event) => {
                set("symbol", event.currentTarget.value.toUpperCase());
              }}
            />
          </label>
        </div>

        <label className="ax-in" htmlFor="description">
          <span>Description (optional)</span>
          <textarea
            id="description"
            value={draft.description}
            rows={3}
            maxLength={1_000}
            onChange={(event) => {
              set("description", event.currentTarget.value);
            }}
          />
        </label>

        <div className="ax-in-row">
          <div className="ax-in">
            <span>Token image</span>
            <LogoField
              value={draft.imageUrl}
              onChange={(url) => {
                set("imageUrl", url);
              }}
            />
          </div>

          <div className="ax-in">
            {/*
              Named "where your fees go" rather than "optional" when Agen is paying, because it
              is the one field that has no fallback: there is no connected wallet to default to
              and the vault fixes the address permanently at creation.
            */}
            <span>{draft.sponsored ? "Where your fees go" : "Fee receiver"}</span>
            <input
              id="fees"
              value={draft.useConnectedWallet && !draft.sponsored ? "" : draft.feeReceiver}
              placeholder={
                draft.sponsored
                  ? "0x… — your address, required"
                  : draft.useConnectedWallet
                    ? (address ?? "your wallet")
                    : "0x…"
              }
              disabled={draft.useConnectedWallet && !draft.sponsored}
              autoComplete="off"
              onChange={(event) => {
                set("feeReceiver", event.currentTarget.value);
              }}
            />

            {draft.sponsored ? null : (
              <label className="ax-check" htmlFor="connected">
                <input
                  id="connected"
                  type="checkbox"
                  checked={draft.useConnectedWallet}
                  onChange={(event) => {
                    set("useConnectedWallet", event.currentTarget.checked);
                  }}
                />
                Connected wallet
              </label>
            )}
          </div>
        </div>

        {/*
          Boost, as a property of the launch rather than a setting to find later.

          It is here and not on the market page because of what is irreversible: naming a
          wallet at launch means this market can never be Boosted, because the vault makes the
          recipient immutable. Naming the escrow costs nothing — Boost starts off, and with it
          off the fees reach the same wallet — so the box is ticked and the consequence of
          clearing it is stated rather than implied.

          Absent entirely for a launch Agen pays for. An escrow has an owner, and the address
          typed into the field above is the creator's own claim rather than something this side
          can prove they control — so a sponsored launch names the address itself. Offering the
          box and forcing it off would be a switch that does nothing.
        */}
        {BOOST_AVAILABLE && !draft.sponsored ? (
          <div className="ax-in">
            <span>Agen Boost</span>

            <label className="ax-check ax-check-lead" htmlFor="boost">
              <input
                id="boost"
                type="checkbox"
                checked={draft.boostCapable}
                onChange={(event) => {
                  set("boostCapable", event.currentTarget.checked);
                }}
              />
              Allow Boost on this market
            </label>

            <p className="ax-in-note">
              {draft.boostCapable
                ? "Boost starts off — your fees come to you as normal. You can switch it on " +
                  "later from the token's page to use them for automatic buybacks instead. " +
                  "The first Boost-capable launch needs one extra transaction."
                : "This market will never be able to use Boost. The fee address is fixed when " +
                  "the market is created and cannot be changed afterwards by anyone."}
            </p>
          </div>
        ) : null}

        {/*
          Not offered when Agen is paying, because the amount is the transaction's value and the
          sponsor wallet is what sends it — a first buy here would be the platform buying somebody
          else's tokens. Stated as an absence with a reason rather than a disabled field, since
          the way to get one is to connect a wallet and that is a choice, not a fault.
        */}
        {draft.sponsored ? (
          <p className="ax-in-note ax-in-note-alone">
            Buying at launch needs your own wallet, because the first buy is paid for in the same
            transaction. You can buy the moment the market is live, from any wallet.
          </p>
        ) : (
        <div className="ax-in">
          <span>Initial buy</span>
          <div className="ax-amount">
            <img className="ax-amount-mark" src="/eth.png" width={22} height={22} alt="" aria-hidden="true" />
            <input
              id="buy"
              value={draft.initialBuy}
              inputMode="decimal"
              placeholder="0"
              autoComplete="off"
              onChange={(event) => {
                set("initialBuy", event.currentTarget.value);
              }}
            />
            <em>{chain.nativeCurrency.symbol}</em>
          </div>
          {/*
            The sizes people actually first-buy. Typing 0.05 is a decision they already
            made on every other launchpad; making them type it here is how they launch
            with zero and then wonder why the chart is flat.
          */}
          <div className="ax-buy-presets" role="group" aria-label="first buy size">
            {FIRST_BUY_PRESETS.map((size) => (
              <button
                key={size}
                type="button"
                className={draft.initialBuy === size ? "on" : undefined}
                onClick={() => {
                  set("initialBuy", size);
                }}
              >
                {size} {chain.nativeCurrency.symbol}
              </button>
            ))}
          </div>
        </div>
        )}

        <button
          type="button"
          className="ax-adv"
          aria-expanded={advanced}
          onClick={() => {
            setAdvanced((was) => !was);
          }}
        >
          Advanced
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
            <path d="m6 9.5 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {advanced ? (
          <div className="ax-in-row ax-in-row-3">
            <label className="ax-in" htmlFor="link-x">
              <span>X link (optional)</span>
              <input
                id="link-x"
                value={draft.linkX}
                placeholder="x.com/yourtoken"
                autoComplete="off"
                onChange={(event) => {
                  set("linkX", event.currentTarget.value);
                }}
              />
            </label>

            <label className="ax-in" htmlFor="link-web">
              <span>Website (optional)</span>
              <input
                id="link-web"
                value={draft.website}
                placeholder="yourtoken.com"
                autoComplete="off"
                onChange={(event) => {
                  set("website", event.currentTarget.value);
                }}
              />
            </label>

            <label className="ax-in" htmlFor="link-tg">
              <span>Telegram (optional)</span>
              <input
                id="link-tg"
                value={draft.telegram}
                placeholder="t.me/yourtoken"
                autoComplete="off"
                onChange={(event) => {
                  set("telegram", event.currentTarget.value);
                }}
              />
            </label>
          </div>
        ) : null}

        <button
          type="button"
          className="ax-preview-go"
          disabled={!ready}
          onClick={() => {
            setPreviewing(true);
          }}
        >
          Preview &amp; Launch
        </button>

        <p className="ax-freenote">
          {problems[0] ??
            (draft.sponsored
              ? "Launching on agen.space is completely free — and Agen covers the network fee too."
              : "Launching on agen.space is completely free, you only pay the network fees.")}
        </p>

        <SiteFooter reveal={false} />
      </main>

      {previewing && derived !== null ? (
        <Preview
          derived={derived}
          draft={draft}
          description={draft.description.trim()}
          onClose={() => {
            setPreviewing(false);
          }}
        />
      ) : null}
    </>
  );
}
