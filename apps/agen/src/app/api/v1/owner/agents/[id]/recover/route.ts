/**
 * Owner treasury recovery.
 *
 * Owner session only — an agent API key cannot reach this route, and neither can
 * the agent. The destination is not accepted from the request: `sendOwnerRecovery`
 * reads it from the agent's own row, so there is nothing here to tamper with.
 */

import { fail, ok } from "../../../../../../lib/agents/http";
import { recoverTreasury } from "../../../../../../lib/agents/recovery";
import { owner } from "../../../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const ctx = owner(request);
    const result = await recoverTreasury(ctx.address, id, ctx.store);
    return ok({ recovery: result });
  } catch (error) {
    return fail(error);
  }
}
