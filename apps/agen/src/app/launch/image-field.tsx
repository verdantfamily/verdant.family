"use client";

/**
 * The token's picture, chosen at the moment its name is.
 *
 * It used to be asked for on the launch screen, two steps and several minutes later, and
 * before that not at all — the create screen showed a picture-frame placeholder and a
 * line saying "you can add a picture once your token is live", because nothing stored an
 * image. Both were wrong in the same way: a creator naming their token is already
 * thinking about what it looks like, and being told to come back later is being told the
 * product is not ready for them.
 *
 * ## It uploads immediately
 *
 * The file goes to the volume as soon as it is chosen, rather than being held and sent
 * with the launch. A build takes minutes and a creator may reload the page in the middle
 * of one, so anything kept only in this component's state is a picture they have to
 * choose twice. What survives is a URL, which is small enough to keep beside the job.
 *
 * The preview is drawn from the local file before the upload finishes, so the picture
 * appears the instant it is picked rather than after a round trip.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface ImageFieldProps {
  /** The stored URL, or null when none has been chosen. */
  readonly value: string | null;
  readonly onChange: (url: string | null) => void;
}

export function ImageField({ value, onChange }: ImageFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Revoked when it changes or the component goes away: an object URL holds the file in
  // memory until it is released, and a creator trying several pictures would pin all of
  // them for the life of the page.
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
    <div className="identity-image">
      <button
        type="button"
        className={`identity-art${shown === null ? "" : " identity-art-filled"}`}
        aria-label={shown === null ? "add a picture" : "change the picture"}
        onClick={() => input.current?.click()}
      >
        {shown === null ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <circle cx="8.8" cy="9.6" r="1.5" />
            <path d="M3.4 16.6 8.5 12l4 3.4 3.4-2.6 4.7 3.9" strokeLinejoin="round" />
          </svg>
        ) : (
          // Not next/image: the source is a blob URL before the upload lands and an API
          // route afterwards, neither of which the optimiser can do anything useful with.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shown} alt="" />
        )}

        {busy ? <span className="identity-art-busy" aria-hidden /> : null}
      </button>

      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Cleared so choosing the same file twice in a row still fires a change.
          event.currentTarget.value = "";
          if (file !== undefined) void take(file);
        }}
      />

      {error === null ? null : <p className="identity-image-error">{error}</p>}
    </div>
  );
}
