import { publicPermissions } from "../../../../lib/agents/permissions";
import { summariseAgent } from "../../../../lib/agents/public";
import { createAgent, publicAgentView } from "../../../../lib/agents/service";
import { fail, ok, readJson } from "../../../../lib/agents/http";
import { owner } from "../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = owner(request);
    // Counted the same way a stranger's view of the same agent is counted, and each
    // of those counts reaches the chain, so this list is slower than reading the
    // records. An owner deciding whether to fund an agent is the one reader who
    // cannot be handed a placebo zero.
    const agents = await Promise.all(
      ctx.store.listOwnerAgents(ctx.address).map(async (agent) => ({
        ...(await summariseAgent(ctx.store, agent)),
        permissions: publicPermissions(ctx.store.getPermissions(agent.id)),
      })),
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
