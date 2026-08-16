import { publicPermissions } from "../../../../lib/agents/permissions";
import { fail, ok } from "../../../../lib/agents/http";
import { agent, logAgent } from "../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = agent(request);
    const permissions = ctx.store.getPermissions(ctx.agent.id);
    logAgent(request, ctx.agent.id, ctx.key.id, 200, null);
    return ok({
      permissions: publicPermissions(permissions),
      allowance: ctx.store.allowance(ctx.agent.id, permissions),
    });
  } catch (error) {
    return fail(error);
  }
}
