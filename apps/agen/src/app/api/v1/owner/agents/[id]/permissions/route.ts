import { AgentError } from "../../../../../../lib/agents/errors";
import { publicPermissions } from "../../../../../../lib/agents/permissions";
import { setAgentPermissions } from "../../../../../../lib/agents/service";
import { fail, ok, readJson } from "../../../../../../lib/agents/http";
import { owner } from "../../../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
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
    return ok({
      permissions: publicPermissions(ctx.store.getPermissions(id)),
      allowance: ctx.store.allowance(id, ctx.store.getPermissions(id)),
    });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const ctx = owner(request);
    const body = await readJson(request);
    const permissions = setAgentPermissions(ctx.address, id, body, ctx.store);
    return ok({ permissions: publicPermissions(permissions) });
  } catch (error) {
    return fail(error);
  }
}
