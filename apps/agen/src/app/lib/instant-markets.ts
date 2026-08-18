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

import { GENERATED_ROOT } from "./builds";
import { EXTERNAL, INSTANT_ADDRESSES } from "./chain";
import { fetchInstantMarketList, type InstantMarketRow } from "./instant-feed";
import { readMetadata } from "./metadata";
import { publicClient } from "./onchain";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";

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
 * Our own document, if this URI is one.
 *
 * Instant writes `https://agen.space/api/metadata/<hash>.json` into the token, and those
 * bytes live on this process's volume. Reading the file is a `readFile`; fetching the URL
 * is a request to ourselves while a catalogue render is already occupying the replica.
 * The file is the same document the route would serve.
 */
function ownMetadataName(uri: string): string | null {
  try {
    const path = new URL(uri).pathname;
    const match = /^\/api\/metadata\/([0-9a-f]{32}\.json)$/.exec(path);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function parseMetadata(raw: unknown): InstantMetadata {
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

  return {
    description: text(record.description, 1_000),
    image: /^https?:\/\//i.test(image) ? image : null,
    links: {
      ...(x === undefined ? {} : { x }),
      ...(website === undefined ? {} : { website }),
      ...(telegram === undefined ? {} : { telegram }),
    },
  };
}

/**
 * A metadata document, or the empty one.
 *
 * Our own documents are read from disk. Everything else is fetched, bounded, because that
 * is an outbound request to an address the creator chose and a page render is waiting on
 * it. Agen's own origin is never fetched: that is a self-request, and a self-request
 * during a catalogue render is how the tokens vanished once already.
 */
export async function readMetadataDocument(uri: string): Promise<InstantMetadata> {
  const trimmed = uri.trim();
  if (trimmed === "" || !/^https?:\/\//i.test(trimmed)) return EMPTY_METADATA;

  const cached = documents.get(trimmed);
  if (cached !== undefined && Date.now() - cached.at < METADATA_TTL_MS) return cached.value;

  const own = ownMetadataName(trimmed);
  if (own !== null) {
    try {
      const bytes = await readMetadata(own);
      if (bytes === null) return EMPTY_METADATA;
      const value = parseMetadata(JSON.parse(bytes) as unknown);
      documents.set(trimmed, { at: Date.now(), value });
      return value;
    } catch {
      return EMPTY_METADATA;
    }
  }

  try {
    const response = await fetch(trimmed, {
      signal: AbortSignal.timeout(4_000),
      cache: "no-store",
    });
    if (!response.ok) return EMPTY_METADATA;
    const value = parseMetadata(await response.json());
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

/**
 * A feed row turned into a market, or null if it is not one of ours.
 *
 * The feed is trusted for figures and checked for identity. Every field below is something
 * the indexer read from the same events the registry was written by, so there is nothing to
 * verify about a supply or a price that would not amount to reading the chain again. What is
 * worth checking is that the row belongs to the deployment this build talks to: the hook has
 * to be ours, and the token has to hash to the pool id the row claims. A feed pointed at
 * another Instant — a fork, a staging indexer, a stale URL — then contributes nothing to the
 * shelf instead of filling it with markets whose pages would 404 against our registry.
 */
function fromFeedRow(row: InstantMarketRow, hook: Address): InstantMarket | null {
  try {
    if (!isAddress(row.token) || !isAddress(row.hook)) return null;
    if (!isAddress(row.creator) || !isAddress(row.vault)) return null;
    if (getAddress(row.hook) !== hook) return null;

    const token = getAddress(row.token);

    // Instant quotes every market in ether, so the pool key is a function of the token alone.
    if (pool.poolIdFor(pool.NATIVE_CURRENCY, token, hook) !== row.poolId) return null;

    return {
      token,
      poolId: row.poolId as Hex,
      creator: getAddress(row.creator),
      createdAt: row.createdAt,
      vault: getAddress(row.vault),
      name: row.name,
      symbol: row.symbol,
      supplyTokens: Number(row.totalSupply / 10n ** BigInt(row.decimals)),
      lpFee: row.fee,
      price: agen.priceFromSqrt(row.sqrtPriceX96),
      liquidity: row.liquidity,
      sqrtPriceX96: row.sqrtPriceX96,
      metadata: EMPTY_METADATA,
    };
  } catch {
    // One unreadable row is one missing card. It is not an empty shelf.
    return null;
  }
}

/**
 * The shelf as the feed sees it, or null where the feed cannot supply one.
 *
 * Null covers no feed configured, an unreachable one, and one that recognises none of the
 * markets it returned — all three mean the caller should ask the chain instead. It does not
 * cover a feed that is reachable and knows about markets, which is the ordinary case and the
 * one this exists for.
 */
async function marketsFromFeed(
  hook: Address,
  limit: number,
): Promise<readonly InstantMarket[] | null> {
  const rows = await fetchInstantMarketList(limit).catch(() => null);
  if (rows === null) return null;

  const ours = rows.flatMap((row) => {
    const market = fromFeedRow(row, hook);
    return market === null ? [] : [{ market, uri: row.metadataURI }];
  });

  if (ours.length === 0) return null;

  /*
   * Pictures come from the volume, not from a request to this same process.
   *
   * The URI is ours (`/api/metadata/<hash>.json`) and the bytes are already on disk, so
   * this is a `readFile` per market. A missing file is initials on that one card. Nothing
   * here can take the shelf down: each document stands or falls alone.
   */
  return Promise.all(
    ours.map(async ({ market, uri }) => ({
      ...market,
      metadata: await readMetadataDocument(uri).catch(() => EMPTY_METADATA),
    })),
  );
}

/**
 * Every Instant market, newest first. Empty when Instant is not deployed.
 *
 * The feed answers this in one request and the chain answers it in two `eth_call`s per
 * market, which is why the feed is asked first rather than as a cache in front of the
 * authority. At thirty markets the chain route is sixty batched calls for a single render,
 * and the public RPC refuses a batch that size as a whole — one rate-limit object where
 * sixty responses were expected, which is not a market failing to load but every market
 * failing at once.
 *
 * The registry remains the authority for what a market *is*: `readInstantMarket` below still
 * reads it, so a token page, a trade and a launch are unaffected by anything here, and every
 * row the feed offers is checked against the pool id it derives from before it is shown.
 * When there is no feed to ask, the chain still answers — slower, and correct.
 */
export async function readInstantMarkets(limit = 200): Promise<readonly InstantMarket[]> {
  const found = addresses();
  if (found === null) return [];

  const fromFeed = await marketsFromFeed(found.hook, limit);
  if (fromFeed !== null) {
    console.info(`[shelf] feed answered with ${String(fromFeed.length)} market(s)`);
    return remember(fromFeed);
  }

  const fromChain = await marketsFromChain(found, limit);
  if (fromChain.length > 0) {
    console.info(`[shelf] chain answered with ${String(fromChain.length)} market(s)`);
    return remember(fromChain);
  }

  const remembered = await loadRemembered();
  console.warn(
    `[shelf] neither the feed nor the chain answered; serving ${String(remembered.length)} remembered market(s)`,
  );

  return remembered;
}

/**
 * The registry route, degraded per market rather than as a whole.
 *
 * `Promise.all` over the joins is what made this all-or-nothing: one market whose token read
 * was caught in a rate-limited batch rejected the lot, and the caller could not tell that
 * from a chain with no markets on it. Each join now stands or falls alone, so a refusal that
 * lands on three markets costs three cards instead of the catalogue.
 *
 * Empty means the page itself could not be read, which the caller treats as failure rather
 * than as an answer.
 */
async function marketsFromChain(
  found: { readonly hook: Address; readonly marketRegistry: Address },
  limit: number,
): Promise<readonly InstantMarket[]> {
  let records: readonly marketReads.MarketRecord[];

  try {
    records = await marketReads.readMarketPage(publicClient(), found, { limit });
  } catch (error) {
    console.warn(`[shelf] the registry would not answer: ${String(error).slice(0, 200)}`);
    return [];
  }

  const joined = await Promise.all(
    records.map(async (record) => join(record).catch(() => null)),
  );

  const markets = joined.filter((market): market is InstantMarket => market !== null);

  if (markets.length < records.length) {
    console.warn(
      `[shelf] the registry listed ${String(records.length)} market(s) and ${String(markets.length)} could be read`,
    );
  }

  return markets;
}

/**
 * The last shelf that could be read, kept so that a failure cannot look like a deletion.
 *
 * Module scope, which is per server process and is the honest scope for this: it is not a
 * cache — nothing is served from it while reads are working, and it is never consulted to
 * save a request — it is the answer to "what do we do when we know we are wrong".
 *
 * The reasoning that makes this safe rather than stale-by-design: Instant's registry only
 * ever grows. A token, its pool and its vault are deployed, the registry records them, and
 * there is no removal — so a catalogue that held thirty markets cannot legitimately hold
 * none a moment later. An empty read after a non-empty one is therefore not news about the
 * chain, it is a failed read, and answering with the markets we last saw is strictly more
 * truthful than answering with none. Delisting is applied downstream of this, so a market
 * removed from the site does not come back through here.
 *
 * What it deliberately does not do is hide a market that has since been launched: a fresh
 * read that works always replaces this, so the memory is only ever consulted on the
 * requests that would otherwise have shown nothing at all.
 */
interface ShelfMemory {
  lastGood: readonly InstantMarket[];
  loadedFromDisk: boolean;
}

/**
 * One memory per process, not one per bundle.
 *
 * Next compiles `instrumentation` and each route into separate bundles, and every one of
 * them gets its own copy of this module's variables. A warm-up at boot that filled a
 * module-scope variable would therefore leave the bundle that actually renders the shelf
 * exactly as cold as it was — which is the shape of bug that made the scheduler invisible
 * to its own health endpoint. `globalThis` is what the two halves have in common.
 *
 * Under Vitest the memory is module-scope again, because the tests reach for a fresh
 * module through `vi.resetModules()` to get a shelf that has never seen anything, and a
 * process-wide memory would leak one case's markets into the next.
 */
const MEMORY = Symbol.for("agen.instant.shelf");

const local: ShelfMemory = { lastGood: [], loadedFromDisk: false };

function memory(): ShelfMemory {
  if (process.env.VITEST === "true") return local;

  const host = globalThis as typeof globalThis & { [MEMORY]?: ShelfMemory };
  host[MEMORY] ??= { lastGood: [], loadedFromDisk: false };
  return host[MEMORY];
}

const SHELF_FILE = "instant-shelf.json";

interface StoredShelf {
  readonly at: number;
  readonly markets: readonly {
    readonly token: string;
    readonly poolId: string;
    readonly creator: string;
    readonly createdAt: number;
    readonly vault: string;
    readonly name: string;
    readonly symbol: string;
    readonly supplyTokens: number;
    readonly lpFee: number;
    readonly price: number;
    readonly liquidity: string;
    readonly sqrtPriceX96: string;
    readonly image: string | null;
    readonly description: string;
  }[];
}

/** The volume is only mounted in the running app. A unit test must not inherit a leftover file. */
const PERSIST = process.env.VITEST !== "true";

async function loadRemembered(): Promise<readonly InstantMarket[]> {
  const held = memory();
  if (held.loadedFromDisk || !PERSIST) return held.lastGood;
  held.loadedFromDisk = true;

  try {
    const raw = JSON.parse(await readFile(joinPath(GENERATED_ROOT, SHELF_FILE), "utf8")) as StoredShelf;
    if (!Array.isArray(raw.markets) || raw.markets.length === 0) return held.lastGood;

    held.lastGood = raw.markets.flatMap((row) => {
      if (!isAddress(row.token) || !isAddress(row.creator) || !isAddress(row.vault)) return [];
      return [
        {
          token: getAddress(row.token),
          poolId: row.poolId as Hex,
          creator: getAddress(row.creator),
          createdAt: row.createdAt,
          vault: getAddress(row.vault),
          name: row.name,
          symbol: row.symbol,
          supplyTokens: row.supplyTokens,
          lpFee: row.lpFee,
          price: row.price,
          liquidity: BigInt(row.liquidity),
          sqrtPriceX96: BigInt(row.sqrtPriceX96),
          metadata: {
            description: typeof row.description === "string" ? row.description : "",
            image:
              typeof row.image === "string" && /^https?:\/\//i.test(row.image) ? row.image : null,
            links: {},
          },
        },
      ];
    });
  } catch {
    // No file, unreadable file, or a deploy that has not written one yet. Memory stays empty
    // and the next successful read creates it.
  }

  return held.lastGood;
}

function remember(markets: readonly InstantMarket[]): readonly InstantMarket[] {
  if (markets.length === 0) return markets;
  const held = memory();
  held.lastGood = markets;
  held.loadedFromDisk = true;
  if (!PERSIST) return markets;

  const stored: StoredShelf = {
    at: Math.floor(Date.now() / 1000),
    markets: markets.map((market) => ({
      token: market.token,
      poolId: market.poolId,
      creator: market.creator,
      createdAt: market.createdAt,
      vault: market.vault,
      name: market.name,
      symbol: market.symbol,
      supplyTokens: market.supplyTokens,
      lpFee: market.lpFee,
      price: market.price,
      liquidity: market.liquidity.toString(),
      sqrtPriceX96: market.sqrtPriceX96.toString(),
      image: market.metadata.image,
      description: market.metadata.description,
    })),
  };

  void mkdir(GENERATED_ROOT, { recursive: true })
    .then(() => writeFile(joinPath(GENERATED_ROOT, SHELF_FILE), JSON.stringify(stored)))
    .catch(() => undefined);

  return markets;
}
