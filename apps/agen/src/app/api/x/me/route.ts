/**
 * Everything the signed-in X account has launched, and what it has earned.
 *
 * Keyed on the id inside the signed session, never on anything in the request — which is the
 * whole security model of this endpoint in one sentence: there is no parameter naming whose
 * launches to return, so there is nothing to tamper with.
 */

import { creatorView } from "../../../lib/x/claim";
import { fail, ok } from "../../../lib/x/http";
import { authenticateX } from "../../../lib/x/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const identity = authenticateX(request);
    return ok(await creatorView(identity));
  } catch (error) {
    return fail(error);
  }
}
