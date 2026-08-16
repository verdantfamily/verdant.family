import { AgentError } from "../../../../../lib/agents/errors";
import { fail, ok } from "../../../../../lib/agents/http";
import { agent, logAgent } from "../../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const ctx = agent(request);
    const launch = ctx.store.getLaunch(id);
    if (launch === null || launch.agentId !== ctx.agent.id) {
      throw new AgentError("LAUNCH_NOT_FOUND", "No such launch.");
    }
    logAgent(request, ctx.agent.id, ctx.key.id, 200, null);
    return ok({ launch });
  } catch (error) {
    return fail(error);
  }
}
