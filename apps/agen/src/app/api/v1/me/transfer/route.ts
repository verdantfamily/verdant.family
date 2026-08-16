import { rejectExternalTransfer } from "../../../../lib/agents/service";
import { fail } from "../../../../lib/agents/http";
import { agent } from "../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Explicitly refused. An agent wallet is not a general-purpose sender. */
export async function POST(request: Request): Promise<Response> {
  try {
    agent(request);
    rejectExternalTransfer();
  } catch (error) {
    return fail(error);
  }
}
