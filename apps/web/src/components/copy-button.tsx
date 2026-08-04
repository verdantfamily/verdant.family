"use client";

import { useEffect, useRef, useState } from "react";

import { copyText } from "../lib/clipboard";

/**
 * Copy a value to the clipboard, with a moment of acknowledgement.
 *
 * An address on this page is the thing a reader most often needs to carry elsewhere — into
 * a wallet, an explorer, a message — and the shortened form shown in the UI cannot be
 * retyped. The check that briefly replaces the icon is the only confirmation there is; a
 * copy that says nothing is indistinguishable from one that silently failed.
 */
export function CopyButton({
  value,
  label = "Copy",
  className = "",
}: {
  readonly value: string;
  readonly label?: string;
  readonly className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  async function copy() {
    // Through `copyText`, which falls back when the async clipboard API is refused. A
    // failure leaves the icon alone rather than claiming a copy that did not happen.
    if (!(await copyText(value))) return;

    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className={`inline-grid size-5 shrink-0 place-items-center rounded-md align-middle transition-colors ${
        copied ? "text-accent" : "text-ink-faint hover:text-ink"
      } ${className}`}
    >
      {copied ? <CheckGlyph /> : <CopyGlyph />}
    </button>
  );
}

function CopyGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.75" />
      <path d="M10.25 5.75V4.25A1.5 1.5 0 0 0 8.75 2.75H4.25A1.5 1.5 0 0 0 2.75 4.25v4.5a1.5 1.5 0 0 0 1.5 1.5h1.5" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.25 8.5 6.25 11.5 12.75 4.5" />
    </svg>
  );
}
