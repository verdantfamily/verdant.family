"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The one control under the headline.
 *
 * A GET-shaped search that navigates rather than filtering in place, so a result is a
 * URL somebody can send to somebody else. It matches the mechanic as well as the name,
 * which is the point of searching here: "buyback" should find the token that does a
 * buyback even when nothing in its name suggests it.
 *
 * The filter button beside it is deliberately not wired to anything yet. There is one
 * dimension worth filtering on today — whether a token is trading — and no token is, so
 * the control would offer a choice with one outcome. It is present, disabled, and
 * labelled, rather than absent and then appearing later at a different width.
 */
export function Search({ initial }: { readonly initial: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);

  const submit = (): void => {
    const trimmed = value.trim();
    router.push(trimmed.length === 0 ? "/" : `/?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="search-row">
      <div className="search-field">
        <svg viewBox="0 0 16 16" aria-hidden="true" className="search-icon">
          <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>

        <input
          value={value}
          placeholder="Search by name, symbol or contract address"
          aria-label="search tokens"
          autoComplete="off"
          onChange={(event) => {
            setValue(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
      </div>

      <button
        type="button"
        className="search-filter"
        disabled
        title="Filters arrive with the first trading token"
        aria-label="filters"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2 4.5h12M4.5 8h7M7 11.5h2"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
