import { approveDecision, publicDecision } from "../../../../../../../../lib/agents/autonomy";
import { fail, ok } from "../../../../../../../../lib/agents/http";
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
    const result = await approveDecision(ctx.address, id, decisionId, ctx.store);
    return ok({ decision: publicDecision(result.decision), executed: result.executed });
  } catch (error) {
    return fail(error);
  }
}
