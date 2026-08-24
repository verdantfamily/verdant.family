/**
 * Claim a Program and give it a name.
 *
 * The right belongs to the address that launched the earliest market running these economics, proven
 * by a signature over `programClaimMessage`. Nothing here reads a session or an address from the
 * body: the signer is recovered from the signature and compared to the eligible author, so there is
 * nothing a caller can assert about who they are.
 *
 * A Program is addressed by its `configHash` here rather than by a slug, and that is not an
 * oversight. An unclaimed Program has no slug — that is what claiming gives it — so the identity is
 * the only way to name one.
 *
 * Idempotent for the owner: submitting the same signed request twice leaves the state as the first
 * left it and answers `changed: false`. A used signature asking for anything else is a replay and is
 * refused, which is what stops an old claim message being used to undo a later rename.
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

  let claim;
  try {
    claim = claimRequestFrom(await request.json().catch(() => null), "claim", id);
  } catch (error) {
    if (!(error instanceof ClaimRequestError)) throw error;
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const answered = await performClaim(claim);

  return NextResponse.json(answered.body, {
    status: answered.status,
    headers: { "cache-control": "no-store" },
  });
}
