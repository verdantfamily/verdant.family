/**
 * Serving a token's picture.
 *
 * Cached immutably, which is safe because the name is the hash of the bytes: this URL
 * cannot ever answer with something different, so there is nothing for a cache to get
 * wrong. That property is doing more work than performance — the address is written into
 * a token's metadata at launch and is fixed for the life of the market.
 */

import { NextResponse } from "next/server";

import { readImage } from "../../../lib/images";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const { name } = await context.params;
  const image = await readImage(name);

  if (image === null) {
    return NextResponse.json({ error: "No such image." }, { status: 404 });
  }

  return new NextResponse(image.body as unknown as BodyInit, {
    headers: {
      "content-type": image.mime,
      "cache-control": "public, max-age=31536000, immutable",
      // The bytes are an upload. Nothing should ever be persuaded to run them.
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}
