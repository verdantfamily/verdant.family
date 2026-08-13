import type { Metadata } from "next";

import { Flow } from "./flow";

export const metadata: Metadata = {
  title: "create — agen.space",
  description: "Describe your market. Agen builds it.",
};

/**
 * The launch page.
 *
 * A thin server shell around a client flow, because everything interesting here is a
 * conversation with a build that is already running. The flow still prerenders — see the
 * note on `fromUrl` for why it reads the query string the long way round.
 *
 * The banner, the navigation and the form all belong to `Flow` rather than to this file:
 * the banner spans the page while the form sits inside the measure, and which of the
 * three steps is current is state only the flow holds.
 */
export default function Launch() {
  return (
    <div className="ax-page">
      <Flow />
    </div>
  );
}
