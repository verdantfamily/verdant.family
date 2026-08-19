/**
 * Cycle history, and the only way to start one.
 *
 * POST runs exactly one cycle and returns when it is done. Nothing schedules
 * itself: there is no timer behind this route, and an agent left alone does
 * nothing. Designing what drives the loop on Railway — replicas, missed slots,
 * restart behaviour — is Phase 3's opening task, and this is the seam it attaches
 * to.
 */

import { publicDecision } from "../../../../../../lib/agents/autonomy";
import { AgentError } from "../../../../../../lib/agents/errors";
import { fail, ok, readJson } from "../../../../../../lib/agents/http";
import { runAgentCycle } from "../../../../../../lib/agents/runner";
import { owned } from "../../../../../../lib/agents/service";
import { owner } from "../../../../_context";

/**
 * As long as a directive can be, before it is cut.
 *
 * The same ceiling a chat message has, because that is where every directive comes from and a
 * longer one would be a mandate written through the wrong door.
 */
const DIRECTIVE_MAX = 2_000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const ctx = owner(request);
    const agent = ctx.store.getAgent(id);
    if (agent === null || agent.ownerAddress.toLowerCase() !== ctx.address.toLowerCase()) {
      throw new AgentError("AGENT_NOT_FOUND", "No such agent.");
    }
    return ok({
      runs: ctx.store.listRuns(id, 50),
      decisions: ctx.store.listDecisions(id, 50).map(publicDecision),
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const ctx = owner(request);
    const agent = owned(ctx.store, ctx.address, id);

    /*
     * What the owner asked for, if they asked for something.
     *
     * A cycle with a directive is still the cycle this route has always run. The text reaches
     * the planner and nothing else — it cannot raise a spend limit, skip a cooldown or grant a
     * permission, because all of those are enforced after the planner has chosen. What it can
     * do is make the choice be the one the owner asked for instead of the one the model would
     * have arrived at alone, which is the difference between an agent and a scheduled process.
     *
     * Trusted only as far as it comes from an authenticated owner acting on their own agent,
     * which is the same trust the mandate itself is written under.
     */
    const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
    const directive =
      typeof body.directive === "string" && body.directive.trim() !== ""
        ? body.directive.trim().slice(0, DIRECTIVE_MAX)
        : null;

    const report = await runAgentCycle(ctx.store, agent, { trigger: "owner", directive });
    return ok({
      run: report.run,
      decision: report.decision === null ? null : publicDecision(report.decision),
      note: report.note,
    });
  } catch (error) {
    return fail(error);
  }
}
