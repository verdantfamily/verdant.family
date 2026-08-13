import type { ReactNode } from "react";

import { TopBar } from "./topbar";

/**
 * The header band on every page that is not the front one.
 *
 * Two forms, and the difference is whether there is a photograph for it.
 *
 * Where there is one it is named here and the band carries it, cropped to the band and
 * scrimmed so type stays legible over whichever part of the picture lands behind it.
 * Where there is not, the band renders the same idea instead of photographing it: the
 * bloom's own palette — moss, sage, sky, and the cream and pink of the flowers — as four
 * soft masses drifting against each other on periods of 29, 37, 43 and 53 seconds. None
 * of those divide evenly, so the composition never repeats exactly, which is the property
 * that makes a background feel alive rather than looped. It costs no image and no
 * JavaScript.
 *
 * The front page's photograph is deliberately not reused for either: a hero image
 * repeated on four screens stops being an image and becomes wallpaper.
 */
export function Bloom({
  active,
  photo,
  centred = false,
  children,
}: {
  readonly active?: "explore" | "create" | "profile" | "docs" | undefined;
  /** A basename in `public/`, which must exist as `.avif`, `.webp` and `.jpg`. */
  readonly photo?: string | undefined;
  readonly centred?: boolean;
  readonly children: ReactNode;
}) {
  const classes = ["ax-bloom", photo === undefined ? "" : "ax-bloom-shot", centred ? "ax-bloom-mid" : ""]
    .filter((entry) => entry.length > 0)
    .join(" ");

  return (
    <section className={classes}>
      {photo === undefined ? (
        <>
          <span className="ax-bloom-a" aria-hidden="true" />
          <span className="ax-bloom-b" aria-hidden="true" />
          <span className="ax-bloom-c" aria-hidden="true" />
          <span className="ax-bloom-d" aria-hidden="true" />
        </>
      ) : (
        <span
          className="ax-bloom-photo"
          aria-hidden="true"
          /*
           * Handed over as three custom properties rather than as a finished
           * `background-image`, because the fallback for a browser without `image-set`
           * is a second `background-image` declaration — and a React style object cannot
           * hold the same property twice. The stylesheet writes both lines; this only
           * says which files.
           */
          style={
            {
              "--shot-avif": `url("/${photo}.avif")`,
              "--shot-webp": `url("/${photo}.webp")`,
              "--shot-jpg": `url("/${photo}.jpg")`,
            } as React.CSSProperties
          }
        />
      )}

      <TopBar active={active} />

      <div className="ax-bloom-in">{children}</div>
    </section>
  );
}
