"use client";

/**
 * The phone's own toolbar, matched to the room it is sitting above.
 *
 * Half of this environment is dark and half is white, and `theme-color` decides what colour
 * iOS tints the toolbar and Android the status bar. Declared once for the whole area it is
 * wrong for half of it: a white bar above the #121212 workspace is a strip of another
 * product across the top of the screen.
 *
 * It cannot be declared per route either, and not for want of trying — `/agents/@atlas` is
 * the dark workspace while `/agents/atlas` is the white public profile, and both are served
 * by the same `page.tsx`. Which room you are in is a runtime fact about who is signed in.
 *
 * So the colour is read off the page instead of described a second time. `body` already
 * carries the correct ground, via `body:has(.ag-night)` in the stylesheet, and this copies
 * that value into the tag. There is one source of truth and no list of dark URLs to keep in
 * step with the components that actually make a screen dark.
 */

import { usePathname } from "next/navigation";
import { useEffect } from "react";

export function AgentChrome() {
  const pathname = usePathname();

  useEffect(() => {
    let tag = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

    if (tag === null) {
      tag = document.createElement("meta");
      tag.name = "theme-color";
      document.head.append(tag);
    }

    const meta = tag;

    // After the frame, not during it. This component is a sibling of the element that carries
    // the class deciding the ground, so at the moment the effect runs the browser has been
    // told about the new room but has not yet resolved what colour it is.
    const frame = requestAnimationFrame(() => {
      meta.content = getComputedStyle(document.body).backgroundColor;
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [pathname]);

  return null;
}
