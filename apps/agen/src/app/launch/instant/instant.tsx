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

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";

import { BOUNDS } from "@verdant/config";

import { Bloom } from "../../bloom";
import { SiteFooter } from "../../footer";
import { chain } from "../../lib/chain";
import { BOOST_AVAILABLE } from "../../lib/boost";
import {
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

  const set = useCallback(<K extends keyof InstantDraft>(key: K, value: InstantDraft[K]) => {
    setDraft((old) => ({ ...old, [key]: value }));
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
            <span>Fee receiver</span>
            <input
              id="fees"
              value={draft.useConnectedWallet ? "" : draft.feeReceiver}
              placeholder={draft.useConnectedWallet ? (address ?? "your wallet") : "0x…"}
              disabled={draft.useConnectedWallet}
              autoComplete="off"
              onChange={(event) => {
                set("feeReceiver", event.currentTarget.value);
              }}
            />

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
          </div>
        </div>

        {/*
          Boost, as a property of the launch rather than a setting to find later.

          It is here and not on the market page because of what is irreversible: naming a
          wallet at launch means this market can never be Boosted, because the vault makes the
          recipient immutable. Naming the escrow costs nothing — Boost starts off, and with it
          off the fees reach the same wallet — so the box is ticked and the consequence of
          clearing it is stated rather than implied.
        */}
        {BOOST_AVAILABLE ? (
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
            "Launching on agen.space is completely free, you only pay the network fees."}
        </p>

        <SiteFooter reveal={false} />
      </main>

      {previewing && derived !== null ? (
        <Preview
          derived={derived}
          description={draft.description.trim()}
          onClose={() => {
            setPreviewing(false);
          }}
        />
      ) : null}
    </>
  );
}
