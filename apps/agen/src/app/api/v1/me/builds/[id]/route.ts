import { readAgentBuild } from "../../../../../lib/agents/service";
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
    const job = await readAgentBuild(ctx.store, ctx.agent.id, id);
    logAgent(request, ctx.agent.id, ctx.key.id, 200, null);
    return ok({ job });
  } catch (error) {
    return fail(error);
  }
}
