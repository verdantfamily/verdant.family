/**
 * The layers a page can lay over the background photograph.
 *
 * The root layout mounts the photograph and nothing else, which is right for a page that
 * is mostly a headline and some cards: the picture is the point, and every surface over it
 * carries its own backdrop blur, so type stays readable without help.
 *
 * A market page is not that page. It is a trade panel, a strip of statistics, a chart, a
 * live tape and a table of trades — small type, a great deal of it, and most of it figures
 * somebody is going to act on. Behind that much content an unmodified photograph stops
 * being a background and starts being competition: the eye keeps finding the flowers
 * between two rows of numbers.
 *
 * So the damping is opt-in per page rather than global, and both states are deliberate.
 * The home page shows the photograph. The market page shows the same photograph through
 * the scrim, the drifting light and the grain that the teaser uses.
 *
 * ## Why this is three fixed elements and not one
 *
 * They blend differently and must therefore be separate compositing layers: the scrim
 * darkens normally, the light is `screen` so it adds to the picture rather than sitting on
 * it, and the grain is `overlay` so it perturbs what is beneath without lightening it.
 * Collapsing them into one element would mean picking one blend mode for all three.
 *
 * All three are `position: fixed` with a negative `z-index`, so they take part in no
 * layout and scroll with nothing. That works from inside a page — rather than only from
 * the root layout — because nothing between here and `<html>` creates a stacking context:
 * `<body>` and `<main>` are a plain flex column. If a wrapper ever gains a `transform`, a
 * `filter` or an `isolation`, these would be trapped inside it and paint over the page's
 * own content instead of under it.
 */
export function Backdrop({ hasPhoto }: { readonly hasPhoto: boolean }) {
  return (
    <>
      <div className="scrim" aria-hidden="true" />

      {/* Without a photograph underneath there is nothing for `screen` to lighten, so this
          layer has to carry the background by itself and is given back some of the
          strength it normally concedes to the picture. */}
      <div className={hasPhoto ? "glow" : "glow bare"} aria-hidden="true">
        <span className="glow-a" />
        <span className="glow-b" />
      </div>

      <div className="grain" aria-hidden="true" />
    </>
  );
}
