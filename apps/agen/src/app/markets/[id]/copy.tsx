"use client";

import { useState } from "react";

/**
 * An identifier that copies itself, shown as a pill rather than as an address.
 *
 * The address is not on the face of it deliberately. A twenty-byte hex string is wanted
 * for pasting far more often than for reading, and printing it costs a line of the
 * header to a value nobody verifies by eye — so the pill says what the thing *is*, and
 * the value goes to the clipboard. It is on `title` for anybody who does want to look.
 *
 * A pool is here for a reason that is easy to miss: a v4 pool id is a hash of the pool
 * key rather than an address, so no explorer has a page for one and copying is the only
 * useful thing that can be done with it.
 *
 * The confirmation is the label changing rather than a toast, because a toast for a
 * clipboard write is a notification about something the reader just did.
 */
export function CopyAddress({
  address,
  label,
}: {
  readonly address: string | null;
  readonly label: string;
}) {
  const [copied, setCopied] = useState(false);

  if (address === null) {
    return (
      <span
        className="pill-copy pending"
        title={`The ${label.toLowerCase()} is assigned when this token launches`}
      >
        {label} — not deployed
      </span>
    );
  }

  return (
    <button
      type="button"
      className="pill-copy"
      title={address}
      onClick={() => {
        void navigator.clipboard.writeText(address).then(
          () => {
            setCopied(true);
            setTimeout(() => {
              setCopied(false);
            }, 1_400);
          },
          () => undefined,
        );
      }}
    >
      <CopyIcon />
      {copied ? "Copied" : label}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.75" />
      <path d="M10.25 5.75V4.25A1.5 1.5 0 0 0 8.75 2.75H4.25A1.5 1.5 0 0 0 2.75 4.25v4.5a1.5 1.5 0 0 0 1.5 1.5h1.5" />
    </svg>
  );
}
