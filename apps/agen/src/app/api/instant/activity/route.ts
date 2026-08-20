/**
 * The Instant tape, for the strip on Explore.
 *
 * Thin over `instantTape` so the homepage can poll without re-rendering sixteen cards,
 * and so the indexer's address stays a server-side setting.
 */

import { NextResponse } from "next/server";

import { instantTape } from "../../../lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const items = await instantTape();
  return NextResponse.json({ items }, { headers: { "cache-control": "no-store" } });
}
