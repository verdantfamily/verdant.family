/**
 * The launch transaction for a cleared build, prepared for one wallet.
 *
 * A POST rather than a GET, and not because anything is written: the answer depends on
 * the connected wallet, it is expensive to produce — the hook's address is mined here —
 * and it must never be cached. A GET carrying an address in a query string would end up
 * in a proxy somewhere, handing one creator the manifest built for another.
 *
 * Nothing is signed or sent. The response is unsigned calldata; the wallet decides.
 */

import { NextResponse } from "next/server";
import { parseEther } from "viem";

import { LaunchError, prepareLaunch } from "../../../../lib/launch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  readonly creator?: unknown;
  readonly feeReceiver?: unknown;
  readonly devBuy?: unknown;
  readonly metadataURI?: unknown;
}

/**
 * An amount of ether, from what somebody typed.
 *
 * `parseEther` is strict about what it accepts and that is wanted: an amount this could
 * not read is an amount the creator did not mean, and guessing at "1,5" or "1 eth"
 * produces a launch for the wrong number.
 */
function ether(value: unknown, field: string, fallback: bigint | null = null): bigint {
  if (value === undefined || value === null || value === "") {
    if (fallback !== null) return fallback;
    throw new LaunchError(`${field} is required.`, 400);
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new LaunchError(`${field} must be an amount.`, 400);
  }

  try {
    const parsed = parseEther(String(value).trim());
    if (parsed < 0n) throw new LaunchError(`${field} cannot be negative.`, 400);
    return parsed;
  } catch (error) {
    if (error instanceof LaunchError) throw error;
    throw new LaunchError(`${field} is not an amount this can read.`, 400);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  try {
    const body = (await request.json().catch(() => ({}))) as Body;

    const prepared = await prepareLaunch({
      jobId: id,
      creator: typeof body.creator === "string" ? body.creator : "",
      feeReceiver: typeof body.feeReceiver === "string" ? body.feeReceiver : "",
      // The opening valuation is not read from the request. It is a protocol constant,
      // and a launch route that accepted one would be an API for opening a market at a
      // price the interface does not offer — which is the same thing as the field still
      // existing, only undocumented.
      devBuyWei: ether(body.devBuy, "The initial buy", 0n),
      ...(typeof body.metadataURI === "string" ? { metadataURI: body.metadataURI } : {}),
    });

    return NextResponse.json(prepared, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof LaunchError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    // Anything else is a defect. The creator gets a sentence; the operator gets the
    // stack, because a launch failing for an unnamed reason is the thing most worth
    // being able to diagnose.
    console.error(`[agen] preparing the launch of ${id} failed:`, error);
    return NextResponse.json(
      { error: "The launch could not be prepared. This has been logged." },
      { status: 500 },
    );
  }
}
