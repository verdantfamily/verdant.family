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
import { fail, ok } from "../../../../../../lib/agents/http";
import { runAgentCycle } from "../../../../../../lib/agents/runner";
import { owned } from "../../../../../../lib/agents/service";
import { owner } from "../../../../_context";

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
    const report = await runAgentCycle(ctx.store, agent, { trigger: "owner" });
    return ok({
      run: report.run,
      decision: report.decision === null ? null : publicDecision(report.decision),
      note: report.note,
    });
  } catch (error) {
    return fail(error);
  }
}
