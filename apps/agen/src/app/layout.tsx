import type { Metadata, Viewport } from "next";
import { Inter_Tight } from "next/font/google";

import "./globals.css";
import "./design.css";
import { Providers } from "./providers";

/**
 * The understudy.
 *
 * The brand face is Aeonik, which is licensed and therefore not committed here. It is
 * declared in `globals.css` as plain `@font-face` rules pointing at `public/fonts/`, and
 * the moment those files exist the page uses them — no build step, no code change.
 *
 * Which is exactly why this is loaded through `next/font` and Aeonik is not. A
 * `next/font/local` call names its files at build time and fails the build when they are
 * missing, so it cannot express "use these if they are there". A plain `@font-face` can:
 * a stylesheet that 404s its font simply falls through to the next family in the stack,
 * and that next family is this one.
 *
 * Inter Tight, because it is the closest neutral grotesk under an open licence — same
 * near-vertical terminals, same tight default fit, no quirks to unlearn — so the gap
 * before the real thing arrives is a small one.
 */
const fallback = Inter_Tight({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-fallback",
});

const TITLE = "agen.space — the agentic launchpad";
const DESCRIPTION =
  "describe how your token should behave. agen writes the contracts, compiles them and tests them.";

/**
 * Link cards need an absolute URL for the image; a relative one works in every local
 * check and then quietly produces no card at all once the page is actually shared.
 *
 * The override exists because the deploy is `vercel build` from a laptop rather than
 * from a push, and a laptop has no `VERCEL_PROJECT_PRODUCTION_URL` to read. See the
 * README — this value is compiled into the markup, so pointing the domain at an older
 * deployment does not update it.
 */
const SITE_URL = readSiteUrl();

/**
 * Empty is absent, and the distinction is load-bearing here rather than tidy: the
 * container build declares this as a build argument so it can be set, which means an
 * image built without one carries the variable as `""`. Under `??` that is a value, and
 * `new URL("")` throws — a deploy that fails in `next build` on a line about link cards.
 */
function readSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  return configured === undefined || configured === "" ? "https://agen.space" : configured;
}

/**
 * The filename carries a version because X, Slack and iMessage all cache a card against
 * its URL and none of them offer a way to ask nicely. Changing the artwork without
 * changing the path means the old one keeps appearing for days. Bump the number whenever
 * `pnpm brand` produces something different.
 */
const CARD = "/og.jpg?v=2";
const CARD_ALT = "agen.space — describe your market, agen builds it";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Agen",
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "agen.space",
    url: SITE_URL,
    type: "website",
    images: [{ url: CARD, width: 1200, height: 630, alt: CARD_ALT, type: "image/jpeg" }],
  },
  twitter: {
    // The only card type that shows the image at full width. Without it X falls back to
    // `summary`, which crops the same file to a small square beside the text and throws
    // away everything the composition is doing.
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    site: "@agendotspace",
    creator: "@agendotspace",
    images: [{ url: CARD, alt: CARD_ALT }],
  },
  icons: {
    // `/favicon.ico` is requested by path regardless of what the markup says, so it is
    // shipped as well as declared. The PNG is what anything modern will actually use.
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: { url: "/apple-icon.png", sizes: "180x180" },
  },
};

export const viewport: Viewport = {
  // The white the page sits on, so the phone's own chrome continues it rather than
  // framing the page with a band in another colour.
  themeColor: "#ffffff",
  colorScheme: "light",
};

/**
 * One white card, on grey.
 *
 * The shell is here rather than in each page because it is the product's frame: the
 * navigation and the content are inside the same sheet of white, and a wrapper repeated
 * in five page files is a wrapper that will eventually differ in one of them.
 */
export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en" className={fallback.variable}>
      <body>
        <Providers>
          <div className="shell">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
