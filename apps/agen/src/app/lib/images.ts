import "server-only";

/**
 * Where a token's picture lives.
 *
 * On the same volume as the build jobs, which is the whole reason this can exist at all:
 * the create screen used to say "you can add a picture once your token is live" and show
 * a placeholder, because nothing stored an image and a control that accepts a file and
 * drops it is worse than no control. There is a disk here — Railway mounts it at
 * `/app/generated` and the builds have been using it all along with under a gigabyte in
 * fifty — so the honest fix was to use it rather than to add a service.
 *
 * ## Content-addressed, and why that matters here
 *
 * A file's name is the hash of its bytes. Two creators uploading the same picture write
 * it once; a creator who uploads, changes their mind and uploads again leaves the first
 * one orphaned rather than overwriting something another market is pointing at. It also
 * means the URL is immutable, so it can be cached forever by anything downstream — which
 * matters because this address is written into a token's metadata at launch and is then
 * fixed for the life of the market.
 *
 * ## What this deliberately does not do
 *
 * No resizing, no re-encoding, no format conversion. Those want a real image pipeline and
 * this is a few hundred kilobytes on a disk; a half-implemented one that silently
 * degrades a creator's artwork would be worse than none. The bound below is what stops it
 * becoming a file host.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { GENERATED_ROOT } from "./builds";

const IMAGES_ROOT = resolve(GENERATED_ROOT, "_images");

/**
 * What may be uploaded.
 *
 * A closed list rather than a check on the declared content type, because the browser's
 * claim about a file is the uploader's claim about it. Each entry is checked against the
 * bytes as well; see `sniff`.
 *
 * SVG is absent on purpose and it is the one worth explaining: an SVG is a document that
 * can carry script, so serving one from this origin would be serving somebody else's
 * JavaScript from Agen's domain. Every other format here is inert.
 */
const KINDS: readonly { readonly ext: string; readonly mime: string; readonly magic: readonly number[] }[] = [
  { ext: "png", mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: "jpg", mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { ext: "gif", mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
  // RIFF....WEBP — the second four bytes are a length, so only the outer marks are fixed.
  { ext: "webp", mime: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] },
];

/** Two megabytes. A token logo that needs more than this is not a logo. */
export const MAX_BYTES = 2 * 1024 * 1024;

export class ImageError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ImageError";
    this.status = status;
  }
}

/**
 * What these bytes actually are, regardless of what they were called.
 *
 * A file named `.png` whose contents are something else is either a mistake or an
 * attempt, and both end the same way: refused. The extension the browser sent is never
 * read.
 */
function sniff(bytes: Uint8Array): (typeof KINDS)[number] {
  for (const kind of KINDS) {
    const matches = kind.magic.every((byte, at) => bytes[at] === byte);
    if (!matches) continue;

    // RIFF is a container, not a format. Confirm the payload actually says WEBP before
    // accepting it, or an AVI would pass as an image.
    if (kind.ext === "webp") {
      const tag = String.fromCharCode(...bytes.slice(8, 12));
      if (tag !== "WEBP") continue;
    }

    return kind;
  }

  throw new ImageError("That file is not a PNG, JPEG, GIF or WebP.");
}

export interface StoredImage {
  /** The path the interface uses and the launch records. Stable forever. */
  readonly url: string;
  readonly bytes: number;
}

/** Write an upload to the volume and return where to find it. */
export async function storeImage(data: ArrayBuffer): Promise<StoredImage> {
  if (data.byteLength === 0) throw new ImageError("That file is empty.");
  if (data.byteLength > MAX_BYTES) {
    throw new ImageError(
      `That image is ${(data.byteLength / 1024 / 1024).toFixed(1)}MB. The limit is 2MB.`,
    );
  }

  const bytes = new Uint8Array(data);
  const kind = sniff(bytes);

  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const name = `${digest}.${kind.ext}`;

  await mkdir(IMAGES_ROOT, { recursive: true });
  await writeFile(resolve(IMAGES_ROOT, name), bytes);

  return { url: `/api/images/${name}`, bytes: data.byteLength };
}

export interface ServedImage {
  readonly body: Uint8Array;
  readonly mime: string;
}

/**
 * Read one back.
 *
 * The name is validated against the shape this module writes rather than sanitised,
 * which is the difference between a check and a hope: a name that is not thirty-two hex
 * characters and a known extension is not a file this ever created, so there is nothing
 * to serve and no path to traverse.
 */
export async function readImage(name: string): Promise<ServedImage | null> {
  const match = /^([0-9a-f]{32})\.(png|jpg|gif|webp)$/.exec(name);
  if (match === null) return null;

  const kind = KINDS.find((candidate) => candidate.ext === match[2]);
  if (kind === undefined) return null;

  const body = await readFile(resolve(IMAGES_ROOT, name)).catch(() => null);
  if (body === null) return null;

  return { body: new Uint8Array(body), mime: kind.mime };
}
