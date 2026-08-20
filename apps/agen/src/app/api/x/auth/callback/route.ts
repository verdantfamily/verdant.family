/**
 * Where X sends the visitor back.
 *
 * Exchanges the code, sets the session cookie, and returns them to `/useagen`. A failure lands on
 * the same page with a reason in the query string rather than on a JSON error document: the person
 * at the end of this redirect is in a browser, and an object with an error code in it is not an
 * answer to somebody who just pressed "sign in".
 */

import { NextResponse } from "next/server";

import { XError } from "../../../../lib/x/errors";
import { completeSignIn } from "../../../../lib/x/oauth";
import { sessionCookie } from "../../../../lib/x/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function site(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  return configured === undefined || configured === "" ? "" : configured;
}

function back(params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString();
  return `${site()}/useagen${query === "" ? "" : `?${query}`}`;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");

  if (denied !== null) {
    return NextResponse.redirect(back({ signin: "cancelled" }));
  }
  if (code === null || state === null) {
    return NextResponse.redirect(back({ signin: "incomplete" }));
  }

  try {
    const result = await completeSignIn({ code, state });
    const response = NextResponse.redirect(back());
    response.headers.set("set-cookie", sessionCookie(result.token, result.expiresAt));
    return response;
  } catch (error) {
    const reason = error instanceof XError ? error.code : "failed";
    console.error("[agen:x] sign-in failed", error);
    return NextResponse.redirect(back({ signin: reason }));
  }
}
