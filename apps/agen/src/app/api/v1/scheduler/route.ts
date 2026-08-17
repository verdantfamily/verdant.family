/**
 * Whether autonomy is alive on this deployment.
 *
 * Unauthenticated and aggregate-only: counts, timestamps and a paused reason.
 * No agent identities, balances or decisions, because the value of this endpoint
 * is that someone can check it from anywhere at the moment things look wrong,
 * and that stops being true the second it needs a session.
 */

import { fail, ok } from "../../../lib/agents/http";
import { schedulerInstance } from "../../../lib/agents/scheduler";
import { autonomyGloballyPaused } from "../../../lib/agents/runner";
import { agentStore } from "../../../lib/agents/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const scheduler = schedulerInstance();

    // No scheduler is a legitimate configuration, not a fault — every
    // deployment except the one holding the volume should look like this.
    if (scheduler === null) {
      const store = agentStore();
      return ok({
        scheduler: {
          running: false,
          reason: "No scheduler is running in this process.",
          pausedReason: autonomyGloballyPaused(store),
          nextScheduledRun: store.nextScheduledRun(),
        },
      });
    }

    return ok({ scheduler: scheduler.health() });
  } catch (error) {
    return fail(error);
  }
}
