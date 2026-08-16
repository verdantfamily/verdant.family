import { agentLaunchBuild } from "../../../../../../lib/agents/service";
import { fail, ok, readJson } from "../../../../../../lib/agents/http";
import { agent, logAgent } from "../../../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const ctx = agent(request, "launch");
    const body = await readJson(request).catch(() => ({}));
    const result = await agentLaunchBuild(ctx.store, ctx.agent, ctx.key.id, id, body);
    logAgent(request, ctx.agent.id, ctx.key.id, 201, null);
    return ok(result, 201);
  } catch (error) {
    return fail(error);
  }
}
