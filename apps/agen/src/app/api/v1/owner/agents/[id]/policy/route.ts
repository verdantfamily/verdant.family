import { autonomyView, setAgentPolicy } from "../../../../../../lib/agents/autonomy";
import { fail, ok, readJson } from "../../../../../../lib/agents/http";
import { owner } from "../../../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const ctx = owner(request);
    const body = await readJson(request);
    setAgentPolicy(ctx.address, id, body, ctx.store);
    return ok({ autonomy: autonomyView(ctx.store, id) });
  } catch (error) {
    return fail(error);
  }
}
