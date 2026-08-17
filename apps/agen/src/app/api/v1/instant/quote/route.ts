/**
 * What an Instant launch would do, on the record but off the chain.
 *
 * Read-only: no document is stored, no salt is reserved, no transaction is created and
 * nothing is signed. It is a `POST` because it carries a draft, not because it writes.
 *
 * Authenticated with an ordinary agent API key and counted against the read limit, so it
 * adds no unauthenticated surface and no separate quota. `creator` and `feeReceiver` may
 * name any address — a quote about somebody else's launch reveals nothing that
 * `InstantFactory`'s constants do not already state, and the launch itself still has to be
 * signed by whoever owns the address.
 */

import { fail, ok, readJson } from "../../../../lib/agents/http";
import { AgentError } from "../../../../lib/agents/errors";
import { quoteInstantLaunch } from "../../../../lib/instant-quote";
import { agent, logAgent } from "../../_context";
import { addressField, optionalString } from "../../_input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let ctx: ReturnType<typeof agent> | null = null;
  try {
    ctx = agent(request, "read");
    const body = await readJson(request);

    const name = optionalString(body.name) ?? "";
    const symbol = optionalString(body.symbol) ?? "";
    if (name.trim() === "" || symbol.trim() === "") {
      throw new AgentError("VALIDATION_FAILED", "A quote needs a name and a ticker.");
    }

    const quote = await quoteInstantLaunch({
      name,
      symbol,
      creator: addressField(body.creator, "creator") ?? ctx.agent.walletAddress,
      initialBuy: optionalString(body.initialBuy),
      feeReceiver: optionalString(body.feeReceiver),
      boostCapable: typeof body.boostCapable === "boolean" ? body.boostCapable : undefined,
      imageUrl: optionalString(body.imageUrl),
    });

    logAgent(request, ctx.agent.id, ctx.key.id, 200, null);
    return ok(quote);
  } catch (error) {
    if (ctx !== null) {
      logAgent(
        request,
        ctx.agent.id,
        ctx.key.id,
        error instanceof AgentError ? error.status : 500,
        error instanceof AgentError ? error.code : "VALIDATION_FAILED",
      );
    }
    return fail(error);
  }
}
