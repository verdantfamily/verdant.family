/**
 * Taking a token's picture.
 *
 * Raw bytes on the body rather than multipart, because there is exactly one file and no
 * fields beside it — parsing a multipart envelope to find the only thing in it is
 * ceremony. The browser sends the `File` straight through `fetch`.
 */

import { NextResponse } from "next/server";

import { ImageError, MAX_BYTES, storeImage } from "../../lib/images";

/** Writes to the volume, so it cannot run at the edge. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // Checked before the body is read as well as after. The header is the uploader's
    // claim and is not trusted, but believing a small one costs nothing and refusing a
    // large one early avoids pulling megabytes into memory to reject them.
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      return NextResponse.json({ error: "That image is over the 2MB limit." }, { status: 413 });
    }

    const stored = await storeImage(await request.arrayBuffer());
    return NextResponse.json(stored, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ImageError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("[agen] storing an image failed:", error);
    return NextResponse.json({ error: "The image could not be saved." }, { status: 500 });
  }
}
