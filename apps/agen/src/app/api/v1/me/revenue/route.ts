import { agentRevenue, claimAgentRevenue } from "../../../../lib/agents/service";
import { fail, ok, readJson } from "../../../../lib/agents/http";
import { agent, logAgent } from "../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = agent(request);
    logAgent(request, ctx.agent.id, ctx.key.id, 200, null);
    return ok(await agentRevenue(ctx.store, ctx.agent));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = agent(request, "launch");
    const body = await readJson(request);
    const token = typeof body.token === "string" ? body.token : "";
    const result = await claimAgentRevenue(ctx.store, { agent: ctx.agent, asOwner: false }, token);
    logAgent(request, ctx.agent.id, ctx.key.id, 200, null);
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
