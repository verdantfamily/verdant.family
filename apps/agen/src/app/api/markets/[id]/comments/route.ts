/**
 * Comments on one token.
 *
 * GET is public. POST is a signed message from the wallet they already use to trade —
 * see `lib/comments.ts`. `no-store` on both: a room that caches is a room that looks
 * empty after somebody just spoke.
 */

import { NextResponse } from "next/server";

import { CommentError, listComments, postComment } from "../../../../lib/comments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const comments = await listComments(id);
  return NextResponse.json({ comments }, { headers: { "cache-control": "no-store" } });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  let body: {
    author?: string;
    text?: string;
    at?: number;
    signature?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "That was not a comment." }, { status: 400 });
  }

  if (
    typeof body.author !== "string" ||
    typeof body.text !== "string" ||
    typeof body.at !== "number" ||
    typeof body.signature !== "string" ||
    !body.signature.startsWith("0x")
  ) {
    return NextResponse.json({ error: "A comment needs a wallet, a line and a signature." }, { status: 400 });
  }

  try {
    const comment = await postComment({
      token: id,
      author: body.author,
      text: body.text,
      at: body.at,
      signature: body.signature as `0x${string}`,
    });
    return NextResponse.json({ comment }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof CommentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[agen] posting a comment failed:", error);
    return NextResponse.json({ error: "The comment could not be saved." }, { status: 500 });
  }
}
