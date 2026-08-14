/**
 * Recording what a token says about itself, just before it is created.
 *
 * Written here rather than by the client because the document is served back from this
 * origin and its address is written into a token that can never repoint it. See
 * `lib/metadata.ts` for what is copied out of the request and what is dropped.
 */

import { NextResponse } from "next/server";

import { MetadataError, storeMetadata } from "../../lib/metadata";

/** Writes to the volume, so it cannot run at the edge. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const stored = await storeMetadata(await request.json());
    return NextResponse.json(stored, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof MetadataError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("[agen] storing token metadata failed:", error);
    return NextResponse.json({ error: "The token details could not be saved." }, { status: 500 });
  }
}
