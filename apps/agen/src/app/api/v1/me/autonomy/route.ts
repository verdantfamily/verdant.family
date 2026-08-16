/**
 * What an agent can learn about its own autonomy: everything, and read-only.
 *
 * There is no PUT here and there will not be one. An agent that could edit its
 * own objective, widen its own policy or switch itself on would make every owner
 * control advisory, and an API key is exactly the credential most likely to leak.
 */

import { autonomyView } from "../../../../lib/agents/autonomy";
import { fail, ok } from "../../../../lib/agents/http";
import { agent, logAgent } from "../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = agent(request);
    const view = autonomyView(ctx.store, ctx.agent.id);
    logAgent(request, ctx.agent.id, ctx.key.id, 200, null);
    return ok({ autonomy: view });
  } catch (error) {
    return fail(error);
  }
}
