import type { Metadata, Viewport } from "next";
import { Inter_Tight } from "next/font/google";
import type { ReactNode } from "react";

import { BottomNav } from "../components/site/bottom-nav";
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

const TITLE = "Verdant — launch a token on Robinhood Chain";
const DESCRIPTION =
  "Fixed-supply tokens on Uniswap v4, paired with ether or a tokenized equity. The fee is written into the pool at creation and the launch position is locked by a contract.";

export const metadata: Metadata = {
  /*
   * Where a relative image in any page's metadata resolves from.
   *
   * Required rather than optional: without it Next resolves `/brand/og.jpg` against
   * `localhost:3000` and every card this app produces points at a machine nobody else can
   * reach. It is read from the environment because the answer differs per deployment and
   * the app cannot know its own public name — `VERCEL_PROJECT_PRODUCTION_URL` is the
   * production domain even when a preview build is what is running, which is the one that
   * should appear in a shared link.
   */
  metadataBase: new URL(siteUrl()),
  title: { default: TITLE, template: "%s — Verdant" },
  description: DESCRIPTION,
  applicationName: "Verdant",

  /*
   * The card a link to this app unfurls into, anywhere it is pasted.
   *
   * This is the default and the market pages override it with one drawn per token. It
   * matters more than it looks: a launch is somebody posting a link, and a link with no
   * card is a grey rectangle with a domain in it. The image is the photograph the teaser
   * uses, already in `public/brand/`, so this costs nothing to serve.
   */
  openGraph: {
    type: "website",
    siteName: "Verdant",
    title: TITLE,
    description: DESCRIPTION,
    ...(BRAND.og === null ? {} : { images: [{ url: BRAND.og, width: 1200, height: 630 }] }),
  },
  twitter: {
    // The large card, not the thumbnail. A token's market cap set small beside a
    // paragraph of description is not worth drawing.
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    ...(BRAND.og === null ? {} : { images: [BRAND.og] }),
  },

  /* Declared only once the file is in `public/brand/`. A `<link rel="icon">` pointing at a
     404 is worse than none: the browser asks for it on every navigation and some of them
     cache the failure against the origin. */
  ...(BRAND.favicon === null ? {} : { icons: { icon: BRAND.favicon } }),
};

/**
 * This deployment's public address.
 *
 * `NEXT_PUBLIC_SITE_URL` first, for the domain the app is actually served on once one is
 * pointed at it. Vercel's own production hostname is the fallback, which is right for
 * every deployment before that happens and for previews. The last resort is localhost,
 * which is wrong in production and only reachable when neither variable is set — a local
 * `next build`.
 */
function siteUrl(): string {
  const explicit = process.env["NEXT_PUBLIC_SITE_URL"];
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();

  const vercel = process.env["VERCEL_PROJECT_PRODUCTION_URL"];
  if (vercel !== undefined && vercel.trim() !== "") return `https://${vercel.trim()}`;

  return "http://localhost:3000";
}

export const viewport: Viewport = {
  /* The photograph's own mean, so the browser chrome on a phone continues the page rather
     than framing it. It used to be `--color-canvas`, a good deal darker, because a scrim
     sat over the picture and that was the tone the composite averaged to. With the scrim
     gone the page reads at the photograph's exposure, and this is the value the teaser —
     which has always shown it unmodified — uses. */
  themeColor: "#362627",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  const photo = BRAND.background;

  /*
   * `data-scroll-behavior` because `globals.css` sets `scroll-behavior: smooth`, and Next
   * currently disables that during a route change on its own. It is dropping that
   * behaviour, and without this attribute a navigation would smooth-scroll to the top of
   * the new page rather than simply arriving there.
   */
  return (
    <html lang="en" data-scroll-behavior="smooth" className={display.variable}>
      {/* The wallet providers wrap everything because the header carries the connect
          control on every page. They render their children through, so a page that
          asks for no account is still rendered on the server. */}
      {/* Bottom padding on phones reserves the height of the fixed BottomNav (plus the home
          indicator), so the footer and the last of a page's content never hide behind it.
          Removed at `md`, where the bottom bar is gone and the header carries navigation. */}
      <body className="flex min-h-screen flex-col pb-[calc(4.25rem+env(safe-area-inset-bottom))] md:pb-0">
        {/* The photograph, mounted once for every route and nothing laid over it. Fixed and
            negatively stacked, so it takes part in no layout and nothing below has to know
            it is there — but every translucent surface in the app is translucent over it,
            and that is why each one carries a backdrop blur. */}
        {photo === null ? null : (
          <div className="photo" style={{ backgroundImage: `url(${photo})` }} aria-hidden="true" />
        )}

        <Providers>
          {/* The mark is resolved here rather than in the header, because the header is a
              client component — it reads the current path — and `existsSync` does not
              exist in a browser. */}
          <Header mark={BRAND.mark} lockup={BRAND.lockup} />
          <main className="flex-1">{children}</main>
          <Footer mark={BRAND.mark} />
          <BottomNav />
        </Providers>
      </body>
    </html>
  );
}
