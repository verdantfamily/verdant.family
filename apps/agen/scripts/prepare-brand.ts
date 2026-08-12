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

/**
 * The card's backdrop.
 *
 * The same two soft masses and the same vignette as the page, because a link card that is
 * flat black next to a page that is lit reads as a different product. Gradients rather
 * than a blurred bitmap: librsvg resolves these at full resolution, and there is no
 * banding to hide at 1200 x 630.
 */
const CARD_BACKDROP = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="mass-a">
      <stop offset="0%" stop-color="#e4e6ec" stop-opacity="0.17"/>
      <stop offset="42%" stop-color="#969ca8" stop-opacity="0.08"/>
      <stop offset="70%" stop-color="#1e2026" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="mass-b">
      <stop offset="0%" stop-color="#d6cec6" stop-opacity="0.12"/>
      <stop offset="45%" stop-color="#7e7a78" stop-opacity="0.06"/>
      <stop offset="72%" stop-color="#18181a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0.35">
      <stop offset="34%" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity="0.035"/>
      <stop offset="66%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.46" r="0.78">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="66%" stop-color="#000000" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="1"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="#000000"/>
  <ellipse cx="205" cy="120" rx="690" ry="560" fill="url(#mass-a)"/>
  <ellipse cx="1010" cy="560" rx="560" ry="470" fill="url(#mass-b)"/>
  <rect width="1200" height="630" fill="url(#sheen)"/>
  <!-- On the rect, not an ellipse: a gradient that stops short of the corners leaves the
       masses lighting them, which is the one place a card must not be brighter. -->
  <rect width="1200" height="630" fill="url(#vignette)"/>
</svg>`;

/**
 * Set in Helvetica rather than the page's own face because this is rendered by sharp on
 * whatever machine runs the script, and a webfont is not available to it. The card is a
 * still frame of the page, not the page.
 */
const CARD_TEXT = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="32%" stop-color="#b9bcc4"/>
      <stop offset="46%" stop-color="#fdfdfe"/>
      <stop offset="54%" stop-color="#7e828c"/>
      <stop offset="78%" stop-color="#d8dae0"/>
      <stop offset="100%" stop-color="#9a9ea8"/>
    </linearGradient>
  </defs>
  <g font-family="Helvetica Neue, Helvetica, Arial, sans-serif" text-anchor="middle">
    <text x="600" y="428" fill="#f4f4f5" font-size="56" font-weight="500"
          letter-spacing="-1.8">the operator is gone.</text>
    <text x="600" y="478" fill="url(#chrome)" font-size="33"
          letter-spacing="-0.9">the system is still running.</text>
    <text x="600" y="546" fill="#4a4a50" font-size="21"
          letter-spacing="0.4">the agentic launchpad — coming august 12</text>
  </g>
</svg>`;

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

  // The card a pasted link shows. Composited here rather than rendered at request time
  // because this site is a static export and has no server to render one.
  const mark = await sharp(cutout)
    .resize({ width: 190, height: 190, fit: "contain", background: "#00000000" })
    .toBuffer();

  await sharp(Buffer.from(CARD_BACKDROP))
    .composite([
      { input: mark, top: 150, left: 505 },
      { input: Buffer.from(CARD_TEXT), top: 0, left: 0 },
    ])
    // 4:4:4 because the type is thin and light on black, and the chroma averaging JPEG
    // does by default is exactly the thing that turns that into coloured fringing.
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toFile(resolve(publicDir, "og.jpg"));

  console.log("wrote mark.png, icon.png, apple-icon.png, favicon.ico, og.jpg");
}

await main();
