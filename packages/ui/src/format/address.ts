/**
 * Addresses and hashes, shortened.
 *
 * The only interesting decision here is how much to keep. Four leading and four
 * trailing characters is the convention, and it is enough for a reader comparing an
 * address against one they already have — which is the only thing a shortened address
 * is good for. It is not enough to distinguish two addresses a determined party
 * *chose* to look alike, so nothing security-relevant should ever be decided from a
 * shortened form. Where that matters, show the whole thing.
 */

/** `0x1234…cdef`. An ellipsis character, not three periods. */
export function shortenAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/**
 * A transaction hash or pool id, shortened more aggressively.
 *
 * Ten leading characters and no tail. A hash is scanned rather than compared — the
 * reader is finding a row again, not verifying an identity — and the leading digits
 * are what they remember.
 */
export function shortenHash(hash: string, lead = 10): string {
  if (hash.length <= lead) return hash;
  return `${hash.slice(0, lead)}…`;
}
