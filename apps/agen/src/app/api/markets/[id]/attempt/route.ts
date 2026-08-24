/**
 * "This build's launch has been sent."
 *
 * Called by the launch screen the instant the wallet hands back a transaction hash, and before the
 * receipt is waited for. Nothing else in the engine-v1 path can report this: the server holds no key
 * and never observes a send, so without this call the difference between "the creator declined" and
 * "the creator signed and we lost the receipt" is invisible — and those two need different answers.
 * One is a launch that never happened; the other is a market that exists and must be found.
 *
 * ## Why this is separate from `/launched`
 *
 * That route means something stronger and requires more: it reads the receipt, checks the log came from
 * the configured engine factory, checks the commitment is the approved one and the creator is the wallet
 * that approved it, and refuses if any of that fails. It cannot answer this question, because at this
 * moment there is no receipt to check.
 *
 * So this route deliberately verifies nothing about the chain. That is safe because of what it can do:
 * move one of this build's own attempts from `reserved` to `sending`, in the registry only. A wrong hash
 * costs the sweep one wasted comparison — reconciliation matches markets to attempts on economics,
 * creator and block window, and the hash is only ever a tie-break between attempts that already match on
 * all three. It is not authority for anything.
 *
 * ## It answers 202 whatever happens
 *
 * The browser is between a signature and a receipt and there is no answer it could act on. A registry
 * that is down costs this launch its lineage claim and nothing else, and the market will still be
 * registered by the sweep with null lineage. Failing here would mean a red error on screen at the exact
 * moment a creator's market is being created successfully.
 */

import { NextResponse } from "next/server";
import { isHex } from "viem";

import { isEngineBuild } from "../../../../lib/builds";
import { recordLaunchSent } from "../../../../lib/registry/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  const body = (await request.json().catch(() => ({}))) as { readonly txHash?: unknown };

  if (typeof body.txHash !== "string" || !isHex(body.txHash) || body.txHash.length !== 66) {
    return NextResponse.json({ error: "A transaction hash is required." }, { status: 400 });
  }

  /*
   * Engine-v1 only, checked rather than assumed. Decision 1 scopes this milestone to that path, and an
   * engine-0 build has no attempt to move — reporting one would be recording a launch of a market this
   * registry does not describe.
   */
  if (!(await isEngineBuild(id).catch(() => false))) {
    return NextResponse.json({ recorded: false }, { status: 202 });
  }

  await recordLaunchSent(id, body.txHash);

  return NextResponse.json(
    { recorded: true },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
