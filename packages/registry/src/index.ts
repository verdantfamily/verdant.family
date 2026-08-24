/**
 * `@verdant/registry` — what a Program is, and how to tell two of them apart.
 *
 * Types and pure functions. No I/O of any kind: no database, no chain, no filesystem, no
 * clock, no environment. That is asserted rather than intended — `boundaries.test.ts` reads
 * this package's own source and fails on an import that would break it.
 *
 * The reason for the constraint is that a Program registry has to be usable from more than
 * one place. The indexer meets a Program when a market is deployed, a launch surface meets
 * one before any market exists, and a test meets one as a fixture. A package that reached
 * for a database would be usable by none of them without one.
 *
 * ## Where identity comes from
 *
 * Not from here. `@verdant/market-engine` owns canonicalization and hashing, and this
 * package calls it — see `identity.ts` for why that is a rule rather than a convenience.
 * This package's own contribution is the *looser* comparison in `normalize.ts`, which exists
 * because a submission that has not been through the engine cannot be hashed by it yet.
 */

export type {
  ChainId,
  Hex,
  LineageEdge,
  LineageKind,
  MarketRef,
  Program,
  ProgramAuthor,
  ProgramVersion,
  SchemaVersion,
  UnixSeconds,
} from "./types.js";

export type { ProgramIdentity } from "./identity.js";
export { deriveProgramIdentity } from "./identity.js";

export type {
  NormalizedConfig,
  NormalizedRecipient,
  NormalizedShare,
  NormalizedStage,
  NormalizedTier,
} from "./normalize.js";
export { dedupeKeyFor, normalizeForDedupe } from "./normalize.js";

export type { ProgramClaimAction, ProgramClaimTerms } from "./claim-message.js";
export { programClaimMessage } from "./claim-message.js";

export type { NamingProblem, NamingRefusal } from "./naming.js";
export {
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  RESERVED_SLUGS,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  slugify,
  validateProgramDescription,
  validateProgramName,
  validateProgramSlug,
} from "./naming.js";
