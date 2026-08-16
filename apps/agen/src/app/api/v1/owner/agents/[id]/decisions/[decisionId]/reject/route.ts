import { publicDecision, rejectDecision } from "../../../../../../../../lib/agents/autonomy";
import { fail, ok, readJson } from "../../../../../../../../lib/agents/http";
import { owner } from "../../../../../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; decisionId: string }> },
): Promise<Response> {
  try {
    const { id, decisionId } = await context.params;
    const ctx = owner(request);
    const body = await readJson(request);
    const decision = rejectDecision(ctx.address, id, decisionId, body.note, ctx.store);
    return ok({ decision: publicDecision(decision) });
  } catch (error) {
    return fail(error);
  }
}
