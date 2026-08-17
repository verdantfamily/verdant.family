/**
 * The four tools that only read: `get_token`, `get_pool`, `get_launches`, `get_instant_metrics`.
 *
 * All four go to the Instant indexer, which is the same source `apps/agen` reads through
 * `lib/instant-feed.ts`. Nothing here computes a total, a ranking or a subtraction the feed
 * does not already publish — see `normalize.ts` for the single exception and why it is one.
 *
 * Together in one file because they are the same shape of work: one request, one rename. A
 * file each would be four headers and no additional clarity.
 */

import { INSTANT_FEES } from "@verdant/config";

import type { FeedMarket } from "../clients/feed.js";
import { AgenMcpError } from "../errors.js";
import { launchSummary, poolView, tokenView } from "../normalize.js";
import { INSTANT_SUPPLY_TOKENS } from "../schemas.js";
import { runTool, type ToolContext, type ToolResult } from "./context.js";

/** Every Instant market opens at this valuation. `lib/instant.ts` owns the number. */
const STARTING_MARKET_CAP_WEI = "1500000000000000000";

export interface TokenLookupInput {
  readonly token?: string | undefined;
  readonly poolId?: string | undefined;
}

/** The feed accepts a pool id or a token address on the same path. */
function identifier(input: TokenLookupInput): string {
  const id = input.token ?? input.poolId;
  if (id === undefined) {
    throw new AgenMcpError("INVALID_INPUT", "Give either token or poolId.", { source: "mcp" });
  }
  return id;
}

/**
 * A market, or a refusal that says which kind of absence it is.
 *
 * The feed answers 404 both for a token that does not exist and for one launched a second
 * ago that it has not indexed yet. `INDEXER_PENDING` is the more useful of the two when the
 * caller has just launched, so the distinction is left to `get_launch_status` — which can
 * see Agen's launch record — and this returns `TOKEN_NOT_FOUND` with that pointer.
 */
async function readMarket(context: ToolContext, id: string, requestId: string, kind: "token" | "pool"): Promise<FeedMarket> {
  try {
    return await context.feed.market(id, requestId);
  } catch (error) {
    if (error instanceof AgenMcpError && (error.code === "TOKEN_NOT_FOUND" || error.detail.httpStatus === 404)) {
      throw new AgenMcpError(
        kind === "token" ? "TOKEN_NOT_FOUND" : "POOL_NOT_FOUND",
        `The Instant indexer has no market for ${id}. If it was launched moments ago, call get_launch_status instead — the indexer lags the chain.`,
        { source: "instant-feed", httpStatus: 404, requestId, retryable: true },
      );
    }
    throw error;
  }
}

export function getToken(context: ToolContext, input: TokenLookupInput): Promise<ToolResult> {
  return runTool({ name: "get_token", context, input }, async ({ requestId }) => {
    const id = identifier(input);
    const market = await readMarket(context, id, requestId, "token");

    // The 24h figures are a second route, and a market is still worth returning without them.
    const stats = await context.feed.stats(market.poolId, requestId).catch(() => null);

    return tokenView(market, stats);
  });
}

export function getPool(context: ToolContext, input: TokenLookupInput): Promise<ToolResult> {
  return runTool({ name: "get_pool", context, input }, async ({ requestId }) => {
    const id = identifier(input);
    return poolView(await readMarket(context, id, requestId, "pool"));
  });
}

export interface GetLaunchesInput {
  readonly sort: "newest" | "volume" | "organicVolume" | "trades" | "liquidity" | "fees";
  readonly creator?: string | undefined;
  readonly token?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export function getLaunches(context: ToolContext, input: GetLaunchesInput): Promise<ToolResult> {
  return runTool({ name: "get_launches", context, input }, async ({ requestId }) => {
    // A token names exactly one market, so a page of them would be a page of one.
    if (input.token !== undefined) {
      const market = await readMarket(context, input.token, requestId, "token");
      return {
        launches: [launchSummary(market)],
        total: 1,
        limit: 1,
        offset: 0,
        sort: input.sort,
        creator: null,
      };
    }

    const page = await context.feed.markets(
      {
        limit: input.limit,
        offset: input.offset,
        sort: input.sort,
        ...(input.creator === undefined ? {} : { creator: input.creator }),
      },
      requestId,
    );

    return {
      launches: page.markets.map(launchSummary),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      sort: page.sort ?? input.sort,
      creator: page.creator ?? input.creator ?? null,
    };
  });
}

export function getInstantMetrics(context: ToolContext): Promise<ToolResult> {
  return runTool({ name: "get_instant_metrics", context, input: {} }, async ({ requestId }) => {
    const metrics = await context.feed.metrics(requestId);

    return {
      at: metrics.at,
      markets: metrics.markets,
      creators: metrics.creators,
      trades: metrics.trades,
      volume: {
        quoteWei: metrics.volume.quote,
        organicQuoteWei: metrics.volume.organicQuote,
        boostQuoteWei: metrics.volume.boostQuote,
        tokenBaseUnits: metrics.volume.token,
      },
      feesAccruedWei: {
        etherLeg: metrics.fees.etherLeg,
        creator: metrics.fees.creator,
        platform: metrics.fees.platform,
        total: metrics.fees.total,
      },
      day: {
        since: metrics.day.since,
        volumeQuoteWei: metrics.day.volumeQuote,
        organicVolumeQuoteWei: metrics.day.organicVolumeQuote,
        trades: metrics.day.trades,
      },
      boost: {
        marketsEnabled: metrics.boost.marketsEnabled,
        spentQuoteWei: metrics.boost.spentQuote,
        sunkTokenBaseUnits: metrics.boost.sunkToken,
        buybacks: metrics.boost.buybacks,
      },
      lastLaunchAt: metrics.lastLaunchAt,
      /*
       * The terms every Instant market shares, alongside the totals.
       *
       * From the contracts by way of `@verdant/config`, so an agent reading metrics does not
       * have to make a second call to learn what a market cap on this platform means.
       */
      terms: {
        supplyTokens: INSTANT_SUPPLY_TOKENS.toString(),
        decimals: 18,
        feePpm: {
          total: INSTANT_FEES.totalPpm,
          creator: INSTANT_FEES.creatorPpm,
          platform: INSTANT_FEES.platformPpm,
          denominator: INSTANT_FEES.denominatorPpm,
        },
        startingMarketCapWei: STARTING_MARKET_CAP_WEI,
      },
    };
  });
}
