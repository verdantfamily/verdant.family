import { redeemChallenge } from "../../../../lib/agents/auth";
import { fail, ok, readJson } from "../../../../lib/agents/http";
import { store } from "../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson(request);
    const session = await redeemChallenge(store(), {
      address: typeof body.address === "string" ? body.address : "",
      nonce: typeof body.nonce === "string" ? body.nonce : "",
      signature: typeof body.signature === "string" ? body.signature : "",
    });
    return ok(session);
  } catch (error) {
    return fail(error);
  }
}
