/**
 * The Instant indexer feed, as typed calls.
 *
 * The same service `apps/agen` reads through `lib/instant-feed.ts` and the same env var
 * names it: `AGEN_INSTANT_FEED_URL`. Every field below is one the feed already publishes —
 * including the subtractions (`organicVolumeQuote`, `circulatingSupply`), which are served
 * rather than computed so that every consumer subtracts the same way.
 *
 * Routes: `apps/instant-indexer/src/api/instant.ts`.
 */

import { AgenMcpError } from "../errors.js";
import type { Logger } from "../logger.js";
import { HttpClient } from "./http.js";

export interface FeedMarket {
  readonly poolId: string;
  readonly token: string;
  readonly hook: string;
  readonly creator: string;
  readonly vault: string;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly totalSupply: string;
  readonly metadataURI: string;
  readonly locker: string;
  readonly positionTokenId: string;
  readonly positionLiquidity: string;
  readonly createdAt: number;
  readonly createdAtBlock: string;
  readonly createdTx: string;
  readonly price: string;
  readonly launchPrice: string;
  readonly sqrtPriceX96: string;
  readonly tick: number;
  readonly liquidity: string;
  readonly swapCount: number;
  readonly volumeQuote: string;
  readonly volumeToken: string;
  readonly organicVolumeQuote: string;
  readonly organicVolumeToken: string;
  readonly boostVolumeQuote: string;
  readonly boostVolumeToken: string;
  readonly lastSwapAt: number | null;
  readonly fees: {
    readonly etherLeg: string;
    readonly creator: string;
    readonly platform: string;
    readonly total: string;
  };
  readonly boost: {
    readonly escrow: string | null;
    readonly capable: boolean;
    readonly enabled: boolean;
    readonly locked: boolean;
    readonly spentQuote: string;
    readonly platformCaptured: boolean;
    readonly agenRoutedQuote: string;
    readonly agenDonatedQuote: string;
    readonly sunkToken: string;
    readonly count: number;
    readonly lastBoostAt: number | null;
  };
  readonly circulatingSupply: string;
}

export interface FeedMarketPage {
  readonly markets: readonly FeedMarket[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly sort?: string;
  readonly creator?: string;
}

export interface FeedStats {
  readonly poolId: string;
  readonly at: number;
  readonly window: number;
  readonly day: {
    readonly since: number;
    readonly volumeQuote: string;
    readonly volumeToken: string;
    readonly boostVolumeQuote: string;
    readonly organicVolumeQuote: string;
    readonly organicVolumeToken: string;
    readonly boostBuybacks: number;
    readonly trades: number;
    readonly changePercent: number | null;
  };
  readonly allTime: { readonly high: string; readonly low: string };
}

export interface FeedMetrics {
  readonly at: number;
  readonly markets: number;
  readonly creators: number;
  readonly trades: number;
  readonly volume: {
    readonly quote: string;
    readonly token: string;
    readonly boostQuote: string;
    readonly boostToken: string;
    readonly organicQuote: string;
    readonly organicToken: string;
  };
  readonly fees: {
    readonly etherLeg: string;
    readonly creator: string;
    readonly platform: string;
    readonly total: string;
  };
  readonly boost: {
    readonly marketsEnabled: number;
    readonly spentQuote: string;
    readonly sunkToken: string;
    readonly buybacks: number;
  };
  readonly day: {
    readonly since: number;
    readonly volumeQuote: string;
    readonly boostVolumeQuote: string;
    readonly organicVolumeQuote: string;
    readonly trades: number;
    readonly boostBuybacks: number;
  };
  readonly lastLaunchAt: number | null;
}

/** The orderings the feed accepts. `trending` is deliberately not among them. */
export const FEED_SORTS = ["newest", "volume", "organicVolume", "trades", "liquidity", "fees"] as const;
export type FeedSort = (typeof FEED_SORTS)[number];

export interface FeedClientOptions {
  readonly baseUrl: string | undefined;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export class FeedClient {
  private readonly http: HttpClient | null;

  constructor(options: FeedClientOptions) {
    this.http =
      options.baseUrl === undefined
        ? null
        : new HttpClient({
            baseUrl: options.baseUrl,
            source: "instant-feed",
            timeoutMs: options.timeoutMs,
            maxRetries: options.maxRetries,
            logger: options.logger,
            fetchImpl: options.fetchImpl,
            sleep: options.sleep,
          });
  }

  get configured(): boolean {
    return this.http !== null;
  }

  /**
   * Read-only and idempotent throughout, so every call retries.
   *
   * Refused rather than faked when the feed is not configured: a discovery tool that
   * silently answers "no markets" is worse than one that says it cannot see.
   */
  private client(): HttpClient {
    if (this.http === null) {
      throw new AgenMcpError(
        "CONFIG_MISSING",
        "This tool reads the Instant indexer. Set AGEN_INSTANT_FEED_URL to the feed's base URL.",
        { source: "mcp" },
      );
    }
    return this.http;
  }

  markets(
    query: { readonly limit?: number; readonly offset?: number; readonly sort?: string; readonly creator?: string },
    requestId: string,
  ): Promise<FeedMarketPage> {
    return this.client().request({
      path: "/instant/markets",
      query: {
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
        ...(query.sort === undefined ? {} : { sort: query.sort }),
        ...(query.creator === undefined ? {} : { creator: query.creator }),
      },
      retry: true,
      requestId,
    });
  }

  /** By pool id or token address — the feed accepts either. */
  market(id: string, requestId: string): Promise<FeedMarket> {
    return this.client().request({
      path: `/instant/markets/${encodeURIComponent(id)}`,
      retry: true,
      requestId,
    });
  }

  stats(id: string, requestId: string): Promise<FeedStats> {
    return this.client().request({
      path: `/instant/markets/${encodeURIComponent(id)}/stats`,
      retry: true,
      requestId,
    });
  }

  metrics(requestId: string): Promise<FeedMetrics> {
    return this.client().request({ path: "/instant/metrics", retry: true, requestId });
  }
}
