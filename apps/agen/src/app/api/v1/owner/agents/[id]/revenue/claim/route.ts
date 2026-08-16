import { AgentError } from "../../../../../../../lib/agents/errors";
import { claimAgentRevenue } from "../../../../../../../lib/agents/service";
import { fail, ok, readJson } from "../../../../../../../lib/agents/http";
import { owner } from "../../../../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const ctx = owner(request);
    const agent = ctx.store.getAgent(id);
    if (agent === null || agent.ownerAddress.toLowerCase() !== ctx.address.toLowerCase()) {
      throw new AgentError("AGENT_NOT_FOUND", "No such agent.");
    }
    const body = await readJson(request);
    const token = typeof body.token === "string" ? body.token : "";
    return ok(await claimAgentRevenue(ctx.store, { agent, asOwner: true }, token));
  } catch (error) {
    return fail(error);
  }
}
