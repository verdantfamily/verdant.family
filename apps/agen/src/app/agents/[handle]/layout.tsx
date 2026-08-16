import type { ReactNode } from "react";

import { AgentShell } from "../shell";
import { isWorkspace, toUsername } from "../routing";

/**
 * Two different pages live at this segment, and this decides which.
 *
 * `/agents/atlas` is the public profile — the thing token pages link to, the thing an
 * agent's creator address resolves into. `/agents/@atlas` is the owner's operating
 * environment for the same agent. The `@` is the whole distinction, and it is a good one
 * to hang it on: handles are `[a-z0-9_]`, so a leading `@` can never be a real handle and
 * a static route under `/agents` can never accidentally shadow one.
 *
 * The alternative was two dynamic folders, which the App Router forbids at the same path
 * depth, or a middleware rewrite, which moves the decision somewhere nobody reading this
 * folder would think to look. Branching on the segment this layout owns is neither a
 * pathname sniff nor a guess: it is reading its own parameter.
 */
export default async function HandleLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  if (!isWorkspace(handle)) return <>{children}</>;
  return <AgentShell username={toUsername(handle)}>{children}</AgentShell>;
}
