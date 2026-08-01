import type { Metadata, Viewport } from "next";
import { Inter_Tight } from "next/font/google";

import { BRAND } from "../lib/brand";
import "./globals.css";

/**
 * Inter Tight, self-hosted at build time.
 *
 * `next/font` downloads the face during the build and serves it from our own origin, so
 * there is no request to Google at runtime, no flash of a fallback face, and no layout shift
 * when it arrives. Two weights, which is what the page uses: regular for the footnote,
 * medium for the headline and the pill.
 */
const display = Inter_Tight({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-display",
});

const DESCRIPTION =
  "Fixed-supply tokens on Uniswap v4, with the swap fee written into the pool at creation and the launch liquidity held by a contract that will not release it. Coming to Robinhood Chain.";

const TITLE = "Verdant — create markets that evolve";

/**
 * Where this is served from, which a link card cannot do without.
 *
 * Crawlers resolve `og:image` as an absolute URL, so a relative path works locally and
 * silently produces no image once it is deployed. Vercel supplies the production domain at
 * build time; `NEXT_PUBLIC_SITE_URL` overrides it for any other host. With neither set the
 * metadata is still valid, just without a resolvable image.
 */
const SITE_URL =
  process.env["NEXT_PUBLIC_SITE_URL"] ??
  (process.env["VERCEL_PROJECT_PRODUCTION_URL"] === undefined
    ? undefined
    : `https://${process.env["VERCEL_PROJECT_PRODUCTION_URL"]}`);

/**
 * A shared link's card and the tab icon, both conditional.
 *
 * Declaring an `og:image` that does not exist is worse than declaring none: X and iMessage
 * fetch it, get a 404, and some of them cache the failure. So the image appears in the
 * metadata only once the file is in `public/brand/`.
 */
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Verdant",
  ...(SITE_URL === undefined ? {} : { metadataBase: new URL(SITE_URL) }),
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Verdant",
    type: "website",
    ...(BRAND.openGraph === null
      ? {}
      : { images: [{ url: BRAND.openGraph, width: 1200, height: 630 }] }),
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    site: "@verdant_family",
    creator: "@verdant_family",
    ...(BRAND.openGraph === null ? {} : { images: [BRAND.openGraph] }),
  },
  ...(BRAND.favicon === null ? {} : { icons: { icon: BRAND.favicon } }),
};

export const viewport: Viewport = {
  /* The photograph's tone, so the browser chrome on a phone continues the page rather than
     framing it. Matches `--void` in globals.css. */
  themeColor: "#362627",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en" className={display.variable}>
      <body>{children}</body>
    </html>
  );
}
