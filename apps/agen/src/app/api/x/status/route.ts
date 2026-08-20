/**
 * Whether the bot is alive, and what it is missing.
 *
 * Unauthenticated and aggregate-only, on the same reasoning as `/api/v1/scheduler`: the value of
 * this endpoint is that somebody can check it from anywhere at the moment things look wrong, and
 * that stops being true the second it needs a credential. So it reports which variables are
 * *absent* and never a value, counts rather than accounts, and nothing about who has launched
 * what.
 *
 * `ready` is the one field worth reading. It is false on a deployment that cannot launch, which
 * during the rollout of this feature is the expected state — `CreatorSeatFactory` is not deployed
 * — and the reasons say so in words rather than leaving an operator to infer it.
 */

import { botUsername, ingressProblems, killedByEnvironment, limits, mentionDelivery } from "../../../lib/x/config";
import { fail, ok } from "../../../lib/x/http";
import { keySeparation, sponsorProblems } from "../../../lib/x/sponsor";
import { xStore } from "../../../lib/x/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const store = xStore();
    const ingress = ingressProblems();
    const sponsor = sponsorProblems();
    const usage = store.usage();
    const config = limits();

    return ok({
      handle: `@${botUsername()}`,
      delivery: mentionDelivery(),
      // Answering questions and launching tokens fail independently, and an operator needs to
      // know which half is down: a bot that can reply but not launch is degraded, not broken.
      canAnswer: ingress.length === 0,
      canLaunch: ingress.length === 0 && sponsor.length === 0 && !killedByEnvironment() && !store.launchesPaused(),
      ready: ingress.length === 0 && sponsor.length === 0,
      paused: { byEnvironment: killedByEnvironment(), byOperator: store.launchesPaused() },
      // Booleans, never addresses: the point of the split is checkable without publishing which
      // wallet holds every unclaimed creator's seat. `separated` false on a configured deployment
      // means the two keys are the same one, which works until the sponsor is rotated and then
      // strands every entitlement older than the rotation.
      keys: keySeparation(),
      problems: [...ingress, ...sponsor],
      today: {
        launches: usage.launches,
        launchesAllowed: config.launchesPerDay,
        gasWei: usage.gasWei.toString(),
        gasAllowedWei: config.gasPerDayWei.toString(),
      },
      cursor: store.sinceId(),
      // Launches whose transaction outcome is unknown. Should be zero; anything else is the one
      // state in this feature that wants a human to look.
      unresolved: store.indeterminateLaunches().length,
    });
  } catch (error) {
    return fail(error);
  }
}
