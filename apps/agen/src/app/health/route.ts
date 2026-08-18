/**
 * Is this container ready to be sent traffic.
 *
 * Nearly nothing else. It does not ask whether a model key works, whether Foundry is
 * installed, whether the job directory is writable or whether any market has ever built —
 * all of which are real questions, and none of which belong here. A health check that
 * fails when a dependency is degraded takes a service that could still serve every page it
 * has and removes it from the load balancer instead. Readiness to *build* is a separate
 * question and `/api/markets` already answers it.
 *
 * The one thing it does wait for is the shelf, and only at boot. Railway holds traffic on
 * the old container until this passes, so answering `ok` before the catalogue had been
 * read once meant every deploy put a cold container in front of visitors and someone saw a
 * page with no tokens on it. `shelf-warmup` bounds the wait, so this cannot keep a
 * container out of service over a feed that is down — see the reasoning there.
 *
 * The path is not a choice. Railway applies this repository's root `railway.toml` to
 * every service deployed from it, the indexer's config sets `healthcheckPath = "/health"`,
 * and a deploy whose health check 404s is killed after five minutes regardless of how
 * well the server is running. The first version of this file was at `api/health`, which
 * serves `/api/health`, which is not the path being polled.
 */

import { shelfReady } from "../lib/shelf-warmup";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const ready = shelfReady();

  return Response.json(
    { ok: ready, service: "agen", ...(ready ? {} : { waitingFor: "shelf" }) },
    { status: ready ? 200 : 503 },
  );
}
