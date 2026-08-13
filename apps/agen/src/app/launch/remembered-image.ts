"use client";

/**
 * The picture, carried from the screen that chose it to the screen that uses it.
 *
 * A creator picks their token's image while naming it, and it is recorded on chain
 * several minutes later at launch. In between is the build, which is long enough that
 * people reload, close the tab, come back from a link, or leave it open over lunch — so
 * component state does not survive the gap and neither does anything held in a parent.
 *
 * The obvious alternative is to store it on the job, which would mean a field on
 * `GenerationJob` in the compiler package. That is a change to the build record for
 * something the build never reads: the pipeline does not know a token has a picture and
 * has no reason to. Keeping it in the browser, keyed by the job it belongs to, puts the
 * fact where it is used and leaves the compiler alone.
 *
 * What is stored is a URL, not an image. The bytes went to the volume the moment they
 * were chosen.
 */

const PREFIX = "agen:image:";

/** Storage that may not exist: Safari's private mode throws rather than declining. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function rememberImage(jobId: string, url: string | null): void {
  const store = storage();
  if (store === null) return;

  try {
    if (url === null) store.removeItem(PREFIX + jobId);
    else store.setItem(PREFIX + jobId, url);
  } catch {
    // A full or disabled store costs the creator one field on the launch screen, which
    // they can fill in again. It must not cost them the launch.
  }
}

export function rememberedImage(jobId: string): string | null {
  const store = storage();
  if (store === null) return null;

  try {
    const found = store.getItem(PREFIX + jobId);
    // Only ever a path this app served. A value from anywhere else — a tampered store, a
    // stale key from another origin's leftovers — is not something to put in a token's
    // metadata, where it is permanent.
    return found !== null && found.startsWith("/api/images/") ? found : null;
  } catch {
    return null;
  }
}
