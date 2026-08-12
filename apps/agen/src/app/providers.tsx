"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider, createConfig, http, injected } from "wagmi";
/*
 * The one connector, from its own module rather than from `wagmi/connectors`.
 *
 * That barrel re-exports every connector wagmi ships, and two of them reach code whose
 * optional dependencies are annotated for Turbopack only — `@wagmi/core`'s Tempo wallet
 * does `import('accounts')` behind a `turbopackOptional` comment. Webpack, which is what
 * `next build` uses here, does not read that comment: it tries to resolve the package,
 * fails, and takes the whole build down. Nothing here uses those connectors, so the fix
 * is not to teach webpack to ignore them but to stop pulling them in.
 */
import { walletConnect } from "@wagmi/connectors/walletConnect";

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

const APP_METADATA = {
  name: "Agen",
  description: "The launchpad for programmable markets",
  // Read from the browser rather than written down: this is the field a wallet shows to
  // somebody deciding whether to approve a session, and a hardcoded one would keep
  // claiming the production domain from a preview deployment or a laptop.
  url: typeof window === "undefined" ? "https://agen.space" : window.location.origin,
  icons: ["https://agen.space/icon.png"],
};

const config = createConfig({
  chains: [chain],
  connectors: [
    injected(),
    ...(WALLETCONNECT_PROJECT_ID === undefined || WALLETCONNECT_PROJECT_ID === ""
      ? []
      : [
          walletConnect({
            projectId: WALLETCONNECT_PROJECT_ID,
            metadata: APP_METADATA,
            showQrModal: true,
          }),
        ]),
  ],
  multiInjectedProviderDiscovery: true,
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
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
