/**
 * An Instant launch, encoded for the caller's own wallet.
 *
 * The server stores the metadata document and mines the salt — both have to happen before
 * the transaction can be encoded — and then answers with unsigned calldata. It holds no
 * key, signs nothing, and takes custody of nothing. Whoever owns `signer` decides whether
 * the launch happens.
 *
 * Counted against the launch limit rather than the read limit. Nothing here reaches the
 * chain, but it does write a document per call, and a preparation is an intent to launch.
 */

import { fail, ok, readJson } from "../../../../lib/agents/http";
import { AgentError } from "../../../../lib/agents/errors";
import { prepareInstantLaunch } from "../../../../lib/instant-prepare";
import { assertAgentOperable } from "../../../../lib/agents/permissions";
import { agent, logAgent } from "../../_context";
import { addressField, optionalString } from "../../_input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let ctx: ReturnType<typeof agent> | null = null;
  try {
    ctx = agent(request, "launch");
    assertAgentOperable(ctx.agent);

    const body = await readJson(request);

    const name = optionalString(body.name);
    const symbol = optionalString(body.symbol);
    const imageUrl = optionalString(body.imageUrl);
    if (name === undefined || symbol === undefined || imageUrl === undefined) {
      throw new AgentError(
        "VALIDATION_FAILED",
        "An Instant launch needs a name, ticker and imageUrl.",
      );
    }

    const prepared = await prepareInstantLaunch({
      name,
      symbol,
      imageUrl,
      signer: addressField(body.signer, "signer") ?? ctx.agent.walletAddress,
      description: optionalString(body.description),
      initialBuy: optionalString(body.initialBuy),
      feeReceiver: optionalString(body.feeReceiver),
      boostCapable: typeof body.boostCapable === "boolean" ? body.boostCapable : undefined,
      linkX: optionalString(body.linkX),
      website: optionalString(body.website),
      telegram: optionalString(body.telegram),
    });

    logAgent(request, ctx.agent.id, ctx.key.id, 200, null);
    return ok(prepared);
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
