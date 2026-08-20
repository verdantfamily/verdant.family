/**
 * Ask X for new mentions and act on them.
 *
 * A cron target rather than a public endpoint, and authenticated because it spends money: a
 * poll can end in a sponsored launch, so an open version of this would be a way to make Agen
 * pay for gas on demand. The check itself is in `lib/x/ingress`, which the webhook shares.
 *
 * Since the poller in `lib/x/poller` runs the same pass inside the web process, this is now the
 * way to force one by hand rather than the only way one happens.
 *
 * `GET` answers the same way as `POST` so that a cron product which only issues GETs can drive
 * it. Both mutate, which is why neither is cacheable and both require the secret.
 */

import { fail, ok } from "../../../lib/x/http";
import { pollOnce } from "../../../lib/x/ingest";
import { authorise } from "../../../lib/x/ingress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function run(request: Request): Promise<Response> {
  try {
    authorise(request);

    const asked = Number(new URL(request.url).searchParams.get("limit") ?? "");
    const bounded = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 100) : null;

    return ok(await pollOnce(bounded === null ? {} : { limit: bounded }));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  return run(request);
}

export async function GET(request: Request): Promise<Response> {
  return run(request);
}
