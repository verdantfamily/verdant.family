import { publicAgentView, setAgentStatus } from "../../../../../../lib/agents/service";
import { fail, ok } from "../../../../../../lib/agents/http";
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
    const agent = setAgentStatus(ctx.address, id, "archived", ctx.store);
    return ok({ agent: publicAgentView(agent) });
  } catch (error) {
    return fail(error);
  }
}
