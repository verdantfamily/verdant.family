/**
 * The push door, for a deployment whose X access includes activity webhooks.
 *
 * Deliberately thin. It authenticates the caller, pulls post ids out of whatever it was sent,
 * and hands each one to the same `ingestPostId` a poll would use — which re-reads the post from
 * X before anything acts on it. So this route parses no X semantics, trusts no field of the
 * body, and shares every guard, limit and idempotency check with polling. Swapping delivery
 * methods is a configuration change, not a code path.
 *
 * ## Duplicates
 *
 * X redelivers. Two defences, in order: the raw envelope is recorded by hash so an identical
 * redelivery is dropped without work, and each mention is claimed by post id in the store so a
 * *differently shaped* delivery of the same mention still cannot launch twice. The second is the
 * one that actually guarantees it; the first only saves the effort.
 *
 * ## GET is a challenge response
 *
 * X verifies a webhook by asking it to sign a token. Answered here because the alternative is a
 * second route for one field, and it needs the same credentials this file already reads.
 */

import { createHmac, createHash } from "node:crypto";

import { ingressSecret, writeCredentials } from "../../../lib/x/config";
import { XError } from "../../../lib/x/errors";
import { fail, ok } from "../../../lib/x/http";
import { ingestPostId, postIdsFrom } from "../../../lib/x/ingest";
import { authorise } from "../../../lib/x/ingress";
import { xStore } from "../../../lib/x/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many mentions one delivery may carry. A batch larger than this is not a batch. */
const MAX_PER_DELIVERY = 10;

export async function GET(request: Request): Promise<Response> {
  try {
    const token = new URL(request.url).searchParams.get("crc_token");
    if (token === null) {
      // Not a challenge. Answering with readiness rather than an error makes this a usable
      // health check for an operator who has just configured the URL.
      return ok({ ready: ingressSecret() !== null && writeCredentials() !== null });
    }

    const credentials = writeCredentials();
    if (credentials === null) {
      throw new XError("CONFIG_MISSING", "The bot's API secret is not configured.");
    }

    const signature = createHmac("sha256", credentials.apiSecret).update(token).digest("base64");
    return Response.json(
      { response_token: `sha256=${signature}` },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    authorise(request);

    const raw = await request.text();
    const store = xStore();

    // The envelope, by content hash. A redelivery of the same bytes stops here.
    const key = createHash("sha256").update(raw).digest("hex");
    if (!store.markEvent(key, "webhook")) {
      return ok({ duplicate: true, handled: 0 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      throw new XError("VALIDATION_FAILED", "That delivery was not JSON.");
    }

    const ids = postIdsFrom(payload).slice(0, MAX_PER_DELIVERY);
    const outcomes = [];
    for (const id of ids) {
      const outcome = await ingestPostId(id, { store });
      if (outcome !== null) outcomes.push({ id, ...outcome });
    }

    return ok({ duplicate: false, seen: ids.length, handled: outcomes.length, outcomes });
  } catch (error) {
    return fail(error);
  }
}
