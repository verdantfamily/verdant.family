/**
 * The endpoint that launches a market Agen pays for.
 *
 * Open, in the sense that it takes no key and no session — that is the product, and it is why
 * every guard lives one layer down in `lib/instant-sponsor.ts` rather than here. A route that
 * decided anything about spending would be a route where a later edit could stop deciding it.
 *
 * What this file does is turn a request into a value, a value into a launch, and a refusal into
 * a status code. Nothing else.
 */

import { NextResponse } from "next/server";

import {
  launchSponsoredFromWeb,
  readRequest,
  webSponsorProblems,
} from "../../../lib/instant-sponsor";
import { XError } from "../../../lib/x/errors";

/** Signs, spends and writes to the ledger volume, so it cannot run at the edge or be cached. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether the form should offer the toggle at all, so a page never shows a switch that fails. */
export function GET(): NextResponse {
  const problems = webSponsorProblems();
  return NextResponse.json(
    { available: problems.length === 0 },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "That is not a launch." }, { status: 400 });
  }

  try {
    const launched = await launchSponsoredFromWeb(readRequest(body));
    return NextResponse.json(launched, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof XError) {
      /*
       * The message, not just the code, and the difference from the bot matters.
       *
       * `speakable` exists because telling a scripted X account which limit it hit tells it what
       * to change. Here the person is looking at a form and the alternative to a reason is a
       * button that does nothing, so the refusal is shown. Nothing in these messages names a
       * remaining quota or a threshold — see the copy in `instant-sponsor.ts` — which is what
       * keeps that honest rather than merely friendlier.
       */
      console.error(`[agen] sponsored web launch refused (${error.code}):`, error.message);
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }

    console.error("[agen] sponsored web launch failed:", error);
    return NextResponse.json(
      { error: "The launch could not be completed. Nothing was created." },
      { status: 500 },
    );
  }
}
