"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { copyText } from "../lib/clipboard";

/**
 * A pill that copies an address rather than navigating to it.
 *
 * Sits in the same row as the links out, and deliberately does a different thing: what
 * somebody wants from a contract address is almost never to look at a page about it, it is
 * to paste it into a wallet or a bot. Making that the click — rather than a copy icon
 * beside a link to an explorer — is one target instead of two, and the larger of them is
 * the thing people actually came for.
 *
 * The label changes to "Copied" for a moment. Without it the click has no visible effect
 * at all, and a reader who is not sure whether it worked will click again, which is how
 * you end up pasting an address twice.
 */
export function CopyPill({
  value,
  label,
  title,
  children,
}: {
  readonly value: string;
  readonly label: string;
  /** The full string, for a tooltip: the pill shows a name, not the address. */
  readonly title?: string;
  readonly children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    // Only on a copy that actually happened. Saying "Copied" and having pasted nothing is
    // worse than no feedback, because it stops the reader checking.
    if (!(await copyText(value))) return;

    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1_400);
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={title ?? value}
      aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[0.72rem] transition ${
        copied
          ? "border-accent/50 bg-accent-soft text-accent-strong"
          : "border-border bg-surface-sunken text-ink-muted hover:border-border-strong hover:text-ink"
      }`}
    >
      {copied ? <CheckGlyph /> : children}
      {copied ? "Copied" : label}
    </button>
  );
}

function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.25 8.5 6.25 11.5 12.75 4.5" />
    </svg>
  );
}
