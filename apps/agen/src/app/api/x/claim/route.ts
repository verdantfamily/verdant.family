/**
 * Offer the signed-in creator's seat to their wallet.
 *
 * Agen signs the invitation; the wallet signs the acceptance. This route returns the unsigned
 * `take` call so the interface can ask for that second signature without building calldata in a
 * browser — the same discipline as everywhere else in this codebase, where the server encodes and
 * the client only signs.
 */

import { offerSeat } from "../../../lib/x/claim";
import { fail, ok, readJson } from "../../../lib/x/http";
import { authenticateX } from "../../../lib/x/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const identity = authenticateX(request);
    const body = await readJson(request);
    return ok(await offerSeat(identity, body.wallet));
  } catch (error) {
    return fail(error);
  }
}
