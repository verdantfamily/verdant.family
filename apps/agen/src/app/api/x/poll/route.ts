/**
 * Ask X for new mentions and act on them.
 *
 * A cron target rather than a public endpoint, and authenticated because it spends money: a
 * poll can end in a sponsored launch, so an open version of this would be a way to make Agen
 * pay for gas on demand. The secret is compared in constant time — a timing oracle on a bearer
 * secret is a small thing to get wrong and a tedious thing to discover.
 *
 * `GET` answers the same way as `POST` so that a cron product which only issues GETs can drive
 * it. Both mutate, which is why neither is cacheable and both require the secret.
 */

import { timingSafeEqual } from "node:crypto";

import { ingressSecret } from "../../../lib/x/config";
import { XError } from "../../../lib/x/errors";
import { fail, ok } from "../../../lib/x/http";
import { pollOnce } from "../../../lib/x/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The presented secret matches the configured one. Length-checked first, as `timingSafeEqual` requires. */
export function authorise(request: Request): void {
  const expected = ingressSecret();
  if (expected === null) {
    throw new XError("CONFIG_MISSING", "X_INGRESS_SECRET is not set, so this endpoint is closed.");
  }

  const header = request.headers.get("authorization");
  const presented =
    (header === null ? null : /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim()) ??
    request.headers.get("x-agen-x-secret");

  if (presented === null || presented === undefined) {
    throw new XError("UNAUTHENTICATED", "This endpoint needs the ingress secret.");
  }

  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new XError("UNAUTHENTICATED", "That is not the ingress secret.");
  }
}

async function run(request: Request): Promise<Response> {
  try {
    authorise(request);

    const asked = Number(new URL(request.url).searchParams.get("limit") ?? "");
    const bounded = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 100) : null;

    return ok(await pollOnce(bounded === null ? {} : { limit: bounded }));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  return run(request);
}

export async function GET(request: Request): Promise<Response> {
  return run(request);
}
