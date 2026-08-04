"use client";

import { useEffect, useState, type ReactNode } from "react";

import { directImage, resolveUri } from "../lib/token-uri";
import { AVATAR_SIZING, type AvatarSize } from "./primitives";

/**
 * A token's picture, from whatever its `metadataURI` turns out to be.
 *
 * The URI is one string and creators use it three ways: an image, a JSON document with an
 * `image` field, or nothing. Rather than demand one of them at launch — which is what a
 * form asking for `token.json` does, and it costs every creator who has a PNG and no
 * hosting — this reads whichever arrived and falls back to `children` when there is
 * nothing to show.
 *
 * The fetch for a document runs in the browser and not on the server. A creator-supplied
 * URL fetched server-side is a request made by this deployment to an address a stranger
 * chose, which is a different and much worse thing than a picture that fails to load.
 */
export function TokenImage({
  uri,
  size = "default",
  children,
}: {
  readonly uri: string;
  readonly size?: AvatarSize;
  /** The plate, shown until an image resolves and again if one never does. */
  readonly children: ReactNode;
}) {
  const [source, setSource] = useState<string | null>(() => directImage(uri));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    const direct = directImage(uri);
    setSource(direct);
    if (direct !== null) return;

    // Only a document can still yield a picture, and only its `image` field. Aborted on
    // unmount so a scrolled-past card does not resolve into a card that replaced it.
    const cancel = new AbortController();
    void (async () => {
      try {
        const response = await fetch(resolveUri(uri), {
          signal: cancel.signal,
          headers: { accept: "application/json" },
        });
        if (!response.ok) return;

        const document: unknown = await response.json();
        const image =
          typeof document === "object" && document !== null && "image" in document
            ? (document as { image?: unknown }).image
            : undefined;

        if (typeof image === "string" && image.trim() !== "") {
          setSource(resolveUri(image.trim()));
        }
      } catch {
        // A creator's link not answering is ordinary, and the plate already says so.
      }
    })();

    return () => cancel.abort();
  }, [uri]);

  const hasImage = source !== null && !failed;

  return (
    <span className={`relative block shrink-0 overflow-hidden ${AVATAR_SIZING[size]}`}>
      {/* The plate is the fallback for a token with no picture. Behind a real image it must
          not show: a logo with a transparent background would otherwise let the plate's
          identicon gradient through, which reads as the token having a colour it did not
          choose. The backing has to be OPAQUE — `surface-sunken` is 18% black, so it let the
          page's own background show through the transparent parts of a logo, which is the
          gradient this was meant to hide. `canvas` is the one solid colour in the theme. So a
          resolved image gets a plain opaque surface behind it, and the plate only when there
          is no image to cover it. */}
      {hasImage ? (
        <span aria-hidden="true" className="absolute inset-0 size-full bg-canvas" />
      ) : (
        children
      )}
      {source === null || failed ? null : (
        // Not `next/image`, and not by omission. Optimising these means either allowing
        // any remote host in `remotePatterns` — which makes this deployment an image proxy
        // for whatever URL a stranger puts on chain — or `unoptimized`, which is this with
        // extra steps. A plain element that can fail is the right shape for a link the
        // protocol does not control.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={source}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

