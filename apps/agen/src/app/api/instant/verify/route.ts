/**
 * Ask for a launched Instant token to be source-verified.
 *
 * Answers before the work starts. Verification takes up to two minutes of waiting on an
 * explorer to index a block, and none of that is anything a creator should watch: the
 * launch has already mined by the time this is called, the token is already tradable, and
 * a Blockscout outage must produce an unverified token rather than a launch that looks
 * like it failed.
 *
 * So this route accepts, starts a detached job, and returns `202`. The browser fires it
 * without awaiting the answer and ignores the response entirely — see `preview.tsx`.
 *
 * ## Why it is safe to expose
 *
 * Two independent reasons, either of which would be enough.
 *
 * The address must be a market in Instant's own registry. Anything else is a 404, so this
 * cannot be used to attach Agen's verification to a contract Agen did not launch.
 *
 * And the payload is derived from the deployed bytecode rather than from the request. The
 * body carries one field — which token — and every constructor argument is read back off
 * that token's own getters. A caller who lied about what a contract is would produce
 * arguments that do not match its creation bytecode, and the explorer would refuse it.
 *
 * There is no key here and none is needed. Verification is a claim about source matching
 * bytecode, which anybody can make and everybody can check; it is not an authorisation.
 */

import { NextResponse } from "next/server";
import { isAddress } from "viem";

import { verifyInstantToken } from "../../../lib/instant-verify";
import { readInstantMarket } from "../../../lib/instant-markets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let token: unknown;
  try {
    ({ token } = (await request.json()) as { token?: unknown });
  } catch {
    return NextResponse.json({ error: "expected a JSON body" }, { status: 400 });
  }

  if (typeof token !== "string" || !isAddress(token)) {
    return NextResponse.json({ error: "token must be an address" }, { status: 400 });
  }

  // Instant's registry is the gate. `readInstantMarket` returns null for an address it
  // does not know, which is the ordinary case for anything else on the chain.
  const market = await readInstantMarket(token);
  if (market === null) {
    return NextResponse.json({ error: "not an Instant market" }, { status: 404 });
  }

  /*
   * Detached on purpose, and safe because this process outlives the request.
   *
   * The same shape `lib/builds.ts` uses for a market build: the work is started, the
   * response goes out, and the promise is left running in the server that served it. The
   * rejection handler is not optional — an unhandled rejection here would take down a web
   * server over an explorer being slow.
   */
  void verifyInstantToken(token).catch(() => undefined);

  return NextResponse.json({ status: "accepted", token }, { status: 202 });
}
