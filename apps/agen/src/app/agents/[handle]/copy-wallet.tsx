"use client";

/**
 * The treasury address, onto the clipboard.
 *
 * The address stays visible next to it rather than being hidden behind the button, for
 * the reason the token page's copy control gives: nobody reads twenty bytes of hex end
 * to end, and everybody checks the first four characters against the ones they were
 * sent. What the button adds is the part that cannot be done by eye — this is the
 * address someone is about to send ETH to, and retyping it is how funds go missing.
 *
 * The confirmation is the button's own label rather than a toast, because a toast for a
 * clipboard write is a notification about something the reader just did.
 */

import { useState } from "react";

export function CopyWallet({ address }: { readonly address: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="ag-copy"
      aria-label={`Copy the treasury address, ${address}`}
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
      {copied ? (
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m3.25 8.5 3 3 6.5-7" />
        </svg>
      ) : (
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
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
