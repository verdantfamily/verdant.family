import "server-only";

/**
 * The document a token's `metadataURI` points at.
 *
 * A token carries one string of at most 256 bytes, and Instant now collects more than
 * one thing to say: a picture, a description, and up to three links. Putting the picture
 * in that slot — which is what this did first — meant the description and the links were
 * collected and then dropped, since nothing else in Agen stores anything about a market
 * created through `VerdantFactory`.
 *
 * So the slot holds a URL to a small JSON document instead, and the picture is one field
 * inside it. That is the ordinary shape for token metadata and it is what a wallet or an
 * explorer will already try to read.
 *
 * ## Content-addressed, like the images beside it
 *
 * The name is the hash of the bytes, so the URL is immutable and can be cached forever.
 * That matters more here than for an image: this address is written into the token at
 * creation with `metadataMutable` false, so nothing can ever repoint it. A mutable URL
 * in that slot would be a promise the interface could break later.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { GENERATED_ROOT } from "./builds";

const METADATA_ROOT = resolve(GENERATED_ROOT, "_metadata");

/** Generous for a description and three links, and far too small to be a file host. */
const MAX_BYTES = 16 * 1024;

export class MetadataError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "MetadataError";
    this.status = status;
  }
}

export interface TokenMetadata {
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  /** An absolute URL. The picture is required by the Instant form. */
  readonly image: string;
  readonly links: {
    readonly x?: string;
    readonly website?: string;
    readonly telegram?: string;
  };
}

/**
 * Rebuilt field by field rather than stored as given.
 *
 * Whatever the browser posted is somebody's input, and this document is served back from
 * Agen's own origin. Copying only the fields this shape declares, each one a trimmed
 * string with a bound, is what stops the slot becoming a place to park arbitrary JSON.
 */
function clean(input: unknown): TokenMetadata {
  if (typeof input !== "object" || input === null) {
    throw new MetadataError("That is not a metadata document.");
  }

  const raw = input as Record<string, unknown>;
  const text = (value: unknown, max: number): string =>
    typeof value === "string" ? value.trim().slice(0, max) : "";

  const name = text(raw.name, 64);
  const symbol = text(raw.symbol, 16);
  const image = text(raw.image, 512);

  if (name === "" || symbol === "") throw new MetadataError("A token needs a name and a ticker.");
  if (!/^https?:\/\//i.test(image)) {
    throw new MetadataError("A token's picture needs a public address.");
  }

  const rawLinks =
    typeof raw.links === "object" && raw.links !== null
      ? (raw.links as Record<string, unknown>)
      : {};

  const link = (value: unknown): string | undefined => {
    const found = text(value, 256);
    return found === "" || !/^https?:\/\//i.test(found) ? undefined : found;
  };

  const x = link(rawLinks.x);
  const website = link(rawLinks.website);
  const telegram = link(rawLinks.telegram);

  return {
    name,
    symbol,
    description: text(raw.description, 1_000),
    image,
    links: {
      ...(x === undefined ? {} : { x }),
      ...(website === undefined ? {} : { website }),
      ...(telegram === undefined ? {} : { telegram }),
    },
  };
}

export interface StoredMetadata {
  /** The path the launch writes into the token. Stable forever. */
  readonly url: string;
}

export async function storeMetadata(input: unknown): Promise<StoredMetadata> {
  const document = clean(input);
  const bytes = new TextEncoder().encode(JSON.stringify(document));

  if (bytes.byteLength > MAX_BYTES) throw new MetadataError("That description is too long.");

  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const name = `${digest}.json`;

  await mkdir(METADATA_ROOT, { recursive: true });
  await writeFile(resolve(METADATA_ROOT, name), bytes);

  return { url: `/api/metadata/${name}` };
}

/**
 * Read one back.
 *
 * The name is validated against the shape this module writes rather than sanitised: a
 * name that is not thirty-two hex characters and `.json` is not a file this created, so
 * there is nothing to serve and no path to traverse.
 */
export async function readMetadata(name: string): Promise<string | null> {
  if (!/^[0-9a-f]{32}\.json$/.test(name)) return null;
  return readFile(resolve(METADATA_ROOT, name), "utf8").catch(() => null);
}
