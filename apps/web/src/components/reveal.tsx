"use client";

import { useEffect, useRef, useState, type ElementType, type ReactNode } from "react";

/**
 * Content that arrives as it is scrolled to.
 *
 * Once, and never again: an element that re-animated every time it crossed the viewport
 * would be an element nobody could read on the way back up. The observer disconnects
 * itself the first time it fires, so a long page costs one entry per section rather than
 * a live subscription per section.
 *
 * ## Why it is not applied to everything
 *
 * Because the first screen must not fade in. Anything above the fold is what a visitor is
 * waiting for, and delaying it by half a second to be tasteful is half a second of a page
 * that looks broken — and on a slow connection the observer may not even have run by the
 * time somebody starts reading. This is for what comes after: the sections underneath, the
 * ones a reader has chosen to scroll to.
 */
export function Reveal({
  children,
  as: Tag = "div",
  delay = 0,
  className = "",
}: {
  readonly children: ReactNode;
  /** The element to render, for a wrapper that has to be a `section` or a `li`. */
  readonly as?: ElementType;
  /** Milliseconds, for staggering siblings. */
  readonly delay?: number;
  readonly className?: string;
}) {
  const element = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = element.current;
    if (node === null) return;

    // No observer, no animation: the resting state is visible, so an old browser gets the
    // content rather than an empty page.
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      // A little before the edge, so a section is already arriving as it appears rather
      // than starting once it is fully on screen and visibly late.
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={element}
      style={shown ? { animationDelay: `${delay}ms` } : undefined}
      className={`reveal ${shown ? "reveal-in" : ""} ${className}`}
    >
      {children}
    </Tag>
  );
}
