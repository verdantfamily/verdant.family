import { publicAgentView } from "../../../lib/agents/service";
import { fail, ok } from "../../../lib/agents/http";
import { agent, logAgent } from "../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = agent(request);
    logAgent(request, ctx.agent.id, ctx.key.id, 200, null);
    ctx.store.recordActivity({ agentId: ctx.agent.id, type: "api_accepted", payload: { path: "/api/v1/me" } });
    return ok({
      agent: publicAgentView(ctx.agent, { permissions: ctx.store.getPermissions(ctx.agent.id) }),
    });
  } catch (error) {
    return fail(error);
  }
}
