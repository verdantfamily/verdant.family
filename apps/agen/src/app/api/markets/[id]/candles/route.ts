/**
 * The series behind the chart, refetched while a token page is open.
 *
 * A thin route over `lib/feed`, and it exists rather than the chart calling the indexer
 * directly for two reasons. The indexer's address is a server-side setting — a browser
 * that knew it would be a browser that could be pointed at a different one — and the
 * filling of empty buckets happens on this side, so every consumer of a series gets the
 * same gapless shape rather than each one deciding what to do with a hole.
 *
 * `no-store`, always. This is the one thing on the page whose whole job is to be current,
 * and a cached response is a chart that has stopped.
 */

import { NextResponse } from "next/server";

import { candles } from "@verdant/sdk";

import { serializeSeries } from "../../../../lib/candles";
import { fetchCandles } from "../../../../lib/feed";
import { buildStoreSource } from "../../../../lib/markets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BUCKETS = 1_000;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const query = new URL(request.url).searchParams;

  const interval = query.get("interval") ?? "5m";
  if (!candles.isCandleInterval(interval)) {
    return NextResponse.json({ error: `unknown interval "${interval}"` }, { status: 400 });
  }

  const requested = Number(query.get("limit") ?? "240");
  const limit =
    Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_BUCKETS) : 240;

  // The indexer keys markets by pool id, and this page is addressed by build id. The
  // build store is what knows the mapping, and a market that has not launched has no
  // pool at all — which is an empty series rather than an error.
  const market = await buildStoreSource().read(id);
  const poolId = market?.poolId ?? null;

  if (poolId === null) {
    return NextResponse.json({ series: null }, { headers: { "cache-control": "no-store" } });
  }

  const series = await fetchCandles(poolId, interval, limit, true);

  return NextResponse.json(
    { series: series === null ? null : serializeSeries(series) },
    { headers: { "cache-control": "no-store" } },
  );
}
