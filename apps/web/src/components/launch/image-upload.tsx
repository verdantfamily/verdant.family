"use client";

import { useEffect, useRef, useState } from "react";

import { ImageProblem, prepareImage, uploadImage, type PreparedImage } from "../../lib/image";

/**
 * Choose a picture, see it, and have its address recorded.
 *
 * The control this replaced was a text field for a URL, which asked every creator to have
 * solved hosting before they arrived. The work is the same three steps it always was — a
 * file, somewhere to put it, an address — but two of them belong to the interface.
 *
 * There is deliberately no way to paste a link. A second path to the same field is a second
 * set of failures to explain, and it exists only because the first path was inadequate: this
 * deployment has a store, so pasting an address is the creator doing the interface's job.
 * Anyone who does want to point at art they already host can still say so through the
 * metadata document, which is where a hosted document belongs.
 */
export function ImageUpload({
  value,
  onChange,
}: {
  /** The address currently recorded, which is `imageUrl` on the draft. */
  readonly value: string;
  readonly onChange: (uri: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // The preview is an object URL held only by this component, so it is this component's to
  // release. Without this a creator who tries six pictures leaks six decoded images.
  useEffect(() => {
    if (preview === null) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  async function accept(file: File | undefined) {
    if (file === undefined) return;

    setProblem(null);
    setBusy(true);

    let prepared: PreparedImage | null = null;
    try {
      prepared = await prepareImage(file);
      const stored = await uploadImage(prepared);

      setPreview((previous) => {
        if (previous !== null) URL.revokeObjectURL(previous);
        return prepared === null ? null : prepared.preview;
      });
      onChange(stored.uri);
    } catch (cause) {
      if (prepared !== null) URL.revokeObjectURL(prepared.preview);
      setProblem(
        cause instanceof ImageProblem
          ? cause.message
          : "Something went wrong handling that file.",
      );
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    setPreview((previous) => {
      if (previous !== null) URL.revokeObjectURL(previous);
      return null;
    });
    setProblem(null);
    onChange("");
    if (input.current !== null) input.current.value = "";
  }

  const shown = preview ?? (value === "" ? null : value);

  return (
    <div>
      <div className="flex items-start gap-4">
        {/* The picture, or the space it will occupy. Shown at the size a market card uses,
            because the point of a preview is the size it will be read at. */}
        <div className="relative size-20 shrink-0 overflow-hidden rounded-[1.1rem] border border-border bg-surface-sunken">
          {shown === null ? (
            <span className="grid size-full place-items-center text-[0.65rem] text-ink-faint">
              512 × 512
            </span>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shown} alt="" className="size-full object-cover" />
          )}
          {busy ? (
            <span className="absolute inset-0 grid place-items-center bg-canvas/70 text-[0.62rem] text-ink">
              working
            </span>
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void accept(event.dataTransfer.files[0]);
            }}
            className={`rounded-xl border border-dashed px-4 py-3 transition-colors ${
              dragging ? "border-accent bg-accent-soft" : "border-border-strong bg-surface"
            }`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => input.current?.click()}
                className="rounded-lg bg-ink px-3 py-1.5 text-[0.78rem] font-medium text-ink-inverse transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {shown === null ? "Upload image" : "Replace"}
              </button>

              {shown === null ? (
                <span className="text-[0.75rem] text-ink-muted">or drop one here</span>
              ) : (
                <button
                  type="button"
                  onClick={clear}
                  className="text-[0.75rem] text-ink-muted underline decoration-dotted underline-offset-4 hover:text-ink"
                >
                  Remove
                </button>
              )}
            </div>

            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(event) => void accept(event.target.files?.[0])}
            />
          </div>

          {problem !== null ? (
            <p className="mt-1.5 text-[0.75rem] text-fall">{problem}</p>
          ) : (
            <p className="mt-1.5 text-[0.75rem] leading-relaxed text-ink-muted">
              PNG, JPEG, WebP or GIF. Cropped to a square and stored at 512 pixels; the
              address it lands at is what the token records.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
