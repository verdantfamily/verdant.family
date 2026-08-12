/**
 * The build's stages, drawn.
 *
 * A build takes a couple of minutes and the screen showing it used to be seven words and
 * seven grey dots. Nothing about that says which part is hard, and nothing about it says
 * the machine is still working — a stalled build and a working one look identical, so a
 * creator watches a static list and wonders whether to reload.
 *
 * So each stage gets a mark that says what that stage *is*, and the one that is running
 * moves. Movement is the honest signal here: it is driven by the job's own state, so it
 * starts when the server says the stage started and stops when the server says it
 * stopped. Nothing here is on a timer and nothing advances because time passed.
 *
 * ## Why this is SVG and CSS rather than an animation library
 *
 * The obvious way to write these is Motion's `pathLength`, which is a lovely API and
 * about forty kilobytes of runtime on the page a creator waits on. `pathLength="1"`
 * normalises a path's length to one unit, which is the whole trick that API is selling;
 * after that a `stroke-dasharray` keyframe does the same drawing, in the compositor,
 * with no JavaScript. The keyframes live beside the rest of the create screen's styles.
 *
 * Every animation is off under `prefers-reduced-motion`, where the icons stay as the
 * static line drawings they already are.
 */

export type StageMark =
  | "understanding"
  | "formalising"
  | "architecture"
  | "generating"
  | "compiling"
  | "testing"
  | "ready";

export type MarkState = "waiting" | "running" | "done" | "failed" | "skipped";

/** The gear's teeth, eight spokes rather than eight hand-written line elements. */
const TEETH = [0, 45, 90, 135, 180, 225, 270, 315];

function Body({ mark }: { readonly mark: StageMark }) {
  switch (mark) {
    /* A brain, mid-thought: the stem and the two hemispheres trace while the outline
       holds still, so it reads as activity inside something rather than a wobble. */
    case "understanding":
      return (
        <>
          <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
          <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
          <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
          <path className="ln-trace" pathLength={1} d="M12 18V5" />
          <path
            className="ln-trace ln-delay-1"
            pathLength={1}
            d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"
          />
          <path className="ln-trace ln-delay-2" pathLength={1} d="M12 5A3 3 0 1 1 17.598 6.5" />
          <path className="ln-trace ln-delay-2" pathLength={1} d="M12 5A3 3 0 1 0 6.402 6.5" />
          <path className="ln-trace ln-delay-3" pathLength={1} d="M18 18a4 4 0 0 0 2-7.464" />
          <path className="ln-trace ln-delay-3" pathLength={1} d="M6 18a4 4 0 0 1-2-7.464" />
        </>
      );

    /* A document being written: the page is fixed, the lines of text arrive in order. */
    case "formalising":
      return (
        <>
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
          <path className="ln-write" pathLength={1} d="M8 13h8" />
          <path className="ln-write ln-delay-1" pathLength={1} d="M8 17h8" />
          <path className="ln-write ln-delay-2" pathLength={1} d="M8 9h2" />
        </>
      );

    /* Four blocks placing themselves, one after another. */
    case "architecture":
      return (
        <>
          <rect className="ln-place" x="3" y="3" width="7.4" height="7.4" rx="1.6" />
          <rect className="ln-place ln-delay-1" x="13.6" y="3" width="7.4" height="7.4" rx="1.6" />
          <rect className="ln-place ln-delay-3" x="3" y="13.6" width="7.4" height="7.4" rx="1.6" />
          <rect
            className="ln-place ln-delay-2"
            x="13.6"
            y="13.6"
            width="7.4"
            height="7.4"
            rx="1.6"
          />
        </>
      );

    /* Angle brackets, breathing apart around a slash that traces like a cursor run. */
    case "generating":
      return (
        <>
          <path className="ln-right" d="m18 16 4-4-4-4" />
          <path className="ln-left" d="m6 8-4 4 4 4" />
          <path className="ln-trace" pathLength={1} d="M14.5 4 9.5 20" />
        </>
      );

    /* A gear. The one stage where the machine really is just grinding. */
    case "compiling":
      return (
        <g className="ln-spin">
          <circle cx="12" cy="12" r="3.2" />
          {TEETH.map((angle) => {
            const radians = (angle * Math.PI) / 180;
            const cos = Math.cos(radians);
            const sin = Math.sin(radians);
            return (
              <path
                key={angle}
                d={`M${String(12 + cos * 6.2)} ${String(12 + sin * 6.2)} L${String(
                  12 + cos * 9.2,
                )} ${String(12 + sin * 9.2)}`}
              />
            );
          })}
        </g>
      );

    /* A flask with two bubbles rising through it. */
    case "testing":
      return (
        <>
          <path d="M10 2v7.31" />
          <path d="M14 9.3V2" />
          <path d="M8.5 2h7" />
          <path d="M14 9.3a6.5 6.5 0 1 1-4 0" />
          <circle className="ln-bubble" cx="10.6" cy="17.4" r="0.9" />
          <circle className="ln-bubble ln-delay-2" cx="13.6" cy="18.2" r="0.7" />
        </>
      );

    /* Done: the tick draws itself once and the ring settles behind it. */
    case "ready":
      return (
        <>
          <circle className="ln-ring" cx="12" cy="12" r="9" />
          <path className="ln-tick" pathLength={1} d="m8.2 12.4 2.6 2.6 5-5.4" />
        </>
      );
  }
}

/** A stage that finished. The same tick everywhere, so a completed list reads as a list. */
function Done() {
  return (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.2 12.4 2.6 2.6 5-5.4" />
    </>
  );
}

/** A stage that failed, and the one place on this screen with a colour. */
function Failed() {
  return (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.6v5.2" />
      <path d="M12 16.4h.01" />
    </>
  );
}

export function StageIcon({
  mark,
  state,
}: {
  readonly mark: StageMark;
  readonly state: MarkState;
}) {
  const running = state === "running";

  return (
    <svg
      className={running ? "stage-icon stage-icon-live" : "stage-icon"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {state === "failed" ? (
        <Failed />
      ) : state === "done" ? (
        <Done />
      ) : (
        <Body mark={mark} />
      )}
    </svg>
  );
}
