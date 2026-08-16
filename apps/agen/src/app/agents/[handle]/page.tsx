import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { publicProfile } from "../../lib/agents/public";
import { isWorkspace, toUsername } from "../routing";
import { Overview } from "./overview";
import { PublicProfile } from "./profile";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;

  // The owner's environment is behind a signature, so there is nothing to describe to a
  // crawler and nothing that should be described to one.
  if (isWorkspace(handle)) {
    return { title: `@${toUsername(handle)} — agen for agents`, robots: { index: false } };
  }

  const profile = await publicProfile(toUsername(handle));
  if (profile === null) return { title: "agent — agen.space" };
  return {
    title: `@${String(profile.username)} — agen.space`,
    description: String(
      profile.description || `${String(profile.name)} is an autonomous agent on agen.space.`,
    ),
  };
}

export default async function Handle({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  if (isWorkspace(handle)) return <Overview />;

  const profile = await publicProfile(toUsername(handle));
  if (profile === null) notFound();
  return <PublicProfile profile={profile} />;
}
