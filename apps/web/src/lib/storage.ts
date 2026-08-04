/**
 * Where an uploaded token image is put, and what its address will be.
 *
 * ## Why this deployment stores anything at all
 *
 * The protocol does not, and cannot: a token records one string of 256 bytes, which is room
 * for an address and not for a picture. For a long time this interface said so and asked
 * creators for a link, which is correct about the contracts and useless as a control —
 * somebody with a PNG on their desktop and no hosting has no way to answer it, and the
 * honest answer to "where do I put this" cannot be "not my problem".
 *
 * So the interface hosts it, and the distinction that matters is kept: the chain still
 * records an address, this deployment is merely the thing at the other end of it. A token
 * launched through here is not bound to this deployment for anything except its picture,
 * and the picture is content-addressed, so moving it to another host — or pinning it to
 * IPFS later — changes where it is served from and not what it is.
 *
 * ## Drivers
 *
 * Which one is used is decided by what is configured, never by a flag, because a flag can
 * be set to something the environment cannot honour. `durable` is the field that matters
 * downstream: an address only this laptop can answer must not reach a token that will
 * record it forever, and the caller enforces that rather than assuming it.
 */
import { put } from "@vercel/blob";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What the uploaded bytes are allowed to be, and what to call the file. */
const FORMATS = {
  "image/webp": { extension: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
  "image/png": { extension: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { extension: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/gif": { extension: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
} as const;

export type ImageFormat = keyof typeof FORMATS;

/**
 * The ceiling on what the route will store.
 *
 * The browser reduces a photograph to a 512px square before it gets here, which lands
 * under 200kB in every case tried, so this is not a budget but a backstop against a caller
 * that is not the form. Generous enough for an animation, small enough that filling the
 * store takes deliberate effort.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export interface StoredImage {
  /** What goes on chain: an `https://` or `ipfs://` address. */
  readonly uri: string;
  /** Whether that address outlives this process. False for the development store. */
  readonly durable: boolean;
  readonly bytes: number;
}

/**
 * The format the bytes actually are, or `null` if they are not an image this accepts.
 *
 * Read from the leading bytes rather than from the request's `content-type`, which is a
 * claim made by the caller. A store that files whatever it is told is a store that can be
 * made to serve an HTML document from an image URL.
 */
export function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  for (const [type, { magic }] of Object.entries(FORMATS)) {
    if (magic.every((byte, index) => bytes[index] === byte)) return type as ImageFormat;
  }
  return null;
}

/**
 * Stores the bytes and returns the address they can be read at.
 *
 * The name is the SHA-256 of the content, so uploading the same picture twice writes the
 * same object twice rather than accumulating copies, and no part of the creator's file name
 * — which is theirs, and occasionally revealing — ends up in a public URL.
 */
export async function storeImage(
  bytes: Uint8Array,
  format: ImageFormat,
): Promise<StoredImage> {
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const name = `tokens/${digest}.${FORMATS[format].extension}`;

  if (process.env["BLOB_READ_WRITE_TOKEN"] !== undefined) {
    const blob = await put(name, bytes as unknown as Blob, {
      access: "public",
      contentType: format,
      // The digest is already in the name, so a suffix would only make the same picture
      // land at a new address on every upload.
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return { uri: blob.url, durable: true, bytes: bytes.byteLength };
  }

  // Nothing is configured, which is the ordinary state of a clone of this repository. The
  // upload works so the form can be used, and says it is not durable so that the launch
  // path can refuse it: a `localhost` address recorded in a token is a picture that was
  // never going to load for anybody, including its creator tomorrow.
  const directory = join(process.cwd(), ".uploads");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${digest}.${FORMATS[format].extension}`), bytes);

  return {
    uri: `/api/image/${digest}.${FORMATS[format].extension}`,
    durable: false,
    bytes: bytes.byteLength,
  };
}

/** Where the development driver keeps its files, for the route that serves them back. */
export function developmentImagePath(name: string): string {
  return join(process.cwd(), ".uploads", name);
}

export function extensionFormat(name: string): ImageFormat | null {
  const extension = name.split(".").pop()?.toLowerCase();
  for (const [type, format] of Object.entries(FORMATS)) {
    if (format.extension === extension) return type as ImageFormat;
  }
  return null;
}
