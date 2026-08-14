import "server-only";

/**
 * Which pool a market's page id refers to, resolved once.
 *
 * The chart and the trade list both poll every second, and both need the same translation:
 * a page is addressed by build id or token address, and the feed keys everything on a pool
 * id. Resolving that through `marketSource().read` costs a registry read, several token
 * reads and — for an Instant market — a fetch of the creator's metadata document. Paying
 * all of it once a second, per open tab, to learn a value that cannot change is the kind of
 * cost that quietly decides how fast a chart can move.
 *
 * ## Why caching forever is safe here
 *
 * A market's pool id is assigned in the transaction that creates the market and there is no
 * function anywhere that changes it. The token address is likewise fixed. So this is not a
 * cache with a staleness policy; it is a lookup table for a mapping that is immutable by
 * construction, and the only reason it is built lazily is that nothing knows the entries
 * until somebody asks.
 *
 * A market that does not exist is *not* remembered, because that is the one answer which
 * can change: a token launched a second ago was unknown a second before that.
 */

import { marketSource } from "./markets";

interface Resolved {
  readonly poolId: string;
  readonly kind: "programmable" | "instant";
}

const known = new Map<string, Resolved>();

/**
 * The pool behind a page id, or null.
 *
 * Null covers a market that has not launched (no pool at all), an id nothing knows, and a
 * chain that would not answer. A caller renders the same empty series for each.
 */
export async function poolFor(id: string): Promise<Resolved | null> {
  const key = id.toLowerCase();

  const remembered = known.get(key);
  if (remembered !== undefined) return remembered;

  const market = await marketSource().read(id);
  if (market === null) return null;

  const poolId = market.poolId ?? null;
  if (poolId === null) return null;

  const resolved: Resolved = { poolId, kind: market.kind };
  known.set(key, resolved);
  return resolved;
}
