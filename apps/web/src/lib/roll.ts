"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A number that travels to its new value instead of jumping to it.
 *
 * For the one figure a page is built around. A market cap that snaps from 3.9K to 4.2K
 * has told the reader the same fact as one that counts, and thrown away the only cue that
 * distinguishes "it moved" from "you misread it a second ago" — which on a page somebody
 * is watching precisely because it moves is the cue that matters.
 *
 * ## What it deliberately does not do
 *
 * Roll on the way in. The first value is arrived at, not counted to, because a market cap
 * counting up from zero on every page load is a slot machine rather than a price. The
 * launch confirmation does count from zero, and that is a different moment with a
 * different meaning — see `CountUp`.
 *
 * And it does not roll a figure the reader is driving. Dragging a crosshair changes the
 * headline on every pixel; tweening between those would lag the pointer and read as the
 * page struggling.
 */
export function useRollingNumber(
  target: number | null,
  {
    durationMs = 400,
    disabled = false,
  }: { readonly durationMs?: number; readonly disabled?: boolean } = {},
): number | null {
  const [shown, setShown] = useState<number | null>(target);
  const from = useRef<number | null>(target);
  const frame = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (target === null) {
      from.current = null;
      setShown(null);
      return;
    }

    // Nothing to travel from, or nothing worth travelling: land on it.
    if (disabled || from.current === null || from.current === target) {
      from.current = target;
      setShown(target);
      return;
    }

    const start = performance.now();
    const origin = from.current;
    const distance = target - origin;

    function step(now: number) {
      const progress = Math.min((now - start) / durationMs, 1);
      // Cubic ease-out: quick off the mark, settling rather than stopping, which is what
      // makes a counting number read as arriving rather than as being animated.
      const eased = 1 - (1 - progress) ** 3;

      const value = origin + distance * eased;
      setShown(value);

      if (progress < 1) {
        frame.current = requestAnimationFrame(step);
        return;
      }
      from.current = target;
    }

    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      // Whatever was on screen is where the next roll starts, so an interrupted one does
      // not jump back before setting off again.
      from.current = shown ?? target;
    };
    // `shown` is read in the cleanup only, and listing it would restart the animation on
    // every frame it sets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs, disabled]);

  return shown;
}

/**
 * A number counted from zero, once, for a thing that just happened.
 *
 * The opposite decision to `useRollingNumber`: here the point is the arrival, so the
 * count is the event being celebrated rather than a value being updated. Used by the
 * launch confirmation and nowhere a price is read from.
 */
export function useCountUp(
  target: number | null,
  { durationMs = 1100, delayMs = 0 }: { readonly durationMs?: number; readonly delayMs?: number } = {},
): number | null {
  const [shown, setShown] = useState<number | null>(target === null ? null : 0);

  useEffect(() => {
    if (target === null) {
      setShown(null);
      return;
    }

    let frame: number | undefined;
    let start: number | undefined;
    // Captured so the closures below carry a `number` rather than the nullable prop.
    const destination = target;

    const timer = setTimeout(() => {
      function step(now: number) {
        start ??= now;
        const progress = Math.min((now - start) / durationMs, 1);
        const eased = 1 - (1 - progress) ** 3;
        setShown(destination * eased);
        if (progress < 1) frame = requestAnimationFrame(step);
      }
      frame = requestAnimationFrame(step);
    }, delayMs);

    return () => {
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [target, durationMs, delayMs]);

  return shown;
}

/**
 * Characters revealed left to right, as though being typed.
 *
 * For a token address on a confirmation, where the address arriving one character at a
 * time is the page saying "this now exists" — it is the first time that string has ever
 * been true. Nowhere else: a value somebody has to read and check should be there
 * immediately.
 */
export function useTypedText(text: string, { perCharMs = 14, delayMs = 0 } = {}): string {
  const [count, setCount] = useState(0);

  useEffect(() => {
    setCount(0);
    let interval: ReturnType<typeof setInterval> | undefined;

    const timer = setTimeout(() => {
      interval = setInterval(() => {
        setCount((previous) => {
          if (previous >= text.length) {
            if (interval !== undefined) clearInterval(interval);
            return previous;
          }
          return previous + 1;
        });
      }, perCharMs);
    }, delayMs);

    return () => {
      clearTimeout(timer);
      if (interval !== undefined) clearInterval(interval);
    };
  }, [text, perCharMs, delayMs]);

  return text.slice(0, count);
}
