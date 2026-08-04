"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * The phone's primary navigation, pinned to the bottom where a thumb reaches.
 *
 * The same four destinations the header carries on a desktop — but a top-of-page pill row
 * is the wrong place for them on a phone, where the top of a tall screen is the hardest
 * thing to reach. So on `md` and up this is hidden and the header's segmented control takes
 * over; below it, the header keeps only the brand and the wallet, and getting around is
 * this bar.
 *
 * It sits above the home indicator on notched phones (`env(safe-area-inset-bottom)`), and
 * the body reserves the same height so nothing important ever hides behind it.
 */
const NAV = [
  { href: "/", label: "Explore", icon: CompassIcon },
  { href: "/launch", label: "Launch", icon: LaunchIcon },
  { href: "/profile", label: "Profile", icon: ProfileIcon },
  { href: "/docs", label: "Docs", icon: DocsIcon },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  /** `/` matches only itself; `/launch/classic` should still light "Launch". */
  function isCurrent(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-canvas/85 shadow-sticky backdrop-blur-xl md:hidden"
    >
      <div className="mx-auto flex max-w-md items-stretch justify-around gap-1 px-2 pb-[env(safe-area-inset-bottom)]">
        {NAV.map(({ href, label, icon: Icon }) => {
          const current = isCurrent(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={current ? "page" : undefined}
              className={`flex flex-1 flex-col items-center gap-1 rounded-xl py-2 text-[0.66rem] font-medium leading-none transition-colors ${
                current ? "text-accent" : "text-ink-muted active:text-ink"
              }`}
            >
              <Icon active={current} />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * The icons, drawn to one grid so their weights match.
 *
 * The active one fills a touch to read as pressed at a glance rather than by its colour
 * alone, which a colour-blind reader cannot rely on.
 */
function Glyph({ active, children }: { readonly active: boolean; readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 1.9 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function CompassIcon({ active }: { readonly active: boolean }) {
  return (
    <Glyph active={active}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.6 8.4 13.2 13.2 8.4 15.6 10.8 10.8Z" fill={active ? "currentColor" : "none"} />
    </Glyph>
  );
}

function LaunchIcon({ active }: { readonly active: boolean }) {
  return (
    <Glyph active={active}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </Glyph>
  );
}

function ProfileIcon({ active }: { readonly active: boolean }) {
  return (
    <Glyph active={active}>
      <circle cx="12" cy="8.5" r="3.25" fill={active ? "currentColor" : "none"} />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
    </Glyph>
  );
}

function DocsIcon({ active }: { readonly active: boolean }) {
  return (
    <Glyph active={active}>
      <path d="M6.5 3.5h7l4 4v13h-11Z" />
      <path d="M13 3.5v4.5h4.5" />
      <path d="M9 12.5h6M9 15.5h6" />
    </Glyph>
  );
}
