import { NextResponse } from "next/server";

import { editBuild } from "../../../../lib/builds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { instruction?: unknown };
  const instruction =
    typeof body.instruction === "string" ? body.instruction.trim() : "";
  if (instruction === "") {
    return NextResponse.json({ ok: false, error: "Describe the change to make." }, { status: 400 });
  }

  const result = await editBuild(id, instruction);
  return NextResponse.json(result, {
    status: result.ok ? 202 : 409,
    headers: { "cache-control": "no-store" },
  });
}
