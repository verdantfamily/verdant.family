"use client";

import { useEffect, useRef, useState } from "react";
import type { Connector } from "wagmi";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { CHAIN_ID, chain, shortAddress } from "./lib/chain";

/**
 * The one place a wallet connection is asked for.
 *
 * Ported from `apps/web`, whose version of this was rewritten twice in response to
 * failures that are invisible on the machine of whoever wrote it. The two that shaped it:
 * offering a connector called "Injected" on a phone, where nothing is on
 * `window.ethereum` and nothing ever will be; and listing a wallet twice because it both
 * announced itself over EIP-6963 and occupied `window.ethereum`.
 *
 * Four states, one button: nothing connected, connecting, connected to the wrong chain,
 * connected. The third is the one worth designing for rather than hiding — a wallet on
 * another chain can still sign, and what it would produce is a transaction against a
 * chain where Agen does not exist.
 *
 * ## Why this is a dialog and not a popover
 *
 * It was a small panel hanging off the button, which works on a desktop and is wrong on a
 * phone: anchored to a control in the corner of a 390px bar, it either overflows the
 * viewport or shrinks the wallet list to something nobody can tap. A centred dialog over
 * a dimmed page is the same on both, and connecting a wallet deserves the whole screen's
 * attention anyway — it is the step everything else depends on.
 */
export function Wallet() {
  const [open, setOpen] = useState(false);

  const { address, status, chainId, connector } = useAccount();
  const connectors = useConnectors();
  const connect = useConnect();
  const { disconnect } = useDisconnect();
  const switchChain = useSwitchChain();

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };

    // The page behind a dialog must not scroll under it, and the scrollbar's width has to
    // be handed back as padding or the layout shifts sideways as it opens.
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
  }, [open]);

  const connected = status === "connected" && address !== undefined;
  const wrongNetwork = connected && chainId !== CHAIN_ID;
  const busy = status === "connecting" || status === "reconnecting" || connect.isPending;

  const face = busy
    ? "connecting…"
    : wrongNetwork
      ? "wrong network"
      : connected
        ? shortAddress(address)
        : "connect wallet";

  return (
    <div className="nav-account">
      <button
        type="button"
        className={wrongNetwork ? "wallet wallet-warn" : "wallet"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
        }}
      >
        {face}
      </button>

      {!open ? null : (
        <div className="axw" role="presentation">
          <div
            className="axw-scrim"
            aria-hidden="true"
            onClick={() => {
              setOpen(false);
            }}
          />

          <div className="axw-modal" role="dialog" aria-modal="true" aria-label="Connect your wallet">
            <header className="axw-head">
              <a
                className="axw-icon"
                href="https://ethereum.org/en/wallets/"
                target="_blank"
                rel="noreferrer"
                aria-label="what is a wallet?"
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.4" />
                  <path
                    d="M8.1 7.7a2 2 0 1 1 2.6 2.2c-.5.2-.8.6-.8 1.1v.4"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                  <circle cx="10" cy="14.2" r="0.85" fill="currentColor" />
                </svg>
              </a>

              <img className="axw-mark" src="/mark.png" width={34} height={34} alt="" />

              <button
                type="button"
                className="axw-icon"
                aria-label="close"
                onClick={() => {
                  setOpen(false);
                }}
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="m6 6 8 8M14 6l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </header>

            {connected ? (
              <Connected
                address={address}
                wallet={connector?.name}
                wrongNetwork={wrongNetwork}
                switching={switchChain.isPending}
                onSwitch={() => {
                  switchChain.mutate({ chainId: CHAIN_ID });
                }}
                onDisconnect={() => {
                  disconnect();
                  setOpen(false);
                }}
              />
            ) : (
              <Choose
                connectors={connectors}
                pending={connect.isPending}
                pendingId={connect.variables?.connector as Connector | undefined}
                error={connect.error}
                onConnect={(chosen) => {
                  connect.mutate(
                    { connector: chosen, chainId: CHAIN_ID },
                    {
                      onSuccess: () => {
                        setOpen(false);
                      },
                    },
                  );
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Whether the generic injected connector has anything behind it.
 *
 * It is configured statically, so wagmi lists it whether or not a wallet ever put itself
 * on `window.ethereum`. Read in an effect rather than during render because the server
 * has no `window`, and a component that answered differently in the two places would be
 * a hydration error.
 */
function useInjectedIsReal(): boolean {
  const [real, setReal] = useState(false);

  useEffect(() => {
    setReal(
      typeof window !== "undefined" && (window as { ethereum?: unknown }).ethereum !== undefined,
    );
  }, []);

  return real;
}

/**
 * Announced wallets win over the generic connector rather than joining it. A wallet that
 * both announces itself and occupies `window.ethereum` — which most extensions do —
 * would otherwise be listed twice under two different names, and nothing on screen would
 * tell a reader the two entries are the same program.
 */
function split(connectors: readonly Connector[], injectedIsReal: boolean) {
  const bridges = connectors.filter((entry) => entry.id === "walletConnect");
  const announced = connectors.filter(
    (entry) => entry.id !== "injected" && entry.id !== "walletConnect",
  );
  const generic = connectors.filter((entry) => entry.id === "injected");

  return {
    installed: announced.length > 0 ? announced : injectedIsReal ? generic : [],
    bridges,
  };
}

function Choose({
  connectors,
  pending,
  pendingId,
  error,
  onConnect,
}: {
  readonly connectors: readonly Connector[];
  readonly pending: boolean;
  readonly pendingId: Connector | undefined;
  readonly error: Error | null;
  readonly onConnect: (connector: Connector) => void;
}) {
  const { installed, bridges } = split(connectors, useInjectedIsReal());

  if (installed.length + bridges.length === 0) {
    return (
      <>
        <p className="axw-title">No wallet on this device</p>
        <p className="axw-help">
          On a phone, open agen.space inside your wallet&apos;s own browser — MetaMask,
          Rainbow, Trust and Coinbase Wallet each have one. A wallet cannot be reached
          from Safari or Chrome.
        </p>
        <p className="axw-help">
          On a computer, install a browser extension. This page finds every wallet that
          announces itself, so it will appear here once one is.
        </p>
      </>
    );
  }

  return (
    <>
      <p className="axw-title">Connect your wallet</p>

      <div className="axw-list">
        {installed.map((entry) => (
          <Row
            key={entry.uid}
            connector={entry}
            badge="installed"
            busy={pending && pendingId?.uid === entry.uid}
            disabled={pending}
            onPick={onConnect}
          />
        ))}

        {bridges.map((entry) => (
          <Row
            key={entry.uid}
            connector={entry}
            badge="qr"
            busy={pending && pendingId?.uid === entry.uid}
            disabled={pending}
            onPick={onConnect}
          />
        ))}
      </div>

      {error === null || isRejection(error) ? null : (
        <p className="axw-error">{error.message}</p>
      )}
    </>
  );
}

/** One wallet: its mark, its name, whether it is here already, and a way in. */
function Row({
  connector,
  badge,
  busy,
  disabled,
  onPick,
}: {
  readonly connector: Connector;
  readonly badge: "installed" | "qr";
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onPick: (connector: Connector) => void;
}) {
  return (
    <button
      type="button"
      className="axw-row"
      disabled={disabled}
      onClick={() => {
        onPick(connector);
      }}
    >
      <Mark connector={connector} />

      <span className="axw-name">{label(connector)}</span>

      <span className={badge === "installed" ? "axw-badge axw-badge-on" : "axw-badge axw-badge-qr"}>
        {busy ? "connecting" : badge === "installed" ? "installed" : "QR code"}
      </span>

      <svg className="axw-chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="m6.5 4 4 4-4 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * What to call a connector on screen.
 *
 * Every announced wallet names itself, so this only ever fires for the generic injected
 * fallback — which calls itself "Injected", a word that means nothing to anybody who is
 * not writing this file. It appears at all only when no wallet announced itself, so the
 * honest description is the one thing we do know about it: it is in the browser.
 */
function label(connector: Connector): string {
  return connector.id === "injected" ? "Browser wallet" : connector.name;
}

/** WalletConnect's own mark. It is configured rather than announced, so it carries none. */
function WalletConnectMark() {
  return (
    <svg className="axw-logo" viewBox="0 0 480 332" aria-hidden="true">
      <path
        fill="#3B99FC"
        d="M126.613 93.984c62.483-61.519 164.291-61.519 226.774 0l7.519 7.409a7.7 7.7 0 0 1 0 11.142l-25.722 25.33a4.05 4.05 0 0 1-5.657 0l-10.349-10.189c-43.587-42.931-114.769-42.931-158.356 0l-11.083 10.912a4.05 4.05 0 0 1-5.657 0L118.36 113.258a7.7 7.7 0 0 1 0-11.142zm280.051 52.551 22.892 22.548a7.7 7.7 0 0 1 0 11.142L326.373 281.799a8.1 8.1 0 0 1-11.315 0l-73.228-72.118a2.03 2.03 0 0 0-2.828 0l-73.227 72.118a8.1 8.1 0 0 1-11.315 0L51.277 180.225a7.7 7.7 0 0 1 0-11.142l22.891-22.548a8.1 8.1 0 0 1 11.315 0l73.228 72.119a2.03 2.03 0 0 0 2.828 0l73.226-72.119a8.1 8.1 0 0 1 11.315 0l73.228 72.119a2.03 2.03 0 0 0 2.828 0l73.226-72.119a8.1 8.1 0 0 1 11.302 0z"
      />
    </svg>
  );
}

/**
 * The wallet's own icon where it announced one, and a fallback where it did not.
 *
 * EIP-6963 carries an icon as a data URI, so an announced extension draws itself. The
 * two connectors configured by hand have no icon of their own: WalletConnect gets its
 * real mark above, and the browser-wallet fallback gets a letter, because a broken image
 * would be worse than one.
 */
function Mark({ connector }: { readonly connector: Connector }) {
  const icon = connector.icon;
  const failed = useRef(false);
  const [broken, setBroken] = useState(false);

  if (connector.id === "walletConnect" && (icon === undefined || broken)) {
    return <WalletConnectMark />;
  }

  if (icon === undefined || broken) {
    return (
      <span className="axw-mono" aria-hidden="true">
        {label(connector).slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    // Not next/image: the source is a data URI the browser already holds, which the
    // optimiser can do nothing useful with.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="axw-logo"
      src={icon}
      alt=""
      aria-hidden="true"
      onError={() => {
        if (failed.current) return;
        failed.current = true;
        setBroken(true);
      }}
    />
  );
}

function Connected({
  address,
  wallet,
  wrongNetwork,
  switching,
  onSwitch,
  onDisconnect,
}: {
  readonly address: `0x${string}`;
  readonly wallet: string | undefined;
  readonly wrongNetwork: boolean;
  readonly switching: boolean;
  readonly onSwitch: () => void;
  readonly onDisconnect: () => void;
}) {
  return (
    <>
      <p className="axw-title">{wallet ?? "Connected"}</p>
      <p className="axw-address">{address}</p>

      {wrongNetwork ? (
        <>
          <p className="axw-help">
            Agen&apos;s contracts are on {chain.name} (chain {String(CHAIN_ID)}). Nothing
            here can be signed until your wallet is there too. If it has never seen this
            chain it will be asked to add it.
          </p>
          <button type="button" className="axw-action" disabled={switching} onClick={onSwitch}>
            {switching ? "waiting for your wallet…" : `Switch to ${chain.name}`}
          </button>
        </>
      ) : (
        <p className="axw-help">
          On {chain.name}, chain {String(CHAIN_ID)}.
        </p>
      )}

      <button type="button" className="axw-action axw-action-quiet" onClick={onDisconnect}>
        Disconnect
      </button>
    </>
  );
}

/** A declined request is not a failure worth reporting: they did it a second ago. */
function isRejection(error: Error): boolean {
  return /user rejected|user denied|rejected the request/i.test(error.message);
}
