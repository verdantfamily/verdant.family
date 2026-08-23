import { NextResponse } from "next/server";

import { approveBuild } from "../../../../lib/builds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  readonly creator?: unknown;
  readonly signature?: unknown;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Body;
  const result = await approveBuild({
    jobId: id,
    creator: typeof body.creator === "string" ? body.creator : "",
    signature: typeof body.signature === "string" ? body.signature : "",
  });

  return NextResponse.json(result, {
    status: result.ok ? 200 : result.error?.includes("no build") ? 404 : 409,
    headers: { "cache-control": "no-store" },
  });
}
