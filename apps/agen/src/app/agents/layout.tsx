import type { Viewport } from "next";
import type { ReactNode } from "react";

import "./agents.css";
import { AgentChrome } from "./chrome";
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
  width: "device-width",
  initialScale: 1,
  /*
   * The rooms in here run to the edges of the glass.
   *
   * Without `cover` a notched phone letterboxes the page between the safe insets, which puts
   * white bars down the sides of a black screen in landscape and stops the bottom tab bar
   * from reaching the bottom of the window. With it the page owns every pixel and owes the
   * insets in return — every fixed bar and every page gutter under `/agents` asks for them
   * with `env(safe-area-inset-*)`.
   */
  viewportFit: "cover",
  // The starting value only. Which room a URL is depends on who is signed in, so the tag is
  // kept honest at runtime instead — see `chrome.tsx`.
  themeColor: "#ffffff",
  colorScheme: "light",
};

export default function AgentsLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="ag-root">
      <AgentChrome />
      <OwnerProvider>{children}</OwnerProvider>
    </div>
  );
}
