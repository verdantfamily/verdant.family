import { createAgentKey, regenerateAgentKey } from "../../../../../../lib/agents/service";
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
      return fail(Object.assign(new Error("No such agent."), { status: 404 }));
    }
    return ok({
      keys: ctx.store.listApiKeys(id).map((key) => ({
        id: key.id,
        prefix: key.prefix,
        createdAt: key.createdAt,
        revokedAt: key.revokedAt,
        lastUsedAt: key.lastUsedAt,
      })),
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const ctx = owner(request);
    const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
    const issued =
      body.regenerate === true
        ? regenerateAgentKey(ctx.address, id, ctx.store)
        : createAgentKey(ctx.address, id, ctx.store);
    return ok(
      {
        key: issued.secret,
        id: issued.id,
        prefix: issued.prefix,
        createdAt: issued.createdAt,
        shownOnce: true,
      },
      201,
    );
  } catch (error) {
    return fail(error);
  }
}
