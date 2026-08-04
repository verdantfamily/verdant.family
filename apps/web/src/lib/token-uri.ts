/**
 * Reading a token's `metadataURI`, which is one string used three ways.
 *
 * The chain stores at most 256 bytes, so a description, a picture and a set of links
 * cannot live on it — only a location can. Creators point that location at an image, at a
 * JSON document describing the token, or at nothing at all, and all three are valid: a
 * form that demanded `token.json` would cost every creator who has a PNG and no hosting.
 *
 * ## This never runs on the server
 *
 * Everything here resolves an address a stranger put on chain. Fetching one from a server
 * component would mean this deployment issuing requests to whatever URL a creator chose —
 * an internal address, a metadata endpoint, something that never answers — which is a far
 * worse failure than a picture that does not load. So the fetch belongs in the browser,
 * where the request is the reader's own and the worst case is a link that stays blank.
 */

/**
 * A gateway for `ipfs://`, because a browser has no way to fetch one.
 *
 * Named here rather than buried so that the compromise is visible: resolving through
 * somebody's HTTP gateway is a third party in the loop for display only. The chain records
 * the `ipfs://` address the creator typed, this is not stored anywhere, and a token whose
 * gateway is down falls back to its plate rather than to an error.
 */
export const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

export function resolveUri(uri: string): string {
  return uri.startsWith("ipfs://") ? IPFS_GATEWAY + uri.slice("ipfs://".length) : uri;
}

/** An `https:` or `ipfs:` address a browser can put in an `img`, or `null` for a document. */
export function directImage(uri: string): string | null {
  const withoutQuery = uri.split(/[?#]/)[0] ?? uri;
  if (/\.json$/i.test(withoutQuery)) return null;
  if (!/^(https?|ipfs):/i.test(uri)) return null;
  return resolveUri(uri);
}

/**
 * What a token's document says about itself, once the untrusted parts are thrown away.
 *
 * The shape is the one `metadataDocument` in `launch.ts` writes, but nothing enforces that
 * a creator used this interface to make it — the URI is whatever they put on chain. So
 * every field is checked rather than cast, and anything that is not a string of sensible
 * length is dropped. A document that is an array, a number, or somebody's unrelated API
 * response parses to a record of nothing rather than throwing.
 */
export interface TokenDocument {
  readonly description: string | null;
  readonly website: string | null;
  readonly x: string | null;
  readonly telegram: string | null;
}

export const EMPTY_DOCUMENT: TokenDocument = {
  description: null,
  website: null,
  x: null,
  telegram: null,
};

/** Long enough for a real paragraph, short enough that nobody can push the page over. */
const MAX_DESCRIPTION = 600;

export function parseTokenDocument(value: unknown): TokenDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return EMPTY_DOCUMENT;
  }

  const document = value as Record<string, unknown>;
  const links =
    typeof document["links"] === "object" && document["links"] !== null
      ? (document["links"] as Record<string, unknown>)
      : {};

  const description = text(document["description"], MAX_DESCRIPTION);

  return {
    description,
    // Only `http(s)`. A creator's link is rendered as an anchor a reader will click, and
    // `javascript:` in an `href` is the oldest way there is to turn somebody else's page
    // into your own. `mailto:` and the rest are refused for the same reason: this renders
    // what it recognises and nothing else.
    website: httpUrl(links["website"]),
    x: httpUrl(links["x"]) ?? httpUrl(links["twitter"]),
    telegram: httpUrl(links["telegram"]),
  };
}

function text(value: unknown, most: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > most ? `${trimmed.slice(0, most).trimEnd()}…` : trimmed;
}

function httpUrl(value: unknown): string | null {
  const trimmed = text(value, 400);
  if (trimmed === null) return null;

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}
