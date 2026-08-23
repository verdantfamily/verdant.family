/**
 * The chain, as the server reads it.
 *
 * One client, made once, used by every page that needs to know what a market is worth.
 * Reads only: nothing here holds a key, and the one transaction Agen produces is built
 * unsigned in `./launch.ts` and signed in a wallet.
 *
 * ## Why the server reads prices at all
 *
 * Because the pages that show them are server-rendered, and a token page whose price
 * arrives after hydration is a token page that flashes a dash at everybody who opens it.
 * The trade panel quotes from the browser — it has to, it quotes what the reader is
 * about to sign — but the price, the market cap and the depth on the page around it are
 * read here and shipped in the HTML.
 *
 * ## Failure is a value
 *
 * Every function returns `null` rather than throwing when the chain cannot be reached or
 * the market is not there. A launchpad whose discovery page 500s because an RPC hiccuped
 * is worse than one that shows a dash: the mechanics, the rules and the contracts are
 * all still true and still worth serving.
 *
 * ## Two registries, and which one to ask is not a guess
 *
 * `AgenMarketRegistry` is one contract type deployed twice: once for generated markets,
 * once for the engine. Each names its own factory as the only account allowed to write to
 * it, so an engine market appears in the engine's registry and nowhere else. The two are
 * indistinguishable by ABI and completely distinct by content, which is the worst possible
 * combination for a reader that guesses: asking the generated registry about an engine
 * market returns "no such market" rather than an error, and the market it describes goes on
 * rendering as an unlaunched build.
 *
 * So every read here takes the engine version as an argument and resolves the registry from
 * it. The caller always knows — it came from the launch record, which recorded which
 * factory's event it decoded — and making it a parameter rather than a default means a new
 * call site cannot silently inherit engine 0's registry.
 */

import "server-only";

import type { EngineVersion } from "@verdant/market-compiler";
import { agen } from "@verdant/sdk";
import { createPublicClient, getAddress, http, type Address, type Hex, type PublicClient } from "viem";

import { AGEN_ADDRESSES, EXTERNAL, chain } from "./chain";
import { engineAddressesOrNull } from "./programmable";

/**
 * Module scope, so a page render does not build a transport per component.
 *
 * `batch` turns the several reads a token page makes into one request. Every call below
 * is a `view` and the chain is cheap, but the round trips are not — a market page asks
 * for a registry record, a pool's slot0 and its liquidity, which is three requests
 * without this and one with it.
 *
 * ## Why the batch has a ceiling
 *
 * Because the public RPC answers a batch it considers too large with a single object —
 * `{"error":{"code":429}}` — where a response per call was asked for. viem matches
 * responses to requests by id, finds nothing for any of them, and raises a `TypeError`
 * rather than a rate-limit error, so what reaches a caller is not "slow down" but an
 * unreadable failure of every read in the batch at once. A page that catches it then
 * renders as though the chain were empty.
 *
 * Left unbounded, viem will put as many as a thousand calls in one request, and the size
 * of a batch is decided by how much a page happens to ask for rather than by what the
 * other end will accept. The ceiling keeps a single refusal from being able to cover a
 * whole render, and `retryCount` is what handles the refusal itself.
 */
const MAX_CALLS_PER_BATCH = 12;

let client: PublicClient | undefined;

export function publicClient(): PublicClient {
  client ??= createPublicClient({
    chain,
    transport: http(undefined, {
      batch: { batchSize: MAX_CALLS_PER_BATCH, wait: 8 },
      retryCount: 2,
    }),
  });
  return client;
}

/** What the pages need to know about a market that exists on chain. */
export interface LiveMarket {
  readonly token: Address;
  readonly hook: Address;
  readonly poolId: Hex;
  readonly creator: Address;
  readonly quoteAsset: Address;
  readonly metadataURI: string;
  /** Seconds. When the market was created, which supersedes the build's own age. */
  readonly createdAt: number;
  /** The fee the pool was created with, recovered by hashing candidate keys. */
  readonly lpFee: number;
  /** Quote asset per whole token, at the block this was read. */
  readonly price: number;
  /** In wei of the quote asset. The pool's own depth, not a dollar figure. */
  readonly liquidity: bigint;
  readonly tick: number;
  readonly sqrtPriceX96: bigint;
}

/**
 * The registry that records markets from a given engine, or `null` where that engine is
 * not deployed on this chain.
 *
 * Exported because the tests assert the routing directly: that engine 1 resolves to the
 * engine's own registry, that engine 0 resolves to the generated-market one, and that
 * neither ever answers with the other's address.
 */
export function registryFor(engineVersion: EngineVersion): Address | null {
  if (engineVersion === 1) {
    const engine = engineAddressesOrNull();
    return engine === null ? null : getAddress(engine.registry);
  }

  return AGEN_ADDRESSES.ok ? AGEN_ADDRESSES.addresses.registry : null;
}

/**
 * A market by its token, from its own engine's registry and the pool.
 *
 * `null` covers three different situations that all mean the same thing to a page:
 * this engine is not deployed here, this token is not one of its markets, or the chain
 * did not answer. Distinguishing them would give a caller three branches that render the
 * same thing.
 */
export async function readLiveMarket(
  token: Address,
  engineVersion: EngineVersion,
): Promise<LiveMarket | null> {
  const registry = registryFor(engineVersion);
  if (registry === null) return null;

  try {
    const record = await agen.readAgenMarketByToken(publicClient(), registry, token);
    if (record === null) return null;

    return await withPool(record);
  } catch {
    return null;
  }
}

/**
 * Every market one engine's registry knows, newest first.
 *
 * The registry pages, so this is one call for the list and one multicall per market for
 * its pool. That is fine at the scale a new launchpad operates at and stops being fine
 * somewhere around a few hundred markets — at which point the indexer's feed answers
 * this question instead, and this function becomes the thing that verifies it.
 */
export async function readLiveMarkets(
  engineVersion: EngineVersion,
  limit = 50,
): Promise<readonly LiveMarket[]> {
  const registry = registryFor(engineVersion);
  if (registry === null) return [];

  try {
    const records = await agen.readAgenMarketPage(publicClient(), registry, { limit });

    const settled = await Promise.all(records.map(async (record) => withPool(record)));
    return settled.filter((market): market is LiveMarket => market !== null);
  } catch {
    return [];
  }
}

/**
 * A registry record plus its pool's current state.
 *
 * The fee is recovered rather than stored: `AgenMarketRegistry` records the pool id but
 * not the key that hashes to it, so `resolveAgenPoolKey` tries the flag and the fixed
 * fees a build can choose and keeps the one that hashes correctly. A market whose fee is
 * outside that set is returned as `null` rather than quoted against a pool nobody has
 * confirmed exists.
 */
async function withPool(record: agen.AgenMarketRecord): Promise<LiveMarket | null> {
  const key = agen.resolveAgenPoolKey(record);
  if (key === null) return null;

  const state = await agen.readPoolState(publicClient(), EXTERNAL.stateView, record.poolId);

  return {
    token: record.token,
    hook: record.hook,
    poolId: record.poolId,
    creator: record.creator,
    quoteAsset: record.quoteAsset,
    metadataURI: record.metadataURI,
    createdAt: record.createdAt,
    lpFee: key.fee,
    price: agen.priceFromSqrt(state.sqrtPriceX96),
    liquidity: state.liquidity,
    tick: state.tick,
    sqrtPriceX96: state.sqrtPriceX96,
  };
}
