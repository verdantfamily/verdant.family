import { fail, ok } from "../../../../lib/agents/http";
import { agent, logAgent } from "../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = agent(request);
    logAgent(request, ctx.agent.id, ctx.key.id, 200, null);
    return ok({ activity: ctx.store.listActivity(ctx.agent.id, 200) });
  } catch (error) {
    return fail(error);
  }
}
