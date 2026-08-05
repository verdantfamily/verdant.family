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
 * fails, and takes the whole build down. Nothing in this app uses those connectors, so
 * the fix is not to teach webpack to ignore them but to stop pulling them in.
 *
 * `@wagmi/connectors` is a direct dependency for this reason, pinned to the exact version
 * wagmi itself depends on so the two cannot become separate copies.
 */
import { walletConnect } from "@wagmi/connectors/walletConnect";

import { CHAIN_ID, chain } from "../lib/chain";

/**
 * The two providers everything that touches a wallet sits inside.
 *
 * Mounted once, in the root layout, and deliberately the only client boundary added
 * there: it renders its children through, so a page that never asks for an account
 * is still a server component and still ships no wallet code of its own.
 *
 * ## The two ways in, and why both are needed
 *
 * EIP-6963 is the whole browser-extension list. Every extension that wants to be found
 * announces itself, wagmi collects the announcements, and the result is the set of
 * wallets actually installed rather than a curated list that goes stale. `injected()`
 * is listed as well, for a wallet that puts itself on `window.ethereum` without
 * announcing; the connect list prefers the announced ones and falls back to it, so a
 * wallet that does both is offered once.
 *
 * None of that reaches a phone. A mobile wallet is a separate application rather than
 * an extension, so in Safari or Chrome nothing is injected and nothing announces — the
 * wallet list was empty on every phone, which is most of the people who arrive at a
 * launch from a link. WalletConnect is the only mechanism that crosses that gap: it
 * deep-links out to whichever wallet application is installed and comes back with a
 * session, and on a desktop it does the same over a QR code.
 *
 * It needs a project id issued to a named application, and this build refuses to
 * pretend it has one — a connector configured with somebody else's id works until it
 * does not. So the connector exists only when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`
 * is set, and a clone with no id behaves exactly as this app did before: extensions
 * only, and an empty state on a phone that says so.
 *
 * The id is not a secret. It identifies the application to the relay and ships in the
 * browser bundle by necessity, which is why it is a `NEXT_PUBLIC_` variable rather
 * than something held on the server.
 */
const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();

/**
 * What the wallet shows about who is asking.
 *
 * The origin is read from the browser rather than written down, because this is the
 * field a wallet displays to somebody deciding whether to approve a session — and a
 * hardcoded one would keep saying the production domain from a preview deployment or a
 * laptop, which is precisely the mismatch that field exists to expose. The fallback
 * only applies while server-rendering, where the connector never initialises.
 */
const APP_METADATA = {
  name: "Verdant",
  description: "Fixed-supply tokens on Uniswap v4",
  url: typeof window === "undefined" ? "https://verdant.family" : window.location.origin,
  icons: ["https://verdant.family/brand/mark.png"],
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
            // Its own modal, which is the QR code on a desktop and the list of installed
            // wallets on a phone. Writing that pairing flow again would be a worse copy
            // of it, and the deep links it holds are maintained by people who watch which
            // wallet changed its scheme this month.
            showQrModal: true,
          }),
        ]),
  ],
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
