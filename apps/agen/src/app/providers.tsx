"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
// The deep path, not the package barrel. `@wagmi/connectors` re-exports every connector
// it ships, including Base Account, which drags in the Coinbase SDK and a set of x402
// packages this app does not install — so the barrel fails to build while the one
// connector actually wanted resolves cleanly.
import { walletConnect } from "@wagmi/connectors/walletConnect";
import { WagmiProvider, createConfig, http, injected, type CreateConnectorFn } from "wagmi";

import { CHAIN_ID, chain } from "./lib/chain";

/**
 * The two providers everything that touches a wallet sits inside.
 *
 * Mounted once in the root layout and deliberately the only client boundary added
 * there: it renders its children through, so a page that never asks for an account is
 * still a server component and still ships no wallet code of its own.
 *
 * ## The two ways in, and why both are needed
 *
 * EIP-6963 is the whole browser-extension list. Every extension that wants to be found
 * announces itself, wagmi collects the announcements, and the result is the set of
 * wallets actually installed rather than a curated list that goes stale. `injected()` is
 * listed as well, for a wallet that puts itself on `window.ethereum` without announcing.
 *
 * None of that reaches a phone, where a wallet is a separate application rather than an
 * extension: nothing is injected and nothing announces. WalletConnect is the only
 * mechanism that crosses that gap, and it needs a project id issued to a named
 * application. This build refuses to pretend it has one — the connector exists only when
 * the variable is set, and without it the wallet list says so rather than offering
 * something that cannot work.
 *
 * The id is not a secret. It identifies the application to the relay and ships in the
 * browser bundle by necessity, which is why it is `NEXT_PUBLIC_`.
 */
const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();

const IN_BROWSER = typeof window !== "undefined";

/**
 * Built once, and that is the whole point of the shape below.
 *
 * This used to start without WalletConnect and swap in a second config from an effect,
 * to keep WalletConnect's IndexedDB-backed storage out of the server render. It worked
 * for its own purpose and quietly broke wallet discovery: `WagmiProvider` subscribes to
 * EIP-6963 when it mounts, so a config handed to it afterwards never hears a single
 * announcement. The list collapsed to the two connectors named here, which is why every
 * browser showed a nameless "Injected" and no MetaMask, Phantom or SafePal.
 *
 * So the config is created once, and only the connector list differs between the two
 * environments. The import is safe in Node; it is *constructing* the connector that
 * reaches for browser storage, and that is what this guard prevents.
 */
function connectorsFor(): CreateConnectorFn[] {
  // Last, and only as a fallback. Anything that announces itself over EIP-6963 arrives
  // with its real name and its own logo, and `wallet.tsx` prefers those — this catches
  // the wallet that takes `window.ethereum` without announcing and nothing else.
  const connectors: CreateConnectorFn[] = [injected({ shimDisconnect: true })];

  if (!IN_BROWSER || WALLETCONNECT_PROJECT_ID === undefined || WALLETCONNECT_PROJECT_ID === "") {
    return connectors;
  }

  connectors.push(
    walletConnect({
      projectId: WALLETCONNECT_PROJECT_ID,
      metadata: {
        name: "Agen",
        description: "The launchpad for programmable markets",
        url: window.location.origin,
        icons: ["https://agen.space/icon.png"],
      },
      showQrModal: true,
    }),
  );

  return connectors;
}

const CONFIG = createConfig({
  chains: [chain],
  // Every extension that wants to be found announces itself here. This is what puts
  // real names and real logos in the list instead of one generic entry.
  multiInjectedProviderDiscovery: true,
  connectors: connectorsFor(),
  transports: { [CHAIN_ID]: http() },
  // This app server-renders, so wagmi must not read a browser store while producing the
  // first HTML. Without it the markup the server sends says "not connected", the
  // client's first render disagrees, and React reports a hydration failure.
  ssr: true,
});

export function Providers({ children }: { readonly children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5_000, retry: 1 },
        },
      }),
  );

  return (
    <WagmiProvider config={CONFIG}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
