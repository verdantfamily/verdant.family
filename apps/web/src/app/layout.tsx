import type { Metadata, Viewport } from "next";
import { Inter_Tight } from "next/font/google";
import type { ReactNode } from "react";

import { Providers } from "../components/providers";
import { Footer } from "../components/site/footer";
import { Header } from "../components/site/header";
import { BRAND } from "../lib/brand";
import "./globals.css";

/**
 * Inter Tight, self-hosted at build time, exactly as the teaser loads it.
 *
 * `next/font` downloads the face during the build and serves it from our own origin, so
 * there is no request to Google at runtime, no flash of a fallback face, and no layout
 * shift when it arrives. The variable name is the one the teaser uses, because
 * `--font-sans` in `globals.css` points at it and the two apps should be describable in
 * one sentence.
 *
 * Three weights rather than the teaser's two. It has a headline and a footnote; this app
 * has a heading level for every one of six page regions, and 600 is what `font-semibold`
 * asks for on panel titles, stat labels and table headers. Loading it is one more file and
 * the alternative is the browser synthesising a bold, which thickens the stems unevenly
 * and is at its most obvious on exactly the small uppercase labels that use it most.
 */
const display = Inter_Tight({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: {
    default: "Verdant — launch a token on Robinhood Chain",
    template: "%s — Verdant",
  },
  description:
    "Fixed-supply tokens on Uniswap v4, paired with ether or a tokenized equity. The fee is written into the pool at creation and the launch position is locked by a contract.",
  applicationName: "Verdant",
  /* Declared only once the file is in `public/brand/`. A `<link rel="icon">` pointing at a
     404 is worse than none: the browser asks for it on every navigation and some of them
     cache the failure against the origin. */
  ...(BRAND.favicon === null ? {} : { icons: { icon: BRAND.favicon } }),
};

export const viewport: Viewport = {
  /* `--color-canvas` in hex, so the browser chrome on a phone continues the page rather
     than framing it. This is the tone the composited background averages to once the scrim
     has done its work, which is a good deal darker than the photograph's own mean — the
     value the teaser uses. */
  themeColor: "#1d1514",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  const photo = BRAND.background;

  return (
    <html lang="en" className={display.variable}>
      {/* The wallet providers wrap everything because the header carries the connect
          control on every page. They render their children through, so a page that
          asks for no account is still rendered on the server. */}
      <body className="flex min-h-screen flex-col">
        {/* The four layers, mounted once for every route. They are fixed and negatively
            stacked, so they take part in no layout and nothing below has to know they are
            there — but every translucent surface in the app is translucent over these, and
            that is why each one carries a backdrop blur. */}
        {photo === null ? null : (
          <div className="photo" style={{ backgroundImage: `url(${photo})` }} aria-hidden="true" />
        )}

        <div className="scrim" aria-hidden="true" />

        <div className={photo === null ? "glow bare" : "glow"} aria-hidden="true">
          <span className="glow-a" />
          <span className="glow-b" />
        </div>

        <div className="grain" aria-hidden="true" />

        <Providers>
          {/* The mark is resolved here rather than in the header, because the header is a
              client component — it reads the current path — and `existsSync` does not
              exist in a browser. */}
          <Header mark={BRAND.mark} lockup={BRAND.lockup} />
          <main className="flex-1">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
