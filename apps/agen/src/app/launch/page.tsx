import type { Metadata } from "next";

import { TopBar } from "../topbar";
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
 * The banner, the steps and the form all live inside `Flow` rather than here: which of
 * the three steps is current is state, and a title block that could not say so would
 * have to be duplicated in the component that can.
 */
export default function Launch() {
  return (
    <div className="ax-page">
      <TopBar active="create" plain />

      <main className="ax-wrap">
        <Flow />
      </main>
    </div>
  );
}
