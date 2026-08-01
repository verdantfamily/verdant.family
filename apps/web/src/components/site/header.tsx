"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ConnectButton } from "../connect-button";

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

  /** `/` would otherwise match every path, and `/launch/classic` should light Launch. */
  function isCurrent(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-canvas/75 shadow-sticky backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
        <Link href="/" className="group flex items-center gap-2.5">
          <Mark mark={mark} lockup={lockup} />
          <span className="text-[1.05rem] font-semibold tracking-tight text-ink">
            Verdant
          </span>
        </Link>

        {/* A well with a white pill in it, which is what a segmented control looks like on
            a dark surface: the track is pressed into the page rather than raised off it. */}
        <nav className="hidden items-center rounded-full border border-border bg-surface-sunken p-1 md:flex">
          {NAV.map((item) => {
            const current = isCurrent(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`rounded-full px-4 py-1.5 text-sm transition ${
                  current
                    ? "bg-ink text-ink-inverse shadow-card"
                    : "text-ink-muted hover:bg-surface-raised hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/launch"
            className="hidden h-9 items-center rounded-full border border-border bg-surface px-4 text-sm font-medium text-ink transition hover:border-border-strong hover:bg-surface-raised sm:inline-flex"
          >
            Launch a token
          </Link>
          <ConnectButton />
        </div>
      </div>

      {/* On a phone the segmented control does not fit beside the wordmark, so it moves
          to its own scrollable row rather than collapsing into a menu nobody opens. */}
      <nav className="flex items-center gap-1 overflow-x-auto border-t border-border/70 px-4 pb-2 pt-1.5 md:hidden">
        {NAV.map((item) => {
          const current = isCurrent(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={current ? "page" : undefined}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm transition ${
                current ? "bg-ink text-ink-inverse" : "text-ink-muted"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
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
