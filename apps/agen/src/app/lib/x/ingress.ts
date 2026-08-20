import "server-only";

/**
 * The secret both delivery doors ask for.
 *
 * It lives here rather than in either route because both need it — a poll and a webhook are the
 * same authorisation question — and Next will not have one route file import another: a route
 * module may only export the handlers, so an exported helper is a build error rather than a
 * style problem. That is worth knowing, because the version of this that failed compiled fine
 * on every machine that ran `next dev` and only refused during `next build`.
 *
 * The comparison is constant time. A timing oracle on a bearer secret is a small thing to get
 * wrong and a tedious thing to discover.
 */

import { timingSafeEqual } from "node:crypto";

import { ingressSecret } from "./config";
import { XError } from "./errors";

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
