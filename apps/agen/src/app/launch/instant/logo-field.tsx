"use client";

/**
 * The token's logo, as a row rather than a tile.
 *
 * The programmable flow's `ImageField` is a square that sits beside the name and the
 * ticker, which is right for that layout and wrong for this one: Instant puts the logo
 * in a two-column grid next to the fee receiver, where a tall square would drag the row
 * out of line with the field beside it. Same upload, same content-addressed answer,
 * different shape.
 *
 * Required here, unlike there. A token launched without a picture cannot be given one
 * afterwards — the metadata URI is written at creation and `metadataMutable` is false —
 * so the field refuses to be skipped rather than warning about it later.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface LogoFieldProps {
  readonly value: string | null;
  readonly onChange: (url: string | null) => void;
}

export function LogoField({ value, onChange }: LogoFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (preview !== null) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const take = useCallback(
    async (file: File) => {
      setError(null);
      setBusy(true);

      setPreview((old) => {
        if (old !== null) URL.revokeObjectURL(old);
        return URL.createObjectURL(file);
      });

      try {
        const response = await fetch("/api/images", {
          method: "POST",
          headers: { "content-type": file.type },
          body: file,
        });

        const body = (await response.json()) as { url?: string; error?: string };

        if (!response.ok || typeof body.url !== "string") {
          setError(body.error ?? "That image could not be saved.");
          onChange(null);
          return;
        }

        onChange(body.url);
      } catch {
        setError("That image could not be saved. Check your connection.");
        onChange(null);
      } finally {
        setBusy(false);
      }
    },
    [onChange],
  );

  const shown = preview ?? value;

  return (
    <div className="ax-logo">
      <button
        type="button"
        className="ax-logo-row"
        onClick={() => input.current?.click()}
      >
        <span className="ax-logo-tile">
          {shown === null ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <rect x="3" y="4" width="18" height="16" rx="4" />
              <circle cx="8.8" cy="9.6" r="1.5" />
              <path d="M3.4 16.6 8.5 12l4 3.4 3.4-2.6 4.7 3.9" strokeLinejoin="round" />
            </svg>
          ) : (
            <img src={shown} alt="" />
          )}
          {busy ? <span className="ax-logo-busy" aria-hidden /> : null}
        </span>

        <span className="ax-logo-text">{shown === null ? "Upload Logo" : "Change logo"}</span>
      </button>

      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file !== undefined) void take(file);
        }}
      />

      {error === null ? null : <p className="ax-logo-error">{error}</p>}
    </div>
  );
}
