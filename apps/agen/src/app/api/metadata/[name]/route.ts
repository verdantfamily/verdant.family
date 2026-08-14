/**
 * Serving what a token says about itself.
 *
 * Cached immutably, which is safe because the name is the hash of the bytes: this URL
 * cannot ever answer with something different. That property is the point rather than a
 * performance note — the address is written into a token at creation with
 * `metadataMutable` false, so nothing can repoint it and nothing should need to.
 */

import { NextResponse } from "next/server";

import { readMetadata } from "../../../lib/metadata";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const { name } = await context.params;
  const document = await readMetadata(name);

  if (document === null) {
    return NextResponse.json({ error: "No such token document." }, { status: 404 });
  }

  return new NextResponse(document, {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=31536000, immutable",
      // Read by wallets and explorers from other origins, and it is public anyway.
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}
