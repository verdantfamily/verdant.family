import { publicCatalogue } from "../../../lib/agents/public";
import { fail, ok } from "../../../lib/agents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return ok({ agents: await publicCatalogue() });
  } catch (error) {
    return fail(error);
  }
}
