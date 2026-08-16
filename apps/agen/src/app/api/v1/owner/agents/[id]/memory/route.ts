/**
 * Agent memory.
 *
 * The table and the read path exist; nothing writes to it automatically. Phase 2
 * deliberately stops at "an owner can tell an agent something it will remember" —
 * an agent that writes its own memory needs a decay and contradiction story that
 * is a design problem in its own right, and inventing one silently here would make
 * every later cycle depend on it.
 */

import { AgentError } from "../../../../../../lib/agents/errors";
import { fail, ok, readJson } from "../../../../../../lib/agents/http";
import { owned } from "../../../../../../lib/agents/service";
import { owner } from "../../../../_context";
import { MEMORY_KINDS, type MemoryKind } from "../../../../../../lib/agents/types";

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
    return ok({ memory: ctx.store.listMemory(id) });
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
    owned(ctx.store, ctx.address, id);

    const body = await readJson(request);
    const content = typeof body.content === "string" ? body.content.trim().slice(0, 2_000) : "";
    if (content === "") {
      throw new AgentError("VALIDATION_FAILED", "A memory needs something written in it.");
    }

    const kind = String(body.kind ?? "fact");
    if (!(MEMORY_KINDS as readonly string[]).includes(kind)) {
      throw new AgentError("VALIDATION_FAILED", `"${kind}" is not a kind of memory.`);
    }

    const memory = ctx.store.insertMemory({
      agentId: id,
      kind: kind as MemoryKind,
      content,
      source: "owner",
    });
    return ok({ memory });
  } catch (error) {
    return fail(error);
  }
}
