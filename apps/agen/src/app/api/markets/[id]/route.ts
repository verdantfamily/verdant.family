/**
 * Reading a build in progress.
 *
 * Polled every second or so by the generation screen. Cheap: the job is one JSON file,
 * and the pipeline writes it at every stage transition, so what this returns is the
 * real state of the build rather than a projection of it.
 */

import { NextResponse } from "next/server";

import { jobStore, publicView } from "../../../lib/builds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  const job = await jobStore()
    .read(id)
    .catch(() => null);

  if (job === null) {
    return NextResponse.json({ error: "No such build." }, { status: 404 });
  }

  return NextResponse.json(publicView(job), {
    // A build's state changes every few seconds and a cached answer would show a
    // creator a screen that has stopped moving while their market is still being built.
    headers: { "cache-control": "no-store" },
  });
}
