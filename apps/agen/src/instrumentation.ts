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
}
