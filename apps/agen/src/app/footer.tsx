"use client";

import { useState } from "react";

/**
 * The footer, once.
 *
 * It was written out inline on six pages, which is how the six of them came to disagree
 * about what they linked to. A footer is the same footer everywhere by definition — that is
 * what makes it a footer — so it is one component and every page renders it.
 *
 * A client component because of the address below: putting `$CNPY` on the clipboard needs an
 * event handler, and the alternative was a server footer wrapping a client island for one
 * button. There is nothing in here worth rendering on the server.
 */

/**
 * The token that backs Agen, and its address.
 *
 * Written out rather than read from configuration, because it is not this deployment's
 * address to know: `$CNPY` exists independently of whether Agen is pointed at mainnet, a
 * fork or a devnet, and a footer that lost its attribution on a testnet build would be
 * wrong about something that does not vary.
 */
const CNPY = "0x532c5583671870723CEEf573600208aF49c87c54";

export function SiteFooter({ reveal = true }: { readonly reveal?: boolean }) {
  return (
    <footer className={reveal ? "ax-footpanel ax-reveal" : "ax-footpanel"}>
      <div>
        <span className="ax-footmark">
          {/* Not next/image: a 24px brand mark already sized, with nothing to optimise. */}
          <img src="/mark.png" width={24} height={24} alt="" aria-hidden="true" />
          agen.space
        </span>
        <p>Tokens whose markets have their own rules</p>

        <p className="ax-footcnpy">
          agen.space is powered by <strong>$CNPY</strong>
          <CopyCnpy />
        </p>
      </div>

      <div className="ax-footlinks">
        {/*
          The only way in to `/useagen`, and the reason it is here rather than in the navigation:
          somebody who launched a token by replying to a post has been told the market's URL and
          nothing else, so the path to claiming their fees has to exist on every page they might
          land on. A footer is the one place that is true of.
        */}
        <a href="/useagen">Launch from X</a>
        <a href="https://x.com/agendotspace" target="_blank" rel="noreferrer">
          Twitter / X
        </a>
        <a href="https://canopyfinance.io" target="_blank" rel="noreferrer">
          Canopy Website
        </a>
        <a href="https://t.me/canopytg" target="_blank" rel="noreferrer">
          Telegram
        </a>
      </div>
    </footer>
  );
}

/**
 * The address, shown and copyable.
 *
 * Shown rather than hidden behind a "copy" label, for the reason the token page's own copy
 * button gives: nobody reads twenty bytes of hex end to end, and everybody checks the first
 * four characters against the ones they were sent. The middle is elided by the stylesheet
 * rather than by slicing, so what is on the clipboard is the whole address and the ends —
 * the parts anybody compares — are always the ends.
 */
function CopyCnpy() {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="ax-footca"
      title={CNPY}
      aria-label={`Copy the $CNPY contract address, ${CNPY}`}
      onClick={() => {
        void navigator.clipboard.writeText(CNPY).then(
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
      <span>{copied ? "Copied" : CNPY}</span>
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
    </button>
  );
}
