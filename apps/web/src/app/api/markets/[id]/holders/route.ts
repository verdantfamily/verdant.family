/**
 * A market's holders, for the holders tab to page through.
 *
 * A sibling of the swaps route, and it exists for the same reason: the indexer is a
 * server-side address, so a table that wants a page its server render did not include
 * has nowhere else to ask.
 *
 * `totalSupply` is echoed back on every page rather than left to the caller, so the
 * share of supply each row shows is computed against the supply the same response
 * counted — a percentage taken against a figure from a different request is a
 * percentage that can quietly exceed a hundred.
 */
import { FeedUnavailableError, MarketNotFoundError, fetchHolders } from "../../../../../lib/feed";
import { serializeHolders } from "../../../../../lib/trades";

/** As many rows as the table shows, and no more. */
const ROWS = 25;

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
    const page = await fetchHolders(id, ROWS, offset, true);
    return Response.json(serializeHolders(page), {
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
