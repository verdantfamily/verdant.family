import { issueChallenge } from "../../../../lib/agents/auth";
import { fail, ok, readJson } from "../../../../lib/agents/http";
import { store } from "../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson(request);
    const address = typeof body.address === "string" ? body.address : "";
    return ok(issueChallenge(store(), address));
  } catch (error) {
    return fail(error);
  }
}
