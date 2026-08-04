/**
 * A market's price history, for the chart to poll.
 *
 * The indexer is not reachable from a browser — `VERDANT_FEED_URL` is a server-side
 * address, and in production it is not public — so a chart that wanted a newer series
 * than the one its page was rendered with had nowhere to ask. This is that door, and it
 * is deliberately a narrow one: a pool id, an interval from a closed set, and a bucket
 * count held well below what the indexer would allow.
 *
 * The count is a parameter because the chart's ranges need it — "the last hour" is sixty
 * one-minute buckets and "everything" is however many the market has been alive for — but
 * it is clamped here rather than passed through, because a route that let anybody ask for
 * a thousand buckets at a resolution they picked is an easy way to make the indexer work
 * hard for nothing.
 */
import { candles } from "@verdant/sdk";

import { serializeSeries } from "../../../../../lib/candles";
import { FeedUnavailableError, MarketNotFoundError, fetchCandles } from "../../../../../lib/feed";

/** What the chart draws when it does not say: enough to fill the width. */
const BUCKETS = 240;

/** More than any range the chart offers needs, and well under the indexer's own ceiling. */
const MOST_BUCKETS = 600;

function bucketsOf(raw: string | null): number {
  const requested = Number(raw ?? BUCKETS);
  if (!Number.isFinite(requested)) return BUCKETS;
  return Math.min(Math.max(Math.trunc(requested), 2), MOST_BUCKETS);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const query = new URL(request.url).searchParams;

  const requested = query.get("interval") ?? "5m";
  if (!candles.isCandleInterval(requested)) {
    return Response.json(
      {
        error: `Unknown interval "${requested}".`,
        intervals: candles.CANDLE_INTERVALS.map((entry) => entry.id),
      },
      { status: 400 },
    );
  }

  try {
    const series = await fetchCandles(id, requested, bucketsOf(query.get("limit")));
    return Response.json(serializeSeries(series), {
      // Not cached. The series is polled precisely because it changes, and a cache in
      // front of it would hand the chart the same picture it already has.
      headers: { "cache-control": "no-store" },
    });
  } catch (cause) {
    if (cause instanceof MarketNotFoundError) {
      return Response.json({ error: "No such market." }, { status: 404 });
    }
    if (cause instanceof FeedUnavailableError) {
      // 503 rather than 500: the interface is fine and the market is fine. Saying so
      // lets the chart keep the line it already has rather than clear it.
      return Response.json({ error: "The market feed is not answering." }, { status: 503 });
    }
    throw cause;
  }
}
