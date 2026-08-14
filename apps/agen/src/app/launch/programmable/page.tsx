import type { Metadata } from "next";

import { Flow } from "../flow";

export const metadata: Metadata = {
  title: "programmable — agen.space",
  description: "Describe your market. Agen builds it.",
};

/**
 * The programmable model, at its own address.
 *
 * The same flow that used to be all of `/launch`. It still writes `/launch?build=<id>`
 * once a build starts, which is deliberate: the build, not the model that began it, is
 * what a reload needs to find, and `/launch` renders the flow whenever it is carrying
 * one.
 */
export default function Programmable() {
  return (
    <div className="ax-page">
      <Flow />
    </div>
  );
}
