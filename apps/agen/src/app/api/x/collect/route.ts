/**
 * Sweep one market's outstanding creator fees to the seat's occupant.
 *
 * Agen pays the gas and cannot receive the money: `collect` pays whoever holds the seat, and this
 * refuses to run until the seat has left Agen's hands. A creator with an empty wallet can still
 * take their fees.
 */

import { collectFees } from "../../../lib/x/claim";
import { XError } from "../../../lib/x/errors";
import { fail, ok, readJson } from "../../../lib/x/http";
import { authenticateX } from "../../../lib/x/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const identity = authenticateX(request);
    const body = await readJson(request);

    const launchId = body.launchId;
    if (typeof launchId !== "string" || launchId === "") {
      throw new XError("VALIDATION_FAILED", "Name the launch to collect from.");
    }

    return ok(await collectFees(identity, launchId));
  } catch (error) {
    return fail(error);
  }
}
