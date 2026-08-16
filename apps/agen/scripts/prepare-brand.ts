#!/usr/bin/env node
/**
 * Cuts the shipped brand files out of the mark artwork.
 *
 * The source is the chrome mark on a black field, and the job is to get rid of the field
 * without getting rid of the artwork's own black — which it has a lot of, as outlines
 * and as the shadow inside the curl of the shape. A plain "make black transparent" pass
 * punches holes straight through the middle of the object.
 *
 * So the field is removed by flooding inwards from the edges instead: darkness that can
 * be reached from outside is background, darkness enclosed by the object is the object.
 *
 * The page used to sidestep this by keeping the black and compositing with
 * `mix-blend-mode: screen`, under which black is nothing. That worked until it did not:
 * blending only reaches as far as the nearest ancestor that creates a stacking context,
 * and the composition is moved by the pointer parallax, which creates one. The mark was
 * therefore blending against the empty group it sits in rather than against the page, so
 * its black field painted as solid black — invisible over the black page, and a visible
 * dark rectangle as soon as the drifting light behind it reached the middle of a wide
 * viewport. Real transparency has no such dependency on what happens to be above it.
 *
 * Trimming matters for a duller reason: an untrimmed square means the mark's optical size
 * depends on however much padding the export happened to have.
 *
 * Usage: pnpm --filter @verdant/agen brand
 */

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../public");
// Kept out of `public/` so the export does not also ship the artwork it was cut from,
// and committed rather than ignored — unlike the landing page's originals this is 37 kB,
// and it is the only copy, so ignoring it would make this script unrunnable by anyone
// who did not happen to have the file.
const source = resolve(here, "../brand-source/mark.png");

/** Anything this dark is the field, not the object. */
const TRIM_THRESHOLD = 12;

/**
 * How dark a pixel must be for the flood to pass through it.
 *
 * Higher than the trim threshold on purpose. Trimming only has to find rows that are
 * entirely empty, whereas this has to cross the faint compression noise around the
 * object without eating into the object's own dark edge, and stopping too early would
 * leave a halo of not-quite-black in the shape of a rectangle.
 */
const KEY_THRESHOLD = 26;

/**
 * Removes the background by flooding inwards from the border.
 *
 * A four-way flood fill over the dark pixels, seeded from every edge pixel. Anything the
 * flood reaches is background and becomes transparent; anything dark that it cannot
 * reach is enclosed by the artwork and is left alone, which is what keeps the outlines
 * and the shadow in the curl of the shape.
 *
 * The queue is a plain array used as a ring, and pixels are marked as they are enqueued
 * rather than as they are dequeued — without that, a pixel can be queued once per
 * neighbour and the fill degenerates badly on a large flat field.
 *
 * Edges are left as they are rather than feathered. What remains around the object is a
 * ring of half-lit anti-aliasing from the original export, and against a black page that
 * is invisible; softening it further would only blur the mark.
 */
function keyOutBackground(
  pixels: Buffer,
  width: number,
  height: number,
): Buffer {
  const count = width * height;
  const seen = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;

  const isDark = (index: number): boolean => {
    const at = index * 4;
    // Unweighted, deliberately: this is asking "is anything here", not "how bright does
    // this look", and a green-weighted luminance would let dark blues through.
    return (
      pixels[at]! <= KEY_THRESHOLD &&
      pixels[at + 1]! <= KEY_THRESHOLD &&
      pixels[at + 2]! <= KEY_THRESHOLD
    );
  };

  const seed = (index: number): void => {
    if (seen[index] === 1 || !isDark(index)) return;
    seen[index] = 1;
    queue[tail++] = index;
  };

  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }

  while (head < tail) {
    const index = queue[head++]!;
    const x = index % width;
    const y = (index / width) | 0;

    if (x > 0) seed(index - 1);
    if (x < width - 1) seed(index + 1);
    if (y > 0) seed(index - width);
    if (y < height - 1) seed(index + width);
  }

  for (let index = 0; index < count; index++) {
    if (seen[index] === 1) pixels[index * 4 + 3] = 0;
  }

  return pixels;
}

/**
 * Packs PNGs into an `.ico`.
 *
 * `favicon.ico` is still worth shipping even though every browser in use understands the
 * `<link rel="icon">` PNG: crawlers, chat clients and link unfurlers frequently skip the
 * markup and request the well-known path directly, and a 404 there is the difference
 * between a mark and a blank square in someone's bookmarks bar.
 *
 * The container is written by hand rather than pulled from a package because it is a
 * six-byte header and a sixteen-byte record per image, and because the payload is allowed
 * to be a PNG rather than the format's original bitmap — everything since IE11 reads that,
 * and it saves encoding BMP with its upside-down rows and its second, redundant alpha
 * mask.
 */
function packIco(images: readonly { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;

  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    // 256 is stored as zero: the field is one byte and the format predates the need.
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size, meaningless for truecolour
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

async function main(): Promise<void> {
  const flat = await sharp(source)
    .trim({ background: "#000000", threshold: TRIM_THRESHOLD })
    .toBuffer();

  const { data, info } = await sharp(flat)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;

  const cut = keyOutBackground(data, width, height);
  const cutout = await sharp(cut, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();

  const kept = cut.reduce(
    (total, value, index) => (index % 4 === 3 && value !== 0 ? total + 1 : total),
    0,
  );
  console.log(
    `trimmed to ${width} x ${height}, kept ${Math.round(
      (kept / (width * height)) * 100,
    )}% opaque`,
  );

  // 512 is twice the largest size the mark is ever drawn at, which is what a retina
  // display needs and the most it can use. Padded with nothing rather than with black —
  // the entire point of the pass above.
  await sharp(cutout)
    .resize({ width: 512, height: 512, fit: "contain", background: "#00000000" })
    .png({ compressionLevel: 9 })
    .toFile(resolve(publicDir, "mark.png"));

  // Every icon does need its own plate: the mark is light grey, and light grey on
  // transparency vanishes in a light tab strip. The inset is a quarter of the canvas,
  // which is roughly what a home-screen icon needs to not look pinned to its own corners.
  const plated = async (size: number): Promise<Buffer> => {
    // Tab-strip sizes get almost none of it. A 16 px icon has no room to spare, and
    // margin that reads as composure at 512 px reads as a shrunken mark at 16.
    const inner = Math.round(size * (size >= 64 ? 0.72 : 0.88));

    const scaled = await sharp(cutout)
      .resize({ width: inner, height: inner, fit: "contain", background: "#00000000" })
      .toBuffer();

    // Drawn onto an opaque square rather than padded with black, which is not the same
    // thing: `background` fills only the margin a resize adds, leaving the transparency
    // the keying pass cut out of the artwork still transparent underneath. Compositing
    // also fixes the size exactly, where padding a rounded half-pixel gives 513.
    return sharp({
      create: { width: size, height: size, channels: 3, background: "#000000" },
    })
      .composite([{ input: scaled, gravity: "centre" }])
      .png({ compressionLevel: 9 })
      .toBuffer();
  };

  await sharp(await plated(512)).toFile(resolve(publicDir, "icon.png"));
  // 180 is the size iOS asks for; anything else is resampled by the phone.
  await sharp(await plated(180)).toFile(resolve(publicDir, "apple-icon.png"));

  const ico = packIco(
    await Promise.all(
      [16, 32, 48].map(async (size) => ({ size, png: await plated(size) })),
    ),
  );
  await writeFile(resolve(publicDir, "favicon.ico"), ico);

  // The share card is deliberately not written here. It used to be — composited onto this
  // script's own black backdrop, set in Helvetica because sharp reads fonts from the system
  // and not from `public/fonts`, and cache-busted by hand with a `?v=` counter in the
  // layout. It outlived its own copy by weeks as a result, still announcing a launch date
  // that had passed, because a file nothing regenerates is a file nobody notices. It is now
  // `src/app/opengraph-image.tsx`, rendered per request in the real typeface.
  console.log("wrote mark.png, icon.png, apple-icon.png, favicon.ico");
}

await main();
