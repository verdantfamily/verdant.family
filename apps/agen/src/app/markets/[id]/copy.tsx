"use client";

import { useState } from "react";

/**
 * The contract address, shown and copyable.
 *
 * Shown, unlike the pill this replaced. The old one printed a label and put the value on
 * the clipboard, on the argument that nobody reads a twenty-byte hex string — which is
 * true of reading it end to end and false of the thing people actually do, which is check
 * the first four characters against the ones they were sent. A token address is how a
 * buyer tells a token from the four impostors named after it, so it goes on the page.
 *
 * The middle is elided by the stylesheet rather than by slicing here, so the full value is
 * selectable and the ends — which are the parts anybody compares — are always the ends.
 *
 * The confirmation is the row saying so rather than a toast, because a toast for a
 * clipboard write is a notification about something the reader just did.
 */
export function CopyAddress({ address }: { readonly address: string | null }) {
  const [copied, setCopied] = useState(false);

  if (address === null) {
    return (
      <button type="button" className="ax-tk-ca" disabled>
        <span>Assigned when this token launches</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="ax-tk-ca"
      title={address}
      aria-label={`Copy the contract address, ${address}`}
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
      <span>{copied ? "Copied to your clipboard" : address}</span>
      <CopyIcon />
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
