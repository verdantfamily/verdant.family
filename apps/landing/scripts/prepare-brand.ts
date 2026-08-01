/**
 * Turns brand originals into files a landing page can actually ship.
 *
 * The originals are what a designer or a camera produces. This background arrived as a
 * 13 MB, 4496 x 3000 JPEG straight off a Nikon, and the logo as a horizontal lockup —
 * mark plus wordmark — drawn on a 976 x 233 canvas. Both are right as sources and unusable
 * as assets: 13 MB is a background nobody on a phone waits for, and a page that wants the
 * mark alone, centred, cannot get it from a file where the mark sits in the left sixth,
 * because what centres is the canvas.
 *
 * So this exists instead of a note asking someone to remember. Sources live in
 * `brand-source/`, which is not committed; what this writes into `public/brand/` is.
 *
 *   pnpm --filter @verdant/landing brand
 *
 * The background is blurred here rather than in CSS, which is the difference between the
 * browser convolving a viewport-sized layer on every animated frame and it drawing an
 * ordinary image. It also compresses to a fraction of the original, because heavy blur is
 * exactly what JPEG is good at: 13 MB becomes about 20 KB.
 *
 * ## Why every file is written twice
 *
 * The teaser and the launchpad are separate Next applications with separate deployments,
 * and a Next app can only serve what is inside its own `public/`. There is no import that
 * reaches across an app boundary for a static file and no shared origin to point both at,
 * so the same five files have to exist under both — which leaves two ways to arrange it,
 * and this is the less bad one. The alternative is a copy step somebody runs by hand, and
 * a hand copy is how the launchpad ends up wearing last month's logo: it fails silently,
 * it fails in only one of the two apps, and nothing about either app looks wrong enough to
 * investigate. One generator writing every destination cannot drift, because there is no
 * moment at which one destination is newer than the other.
 *
 * The duplicated bytes are committed deliberately for the same reason the originals are
 * not: these are build outputs small enough (about 60 KB in total) that having them in the
 * tree is cheaper than a clone that renders a broken image until someone installs sharp.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, "..");
const SOURCE = join(APP, "brand-source");

/**
 * Every app that serves these files, in the order a reader would think of them.
 *
 * Adding a third app is adding a line here. Nothing else in this file knows how many
 * destinations there are.
 */
const OUTS = [
  join(APP, "public", "brand"),
  join(APP, "..", "web", "public", "brand"),
] as const;

/** Writes one generated file to every destination. */
function emit(name: string, data: Buffer): void {
  for (const out of OUTS) writeFileSync(join(out, name), data);
}

/** Wide enough for a 5K display once blurred, since blur hides the upscale. */
const BACKGROUND_WIDTH = 1920;
/** Applied after the resize above, so it is a radius in output pixels. */
const BACKGROUND_BLUR = 24;
/** The mark renders at ~44 px, so 4x survives a 3x display and a larger future use. */
const MARK_HEIGHT = 176;
/** The lockup is wider than it is tall; height is the useful dimension to pin. */
const LOCKUP_HEIGHT = 160;
/** One size, scaled down by the browser. Large enough for a bookmark tile. */
const ICON = 256;
/** Alpha above this counts as ink. Antialiased edges trail off to nothing below it. */
const INK = 16;
/** Empty columns this wide separate the mark from the wordmark rather than two letters. */
const LOCKUP_GAP = 24;
const OG = { width: 1200, height: 630 } as const;
/** Kept in step with `--void` in globals.css; the run prints the value to check it against. */
const VOID = "#362627";

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Pixels {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly channels: number;
}

function source(name: string): string | null {
  const path = join(SOURCE, name);
  return existsSync(path) ? path : null;
}

async function pixels(path: string): Promise<Pixels> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function alphaAt({ data, width, channels }: Pixels, x: number, y: number): number {
  return data[(y * width + x) * channels + 3] ?? 0;
}

/**
 * The tightest box containing ink.
 *
 * sharp's own `trim` would do this, but only by comparing against the corner pixel, which
 * cannot tell "empty canvas" from "one faint stray pixel in the corner". Reading alpha
 * directly is a few lines and says what it means.
 */
function inkBox(image: Pixels, columns?: { from: number; to: number }): Box {
  const from = columns?.from ?? 0;
  const to = columns?.to ?? image.width - 1;
  let left = to;
  let right = from;
  let top = image.height - 1;
  let bottom = 0;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = from; x <= to; x += 1) {
      if (alphaAt(image, x, y) <= INK) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/** Where the mark ends, or null if the file holds no gap wide enough to be one. */
function markRightEdge(image: Pixels, box: Box): number | null {
  const end = box.left + box.width - 1;
  let gapStart: number | null = null;

  for (let x = box.left; x <= end; x += 1) {
    let inked = false;
    for (let y = box.top; y < box.top + box.height; y += 1) {
      if (alphaAt(image, x, y) > INK) {
        inked = true;
        break;
      }
    }

    if (inked) {
      if (gapStart !== null && x - gapStart >= LOCKUP_GAP) return gapStart - 1;
      gapStart = null;
    } else if (gapStart === null) {
      gapStart = x;
    }
  }

  return null;
}

/** The cropped lockup, which the link card is composed from once it exists. */
async function logo(path: string): Promise<Buffer> {
  const image = await pixels(path);
  const box = inkBox(image);
  const split = markRightEdge(image, box);

  const lockup = await sharp(path)
    .extract(box)
    .resize({ height: LOCKUP_HEIGHT })
    .png({ compressionLevel: 9 })
    .toBuffer();
  emit("logo.png", lockup);
  console.log(
    `logo.png    lockup ${box.width}x${box.height} from ${image.width}x${image.height}, ` +
      `emitted ${LOCKUP_HEIGHT}px tall`,
  );

  if (split === null) {
    console.log("mark.png    skipped: no gap in the source wide enough to be a lockup gap");
    return lockup;
  }

  // The mark's own vertical extent, not the lockup's: the wordmark's descenders and the
  // mark's flourish do not start and stop in the same places.
  const mark = inkBox(image, { from: box.left, to: split });
  const cut = await sharp(path)
    .extract(mark)
    .resize({ height: MARK_HEIGHT })
    .png({ compressionLevel: 9 })
    .toBuffer();
  emit("mark.png", cut);
  console.log(
    `mark.png    ${mark.width}x${mark.height} split at x=${split}, emitted ${MARK_HEIGHT}px tall`,
  );

  await icon(cut);
  return lockup;
}

/**
 * The tab icon.
 *
 * On a filled plate rather than transparent, because the mark is white: on transparency it
 * disappears into every light-themed tab strip and bookmark bar there is. The plate is the
 * page's own background colour, so the favicon and the page agree.
 */
async function icon(mark: Buffer): Promise<void> {
  const overlay = await sharp(mark)
    .resize({ height: Math.round(ICON * 0.62), fit: "inside" })
    .png()
    .toBuffer();

  const plate = await sharp({
    create: { width: ICON, height: ICON, channels: 4, background: VOID },
  })
    .composite([{ input: overlay, gravity: "centre" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  emit("favicon.png", plate);

  console.log(`favicon.png ${ICON}x${ICON} on ${VOID}`);
}

async function background(path: string): Promise<void> {
  const image = sharp(path).rotate();
  const { width, height } = await image.metadata();

  const shipped = await image
    .resize({ width: BACKGROUND_WIDTH, withoutEnlargement: true })
    .blur(BACKGROUND_BLUR)
    // Progressive, so a slow connection paints the whole picture roughly rather than the
    // top third of it exactly. On an image this blurred the early pass is indistinguishable.
    .jpeg({ quality: 72, progressive: true, mozjpeg: true })
    .toBuffer();
  emit("bg.jpg", shipped);

  console.log(`bg.jpg      ${width}x${height} resized to ${BACKGROUND_WIDTH}w, blur ${BACKGROUND_BLUR}`);

  // The mean colour becomes the page background, so the paint before the photograph
  // arrives is the photograph's own tone rather than a white flash.
  const { channels } = await sharp(path).resize({ width: 200 }).stats();
  const hex = channels
    .slice(0, 3)
    .map(({ mean }) => Math.round(mean).toString(16).padStart(2, "0"))
    .join("");
  console.log(`            mean colour #${hex} — this is what --void should be`);
}

/**
 * The card a pasted link shows.
 *
 * Background and lockup, no text: text here would be set in whatever font the renderer
 * happens to have, which is never the one the page uses, and a card whose typography is
 * not ours reads as somebody else's link. The title and description come from metadata.
 */
async function openGraph(backgroundPath: string, lockup: Buffer): Promise<void> {
  const overlay = await sharp(lockup).resize({ width: 520 }).png().toBuffer();

  const card = await sharp(backgroundPath)
    .rotate()
    .resize({ ...OG, fit: "cover", position: "centre" })
    .blur(14)
    .modulate({ brightness: 0.9 })
    .composite([{ input: overlay, gravity: "centre" }])
    .jpeg({ quality: 82, progressive: true, mozjpeg: true })
    .toBuffer();
  emit("og.jpg", card);

  console.log(`og.jpg      ${OG.width}x${OG.height}`);
}

async function main(): Promise<void> {
  for (const out of OUTS) mkdirSync(out, { recursive: true });

  const backgroundPath = source("bg.jpg") ?? source("bg.jpeg") ?? source("background.jpg");
  const logoPath = source("logo.png");

  if (backgroundPath === null && logoPath === null) {
    console.error(
      `Nothing to do. Put originals in ${SOURCE} as bg.jpg and logo.png, then run this again.`,
    );
    process.exitCode = 1;
    return;
  }

  const lockup = logoPath === null ? null : await logo(logoPath);
  if (backgroundPath !== null) await background(backgroundPath);
  if (backgroundPath !== null && lockup !== null) {
    await openGraph(backgroundPath, lockup);
  }

  console.log(`\nwritten to ${OUTS.length} destinations:`);
  for (const out of OUTS) console.log(`            ${out}`);
}

await main();
