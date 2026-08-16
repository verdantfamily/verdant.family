import { notFound } from "next/navigation";

import { isWorkspace } from "../routing";

/**
 * Pages under this segment that only exist inside the owner environment.
 *
 * `/agents/atlas` is a public profile and has no sub-pages; `/agents/@atlas/wallet` does.
 * Without this, a bare handle would fall through the branching layout, render outside the
 * shell, and fail on the first hook that expects an active agent. A 404 is both the
 * honest answer and the one that keeps the failure at the route.
 */
export async function workspaceOnly(params: Promise<{ handle: string }>): Promise<void> {
  const { handle } = await params;
  if (!isWorkspace(handle)) notFound();
}
