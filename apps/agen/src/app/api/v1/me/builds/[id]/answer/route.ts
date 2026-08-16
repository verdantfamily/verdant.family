import { answerAgentBuild } from "../../../../../../lib/agents/service";
import { AgentError } from "../../../../../../lib/agents/errors";
import { fail, ok, readJson } from "../../../../../../lib/agents/http";
import { agent, logAgent } from "../../../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const ctx = agent(request);
    const body = await readJson(request);
    const answers = Array.isArray(body.answers) ? body.answers : [];
    if (!answers.every((entry) => typeof entry === "object" && entry !== null && "id" in entry)) {
      throw new AgentError("VALIDATION_FAILED", "answers must be a list of { id, answer }.");
    }
    const job = await answerAgentBuild(
      ctx.store,
      ctx.agent.id,
      id,
      answers as { id: string; answer?: string }[],
    );
    logAgent(request, ctx.agent.id, ctx.key.id, 202, null);
    return ok({ job }, 202);
  } catch (error) {
    return fail(error);
  }
}
