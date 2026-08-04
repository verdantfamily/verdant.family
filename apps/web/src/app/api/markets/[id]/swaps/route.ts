/**
 * A market's trades, for the history table to poll and page through.
 *
 * The same narrow door as the candles route next to it, and for the same reason: the
 * indexer is a server-side address, so a table that wanted rows newer than the ones its
 * page was rendered with had nowhere to ask.
 *
 * The row count stays fixed here rather than being taken from the caller — the only
 * caller is that table and it always shows a page of the same size — but the offset is
 * the caller's, because paging is the one thing it cannot decide on this side.
 */
import { FeedUnavailableError, MarketNotFoundError, fetchSwaps } from "../../../../../lib/feed";
import { serializeHistory } from "../../../../../lib/trades";

/** As many rows as the table shows, and no more. */
const ROWS = 30;

/** Anything that is not a page position is page zero, which is the harmless reading. */
function offsetOf(raw: string | null): number {
  const requested = Number(raw ?? 0);
  if (!Number.isFinite(requested) || requested < 0) return 0;
  return Math.trunc(requested);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const offset = offsetOf(new URL(request.url).searchParams.get("offset"));

  try {
    const history = await fetchSwaps(id, ROWS, offset);
    // Serialised by the same function the page uses, so the shape the table hydrates
    // with and the shape it polls for cannot drift apart.
    return Response.json(serializeHistory(history), {
      headers: { "cache-control": "no-store" },
    });
  } catch (cause) {
    if (cause instanceof MarketNotFoundError) {
      return Response.json({ error: "No such market." }, { status: 404 });
    }
    if (cause instanceof FeedUnavailableError) {
      return Response.json({ error: "The market feed is not answering." }, { status: 503 });
    }
    throw cause;
  }
}
