import "server-only";

/**
 * Instant markets, read from the chain.
 *
 * The programmable half of the catalogue is read from build jobs on disk, because a build
 * is where a programmable market comes from and most builds are never launched. An Instant
 * market has no build. It is created in one transaction and the only record of it is the
 * registry row that transaction wrote, so this module is the whole source: there is
 * nothing local to join against and nothing to say about an Instant market before it
 * exists on chain.
 *
 * ## Its own registry, and why
 *
 * `MarketRegistry.writer` is immutable and Verdant's names Verdant's factory, so Instant
 * deploys a second one and `InstantFactory` writes there. It is the same contract, which
 * is why the SDK's `readMarketRecord` and `readMarketPage` work here unchanged — they take
 * the registry's address as an argument for exactly this reason.
 *
 * ## Three fields the registry does not mean what it says
 *
 * `creatorBps` and `protocolBps` are zero on every Instant row, on purpose, and nothing
 * here reads them: 1.00% and 0.50% of a 1.50% fee are two thirds and one third, and one
 * third is not a whole number of basis points. `InstantFees` is the authority. `splitter`
 * is read, and it holds the market's `InstantFeeVault` — the field is named for the job
 * rather than the contract. See ADR-014.
 *
 * ## The description, the picture and the links
 *
 * None of them are on chain. The token carries one 256-byte string, `metadataURI`, and it
 * points at a JSON document Agen served at launch; the picture and the creator's accounts
 * are fields inside it. That document is fetched here and every failure to read it is
 * absorbed — a market whose metadata host is down is still a market with a price, and a
 * page that 500s because a description could not be fetched would be trading availability
 * for a paragraph.
 */

import { agen, markets as marketReads, pool } from "@verdant/sdk";
import type { Address, Hex } from "viem";
import { getAddress, isAddress } from "viem";

import { EXTERNAL, INSTANT_ADDRESSES } from "./chain";
import { publicClient } from "./onchain";

/** How long a metadata document is trusted. It is content-addressed, so this is generous. */
const METADATA_TTL_MS = 5 * 60 * 1000;

/** What the creator said about their token, if it could be read. */
export interface InstantMetadata {
  readonly description: string;
  readonly image: string | null;
  readonly links: {
    readonly x?: string;
    readonly website?: string;
    readonly telegram?: string;
  };
}

/** One Instant market, joined from the registry, the token, the pool and the document. */
export interface InstantMarket {
  readonly token: Address;
  readonly poolId: Hex;
  readonly creator: Address;
  readonly createdAt: number;
  /** The `InstantFeeVault`, from the registry's `splitter` field. */
  readonly vault: Address;
  readonly name: string;
  readonly symbol: string;
  /** Whole tokens. A billion, for every Instant market. */
  readonly supplyTokens: number;
  readonly lpFee: number;
  /** Quote asset per whole token, at the block this was read. */
  readonly price: number;
  readonly liquidity: bigint;
  readonly sqrtPriceX96: bigint;
  readonly metadata: InstantMetadata;
}

const EMPTY_METADATA: InstantMetadata = { description: "", image: null, links: {} };

/**
 * Fetched documents, kept for a few minutes.
 *
 * Module scope, which is per server process and is the right scope: the document is
 * content-addressed and immutable — `metadataMutable` is false on every Instant token, so
 * nothing can ever repoint the URI — and without this every render of the catalogue would
 * fetch one document per market.
 */
const documents = new Map<string, { readonly at: number; readonly value: InstantMetadata }>();

/**
 * A metadata document, or the empty one.
 *
 * Every field is copied out by name and bounded, exactly as `storeMetadata` does on the
 * way in. The URI is written into the token at creation and cannot be changed, but it is
 * still a URL a creator chose, so what comes back is somebody's JSON and is treated as
 * such rather than spread into the model.
 */
export async function readMetadataDocument(uri: string): Promise<InstantMetadata> {
  const trimmed = uri.trim();
  if (trimmed === "" || !/^https?:\/\//i.test(trimmed)) return EMPTY_METADATA;

  const cached = documents.get(trimmed);
  if (cached !== undefined && Date.now() - cached.at < METADATA_TTL_MS) return cached.value;

  try {
    // Bounded, because this is an outbound request to an address the creator chose and a
    // page render is waiting on it.
    const response = await fetch(trimmed, {
      signal: AbortSignal.timeout(4_000),
      cache: "no-store",
    });
    if (!response.ok) return EMPTY_METADATA;

    const raw: unknown = await response.json();
    if (typeof raw !== "object" || raw === null) return EMPTY_METADATA;

    const record = raw as Record<string, unknown>;
    const text = (value: unknown, max: number): string =>
      typeof value === "string" ? value.trim().slice(0, max) : "";

    const link = (value: unknown): string | undefined => {
      const found = text(value, 256);
      return found === "" || !/^https?:\/\//i.test(found) ? undefined : found;
    };

    const rawLinks =
      typeof record.links === "object" && record.links !== null
        ? (record.links as Record<string, unknown>)
        : {};

    const image = text(record.image, 512);
    const x = link(rawLinks.x);
    const website = link(rawLinks.website);
    const telegram = link(rawLinks.telegram);

    const value: InstantMetadata = {
      description: text(record.description, 1_000),
      image: /^https?:\/\//i.test(image) ? image : null,
      links: {
        ...(x === undefined ? {} : { x }),
        ...(website === undefined ? {} : { website }),
        ...(telegram === undefined ? {} : { telegram }),
      },
    };

    documents.set(trimmed, { at: Date.now(), value });
    return value;
  } catch {
    return EMPTY_METADATA;
  }
}

/** The two addresses every read here needs, or null when Instant is not deployed. */
function addresses(): { readonly hook: Address; readonly marketRegistry: Address } | null {
  if (INSTANT_ADDRESSES === null) return null;
  return { hook: INSTANT_ADDRESSES.hook, marketRegistry: INSTANT_ADDRESSES.registry };
}

/**
 * A registry record joined with its token, its pool and its document.
 *
 * The pool key is derived rather than recovered. A programmable market's fee is one of
 * several a build may choose, so `resolveAgenPoolKey` has to hash candidates until one
 * matches the recorded id; Instant has exactly one shape — ether against the token, the
 * dynamic-fee flag, the shared hook — so the key is a function of the token alone. It is
 * still checked against the recorded pool id, because a key that does not hash to a real
 * pool would quote into the dark rather than fail.
 */
async function join(record: marketReads.MarketRecord): Promise<InstantMarket | null> {
  const found = addresses();
  if (found === null) return null;

  const key = marketReads.poolKeyOf(record, found.hook);
  if (pool.poolIdOf(key) !== record.poolId) return null;

  const [token, state] = await Promise.all([
    marketReads.readToken(publicClient(), record.token),
    agen.readPoolState(publicClient(), EXTERNAL.stateView, record.poolId),
  ]);

  const metadata = await readMetadataDocument(token.metadataURI);

  return {
    token: record.token,
    poolId: record.poolId,
    creator: record.creator,
    createdAt: record.createdAt,
    vault: record.splitter,
    name: token.name,
    symbol: token.symbol,
    supplyTokens: Number(token.totalSupply / 10n ** BigInt(token.decimals)),
    lpFee: key.fee,
    price: agen.priceFromSqrt(state.sqrtPriceX96),
    liquidity: state.liquidity,
    sqrtPriceX96: state.sqrtPriceX96,
    metadata,
  };
}

/**
 * One Instant market by its token address.
 *
 * `null` covers every way this can come to nothing — Instant is not deployed here, the
 * address is not one of its markets, the chain did not answer — because a caller would
 * render the same thing for all three.
 */
export async function readInstantMarket(token: string): Promise<InstantMarket | null> {
  const found = addresses();
  if (found === null || !isAddress(token)) return null;

  try {
    const record = await marketReads.readMarketRecord(publicClient(), found, {
      token: getAddress(token),
    });
    return await join(record);
  } catch {
    // `marketByToken` reverts on a token the registry does not know, which is the
    // ordinary case for any address somebody types into the URL.
    return null;
  }
}

/** Every Instant market, newest first. Empty when Instant is not deployed. */
export async function readInstantMarkets(limit = 50): Promise<readonly InstantMarket[]> {
  const found = addresses();
  if (found === null) return [];

  try {
    const records = await marketReads.readMarketPage(publicClient(), found, { limit });
    const joined = await Promise.all(records.map(async (record) => join(record)));
    return joined.filter((market): market is InstantMarket => market !== null);
  } catch {
    return [];
  }
}
