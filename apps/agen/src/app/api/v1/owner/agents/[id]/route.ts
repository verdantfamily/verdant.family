import { publicPermissions } from "../../../../../lib/agents/permissions";
import { publicAgentView, updateAgentProfile } from "../../../../../lib/agents/service";
import { AgentError } from "../../../../../lib/agents/errors";
import { fail, ok, readJson } from "../../../../../lib/agents/http";
import { owner } from "../../../_context";

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
      agent: publicAgentView(agent, { permissions: ctx.store.getPermissions(agent.id) }),
      keys: ctx.store.listApiKeys(agent.id).map((key) => ({
        id: key.id,
        prefix: key.prefix,
        createdAt: key.createdAt,
        revokedAt: key.revokedAt,
        lastUsedAt: key.lastUsedAt,
      })),
      launches: ctx.store.listLaunches(agent.id),
      allowance: ctx.store.allowance(agent.id, ctx.store.getPermissions(agent.id)),
    });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const ctx = owner(request);
    const body = await readJson(request);
    const agent = updateAgentProfile(
      ctx.address,
      id,
      {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(body.imageUrl === null || typeof body.imageUrl === "string" ? { imageUrl: body.imageUrl as string | null } : {}),
      },
      ctx.store,
    );
    return ok({
      agent: publicAgentView(agent, { permissions: ctx.store.getPermissions(agent.id) }),
      permissions: publicPermissions(ctx.store.getPermissions(agent.id)),
    });
  } catch (error) {
    return fail(error);
  }
}
