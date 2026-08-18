/**
 * The conversation between an owner and their agent.
 *
 * Owner-authenticated, like every route in this folder, and deliberately not available to
 * an API key: a key is how the agent acts, and this is how its owner talks to it. The two
 * are different powers and giving a key the ability to write standing instructions would
 * let a leaked key change what the agent does forever rather than only what it does once.
 *
 * Nothing here executes. See `chat.ts`.
 */

import { sendChatMessage } from "../../../../../../lib/agents/chat";
import { fail, ok, readJson } from "../../../../../../lib/agents/http";
import { owned } from "../../../../../../lib/agents/service";
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
    owned(ctx.store, ctx.address, id);
    return ok({ turns: ctx.store.listChat(id) });
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
    const agent = owned(ctx.store, ctx.address, id);

    const body = await readJson(request);
    const result = await sendChatMessage(
      ctx.store,
      agent,
      typeof body.message === "string" ? body.message : "",
    );

    return ok({ turns: result.turns, filed: result.filed });
  } catch (error) {
    return fail(error);
  }
}
