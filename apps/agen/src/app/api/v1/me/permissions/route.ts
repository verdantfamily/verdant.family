import { publicPermissions } from "../../../../lib/agents/permissions";
import { rejectAgentSelfModify } from "../../../../lib/agents/service";
import { fail, ok } from "../../../../lib/agents/http";
import { agent, logAgent } from "../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = agent(request);
    logAgent(request, ctx.agent.id, ctx.key.id, 200, null);
    return ok({ permissions: publicPermissions(ctx.store.getPermissions(ctx.agent.id)) });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    agent(request);
    rejectAgentSelfModify();
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  return PUT(request);
}
