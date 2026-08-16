import { readTreasury } from "../../../../lib/agents/service";
import { fail, ok } from "../../../../lib/agents/http";
import { agent, logAgent } from "../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = agent(request);
    logAgent(request, ctx.agent.id, ctx.key.id, 200, null);
    return ok(await readTreasury(ctx.agent));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(): Promise<Response> {
  try {
    const { rejectExternalTransfer } = await import("../../../../lib/agents/service");
    rejectExternalTransfer();
    return fail(new Error("unreachable"));
  } catch (error) {
    return fail(error);
  }
}
