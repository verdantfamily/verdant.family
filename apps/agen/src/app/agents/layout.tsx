import type { Viewport } from "next";
import type { ReactNode } from "react";

import "./agents.css";
import { OwnerProvider } from "./owner";

/**
 * The boundary between the two products.
 *
 * The stylesheet is imported here and nowhere else, and every rule in it is scoped under
 * `.ag-root`, so the launchpad cannot inherit a single declaration from this environment
 * however deeply the two are nested. `.ag-root` replaces the main app's card frame the
 * way `.ax-page` does: same ground, same measure, different furniture on it.
 *
 * The owner session lives at this level so it survives movement between the gate, the
 * create screen and the shell. It is not persisted anywhere — see `owner.tsx`.
 */
export const viewport: Viewport = {
  // The phone's own chrome continues the page rather than capping it with a dark band.
  themeColor: "#ffffff",
  colorScheme: "light",
};

export default function AgentsLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="ag-root">
      <OwnerProvider>{children}</OwnerProvider>
    </div>
  );
}
