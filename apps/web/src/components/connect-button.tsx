"use client";

import { shortenAddress } from "@verdant/ui";
import { useEffect, useRef, useState } from "react";
import type { Connector } from "wagmi";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { CHAIN_ID, chain } from "../lib/chain";
import { describeError, isUserRejection } from "../lib/errors";

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
 * The wallets to choose from.
 *
 * Announced wallets first, and the generic injected connector only when nothing
 * announced itself. A wallet that both announces and occupies `window.ethereum` would
 * otherwise appear twice under two different names, and a reader has no way to tell
 * that the two entries are the same extension.
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
  const announced = connectors.filter((entry) => entry.id !== "injected");
  const offered = announced.length > 0 ? announced : connectors;

  if (offered.length === 0) {
    return (
      <>
        <p className="text-sm font-semibold text-ink">No wallet found</p>
        <p className="mt-2 text-[0.8rem] leading-relaxed text-ink-muted">
          This page looks for browser wallets that announce themselves, which every
          current extension does. Install one, or open this page in a wallet&apos;s own
          browser, and it will appear here.
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
        {offered.map((entry) => (
          <button
            key={entry.uid}
            type="button"
            disabled={pending}
            onClick={() => onConnect(entry)}
            className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface-sunken px-3 py-2.5 text-left transition hover:border-border-strong hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
          >
            <WalletIcon icon={entry.icon} />
            <span className="min-w-0 flex-1 truncate text-[0.85rem] font-medium text-ink">
              {entry.name}
            </span>
          </button>
        ))}
      </div>

      <FailureNote error={error} />
    </>
  );
}

/** The connected state: who you are, which chain, and the way out. */
function ConnectedPanel({
  address,
  wallet,
  wrongNetwork,
  switching,
  error,
  onSwitch,
  onDisconnect,
}: {
  readonly address: `0x${string}`;
  readonly wallet: string | undefined;
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

      {wrongNetwork ? (
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
 * Drawn as a background image rather than an `<img>`, because these arrive as data
 * URIs from the extension: there is nothing for an image loader to optimise, and a
 * bare `<img>` is what this app's lint rules exist to catch.
 */
function WalletIcon({ icon }: { readonly icon: string | undefined }) {
  if (icon === undefined) {
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
    <span
      aria-hidden="true"
      className="size-6 shrink-0 rounded-md bg-surface-sunken bg-contain bg-center bg-no-repeat"
      style={{ backgroundImage: `url("${icon}")` }}
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
