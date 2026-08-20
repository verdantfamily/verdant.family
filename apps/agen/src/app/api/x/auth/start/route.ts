/**
 * Send a visitor to X to prove who they are.
 *
 * A redirect rather than a JSON payload with a URL in it, so the button on `/useagen` can be a
 * plain link that works without JavaScript and without the client ever handling the state or the
 * challenge.
 */

import { beginSignIn } from "../../../../lib/x/oauth";
import { fail } from "../../../../lib/x/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const { url } = beginSignIn();
    return Response.redirect(url, 302);
  } catch (error) {
    return fail(error);
  }
}
