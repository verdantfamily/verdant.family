/**
 * Server boot. Next calls `register` once per server process, which is the only
 * hook we have that runs when the container starts rather than when a request
 * arrives — and a scheduler that only exists once somebody visits the site is
 * not a scheduler.
 */

export async function register(): Promise<void> {
  // `register` also runs in the edge runtime, where there is no filesystem, no
  // SQLite and no timers worth having. The import is dynamic so that the agent
  // store is not even loaded there.
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;

  const { startScheduler } = await import("./app/lib/agents/scheduler");
  const scheduler = startScheduler();

  if (scheduler !== null) {
    // One line, at boot, so a deployment's logs answer "is autonomy on here"
    // without a database or an endpoint.
    console.log("[agents] scheduler started");
  }

  await warmShelf();
}

/**
 * Read the shelf once before anybody is sent here.
 *
 * `/health` waits on this, so the cost of a cold feed is paid by the deploy rather than by
 * whoever loads the site a second after it. Failure is not fatal and is not retried: the
 * deadline in `shelf-warmup` releases the container anyway, and a shelf that could not be
 * read now is a shelf `readInstantMarkets` will fall back to the remembered copy for.
 */
async function warmShelf(): Promise<void> {
  const { warmupStarted, warmupFinished } = await import("./app/lib/shelf-warmup");
  warmupStarted();

  try {
    const { readInstantMarkets } = await import("./app/lib/instant-markets");
    const markets = await readInstantMarkets();
    console.log(`[shelf] warm at boot with ${String(markets.length)} market(s)`);
  } catch (error) {
    console.warn(`[shelf] could not warm at boot: ${String(error).slice(0, 200)}`);
  } finally {
    warmupFinished();
  }
}
