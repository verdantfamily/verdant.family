/**
 * Rename a claimed Program.
 *
 * The same proof as a claim and the same recovered signer, with two differences. The message binds
 * `Action: rename`, so a claim signature is not a rename signature — the two authorise different
 * things and a proof for one must not be a proof for the other. And the eligible author must already
 * be the owner: a rename of an unclaimed Program is refused rather than treated as a claim, because
 * those are different acts and merging them would let a rename create ownership.
 *
 * What it changes is the label and the slug. It does not touch `configHash`, lineage, `dedupe_key`
 * or `claimed_at` — ownership began once, and renaming is not beginning it again.
 *
 * The old slug is retired rather than freed, and stops resolving: `/api/programs/<old>` 404s from
 * this moment. See `api/programs/[id]/route.ts` for why that is a 404 and not a redirect.
 */

import { NextResponse } from "next/server";

import {
  ClaimRequestError,
  claimRequestFrom,
  performClaim,
} from "../../../../lib/registry/claim-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  let rename;
  try {
    rename = claimRequestFrom(await request.json().catch(() => null), "rename", id);
  } catch (error) {
    if (!(error instanceof ClaimRequestError)) throw error;
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const answered = await performClaim(rename);

  return NextResponse.json(answered.body, {
    status: answered.status,
    headers: { "cache-control": "no-store" },
  });
}
