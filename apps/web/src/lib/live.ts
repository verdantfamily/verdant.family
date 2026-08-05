import type { Market, MarketStats } from "./feed";

/**
 * Everything on a market page that moves, in one payload.
 *
 * The band under the chart used to be rendered once by the server and then left there:
 * `revalidate` refreshes the cached HTML for the *next* visitor, not the tab already
 * open, so a reader watching a market trade saw the volume, the holder count and the
 * all-time high sit perfectly still. This is what the band polls instead.
 *
 * One payload rather than three, because it is fetched on a timer and three requests a
 * second per open tab is a cost the indexer pays for nothing. It is also what keeps the
 * figures consistent with each other: a market cap taken from one response and a
 * liquidity figure from another are two different instants presented as one row.
 *
 * Amounts cross as decimal strings for the usual reason — JSON has no integer wide
 * enough for wei — and are turned back into `bigint` before anything is computed from
 * them, so the arithmetic on the client is the arithmetic the server would have done.
 */
export interface SerializedLive {
  /** Chain time this was read at, which every age and countdown is measured against. */
  readonly at: number;

  readonly sqrtPriceX96: string;
  readonly initialSqrtPriceX96: string;
  readonly liquidity: string;
  readonly totalSupply: string;
  readonly swapCount: number;

  readonly fee: {
    readonly ppm: number;
    readonly at: number;
    readonly stageIndex: number;
    readonly stageCount: number;
    readonly nextTransitionAt: number | null;
  };

  /**
   * `null` when the statistics query failed on its own.
   *
   * Separate from the market because it is a separate query against the indexer and a
   * slow holder count must not cost the page its market cap. The band renders a dash for
   * these and keeps everything else moving.
   */
  readonly stats: {
    readonly dayVolumeQuote: string;
    readonly dayTrades: number;
    readonly allTimeHigh: string;
    readonly holders: number;
  } | null;

  /**
   * Dollars per ether, carried with the figures rather than fixed at page load.
   *
   * It is the multiplier every dollar figure on the band goes through, so pinning it at
   * first render would leave a market cap drifting away from the truth over a long
   * session for a reason nothing on the page could explain.
   */
  readonly usdPerEth: number | null;
}

export function serializeLive(
  market: Market,
  stats: MarketStats | null,
  usdPerEth: number | null,
): SerializedLive {
  return {
    at: market.fee.at,
    sqrtPriceX96: market.sqrtPriceX96.toString(),
    initialSqrtPriceX96: market.initialSqrtPriceX96.toString(),
    liquidity: market.liquidity.toString(),
    totalSupply: market.totalSupply.toString(),
    swapCount: market.swapCount,
    fee: {
      ppm: market.fee.ppm,
      at: market.fee.at,
      stageIndex: market.fee.stageIndex,
      stageCount: market.fee.stageCount,
      nextTransitionAt: market.fee.nextTransitionAt,
    },
    stats:
      stats === null
        ? null
        : {
            dayVolumeQuote: stats.day.volumeQuote.toString(),
            dayTrades: stats.day.trades,
            allTimeHigh: stats.allTime.high.toString(),
            holders: stats.holders,
          },
    usdPerEth,
  };
}
