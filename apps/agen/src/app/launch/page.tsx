import type { Metadata } from "next";

import { Nav } from "../nav";
import { Flow } from "./flow";

/**
 * The launch page.
 *
 * A thin server shell around a client flow, because everything interesting here is a
 * conversation with a build that is already running. The flow still prerenders — see the
 * note on `fromUrl` for why it reads the query string the long way round.
 */
export const metadata: Metadata = {
  title: "launch — agen.space",
  description: "Describe your market. Agen builds it.",
};

export default function Launch() {
  return (
    <>
      <div className="canvas" aria-hidden="true">
        <span className="mass mass-a" />
        <span className="mass mass-b" />
      </div>
      <div className="grain" aria-hidden="true" />

      <Nav active="launch" />

      <main className="page launch">
        <Flow />
      </main>
    </>
  );
}
