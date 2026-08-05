"use client";

import { useEffect, useRef, useState } from "react";

import { flashFor } from "../lib/flash";

/**
 * A figure that says so when it moves.
 *
 * A page of six polled numbers that update silently is indistinguishable from a page
 * that has stopped polling. That is the actual failure — not latency, but the absence of
 * any evidence that the thing is alive — and it is why this exists rather than a faster
 * interval alone. When a value changes, a wash appears behind it and decays: green up,
 * red down.
 *
 * ## Why the remount
 *
 * A CSS animation runs when the class is applied and never again, so a second change
 * inside the decay of the first would do nothing at all — which is exactly the case that
 * matters, a market taking trades faster than the animation is long. Incrementing a key
 * gives React a different element each time, so every change restarts the animation from
 * the beginning. The element is a `span` holding text; remounting one costs nothing.
 *
 * ## Why direction is a separate argument
 *
 * Because the displayed text is rounded and the comparison must not be. "$3.9K" to
 * "$3.9K" is not a change worth flashing even when the underlying figure moved, and
 * "1B TEST" would compare as a string forever. So the text decides *whether* to flash and
 * the number decides *which way*, and a caller with no meaningful ordering passes `null`
 * to get the neutral wash.
 */
export function LiveValue({
  text,
  amount,
  quiet = false,
  className = "",
}: {
  readonly text: string;
  /** The unrounded figure behind `text`, for direction only. `null` where there is none. */
  readonly amount: number | null;
  /**
   * Track the value but do not announce it.
   *
   * For a figure that is being changed by the reader rather than by the market — the
   * headline follows the chart's crosshair, and washing it green on every pixel of a drag
   * would be motion that means nothing. The previous value is still recorded, so the
   * first genuine change after this goes false is compared against the right thing
   * instead of flashing spuriously.
   */
  readonly quiet?: boolean;
  readonly className?: string;
}) {
  const previous = useRef({ text, amount });
  const [change, setChange] = useState<{ tick: number; flash: "rise" | "fall" }>({
    tick: 0,
    flash: "rise",
  });

  useEffect(() => {
    const flash = flashFor(previous.current, { text, amount }, quiet);
    // Recorded whether or not it flashed, so the next genuine change is compared against
    // what is actually on screen rather than against whatever was there before a drag.
    previous.current = { text, amount };

    if (flash === null) return;
    setChange((last) => ({ tick: last.tick + 1, flash }));
  }, [text, amount, quiet]);

  return (
    <span
      // Nothing has changed yet on the first render, and animating then would flash every
      // figure on the page the moment it loads.
      key={change.tick}
      className={`${className} ${
        change.tick === 0 ? "" : `-mx-1 rounded px-1 flash-${change.flash}`
      }`}
    >
      {text}
    </span>
  );
}
