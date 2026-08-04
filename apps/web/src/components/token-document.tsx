"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  directImage,
  parseTokenDocument,
  resolveUri,
  EMPTY_DOCUMENT,
  type TokenDocument,
} from "../lib/token-uri";

/**
 * What a token says about itself, read in the browser.
 *
 * A client component because the address being fetched is one a stranger put on chain, and
 * a server that follows those is a server making requests on behalf of anyone who can
 * afford a launch. See `lib/token-uri.ts`. The consequence is that a description and a set
 * of links arrive slightly after the rest of the page, which is why every caller here
 * supplies something to render in the meantime.
 *
 * Both components below share one query key, so a page showing the description and the
 * links fetches the document once rather than twice.
 */
function useTokenDocument(uri: string): TokenDocument {
  const trimmed = uri.trim();
  // A URI that is plainly an image is not a document, and asking for it would spend a
  // request to parse a PNG as JSON.
  const enabled = trimmed !== "" && directImage(trimmed) === null;

  const { data } = useQuery({
    queryKey: ["token-document", trimmed],
    queryFn: async (): Promise<TokenDocument> => {
      const response = await fetch(resolveUri(trimmed), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`the document answered ${response.status}`);
      return parseTokenDocument(await response.json());
    },
    enabled,
    // It is somebody's static file. Re-reading it every few seconds would say nothing new.
    staleTime: 5 * 60 * 1_000,
    retry: false,
  });

  return data ?? EMPTY_DOCUMENT;
}

/**
 * The token's own description, or something true in its place.
 *
 * The fallback is the model's mechanism rather than "no description yet". A creator who
 * wrote nothing has still chosen a market that behaves a particular way, and saying what
 * that is beats an empty space telling a reader that somebody could not be bothered.
 */
export function TokenDescription({
  uri,
  fallback,
}: {
  readonly uri: string;
  readonly fallback: ReactNode;
}) {
  const { description } = useTokenDocument(uri);

  return (
    <p className="max-w-2xl text-[0.82rem] leading-relaxed text-ink-muted">
      {description ?? fallback}
    </p>
  );
}

/**
 * The creator's links, as pills, and nothing where there are none.
 *
 * These are the only things on this page pointing somewhere Verdant does not control, so
 * they carry `rel="noreferrer nofollow"`: a launch costs a transaction and nothing else,
 * which makes a market page an inexpensive place to put a link if the link inherits any
 * standing from the site it sits on.
 */
export function TokenLinks({ uri }: { readonly uri: string }) {
  const { website, x, telegram } = useTokenDocument(uri);

  return (
    <>
      {x === null ? null : (
        <LinkPill href={x} label="X">
          <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3" fill="currentColor">
            <path d="M12.6 1.5h2.3l-5 5.7 5.9 7.8h-4.6l-3.6-4.7-4.1 4.7H1.2l5.4-6.2L1 1.5h4.7l3.3 4.3ZM11.8 13.6h1.3L5.2 2.8H3.8Z" />
          </svg>
        </LinkPill>
      )}

      {telegram === null ? null : (
        <LinkPill href={telegram} label="Telegram">
          <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3" fill="currentColor">
            <path d="M14.6 2.3 1.5 7.4c-.6.2-.6.9 0 1.1l3.3 1 1.3 4c.1.4.6.5.9.2l1.8-1.7 3.4 2.5c.4.3.9.1 1-.4l2.3-11c.1-.5-.4-.9-.9-.8ZM6.2 9.5l6-3.9-4.6 4.6-.2 2.2Z" />
          </svg>
        </LinkPill>
      )}

      {website === null ? null : (
        <LinkPill href={website} label="Website">
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <circle cx="8" cy="8" r="6" />
            <path d="M2 8h12M8 2c1.6 1.7 2.4 3.7 2.4 6S9.6 12.3 8 14C6.4 12.3 5.6 10.3 5.6 8S6.4 3.7 8 2Z" />
          </svg>
        </LinkPill>
      )}
    </>
  );
}

function LinkPill({
  href,
  label,
  children,
}: {
  readonly href: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer nofollow"
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-sunken px-3 py-1.5 text-[0.72rem] text-ink-muted transition hover:border-border-strong hover:text-ink"
    >
      {children}
      {label}
    </a>
  );
}
