/**
 * The feed's rows, as the tools' answers.
 *
 * Renaming and selecting only. The one arithmetic operation is a market cap — price times
 * supply — and it is here rather than upstream because the feed publishes a price and a
 * supply and no consumer of it wants to multiply two decimal strings by hand. Everything
 * else that looks derived (`organicVolumeQuote`, `circulatingSupply`) is served by the feed
 * for the stated reason that every consumer should subtract the same way.
 *
 * Wei stays a string end to end. A `number` would round a supply of 10^27, and an agent that
 * reports a rounded supply has misreported the token.
 */

import { INSTANT_FEES } from "@verdant/config";

import type { FeedMarket, FeedStats } from "./clients/feed.js";

export const ETHER = "0x0000000000000000000000000000000000000000" as const;

export const FEE_PPM = {
  total: INSTANT_FEES.totalPpm,
  creator: INSTANT_FEES.creatorPpm,
  platform: INSTANT_FEES.platformPpm,
  denominator: INSTANT_FEES.denominatorPpm,
} as const;

/**
 * Price times supply, in wei, without floating point.
 *
 * `price` is a decimal string of wei-per-whole-token and can carry a long fraction, so it is
 * scaled to an integer before multiplying and scaled back afterwards. `Number` would lose
 * the tail of both operands.
 */
export function marketCapWei(priceWeiPerToken: string, totalSupplyBaseUnits: string, decimals: number): string {
  try {
    const [whole = "0", fraction = ""] = priceWeiPerToken.split(".");
    const scale = 10n ** BigInt(fraction.length);
    const price = BigInt(`${whole === "" ? "0" : whole}${fraction}`);
    const supplyWholeTokens = BigInt(totalSupplyBaseUnits) / 10n ** BigInt(decimals);
    return ((price * supplyWholeTokens) / scale).toString();
  } catch {
    return "0";
  }
}

export function tokenView(market: FeedMarket, stats: FeedStats | null): Record<string, unknown> {
  return {
    address: market.token,
    name: market.name,
    symbol: market.symbol,
    decimals: market.decimals,
    totalSupply: market.totalSupply,
    circulatingSupply: market.circulatingSupply,
    creator: market.creator,
    feeReceiver: market.vault,
    vault: market.vault,
    launchType: "instant" as const,
    pool: {
      id: market.poolId,
      hook: market.hook,
      fee: market.fee,
      tickSpacing: market.tickSpacing,
      liquidity: market.liquidity,
      tick: market.tick,
      sqrtPriceX96: market.sqrtPriceX96,
    },
    priceWeiPerToken: market.price,
    launchPriceWeiPerToken: market.launchPrice,
    marketCapWei: marketCapWei(market.price, market.totalSupply, market.decimals),
    volume: {
      allTimeQuoteWei: market.volumeQuote,
      organicQuoteWei: market.organicVolumeQuote,
      boostQuoteWei: market.boostVolumeQuote,
      day:
        stats === null
          ? null
          : {
              quoteWei: stats.day.volumeQuote,
              organicQuoteWei: stats.day.organicVolumeQuote,
              trades: stats.day.trades,
              changePercent: stats.day.changePercent,
            },
    },
    feesAccruedWei: {
      creator: market.fees.creator,
      platform: market.fees.platform,
      total: market.fees.total,
    },
    trades: market.swapCount,
    createdAt: market.createdAt,
    createdTx: market.createdTx,
    metadataURI: market.metadataURI,
    boost: {
      capable: market.boost.capable,
      enabled: market.boost.enabled,
      escrow: market.boost.escrow,
    },
    /*
     * Tradable the moment the market exists.
     *
     * `InstantFactory.create` deploys the token, initialises the pool and mints the locked
     * position in one transaction — so a market this feed can see is a market with liquidity
     * in it. There is no graduation, no bonding phase and no listing step to wait for.
     */
    tradable: true,
    indexed: true as const,
  };
}

export function poolView(market: FeedMarket): Record<string, unknown> {
  return {
    id: market.poolId,
    token: market.token,
    symbol: market.symbol,
    hook: market.hook,
    currency0: ETHER,
    currency1: market.token,
    fee: market.fee,
    tickSpacing: market.tickSpacing,
    liquidity: market.liquidity,
    tick: market.tick,
    sqrtPriceX96: market.sqrtPriceX96,
    priceWeiPerToken: market.price,
    positionTokenId: market.positionTokenId,
    positionLiquidity: market.positionLiquidity,
    locker: market.locker,
    vault: market.vault,
    feePpm: FEE_PPM,
    volumeQuoteWei: market.volumeQuote,
    organicVolumeQuoteWei: market.organicVolumeQuote,
    trades: market.swapCount,
    lastSwapAt: market.lastSwapAt,
    createdAt: market.createdAt,
  };
}

export function launchSummary(market: FeedMarket): Record<string, unknown> {
  return {
    token: market.token,
    poolId: market.poolId,
    name: market.name,
    symbol: market.symbol,
    creator: market.creator,
    createdAt: market.createdAt,
    priceWeiPerToken: market.price,
    marketCapWei: marketCapWei(market.price, market.totalSupply, market.decimals),
    liquidity: market.liquidity,
    volumeQuoteWei: market.volumeQuote,
    organicVolumeQuoteWei: market.organicVolumeQuote,
    trades: market.swapCount,
    feesAccruedTotalWei: market.fees.total,
    boostEnabled: market.boost.enabled,
  };
}
