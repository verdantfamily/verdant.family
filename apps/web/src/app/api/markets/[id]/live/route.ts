/**
 * The moving figures on a market page, for the band under the chart to poll.
 *
 * A sibling of the candles and swaps routes, and it exists for the same reason: the
 * indexer is a server-side address that a browser cannot reach. What is different is
 * that this one answers a question the page used to answer only once. The band was
 * server-rendered and then frozen for the life of the tab — `revalidate` refreshes the
 * HTML a later visitor gets, not the page already on screen — so volume, holders and the
 * all-time high never moved while somebody watched a market trade.
 *
 * Both queries run together and the market is the one that matters: a failed statistics
 * query returns `null` for that half rather than failing the request, because a slow
 * holder count should cost the band a holder count and not a market cap.
 */
import {
  FeedUnavailableError,
  MarketNotFoundError,
  fetchMarket,
  fetchMarketStats,
  type MarketStats,
} from "../../../../../lib/feed";
import { serializeLive } from "../../../../../lib/live";
import { fetchUsdPerEth } from "../../../../../lib/usd";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  try {
    // Fresh, past the window the page render reads through. This is polled about once a
    // second and a cached answer would be the same figures over and over — the whole
    // reason the interface looked frozen while the chain was busy.
    const [market, stats, usdPerEth] = await Promise.all([
      fetchMarket(id, true),
      fetchMarketStats(id, true).catch((): MarketStats | null => null),
      fetchUsdPerEth(),
    ]);

    return Response.json(serializeLive(market, stats, usdPerEth), {
      headers: { "cache-control": "no-store" },
    });
  } catch (cause) {
    if (cause instanceof MarketNotFoundError) {
      return Response.json({ error: "No such market." }, { status: 404 });
    }
    if (cause instanceof FeedUnavailableError) {
      // 503 rather than 500: the interface is fine and so is the market. Saying so lets
      // the band keep the figures it already has rather than blank them.
      return Response.json({ error: "The market feed is not answering." }, { status: 503 });
    }
    throw cause;
  }
}
