/**
 * Shared lookups the inspect tools sit on.
 *
 * One resolution path: a ticker, a name, a token address, a pool id, or an agen.space URL
 * all become the same market row. The tools then format different slices of it. That is
 * cheaper than five tools each talking to the feed in a slightly different way, and it is
 * what lets "is this token actually doing well?" work when the person said `$DOG`, pasted
 * a contract, or just replied under a chart.
 */

import { formatEther, isAddress } from "viem";

import { instantFeedConfigured, fetchInstantMarketList, fetchInstantStats } from "../instant-feed";
import { readInstantMarket, readMetadataDocument } from "../instant-markets";
import { publicClient } from "../onchain";
import { abi } from "@verdant/sdk";

export interface MarketSnapshot {
  readonly token: string;
  readonly poolId: string;
  readonly name: string;
  readonly symbol: string;
  readonly creator: string;
  readonly vault: string;
  readonly createdAt: number;
  readonly url: string;
  readonly priceEth: string | null;
  readonly liquidityEth: string | null;
  readonly volume24hEth: string | null;
  readonly trades24h: number | null;
  readonly change24hPercent: number | null;
  readonly creatorFeesEth: string | null;
  readonly description: string | null;
  readonly metadataURI: string | null;
}

function weiEth(wei: bigint): string {
  return `${formatEther(wei)} ETH`;
}

function looksLikeId(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value) || /^0x[a-fA-F0-9]{64}$/.test(value);
}

/** Strip an agen.space URL or a leading $ so the rest of the lookup sees a ticker or an id. */
export function normaliseQuery(raw: string): string {
  const trimmed = raw.trim();
  const fromUrl = /agen\.space\/markets\/(0x[a-fA-F0-9]{40,64})/i.exec(trimmed);
  if (fromUrl !== null) return fromUrl[1]!;
  return trimmed.replace(/^\$/, "");
}

/**
 * Find one Instant market, or explain why not.
 *
 * Prefers the indexer list (fast, has every live market) and falls back to a chain read
 * when the query is an address the feed has not indexed yet.
 */
export async function resolveMarket(query: string): Promise<MarketSnapshot | string> {
  const needle = normaliseQuery(query);
  if (needle === "") return "Give a ticker, a token address, a pool id, or an agen.space URL.";

  const list = instantFeedConfigured ? await fetchInstantMarketList(200) : null;
  const match = list === null ? null : pickFromList(list, needle);

  if (match !== null) {
    return hydrate({
      token: match.token,
      poolId: match.poolId,
      name: match.name,
      symbol: match.symbol,
      creator: match.creator,
      vault: match.vault,
      createdAt: match.createdAt,
      metadataURI: match.metadataURI,
      liquidity: match.liquidity,
    });
  }

  if (looksLikeId(needle) && needle.length === 42) {
    const onchain = await readInstantMarket(needle).catch(() => null);
    if (onchain !== null) {
      return hydrate({
        token: onchain.token,
        poolId: onchain.poolId,
        name: onchain.name,
        symbol: onchain.symbol,
        creator: onchain.creator,
        vault: onchain.vault,
        createdAt: onchain.createdAt,
        metadataURI: null,
        liquidity: onchain.liquidity,
        price: onchain.price,
        description: onchain.metadata.description,
      });
    }
  }

  if (list === null) {
    return "The Instant indexer is not configured, so live market data is unavailable.";
  }
  return `No Instant market matches ${needle}.`;
}

function pickFromList(
  list: readonly {
    readonly token: string;
    readonly poolId: string;
    readonly name: string;
    readonly symbol: string;
    readonly creator: string;
    readonly vault: string;
    readonly createdAt: number;
    readonly metadataURI: string;
    readonly liquidity: bigint;
  }[],
  needle: string,
): (typeof list)[number] | null {
  const lower = needle.toLowerCase();
  const exact = list.find(
    (row) =>
      row.token.toLowerCase() === lower ||
      row.poolId.toLowerCase() === lower ||
      row.symbol.toLowerCase() === lower,
  );
  if (exact !== undefined) return exact;

  const named = list.filter((row) => row.name.toLowerCase().includes(lower));
  return named.length === 1 ? named[0]! : null;
}

async function hydrate(row: {
  readonly token: string;
  readonly poolId: string;
  readonly name: string;
  readonly symbol: string;
  readonly creator: string;
  readonly vault: string;
  readonly createdAt: number;
  readonly metadataURI: string | null;
  readonly liquidity: bigint;
  readonly price?: number;
  readonly description?: string;
}): Promise<MarketSnapshot> {
  const stats = await fetchInstantStats(row.token).catch(() => null);
  const meta =
    row.description !== undefined
      ? { description: row.description }
      : row.metadataURI !== null && row.metadataURI !== ""
        ? await readMetadataDocument(row.metadataURI).catch(() => null)
        : null;

  let creatorFeesEth: string | null = null;
  if (isAddress(row.vault, { strict: false })) {
    try {
      const accrued = await publicClient().readContract({
        address: row.vault,
        abi: abi.instantFeeVaultAbi,
        functionName: "creatorAccrued",
      });
      creatorFeesEth = weiEth(accrued);
    } catch {
      creatorFeesEth = null;
    }
  }

  const volume = stats?.day.organicVolumeQuote ?? stats?.day.volumeQuote ?? null;

  return {
    token: row.token,
    poolId: row.poolId,
    name: row.name,
    symbol: row.symbol,
    creator: row.creator,
    vault: row.vault,
    createdAt: row.createdAt,
    url: `https://agen.space/markets/${row.token}`,
    priceEth: row.price !== undefined ? `${row.price} ETH` : null,
    liquidityEth: weiEth(row.liquidity),
    volume24hEth: volume === null ? null : weiEth(volume),
    trades24h: stats?.day.trades ?? null,
    change24hPercent: stats?.day.changePercent ?? null,
    creatorFeesEth,
    description: meta?.description ?? null,
    metadataURI: row.metadataURI,
  };
}

export function formatSnapshot(snapshot: MarketSnapshot): string {
  const lines = [
    `${snapshot.name} ($${snapshot.symbol})`,
    snapshot.url,
    `token: ${snapshot.token}`,
    `pool: ${snapshot.poolId}`,
    `creator: ${snapshot.creator}`,
    snapshot.priceEth === null ? null : `price: ${snapshot.priceEth}`,
    snapshot.liquidityEth === null ? null : `liquidity: ${snapshot.liquidityEth}`,
    snapshot.volume24hEth === null ? null : `volume 24h: ${snapshot.volume24hEth}`,
    snapshot.trades24h === null ? null : `trades 24h: ${String(snapshot.trades24h)}`,
    snapshot.change24hPercent === null
      ? null
      : `change 24h: ${snapshot.change24hPercent.toFixed(2)}%`,
    snapshot.creatorFeesEth === null ? null : `creator fees accrued: ${snapshot.creatorFeesEth}`,
    `launched: ${new Date(snapshot.createdAt * 1000).toISOString()}`,
    snapshot.description === null || snapshot.description === ""
      ? null
      : `description: ${snapshot.description}`,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

export async function searchMarkets(query: string, limit: number): Promise<string> {
  if (!instantFeedConfigured) {
    return "The Instant indexer is not configured, so markets cannot be searched.";
  }

  const list = await fetchInstantMarketList(200);
  if (list === null) return "The Instant indexer did not answer.";

  const needle = normaliseQuery(query).toLowerCase();
  const matched =
    needle === ""
      ? [...list].sort((a, b) => b.createdAt - a.createdAt)
      : list.filter(
          (row) =>
            row.symbol.toLowerCase().includes(needle) ||
            row.name.toLowerCase().includes(needle) ||
            row.token.toLowerCase() === needle,
        );

  const take = matched.slice(0, Math.min(Math.max(limit, 1), 8));
  if (take.length === 0) return `No Instant markets match ${query}.`;

  return take
    .map(
      (row) =>
        `${row.name} ($${row.symbol}) ${row.token} liq ${formatEther(row.liquidity)} ETH ` +
        `https://agen.space/markets/${row.token}`,
    )
    .join("\n");
}
