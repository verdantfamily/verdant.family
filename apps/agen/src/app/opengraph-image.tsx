import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { loadFonts } from "./lib/og-fonts";

/**
 * The picture a link to agen.space shows.
 *
 * The front page's own photograph and the front page's own headline, because a share card
 * is the first thing most people see of this product and it should be the same thing they
 * land on. What it replaced was a pre-launch teaser — a black field reading "the operator
 * is gone / coming august 12" — which kept being served for weeks after launch because it
 * was a static file that nothing pointed at any more.
 *
 * ## Rendered rather than composited
 *
 * The old card was cut by `scripts/prepare-brand.ts` into `public/og.jpg`, which meant the
 * artwork lived in a file, the copy lived in an SVG string inside a build script, and the
 * cache was busted by hand with a `?v=` counter that somebody had to remember to bump. All
 * three are gone: this route draws the card at request time, so the copy sits next to the
 * page's copy, and Next hashes the URL from the content — a changed card is a changed
 * address, without a version to increment.
 *
 * It also gets the real typeface. `prepare-brand.ts` composited through sharp, which reads
 * fonts from the system rather than from `public/fonts`, so the teaser was set in
 * Helvetica. Satori takes the bytes.
 *
 * ## Every route without a card of its own
 *
 * A root `opengraph-image` is inherited, so this is what `/markets`, `/launch`, `/profile`
 * and `/metrics` show too. `/markets/[id]` overrides it with the token's own card. Nothing
 * in `layout.tsx` names an image any more, deliberately: a config-declared `images` array
 * beside a file-based card is two answers to one question.
 */

export const runtime = "nodejs";
export const alt = "agen.space — tokens whose markets have their own rules";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Never. Unlike the token card, which carries a price and is deliberately stale by at most
 * a minute, nothing on this one moves: a photograph and two fixed sentences. Next prerenders
 * it once during the build, so a shared link costs a static file read and no render at all,
 * and a change to the copy above ships as part of a deploy rather than whenever a window
 * happens to lapse.
 *
 * It is a PNG at a little over a megabyte, which is what `next/og` emits — Satori rasterises
 * through resvg and offers no JPEG. Every unfurler that matters accepts it (X and Telegram
 * both allow five megabytes); WhatsApp is the one that prefers a few hundred kilobytes and
 * may fall back to no picture. Re-encoding would mean sharp, which is a devDependency here
 * and not something this deploy can promise at runtime, and a card that sometimes fails to
 * render is worse than one that is merely large.
 */
export const revalidate = false;

const WIDTH = 1200;
const HEIGHT = 630;

const HEADLINE = "Welcome to evolving tokens.";
const SUBLINE =
  "Say how your token should behave and Agen writes, compiles and tests the contracts behind it.";

/**
 * The hero photograph, as a data URL.
 *
 * `bg.jpg` rather than `bg.png`: the same picture at a twentieth of the bytes, and this is
 * inlined into the render on every cache miss. Read from disk rather than fetched from our
 * own origin, because a self-fetch during a request is how a single-threaded server
 * deadlocks serving its own share card.
 *
 * Null when it cannot be read, and the card below still draws — on the bloom's own palette
 * instead. A missing photograph should cost the picture, not the preview.
 */
let photo: string | null | undefined;

async function heroPhoto(): Promise<string | null> {
  if (photo !== undefined) return photo;

  for (const path of [
    join(process.cwd(), "public/bg.jpg"),
    join(process.cwd(), "apps/agen/public/bg.jpg"),
  ]) {
    const bytes = await readFile(path).catch(() => null);
    if (bytes !== null) {
      photo = `data:image/jpeg;base64,${bytes.toString("base64")}`;
      return photo;
    }
  }

  photo = null;
  return photo;
}

export default async function Image() {
  const [fonts, hero] = await Promise.all([loadFonts(), heroPhoto()]);

  return new ImageResponse(<Card hero={hero} />, { ...size, fonts });
}

function Card({ hero }: { readonly hero: string | null }) {
  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        display: "flex",
        position: "relative",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "Agen",
        /*
         * The moss of the photograph, so the fallback is the same temperature as the thing
         * it stands in for rather than a black rectangle.
         */
        background: "#4a5340",
      }}
    >
      {hero === null ? null : (
        // Satori's img, not the browser's: there is no layout engine here to lazy-load for.
        <img
          src={hero}
          alt=""
          width={WIDTH}
          height={HEIGHT}
          style={{ position: "absolute", top: 0, left: 0, objectFit: "cover" }}
        />
      )}

      {/*
        A scrim, because the photograph is a bright sky at the top and a lit meadow at the
        bottom and white type over either is unreadable in the places it matters. Darkest
        through the middle band where the words sit, which is the page's own treatment.
      */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: WIDTH,
          height: HEIGHT,
          background:
            "linear-gradient(180deg, rgba(8,10,7,0.08) 0%, rgba(8,10,7,0.3) 48%, rgba(8,10,7,0.16) 100%)",
        }}
      />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          padding: "0 112px",
        }}
      >
        <div
          style={{
            fontSize: 26,
            fontWeight: 400,
            letterSpacing: "0.02em",
            color: "rgba(255,255,255,0.88)",
            textShadow: "0 1px 14px rgba(0,0,0,0.55)",
          }}
        >
          agen.space
        </div>

        <div
          style={{
            display: "flex",
            marginTop: 18,
            /*
             * Sized so the headline sets on one line with a margin either side rather than
             * running to the edges — a card is cropped by some clients and read as a
             * thumbnail by most, and type that touches the frame looks like a mistake at
             * either size.
             */
            fontSize: 72,
            fontWeight: 500,
            letterSpacing: "-0.045em",
            lineHeight: 1.04,
            color: "#ffffff",
            /*
             * The photograph is busy and white type on it needs a hard edge rather than a
             * glow, which is what the page gets from a scrim it can afford to make heavier
             * over a full viewport.
             */
            textShadow: "0 2px 30px rgba(0,0,0,0.62)",
          }}
        >
          {HEADLINE}
        </div>

        <div
          style={{
            display: "flex",
            marginTop: 26,
            maxWidth: 760,
            fontSize: 27,
            fontWeight: 400,
            lineHeight: 1.42,
            letterSpacing: "-0.012em",
            color: "rgba(255,255,255,0.9)",
            textShadow: "0 1px 18px rgba(0,0,0,0.6)",
          }}
        >
          {SUBLINE}
        </div>
      </div>
    </div>
  );
}
