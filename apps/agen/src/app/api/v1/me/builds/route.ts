import { agentStartBuild } from "../../../../lib/agents/service";
import { fail, ok, readJson } from "../../../../lib/agents/http";
import { agent, logAgent } from "../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = agent(request, "launch");
    const body = await readJson(request);
    const job = await agentStartBuild(ctx.store, ctx.agent, ctx.key.id, body);
    logAgent(request, ctx.agent.id, ctx.key.id, 202, null);
    return ok({ jobId: job.id, job }, 202);
  } catch (error) {
    return fail(error);
  }
}
