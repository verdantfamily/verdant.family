import { AgentError } from "../../../../../../lib/agents/errors";
import { agentRevenue } from "../../../../../../lib/agents/service";
import { fail, ok } from "../../../../../../lib/agents/http";
import { owner } from "../../../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const ctx = owner(request);
    const agent = ctx.store.getAgent(id);
    if (agent === null || agent.ownerAddress.toLowerCase() !== ctx.address.toLowerCase()) {
      throw new AgentError("AGENT_NOT_FOUND", "No such agent.");
    }
    return ok(await agentRevenue(ctx.store, agent));
  } catch (error) {
    return fail(error);
  }
}
