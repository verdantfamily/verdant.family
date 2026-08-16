import { agentInstantLaunch } from "../../../../../lib/agents/service";
import { fail, ok, readJson } from "../../../../../lib/agents/http";
import { AgentError } from "../../../../../lib/agents/errors";
import { agent, logAgent } from "../../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let ctx: ReturnType<typeof agent> | null = null;
  try {
    ctx = agent(request, "launch");
    const body = await readJson(request);
    const result = await agentInstantLaunch(ctx.store, ctx.agent, ctx.key.id, body);
    logAgent(request, ctx.agent.id, ctx.key.id, 201, null);
    return ok(result, 201);
  } catch (error) {
    if (ctx !== null) {
      logAgent(
        request,
        ctx.agent.id,
        ctx.key.id,
        error instanceof AgentError ? error.status : 500,
        error instanceof AgentError ? error.code : "VALIDATION_FAILED",
      );
      if (error instanceof AgentError && error.code.startsWith("PERMISSION")) {
        ctx.store.recordActivity({
          agentId: ctx.agent.id,
          type: "permission_rejected",
          payload: { code: error.code, permission: error.permission },
        });
      }
    }
    return fail(error);
  }
}
