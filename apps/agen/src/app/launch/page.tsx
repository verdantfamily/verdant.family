import type { Metadata } from "next";

import { Flow } from "./flow";
import { Models } from "./models";

export const metadata: Metadata = {
  title: "create — agen.space",
  description: "Choose how your token opens. Instant, or described in plain English.",
};

/**
 * The launch page.
 *
 * Two things live at this address, and which one renders is decided by the query string
 * rather than by a redirect.
 *
 * Ordinarily it is the shelf of launch models, because arriving at Create without having
 * chosen one is the common case. But a build in flight owns this URL: `Flow` writes
 * `/launch?build=<id>` as it starts so a reload lands back on the running build, and the
 * front page's composer sends a typed description here as `?prompt=`. Both of those are
 * already past the choice, so both render the flow.
 *
 * Doing it this way rather than moving the flow wholesale means every link and every
 * replaced URL that already exists goes on working, and the file that writes them does
 * not have to be touched.
 */
export default async function Launch({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const resuming = params.build !== undefined || params.prompt !== undefined;

  return <div className="ax-page">{resuming ? <Flow /> : <Models />}</div>;
}
