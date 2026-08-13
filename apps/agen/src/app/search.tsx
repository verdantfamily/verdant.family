"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Finding a token.
 *
 * A GET-shaped search that navigates rather than filtering in place, so a result is a URL
 * somebody can send to somebody else. It matches the mechanic as well as the name, which
 * is the point of searching here: "buyback" should find the token that does a buyback
 * even when nothing in its name suggests it.
 *
 * The filter button that used to sit beside it is gone. It was disabled, because there
 * was one dimension worth filtering on and nothing to filter, and the ordering control
 * next to it now does the job a reader would have reached for.
 */
export function Search({ initial }: { readonly initial: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);

  return (
    <div className="ax-search">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M10.7 10.7 14 14"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
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
          if (event.key !== "Enter") return;
          event.preventDefault();
          const trimmed = value.trim();
          router.push(trimmed.length === 0 ? "/" : `/?q=${encodeURIComponent(trimmed)}`);
        }}
      />
    </div>
  );
}
