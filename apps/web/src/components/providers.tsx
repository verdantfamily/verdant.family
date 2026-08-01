"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider, createConfig, http, injected } from "wagmi";

import { CHAIN_ID, chain } from "../lib/chain";

/**
 * The two providers everything that touches a wallet sits inside.
 *
 * Mounted once, in the root layout, and deliberately the only client boundary added
 * there: it renders its children through, so a page that never asks for an account
 * is still a server component and still ships no wallet code of its own.
 *
 * ## Why only the injected connector
 *
 * EIP-6963 is the whole wallet list. Every extension that wants to be found announces
 * itself, wagmi collects the announcements, and the result is the set of wallets
 * actually installed rather than a curated list that goes stale. WalletConnect would
 * add wallets on other devices and needs a project id issued to a named application,
 * which this repository does not have — and a connector configured with somebody
 * else's id would work until it did not.
 *
 * `injected()` is listed as well as the discovery, for a wallet that puts itself on
 * `window.ethereum` without announcing. The connect list prefers the announced ones
 * and falls back to this, so a wallet that does both is offered once.
 */
const config = createConfig({
  chains: [chain],
  connectors: [injected()],
  // The default, stated because it is the mechanism the wallet list depends on rather
  // than an incidental setting.
  multiInjectedProviderDiscovery: true,
  transports: { [CHAIN_ID]: http() },
  // This app server-renders, so wagmi must not read a browser store while producing
  // the first HTML. Without it the markup the server sends says "not connected" and
  // the client's first render disagrees, which React reports as a hydration failure.
  ssr: true,
});

export function Providers({ children }: { readonly children: ReactNode }) {
  // Held in state rather than created at module scope, so that a client which somehow
  // outlives a navigation cannot be shared between two renders of the tree.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain reads here are prices and allowances, both of which move. Nothing
            // is cached long enough to be quoted from; the trade panel re-quotes on
            // its own schedule and this only prevents a duplicate request in flight.
            staleTime: 5_000,
            retry: 1,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
