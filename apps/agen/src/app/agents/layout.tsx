import type { Viewport } from "next";
import type { ReactNode } from "react";

import "./agents.css";
import { OwnerProvider } from "./owner";

/**
 * The boundary between the two products.
 *
 * The stylesheet is imported here and nowhere else, and every rule in it is scoped under
 * `.ag-root`, so the launchpad cannot inherit a single declaration from this environment
 * however deeply the two are nested. `.ag-root` fills the main app's white sheet rather
 * than replacing it: same frame, same rounded corners, entirely different room inside.
 *
 * The owner session lives at this level so it survives movement between the gate, the
 * create screen and the shell. It is not persisted anywhere — see `owner.tsx`.
 */
export const viewport: Viewport = {
  // The phone's own chrome continues the environment rather than framing it in white.
  themeColor: "#08080a",
  colorScheme: "dark",
};

export default function AgentsLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="ag-root">
      <OwnerProvider>{children}</OwnerProvider>
    </div>
  );
}
