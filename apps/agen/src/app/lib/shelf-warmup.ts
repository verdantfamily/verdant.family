/**
 * Whether this container is ready to be shown to anyone.
 *
 * Railway keeps the previous container serving until the new one's health check passes,
 * which is the whole mechanism for a deploy nobody notices. `/health` answered `ok` the
 * moment Next was listening, so the switch happened while the shelf was still cold: the
 * first request to arrive was the one that had to fetch the feed, and a visitor who
 * happened to be that request saw a page with no tokens on it. Every redeploy had a window
 * of a few seconds where the catalogue looked empty, which is exactly the complaint.
 *
 * So the check waits for the shelf instead. `register` reads it once at boot and reports
 * here, and until that lands the container says it is not ready and keeps its traffic on
 * the old one.
 *
 * ## Why it gives up waiting
 *
 * A deadline, because the alternative is worse than a cold shelf. If the feed and the
 * chain were both unreachable, an ungated check would keep every container unhealthy, and
 * Railway would eventually fail the deploy and leave the site on an old image — an outage
 * caused by the thing meant to prevent a flicker. After the deadline the container reports
 * ready regardless and serves from the remembered shelf on the volume, which is the
 * degraded-but-honest answer this was built for.
 */

const KEY = Symbol.for("agen.shelf.warmup");

interface Warmup {
  ready: boolean;
  startedAt: number;
}

/** Long enough for a feed request and a chain fallback; short against a five-minute window. */
const DEADLINE_MS = 25_000;

function state(): Warmup {
  const host = globalThis as typeof globalThis & { [KEY]?: Warmup };
  host[KEY] ??= { ready: false, startedAt: 0 };
  return host[KEY];
}

/** Called at boot, before the first read, so the deadline runs from the right moment. */
export function warmupStarted(): void {
  const held = state();
  if (held.startedAt === 0) held.startedAt = Date.now();
}

/** Called once the shelf has been read, whatever it managed to read. */
export function warmupFinished(): void {
  state().ready = true;
}

/**
 * True once the shelf is warm, or once waiting for it has stopped being reasonable.
 *
 * A `startedAt` of zero means nothing ever announced a warm-up — a build without the boot
 * hook, or the edge runtime — and that reports ready rather than hanging, because a health
 * check that depends on a hook it cannot prove ran is a health check that fails closed on
 * the day somebody removes the hook.
 */
export function shelfReady(): boolean {
  const held = state();
  if (held.ready) return true;
  if (held.startedAt === 0) return true;
  return Date.now() - held.startedAt > DEADLINE_MS;
}
