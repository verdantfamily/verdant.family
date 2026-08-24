/**
 * How a Program is written out, in one place.
 *
 * The listing and the single-Program route return the same shape, and they do it by calling the same
 * function rather than by two object literals that agree today. A consumer that could tell which
 * route a Program came from would be a consumer with two code paths for one thing.
 *
 * ## Unclaimed is null, never a placeholder
 *
 * A Program nobody has claimed has `name: null`, `slug: null`, `claim: null`. Nothing here invents
 * "Program 0x1d0a…" or "Untitled", and the reason is that a generated name is indistinguishable from
 * a chosen one the moment it is on a screen: a reader cannot tell whether an author picked it, a
 * client cannot tell whether to offer a claim, and the first time somebody claims a Program the name
 * would appear to change when in fact it appeared for the first time. Null says the true thing, and
 * every surface that wants to show something can decide what for itself.
 */

import type { Program } from "@verdant/registry";
import type { ClaimedProgram } from "@verdant/registry-db";

export interface PresentedProgram {
  readonly configHash: string;
  readonly schemaVersion: number;
  readonly dedupeKey: string;
  readonly author: { readonly address: string };
  readonly name: string | null;
  readonly slug: string | null;
  readonly description: string | null;
  readonly claim: {
    readonly claimedBy: string;
    readonly claimedAt: number;
  } | null;
  readonly firstObservedAt: number;
  readonly firstObservedIn: Program["firstObservedIn"];
  readonly marketCount: number;
  readonly markets: Program["markets"];
}

/**
 * A Program and its label as JSON.
 *
 * Every field is already a string or a number in `@verdant/registry`'s types — the large integers
 * live inside `dedupeKey`, which is text — so there is no `bigint` to serialise and no place for a
 * rounding error to enter. `marketCount` is derived rather than stored, because a count that is
 * maintained is a count that drifts and counting rows is what a database is for.
 *
 * `author` and `claim.claimedBy` are two different facts and both are returned. The first is who was
 * observed launching this Program first and is provenance; the second is who proved it with a
 * signature and is the only one that authorises anything. They agree wherever a Program has one
 * market, which is everywhere today — but a consumer that treated them as interchangeable would be
 * wrong exactly when two people launched identical economics.
 */
export function presentProgram(
  program: Program,
  claim: ClaimedProgram | null,
): PresentedProgram {
  return {
    configHash: program.configHash,
    schemaVersion: program.schemaVersion,
    dedupeKey: program.dedupeKey,
    author: { address: program.author.address },
    name: program.name,
    slug: claim?.slug ?? null,
    description: claim?.description ?? null,
    claim:
      claim === null ? null : { claimedBy: claim.claimedBy, claimedAt: claim.claimedAt },
    firstObservedAt: program.firstObservedAt,
    firstObservedIn: program.firstObservedIn,
    marketCount: program.markets.length,
    markets: program.markets,
  };
}
