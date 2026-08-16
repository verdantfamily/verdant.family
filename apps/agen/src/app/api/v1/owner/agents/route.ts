import { publicPermissions } from "../../../../lib/agents/permissions";
import { createAgent, publicAgentView } from "../../../../lib/agents/service";
import { fail, ok, readJson } from "../../../../lib/agents/http";
import { owner } from "../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = owner(request);
    const agents = ctx.store.listOwnerAgents(ctx.address).map((agent) =>
      publicAgentView(agent, { permissions: ctx.store.getPermissions(agent.id) }),
    );
    return ok({ agents });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = owner(request);
    const body = await readJson(request);
    const created = createAgent(
      ctx.address,
      {
        name: typeof body.name === "string" ? body.name : "",
        username: typeof body.username === "string" ? body.username : "",
        description: typeof body.description === "string" ? body.description : "",
        imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : null,
        permissions: body.permissions,
      },
      ctx.store,
    );
    return ok(
      {
        agent: publicAgentView(created.agent, { permissions: created.permissions }),
        permissions: publicPermissions(created.permissions),
      },
      201,
    );
  } catch (error) {
    return fail(error);
  }
}
