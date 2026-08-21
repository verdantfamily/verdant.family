/**
 * Sending a market's creator fees to the creator, at Agen's expense.
 *
 * Takes no key and no session, and that is correct rather than convenient: the destination is
 * immutable on the vault and this call cannot influence it, so there is no authority to check.
 * See `lib/instant-payout.ts` for what *is* guarded, which is the gas.
 *
 * `GET` answers what is waiting and whether it is enough, so a page can show a button that will
 * work rather than one that explains itself after being pressed.
 */

import { NextResponse } from "next/server";

import {
  payOutCreator,
  payoutLimits,
  payoutProblems,
  readPayoutStanding,
} from "../../../lib/instant-payout";
import { readInstantVault } from "../../../lib/instant-vault";
import { XError } from "../../../lib/x/errors";
import { isAddress, getAddress } from "viem";

/** Signs and spends, so it cannot run at the edge or be cached. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!isAddress(token, { strict: false })) {
    return NextResponse.json({ error: "That is not a token address." }, { status: 400 });
  }

  if (payoutProblems().length > 0) {
    return NextResponse.json(
      { available: false, owedWei: "0", claimable: false },
      { headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const vault = await readInstantVault(getAddress(token));
    const { owedWei, costWei } = await readPayoutStanding(vault);
    const enough = owedWei > 0n && owedWei >= costWei * payoutLimits().minMultiple;

    return NextResponse.json(
      { available: true, owedWei: owedWei.toString(), claimable: enough },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof XError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("[agen] reading what a market owes its creator failed:", error);
    return NextResponse.json({ error: "The chain could not be reached." }, { status: 503 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let token = "";
  try {
    const body = (await request.json()) as { token?: unknown };
    token = typeof body.token === "string" ? body.token : "";
  } catch {
    return NextResponse.json({ error: "That is not a request." }, { status: 400 });
  }

  try {
    const paid = await payOutCreator(token);
    return NextResponse.json(
      {
        vault: paid.vault,
        recipient: paid.recipient,
        amountWei: paid.amountWei.toString(),
        txHash: paid.txHash,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof XError) {
      console.error(`[agen] settling creator fees refused (${error.code}):`, error.message);
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }

    console.error("[agen] settling creator fees failed:", error);
    return NextResponse.json(
      { error: "The fees could not be sent. Nothing was moved." },
      { status: 500 },
    );
  }
}
