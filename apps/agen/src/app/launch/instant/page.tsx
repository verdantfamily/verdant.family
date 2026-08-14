import type { Metadata } from "next";

import { Instant } from "./instant";

export const metadata: Metadata = {
  title: "instant — agen.space",
  description: "A fixed-supply token and a market for it, in one transaction.",
};

/**
 * The instant model.
 *
 * A thin server shell, like the programmable one: the banner belongs to the flow because
 * which of the two steps is current is state, and a title block that could not say so
 * would have to be duplicated in the component that can.
 */
export default function InstantPage() {
  return (
    <div className="ax-page">
      <Instant />
    </div>
  );
}
