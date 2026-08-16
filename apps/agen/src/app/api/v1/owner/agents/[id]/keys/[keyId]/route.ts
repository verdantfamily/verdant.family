import { revokeAgentKey } from "../../../../../../../lib/agents/service";
import { fail, ok } from "../../../../../../../lib/agents/http";
import { owner } from "../../../../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; keyId: string }> },
): Promise<Response> {
  try {
    const { id, keyId } = await context.params;
    const ctx = owner(request);
    revokeAgentKey(ctx.address, id, keyId, ctx.store);
    return ok({ revoked: true, keyId });
  } catch (error) {
    return fail(error);
  }
}
