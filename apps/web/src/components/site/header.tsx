"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { LAUNCHING_OPEN } from "../../lib/launch-window";
import { ConnectButton } from "../connect-button";
import { LaunchSoonTrigger } from "../launch-soon";

/** Shared so the link and the button that replaces it are the same object on screen. */
const LAUNCH_BUTTON =
  "hidden h-9 items-center rounded-full border border-border bg-surface/80 px-4 text-sm font-medium text-ink backdrop-blur-xl transition hover:border-border-strong hover:bg-surface-raised md:inline-flex";

/**
 * The four places there are to go.
 *
 * A launchpad is really four surfaces — look at markets, make one, see your own, read
 * how it works — so the navigation is those four and nothing else. It is rendered as a
 * segmented control rather than a row of links because the segment that is lit tells you
 * where you are without a second cue.
 */
const NAV = [
  { href: "/", label: "Explore" },
  { href: "/launch", label: "Launch" },
  { href: "/profile", label: "Profile" },
  { href: "/docs", label: "Docs" },
] as const;

/**
 * The brand files are resolved by the root layout and handed down.
 *
 * This component reads the current path, so it is a client component, so it cannot touch
 * the filesystem. Both paths are `null` when the generator has never been run, and the
 * mark below falls back to a drawn one — which is a different picture, not a broken page.
 */
export function Header({
  mark,
  lockup,
}: {
  readonly mark: string | null;
  readonly lockup: string | null;
}) {
  const pathname = usePathname();
  const scrolled = useScrolled();
  const { track, pill, settled } = useSlidingPill(pathname);

  /** `/` would otherwise match every path, and `/launch/classic` should light Launch. */
  function isCurrent(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  /*
   * Floating rather than a bar. The header carries no background of its own, so the
   * photograph runs unbroken behind it and the controls read as glass pills laid on top —
   * each one carries its own blur, which is what keeps their labels legible over a picture.
   *
   * The veil below is what makes that survive contact with a page. See `.header-veil`.
   */
  return (
    <header className="sticky top-0 z-40">
      {/*
       * Absent at the top of a page, because there is nothing up there to separate from and
       * the photograph is the first thing anybody sees. It fades in the moment the page
       * moves, which is also the moment content starts arriving under the controls.
       */}
      <div
        aria-hidden="true"
        className={`header-veil pointer-events-none absolute inset-x-0 top-0 -z-10 h-24 transition-opacity duration-300 ${
          scrolled ? "opacity-100" : "opacity-0"
        }`}
      />

      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="group flex items-center gap-2.5">
          <Mark mark={mark} lockup={lockup} />
          <span className="text-[1.02rem] font-medium tracking-tight text-ink">
            verdant.family
          </span>
        </Link>

        {/* A well with a white pill in it, which is what a segmented control looks like on
            a dark surface: the track is pressed into the page rather than raised off it.
            The pill is one element that moves, rather than a background switched off one
            link and on to another — so a navigation reads as a thing sliding across the
            control instead of two separate flickers. */}
        <nav
          ref={track}
          className="relative hidden items-center rounded-full border border-border bg-surface-sunken/80 p-1 backdrop-blur-xl md:flex"
        >
          {pill === null ? null : (
            <span
              aria-hidden="true"
              className={`absolute inset-y-1 rounded-full bg-ink shadow-card ${
                settled ? "transition-[transform,width] duration-300 ease-out" : ""
              }`}
              style={{
                width: pill.width,
                transform: `translateX(${pill.left}px)`,
                left: 0,
              }}
            />
          )}

          {NAV.map((item) => {
            const current = isCurrent(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current ? "page" : undefined}
                // Above the pill, and coloured against it rather than carrying it.
                className={`relative z-10 rounded-full px-4 py-1.5 text-sm transition-colors ${
                  current ? "text-ink-inverse" : "text-ink-muted hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          {/* While launching is closed this opens the notice rather than navigating to a
              route whose only content is that notice. */}
          {LAUNCHING_OPEN ? (
            <Link href="/launch" className={LAUNCH_BUTTON}>
              Launch token
            </Link>
          ) : (
            <LaunchSoonTrigger>
              {(open) => (
                <button type="button" onClick={open} className={LAUNCH_BUTTON}>
                  Launch token
                </button>
              )}
            </LaunchSoonTrigger>
          )}
          <ConnectButton label="Connect Wallet" />
        </div>
      </div>
    </header>
  );
}

/**
 * Where the lit segment is, so one pill can move between them.
 *
 * Measured from the DOM rather than computed, because the labels have different widths
 * and the only thing that knows how wide "Profile" renders in this face at this size is
 * the browser that just laid it out.
 *
 * ## Why the layout effect, and why `settled`
 *
 * The measurement has to happen before the browser paints, or the first frame of every
 * page load has an unlit control and the pill visibly snaps into place. `useLayoutEffect`
 * runs in that gap — on the client only, which is what the guard below is for: it does
 * not run during a server render and React warns if it is asked to.
 *
 * `settled` then withholds the transition until after that first positioning. Without it
 * the pill animates from the left edge of the control to the current tab every time
 * somebody loads a page, which looks like a bug rather than like an entrance.
 */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function useSlidingPill(pathname: string) {
  const track = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const [settled, setSettled] = useState(false);

  useIsomorphicLayoutEffect(() => {
    const container = track.current;
    if (container === null) return;

    function measure() {
      const active = container?.querySelector<HTMLElement>('[aria-current="page"]');
      setPill(
        active == null ? null : { left: active.offsetLeft, width: active.offsetWidth },
      );
    }

    measure();

    // The control's width changes with the viewport, and a pill measured at one width is
    // in the wrong place at another.
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [pathname]);

  // A frame after the first placement, so the transition applies to every move except the
  // one that put it there.
  useEffect(() => {
    if (pill === null || settled) return;
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [pill, settled]);

  return { track, pill, settled };
}

/**
 * Whether the page has moved at all.
 *
 * A few pixels rather than zero, so that the veil does not flicker on and off under the
 * elastic overscroll a trackpad produces at the very top of a page.
 *
 * Read in an effect and not during render: the server has no scroll position, and a
 * component that answered differently in the two places would be a hydration error. The
 * listener is passive because it only reads — declaring that is what lets the browser
 * scroll without waiting to see whether this handler cancels it.
 */
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    function read() {
      setScrolled(window.scrollY > 8);
    }

    read();
    window.addEventListener("scroll", read, { passive: true });
    return () => window.removeEventListener("scroll", read);
  }, []);

  return scrolled;
}

/**
 * The mark, however it is available.
 *
 * The real file first, then the lockup, then a drawn sprout — the same ladder the teaser
 * climbs, for the same reason: a missing brand file should cost the page its polish and
 * not its meaning. The lockup is the second choice rather than the first because it
 * carries the wordmark, and the wordmark is already set in type immediately to its right.
 *
 * Each of them is a background image on a sized box rather than an `<img>`. The mark is
 * shipped at 176 px and drawn at 32, so there is no intrinsic size worth honouring and
 * nothing for an image loader to optimise; this is the same treatment a wallet's announced
 * icon gets in `connect-button.tsx`, and it keeps the accessible name on one element
 * whichever branch renders.
 */
function Mark({ mark, lockup }: { readonly mark: string | null; readonly lockup: string | null }) {
  if (mark !== null) {
    return (
      <span
        role="img"
        aria-label="Verdant"
        className="size-8 shrink-0 bg-contain bg-center bg-no-repeat"
        style={{ backgroundImage: `url("${mark}")` }}
      />
    );
  }

  if (lockup !== null) {
    return (
      <span
        role="img"
        aria-label="Verdant"
        className="h-7 w-24 shrink-0 bg-contain bg-left bg-no-repeat"
        style={{ backgroundImage: `url("${lockup}")` }}
      />
    );
  }

  return <Sprout />;
}

/**
 * The fallback mark, drawn rather than shipped as an image.
 *
 * White strokes on the page's own background, as the teaser draws it. It used to sit on a
 * green plate, which was how a mark held its own against a near-white canvas; on a dark
 * one the plate is the brighter object of the two and the sprout inside it disappears.
 */
function Sprout() {
  return (
    <span role="img" aria-label="Verdant" className="grid size-8 shrink-0 place-items-center">
      <svg
        viewBox="0 0 20 20"
        aria-hidden="true"
        className="size-[1.35rem] text-ink"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 17V8.5" />
        <path d="M10 9.5C10 6.2 12.4 3.6 16 3.2c.4 3.6-2.2 6.3-5.4 6.3H10Z" />
        <path d="M10 12.2C10 9.9 8.2 8 5.6 7.7c-.3 2.6 1.6 4.5 3.9 4.5H10Z" />
      </svg>
    </span>
  );
}
