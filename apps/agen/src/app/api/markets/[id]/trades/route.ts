/**
 * The trade list, refetched while a token page is open.
 *
 * The page renders the trades it had when it was served, and until now that was all it ever
 * showed: a market could take twenty swaps while somebody watched, and the list under the
 * chart would not move until they reloaded. The chart was live and the history beside it was
 * a photograph.
 *
 * A thin route over `marketSource().trades`, for the same reasons the candles route exists
 * beside it. The indexer's address is a server-side setting — a browser that knew it could
 * be pointed at a different one — and the shape a page wants is assembled here rather than
 * in each consumer.
 *
 * `no-store`, always. This is one of the two things on the page whose whole job is to be
 * current, and a cached response is a feed that has stopped.
 */

import { NextResponse } from "next/server";

import { marketSource } from "../../../../lib/markets";
import { poolFor } from "../../../../lib/pool-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  // A market with no pool has no trades and is not an error. Asked through `poolFor` so the
  // per-second poll does not re-resolve the market from the chain each time.
  const market = await poolFor(id);
  if (market === null) {
    return NextResponse.json({ trades: [] }, { headers: { "cache-control": "no-store" } });
  }

  const trades = await marketSource().trades(id);

  /*
   * `amountEth` is a float already and every other figure here is a number, so nothing needs
   * widening on the way out — unlike a candle series, whose prices are `bigint` at 36
   * decimals precisely because a float would lose them.
   */
  return NextResponse.json({ trades }, { headers: { "cache-control": "no-store" } });
}
