"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Wallet } from "./wallet";

const LINKS: readonly { readonly href: string; readonly label: string; readonly key: string }[] = [
  { href: "/", label: "Explore", key: "explore" },
  { href: "/launch", label: "Create", key: "create" },
  { href: "/profile", label: "Profile", key: "profile" },
];

/**
 * The white pill floating on the plate.
 *
 * The links are absolutely centred rather than laid out between the mark and the wallet,
 * so they sit on the page's midline and stay there when a connected address replaces
 * "connect wallet" and changes the width of the right-hand side.
 *
 * ## Below the fold of a phone
 *
 * Four links, a mark and an address do not fit across 390 pixels, and the arrangements
 * that make them fit are all worse than not trying: shrinking the type below its floor,
 * or dropping links until the bar is no longer navigation. So under 780px the links move
 * into a sheet behind a button, and the bar keeps only the mark, the wallet and the way
 * in — which is the one layout that stays legible at every width.
 */
export function TopBar({
  active,
}: {
  readonly active?: "explore" | "create" | "profile" | "docs" | undefined;
}) {
  const [open, setOpen] = useState(false);
  const path = usePathname();

  // A route change closes it. Next keeps this component mounted across a client
  // navigation, so without this the sheet would still be covering the page it just
  // navigated to.
  useEffect(() => {
    setOpen(false);
  }, [path]);

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };

    // The page behind a sheet must not scroll under it, and the scrollbar's width has to
    // be given back as padding or the whole layout jumps sideways as it opens.
    const gap = window.innerWidth - document.documentElement.clientWidth;
    const { overflow, paddingRight } = document.body.style;
    document.body.style.overflow = "hidden";
    if (gap > 0) document.body.style.paddingRight = `${String(gap)}px`;

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
    };
  }, [open]);

  return (
    <>
      <header className="ax-navpill">
        <Link className="ax-brand" href="/" aria-label="agen">
          <img src="/mark.png" width={22} height={22} alt="" aria-hidden="true" />
        </Link>

        <nav className="ax-nav" aria-label="sections">
          {LINKS.map((link) => (
            <Link key={link.key} className={active === link.key ? "on" : ""} href={link.href}>
              {link.label}
            </Link>
          ))}
          <a href="https://x.com/agendotspace" target="_blank" rel="noreferrer">
            Docs
          </a>
        </nav>

        <div className="ax-top-right">
          <Wallet />

          <button
            type="button"
            className="ax-burger"
            aria-label={open ? "close menu" : "open menu"}
            aria-expanded={open}
            aria-controls="ax-menu"
            onClick={() => {
              setOpen((was) => !was);
            }}
          >
            {/* Two lines that become a cross. Animating the same two elements rather than
                swapping icons is what makes the change read as one object moving. */}
            <span className={open ? "ax-burger-bar ax-burger-x" : "ax-burger-bar"} />
            <span className={open ? "ax-burger-bar ax-burger-x" : "ax-burger-bar"} />
          </button>
        </div>
      </header>

      {/*
        Rendered always rather than mounted on open, so the sheet can animate both ways.
        A panel that only exists while open has nothing to animate out from, and closing
        it would be a disappearance.
      */}
      <div
        className={open ? "ax-scrim ax-scrim-on" : "ax-scrim"}
        aria-hidden="true"
        onClick={() => {
          setOpen(false);
        }}
      />

      <div id="ax-menu" className={open ? "ax-sheet ax-sheet-on" : "ax-sheet"} hidden={!open}>
        <nav aria-label="sections">
          {LINKS.map((link, index) => (
            <Link
              key={link.key}
              href={link.href}
              className={active === link.key ? "on" : ""}
              style={{ ["--i" as string]: String(index) }}
            >
              {link.label}
            </Link>
          ))}
          <a
            href="https://x.com/agendotspace"
            target="_blank"
            rel="noreferrer"
            style={{ ["--i" as string]: "3" }}
          >
            Docs
          </a>
        </nav>
      </div>
    </>
  );
}
