/**
 * "This build is now that market."
 *
 * Called by the launch screen once the creator's transaction has a receipt. The body is
 * a transaction hash and nothing else — every fact recorded is read from the chain's own
 * account of what that transaction did, so the worst a wrong hash can do is fail.
 *
 * A GET answers the same question for a page that wants to know whether a build has been
 * launched without asking the chain to enumerate its registry.
 */

import { NextResponse } from "next/server";
import { isHex } from "viem";

import { LaunchRecordError, readLaunch, recordLaunch } from "../../../../lib/launched";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const record = await readLaunch(id).catch(() => null);

  return NextResponse.json(
    { launched: record !== null, record },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  try {
    const body = (await request.json().catch(() => ({}))) as { readonly txHash?: unknown };

    if (typeof body.txHash !== "string" || !isHex(body.txHash) || body.txHash.length !== 66) {
      return NextResponse.json({ error: "A transaction hash is required." }, { status: 400 });
    }

    const record = await recordLaunch(id, body.txHash);
    return NextResponse.json({ record }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof LaunchRecordError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(`[agen] recording the launch of ${id} failed:`, error);
    return NextResponse.json(
      { error: "The launch could not be recorded. This has been logged." },
      { status: 500 },
    );
  }
}
