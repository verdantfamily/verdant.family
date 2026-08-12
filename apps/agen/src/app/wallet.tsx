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
 */
export function Wallet() {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  const { address, status, chainId, connector } = useAccount();
  const connectors = useConnectors();
  const connect = useConnect();
  const { disconnect } = useDisconnect();
  const switchChain = useSwitchChain();

  // A popover that outlives a click elsewhere is a popover the reader has to fight.
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

  const face = busy
    ? "connecting…"
    : wrongNetwork
      ? "wrong network"
      : connected
        ? shortAddress(address)
        : "connect wallet";

  return (
    <div className="nav-account" ref={container}>
      <button
        type="button"
        className={wrongNetwork ? "wallet wallet-warn" : "wallet"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((was) => !was);
        }}
      >
        {face}
      </button>

      {open ? (
        <div className="wallet-panel" role="dialog" aria-label="Wallet">
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
              error={connect.error}
              onConnect={(chosen) => {
                connect.mutate(
                  { connector: chosen, chainId: CHAIN_ID },
                  { onSuccess: () => { setOpen(false); } },
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
  error,
  onConnect,
}: {
  readonly connectors: readonly Connector[];
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onConnect: (connector: Connector) => void;
}) {
  const { installed, bridges } = split(connectors, useInjectedIsReal());

  if (installed.length + bridges.length === 0) {
    return (
      <>
        <p className="wallet-title">no wallet on this device</p>
        <p className="wallet-help">
          On a phone, open agen.space inside your wallet&apos;s own browser — MetaMask,
          Rainbow, Trust and Coinbase Wallet each have one. A wallet cannot be reached
          from Safari or Chrome.
        </p>
        <p className="wallet-help">
          On a computer, install a browser extension. This page finds every wallet that
          announces itself, so it will appear here once one is.
        </p>
      </>
    );
  }

  return (
    <>
      <p className="wallet-title">connect a wallet</p>
      <p className="wallet-help">
        Agen never takes custody. Connecting shows your address; it authorises nothing on
        its own.
      </p>

      <div className="wallet-list">
        {[...installed, ...bridges].map((entry) => (
          <button
            type="button"
            key={entry.uid}
            disabled={pending}
            className="wallet-row"
            onClick={() => {
              onConnect(entry);
            }}
          >
            <span>{entry.name}</span>
            {entry.id === "walletConnect" ? <span className="wallet-hint">and 70+ more</span> : null}
          </button>
        ))}
      </div>

      {error === null || isRejection(error) ? null : (
        <p className="wallet-error">{error.message}</p>
      )}
    </>
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
      <p className="wallet-title">{wallet ?? "connected"}</p>
      <p className="wallet-address">{address}</p>

      {wrongNetwork ? (
        <>
          <p className="wallet-help">
            Agen&apos;s contracts are on {chain.name} (chain {String(CHAIN_ID)}). Nothing
            here can be signed until your wallet is there too. If it has never seen this
            chain it will be asked to add it.
          </p>
          <button type="button" className="wallet-row" disabled={switching} onClick={onSwitch}>
            {switching ? "waiting for your wallet…" : `switch to ${chain.name}`}
          </button>
        </>
      ) : (
        <p className="wallet-help">
          On {chain.name}, chain {String(CHAIN_ID)}.
        </p>
      )}

      <button type="button" className="wallet-row" onClick={onDisconnect}>
        disconnect
      </button>
    </>
  );
}

/** A declined request is not a failure worth reporting: they did it a second ago. */
function isRejection(error: Error): boolean {
  return /user rejected|user denied|rejected the request/i.test(error.message);
}
