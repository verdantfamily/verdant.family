/**
 * Is this container up.
 *
 * Nothing else. It does not ask whether a model key works, whether Foundry is installed,
 * whether the job directory is writable or whether any market has ever built — all of
 * which are real questions, and none of which belong here. A health check that fails when
 * a dependency is degraded takes a service that could still serve every page it has and
 * removes it from the load balancer instead. Readiness to *build* is a separate question
 * and `/api/markets` already answers it.
 *
 * The path is not a choice. Railway applies this repository's root `railway.toml` to
 * every service deployed from it, the indexer's config sets `healthcheckPath = "/health"`,
 * and a deploy whose health check 404s is killed after five minutes regardless of how
 * well the server is running. The first version of this file was at `api/health`, which
 * serves `/api/health`, which is not the path being polled.
 */

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ ok: true, service: "agen" });
}
