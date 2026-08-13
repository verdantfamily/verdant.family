import type { ReactNode } from "react";

import { TopBar } from "./topbar";

/**
 * The header band on every page that is not the front one.
 *
 * The photograph belongs to the welcome and nowhere else — a hero image repeated on four
 * screens stops being an image and becomes wallpaper, and it would fight the content on
 * pages that are mostly figures and type. This is the same idea rendered rather than
 * photographed: the bloom's own palette — moss, sage, sky, and the cream and pink of the
 * flowers — as four soft masses that drift against each other on different periods.
 *
 * Because none of the periods divide evenly, the composition never repeats exactly, which
 * is the property that makes a background feel alive rather than looped. It costs no
 * image and no JavaScript.
 */
export function Bloom({
  active,
  children,
}: {
  readonly active?: "explore" | "create" | "profile" | "docs" | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className="ax-bloom">
      <span className="ax-bloom-a" aria-hidden="true" />
      <span className="ax-bloom-b" aria-hidden="true" />
      <span className="ax-bloom-c" aria-hidden="true" />
      <span className="ax-bloom-d" aria-hidden="true" />

      <TopBar active={active} />

      <div className="ax-bloom-in">{children}</div>
    </section>
  );
}
