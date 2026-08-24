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
import { ingestPostId, pollOnce } from "../../../lib/x/ingest";
import { authorise } from "../../../lib/x/ingress";
import { xStore } from "../../../lib/x/store";
import { spendableWei } from "../../../lib/x/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function run(request: Request): Promise<Response> {
  try {
    authorise(request);

    const url = new URL(request.url);

    // A support read, behind the same secret as the rest of this route: the deposit address of
    // an X account's trading wallet, and what it holds. Read-only — it never creates a wallet —
    // so an account with no wallet yet answers null rather than being given one. This exists
    // because the address is only otherwise learnable from a reply the bot posts, and a person
    // who deletes the tweet before that lands has no way back to it.
    const walletId = url.searchParams.get("wallet")?.trim() ?? "";
    if (/^\d{1,25}$/.test(walletId)) {
      const row = xStore().walletFor(walletId);
      if (row === null) return ok({ xUserId: walletId, wallet: null });
      const funds = await spendableWei(row.address);
      return ok({
        xUserId: walletId,
        wallet: row.address,
        balanceWei: funds.balanceWei.toString(),
        spendableWei: funds.spendableWei.toString(),
        gasReserveWei: funds.gasReserveWei.toString(),
      });
    }

    const id = url.searchParams.get("id")?.trim() ?? "";
    if (/^\d{15,25}$/.test(id)) {
      const store = xStore();
      const previous = store.mentionRecord(id);
      // A mention that never produced a reply and never spent is safe to try again.
      // `traded` and `launched` are not: those already moved money.
      if (
        previous !== null &&
        previous.replyPostId === null &&
        previous.outcome !== "traded" &&
        previous.outcome !== "launched"
      ) {
        store.releaseMention(id);
      }
      return ok({ id, ...(await ingestPostId(id, { store })) });
    }

    const asked = Number(url.searchParams.get("limit") ?? "");
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
