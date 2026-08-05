"use client";

import { shortenAddress } from "@verdant/ui";
import { useEffect, useRef, useState } from "react";
import type { Connector } from "wagmi";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { CHAIN_ID, chain } from "../lib/chain";
import { describeError, isUserRejection } from "../lib/errors";
import { cannotReach, walletChoices } from "../lib/wallets";

/**
 * The one place a wallet connection is asked for.
 *
 * Every surface that needs a signature — the header, both launch forms, the trade
 * panel — renders this and nothing else, so there is one connect affordance rather
 * than five that drift apart.
 *
 * It has four states and shows all of them in the same button: nothing connected, a
 * connection in progress, connected to the wrong chain, and connected. The third is
 * the one worth designing for rather than hiding. A wallet on another chain can still
 * sign — it will produce a transaction against a chain where Verdant does not exist —
 * so the button stops being a connect control and becomes the offer to switch.
 */
export function ConnectButton({
  size = "default",
  label = "Connect wallet",
  className = "",
}: {
  readonly size?: "default" | "large";
  readonly label?: string;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  const { address, status, chainId, connector } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const { disconnect } = useDisconnect();
  const switchChain = useSwitchChain();

  // A popover that outlives a click elsewhere on the page is a popover the user has to
  // fight, so dismiss on any outside pointer press and on Escape.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const connected = status === "connected" && address !== undefined;
  const wrongNetwork = connected && chainId !== CHAIN_ID;
  const busy = status === "connecting" || status === "reconnecting" || connect.isPending;

  const sizing =
    size === "large" ? "h-12 px-6 text-[0.95rem] gap-2.5" : "h-9 px-4 text-sm gap-2";

  // The wrong-network button is the one place this control is not ink-coloured. It is
  // reporting a condition rather than offering the primary action, and a caution
  // surface says that without a second line of text.
  const tone = wrongNetwork
    ? "border border-caution/30 bg-caution-soft text-caution hover:bg-caution-soft/70"
    : "bg-ink text-ink-inverse hover:bg-ink/90";

  const face = busy
    ? "Connecting…"
    : wrongNetwork
      ? "Wrong network"
      : connected
        ? shortenAddress(address)
        : label;

  return (
    <div ref={container} className={`relative ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((previous) => !previous)}
        className={`inline-flex w-full items-center justify-center rounded-full font-medium shadow-card transition active:scale-[0.985] ${tone} ${sizing} ${connected && !wrongNetwork ? "numeric" : ""}`}
      >
        {wrongNetwork ? <WarningGlyph /> : <WalletGlyph />}
        {face}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Wallet"
          /*
           * The one surface in the app that floats over page content rather than over the
           * background, and the only one that is nearly opaque.
           *
           * Every other surface here is a few per cent of white, because what it has to
           * separate itself from is a photograph that arrives blurred. This one has to
           * separate itself from type — the navigation and a heading sit directly beneath
           * it — and translucency plus a blur does not do that: blurred text stays
           * perfectly legible as shape, and it lands on top of the words in the menu. So
           * the plate is the canvas at 95%, and the lift comes from the border and the
           * shadow rather than from letting the page through.
           */
          className="absolute right-0 z-50 mt-2 w-80 rounded-card border border-border-strong bg-canvas/95 p-4 text-left shadow-lift backdrop-blur-xl"
        >
          {connected ? (
            <ConnectedPanel
              address={address}
              wallet={connector?.name}
              stranded={
                connector === undefined ? null : cannotReach(connector.id, CHAIN_ID)
              }
              wrongNetwork={wrongNetwork}
              switching={switchChain.isPending}
              error={switchChain.error}
              onSwitch={() => switchChain.mutate({ chainId: CHAIN_ID })}
              onDisconnect={() => {
                disconnect();
                setOpen(false);
              }}
            />
          ) : (
            <ChoosePanel
              connectors={connectors}
              pending={connect.isPending}
              error={connect.error}
              onConnect={(chosen) => {
                connect.mutate(
                  { connector: chosen, chainId: CHAIN_ID },
                  { onSuccess: () => setOpen(false) },
                );
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Whether the generic injected connector has anything behind it.
 *
 * It is configured statically, so wagmi lists it whether or not a wallet ever put
 * itself on `window.ethereum` — and on a phone's ordinary browser nothing has. Offering
 * it there produced the whole of the failure this guards against: the only entry in the
 * list was one called "Injected", tapping it raised a provider-not-found, and a reader
 * had no way to learn that no wallet on their device was ever going to appear.
 *
 * Read in an effect rather than during render because the server has no `window` and a
 * component that answered differently in the two places would be a hydration error.
 * Announced wallets need no such test: a connector exists for one only because it
 * announced itself, which is proof it is there.
 */
function useInjectedIsReal(): boolean {
  const [real, setReal] = useState(false);

  useEffect(() => {
    setReal(
      typeof window !== "undefined" &&
        (window as { ethereum?: unknown }).ethereum !== undefined,
    );
  }, []);

  return real;
}

/**
 * The wallets to choose from.
 *
 * Announced wallets first, and the generic injected connector only when nothing
 * announced itself and something is actually on `window.ethereum`. A wallet that both
 * announces and occupies that property would otherwise appear twice under two different
 * names, and a reader has no way to tell that the two entries are the same extension.
 */
function ChoosePanel({
  connectors,
  pending,
  error,
  onConnect,
}: {
  readonly connectors: readonly Connector[];
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onConnect: (connector: Connector) => void;
}) {
  const injectedIsReal = useInjectedIsReal();
  const { installed, bridges } = walletChoices(connectors, injectedIsReal);

  if (installed.length + bridges.length === 0) {
    return (
      <>
        <p className="text-sm font-semibold text-ink">No wallet on this device</p>

        {/*
         * Reached only by a build with no WalletConnect project id configured, since
         * that connector is offerable everywhere and would have filled this list. So
         * this is the case where a phone genuinely has one way in, and saying which
         * beats a roster of wallets none of which can be reached from here.
         */}
        <p className="mt-2 text-[0.8rem] leading-relaxed text-ink-muted">
          <span className="font-medium text-ink">On a phone:</span> open{" "}
          <span className="numeric text-ink">verdant.family</span> inside your
          wallet&apos;s own browser — MetaMask, Rainbow, Trust and Coinbase Wallet each
          have one under a Browser or Discover tab. A wallet cannot be reached from
          Safari or Chrome.
        </p>

        <p className="mt-2 text-[0.8rem] leading-relaxed text-ink-muted">
          <span className="font-medium text-ink">On a computer:</span> install a browser
          extension. This page finds every wallet that announces itself, so it will
          appear here once one is installed.
        </p>
      </>
    );
  }

  return (
    <>
      <p className="text-sm font-semibold text-ink">Connect a wallet</p>
      <p className="mt-1 text-[0.75rem] leading-relaxed text-ink-muted">
        Verdant never takes custody. Connecting shows your address; it authorises
        nothing on its own.
      </p>

      <div className="mt-3 space-y-1.5">
        {installed.map((entry) => {
          // Named before the tap rather than discovered after it. Connecting is still
          // allowed — the roster this comes from is somebody else's and will go stale —
          // but nothing signed from here would ever succeed, and a reader deserves that
          // sentence before they spend a launch finding out.
          const stranded = cannotReach(entry.id, CHAIN_ID);
          return (
            <WalletRow
              key={entry.uid}
              entry={entry}
              pending={pending}
              onConnect={onConnect}
              caution={stranded === null ? undefined : `Cannot reach ${chain.name}`}
            />
          );
        })}

        {/*
         * Set apart from the wallets above it, because it is not one. Choosing it opens a
         * pairing flow rather than a wallet, and on a phone it leaves the browser
         * entirely — worth saying before the tap rather than after it.
         *
         * The hint names wallets rather than describing a mechanism. Only extensions
         * actually installed here can be listed above, so to a reader with two of them
         * this row is the entire rest of the world, and "WalletConnect" alone does not
         * say that SafePal and Backpack are behind it.
         */}
        {bridges.map((entry) => (
          <WalletRow
            key={entry.uid}
            entry={entry}
            pending={pending}
            onConnect={onConnect}
            hint="SafePal, Backpack, Trust and 70+ more"
          />
        ))}
      </div>

      <FailureNote error={error} />
    </>
  );
}

function WalletRow({
  entry,
  pending,
  hint,
  caution,
  onConnect,
}: {
  readonly entry: Connector;
  readonly pending: boolean;
  readonly hint?: string | undefined;
  /** Shown in place of the hint, in the colour of a thing that will not work. */
  readonly caution?: string | undefined;
  readonly onConnect: (connector: Connector) => void;
}) {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => onConnect(entry)}
      className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface-sunken px-3 py-2.5 text-left transition hover:border-border-strong hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
    >
      <WalletIcon icon={entry.icon} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.85rem] font-medium text-ink">
          {entry.name}
        </span>
        {caution !== undefined ? (
          <span className="block truncate text-[0.72rem] text-caution">{caution}</span>
        ) : hint === undefined ? null : (
          <span className="block truncate text-[0.72rem] text-ink-muted">{hint}</span>
        )}
      </span>
    </button>
  );
}

/** The connected state: who you are, which chain, and the way out. */
function ConnectedPanel({
  address,
  wallet,
  stranded,
  wrongNetwork,
  switching,
  error,
  onSwitch,
  onDisconnect,
}: {
  readonly address: `0x${string}`;
  readonly wallet: string | undefined;
  /** The wallet's name when it cannot reach this chain at all, and `null` otherwise. */
  readonly stranded: string | null;
  readonly wrongNetwork: boolean;
  readonly switching: boolean;
  readonly error: Error | null;
  readonly onSwitch: () => void;
  readonly onDisconnect: () => void;
}) {
  return (
    <>
      <p className="text-sm font-semibold text-ink">{wallet ?? "Connected"}</p>
      <p className="numeric mt-1 break-all text-[0.75rem] leading-relaxed text-ink-muted">
        {address}
      </p>

      {/*
       * Checked before the wrong-network offer, because for this wallet that offer is a
       * lie: switching is what it cannot do. Telling somebody to press a button that will
       * fail is worse than telling them nothing, and it is what sent one launch and every
       * trade into the same unexplained signing error.
       */}
      {stranded !== null ? (
        <div className="mt-3 rounded-xl border border-caution/30 bg-caution-soft px-3.5 py-3">
          <p className="text-[0.78rem] font-semibold text-ink">
            {stranded} cannot reach {chain.name}
          </p>
          <p className="mt-1 text-[0.75rem] leading-relaxed text-ink-muted">
            It supports a fixed list of networks and does not let anyone add another, so
            chain {CHAIN_ID} is out of its reach. Nothing signed here will go through, and
            the error it gives will not say why.
          </p>
          <p className="mt-2 text-[0.75rem] leading-relaxed text-ink-muted">
            Use a wallet that adds networks on request — MetaMask, Rabby, Rainbow — or
            connect one on your phone through WalletConnect.
          </p>
        </div>
      ) : wrongNetwork ? (
        <div className="mt-3 rounded-xl border border-caution/30 bg-caution-soft px-3.5 py-3">
          <p className="text-[0.78rem] font-semibold text-ink">
            Your wallet is on another network
          </p>
          <p className="mt-1 text-[0.75rem] leading-relaxed text-ink-muted">
            Verdant&apos;s contracts are on {chain.name} (chain {CHAIN_ID}). Nothing
            here can be signed until your wallet is there too. If it has never seen this
            chain it will be asked to add it.
          </p>
          <button
            type="button"
            disabled={switching}
            onClick={onSwitch}
            className="mt-2.5 inline-flex h-9 w-full items-center justify-center rounded-full bg-ink px-4 text-[0.82rem] font-medium text-ink-inverse transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {switching ? "Waiting for your wallet…" : `Switch to ${chain.name}`}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-[0.75rem] text-ink-muted">
          On {chain.name}, chain {CHAIN_ID}.
        </p>
      )}

      <FailureNote error={error} />

      <button
        type="button"
        onClick={onDisconnect}
        className="mt-3 inline-flex h-9 w-full items-center justify-center rounded-full border border-border bg-surface px-4 text-[0.82rem] font-medium text-ink transition hover:border-border-strong hover:bg-surface-raised"
      >
        Disconnect
      </button>
    </>
  );
}

/**
 * What went wrong, when something did.
 *
 * A declined request is not shown at all: the reader performed it deliberately a
 * second ago and telling them about it reads as a malfunction.
 */
function FailureNote({ error }: { readonly error: Error | null }) {
  if (error === null || isUserRejection(error)) return null;
  return (
    <p className="mt-3 rounded-xl border border-fall/40 bg-fall/14 px-3.5 py-2.5 text-[0.75rem] leading-relaxed text-ink-muted">
      {describeError(error)}
    </p>
  );
}

/**
 * A wallet's own mark, as announced.
 *
 * ## Why an `<img>` and not a background image
 *
 * This was a background image, and Phantom rendered as an empty square because of it.
 * An EIP-6963 icon is a data URI, and the specification's own example is a *raw* SVG
 * one — `data:image/svg+xml,<svg version="1.1" ...>`, double quotes and all. Interpolated
 * into `url("…")` the first of those quotes closes the CSS string, the declaration is
 * discarded as malformed, and what is left is the empty plate behind it. There is no
 * error to catch and nothing in the console: the wallet simply has no logo.
 *
 * An attribute has no such problem, and the specification asks for this element by name
 * anyway — an SVG can carry script, and rendering one through `<img>` is what guarantees
 * none of it runs. The usual objection does not apply either: there is nothing for an
 * image optimiser to do with a data URI a browser extension just handed us.
 *
 * ## Why the failure is caught
 *
 * Because the string comes from a third party and may be anything at all. A mark that
 * will not decode falls back to the drawn glyph, which is the same one a wallet that
 * announced no icon gets — a row with a plate and a name, rather than a hole.
 */
function WalletIcon({ icon }: { readonly icon: string | undefined }) {
  const [broken, setBroken] = useState(false);

  if (icon === undefined || broken) {
    return (
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-md bg-surface-sunken text-ink-faint"
      >
        <WalletGlyph />
      </span>
    );
  }

  return (
    /* A data URI an extension handed us: nothing for an optimiser to fetch or resize, and
       EIP-6963 asks for this element by name so that SVG script cannot run. */
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={icon}
      alt=""
      aria-hidden="true"
      onError={() => setBroken(true)}
      className="size-6 shrink-0 rounded-md bg-surface-sunken object-contain"
    />
  );
}

function WalletGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1.75" y="3.75" width="12.5" height="9" rx="2.25" />
      <path d="M10.75 8.25h1.5" />
    </svg>
  );
}

function WarningGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2.5 14.5 13.5h-13Z" />
      <path d="M8 6.75v3" />
      <path d="M8 11.75h.01" />
    </svg>
  );
}
