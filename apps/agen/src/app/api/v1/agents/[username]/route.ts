import { publicProfile } from "../../../../lib/agents/public";
import { AgentError } from "../../../../lib/agents/errors";
import { fail, ok } from "../../../../lib/agents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ username: string }> },
): Promise<Response> {
  try {
    const { username } = await context.params;
    const profile = await publicProfile(username);
    if (profile === null) throw new AgentError("AGENT_NOT_FOUND", "No such agent.");
    return ok({ agent: profile });
  } catch (error) {
    return fail(error);
  }
}
