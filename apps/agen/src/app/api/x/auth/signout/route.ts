/**
 * Forget the session.
 *
 * Nothing to revoke on X's side — no token was kept — so this is only the cookie going away.
 */

import { NextResponse } from "next/server";

import { clearedSessionCookie } from "../../../../lib/x/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const response = NextResponse.json(
    { ok: true, data: { signedOut: true } },
    { headers: { "cache-control": "no-store" } },
  );
  response.headers.set("set-cookie", clearedSessionCookie());
  return response;
}
