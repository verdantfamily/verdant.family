/**
 * The grammar of a `/agents` URL.
 *
 * There is exactly one dynamic segment under `/agents`, and it carries two meanings:
 *
 *     /agents/atlas     the public profile
 *     /agents/@atlas    the owner's environment for the same agent
 *
 * Handles match `[a-z0-9_]{3,20}`, so a leading `@` is unambiguous in both directions —
 * it can never be part of a handle, and it can never collide with a static sibling like
 * `/agents/explore` or `/agents/create`, since the router prefers a literal segment over
 * a dynamic one anyway.
 *
 * The router treats `@` as meaningful only in *folder* names, where it declares a
 * parallel route. In a URL it is an ordinary character and arrives in `params` intact,
 * decoded, whether the browser sends it literally or as `%40`. Both forms were checked
 * against the running app before this was built on.
 *
 * Keeping this in one file means the two consumers — the layout that decides which page
 * to render, and everything that builds links — cannot disagree about what an `@` means.
 */

/**
 * A route parameter can arrive either way round.
 *
 * Route handlers under `/api` are given `@atlas`; page params for the same character are
 * given `%40atlas`. Both are the same URL and neither is wrong, so every read of the
 * segment goes through here rather than each caller remembering which side it is on.
 */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Whether this segment addresses the owner environment rather than the public profile. */
export function isWorkspace(segment: string): boolean {
  return decode(segment).startsWith("@");
}

/** The bare handle, with any leading `@` removed. */
export function toUsername(segment: string): string {
  const handle = decode(segment);
  return handle.startsWith("@") ? handle.slice(1) : handle;
}

/** The owner environment for an agent, optionally a page within it. */
export function workspaceHref(username: string, page = ""): string {
  return page === "" ? `/agents/@${username}` : `/agents/@${username}/${page}`;
}
