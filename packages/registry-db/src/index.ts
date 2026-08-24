/**
 * `@verdant/registry-db` — where Programs are kept.
 *
 * The impure half of the pair. `@verdant/registry` holds the types and the identity functions and
 * touches nothing; this package owns the schema, the migration, the HTTP boundary to the indexer,
 * and the queries. The split is asserted rather than intended: `boundaries.test.ts` here checks
 * that M0 has no database import, and M0's own suite checks the same from its side.
 *
 * Two rules shape everything in it.
 *
 * **The registry's database is its own.** Not Ponder's. Ponder owns and migrates its schema and
 * changes it as the chain turns out to work differently than assumed, and its tables are rebuilt
 * from the start block on a reindex. Reading them would break the registry silently; writing to
 * them would put author-authored rows somewhere that gets wiped.
 *
 * **Chain facts arrive over HTTP.** Through `indexer.ts`, against a response shape the indexer
 * publishes deliberately, validated field by field before it is believed. That is what makes a
 * schema change upstream an error naming a field rather than an `undefined` flowing into a hash.
 *
 * `src/testing` is not exported. It imports a devDependency, so shipping it would ship a broken
 * import to any consumer that tried to use it.
 */

export * as schema from "./schema.js";
export {
  launchAttempts,
  programLineage,
  programMarkets,
  programVersions,
  programs,
} from "./schema.js";

export {
  ALL_TABLES,
  ATTEMPT_TABLES,
  MIGRATION_TAGS,
  PROGRAM_TABLES,
  allDownSql,
  allUpSql,
  attemptsDownSql,
  attemptsUpSql,
  downSql,
  upSql,
} from "./migrate.js";

export {
  REGISTRY_DATABASE_URL_VAR,
  registryClient,
  registryConfigured,
  type RegistryClient,
} from "./client.js";

export {
  countPrograms,
  findByDedupeKey,
  listPrograms,
  readProgram,
  readProgramOnChain,
  saveProgram,
  type ListOptions,
  type ProgramWrite,
  type RegistryDatabase,
} from "./programs.js";

export {
  IndexerError,
  httpIndexer,
  type HttpIndexerOptions,
  type IndexerClient,
  type IndexerMarket,
} from "./indexer.js";

export {
  BackfillError,
  backfillPrograms,
  programOf,
  type BackfillOptions,
  type BackfillResult,
} from "./backfill.js";

export {
  ATTEMPT_BLOCK_WINDOW,
  ATTEMPT_RESERVED_TTL_SECONDS,
  ATTEMPT_SENDING_TTL_SECONDS,
  attemptsFor,
  expireAttempts,
  listAttempts,
  markAttemptLaunched,
  markAttemptSending,
  markAttemptSentForJob,
  readAttempt,
  reserveAttempt,
  type ExpiryOptions,
  type ExpiryResult,
  type LaunchAttempt,
  type LaunchAttemptStatus,
  type AttemptLineageClaim,
  type NewLaunchAttempt,
} from "./attempts.js";

export {
  hasLineage,
  parentsOf,
  saveLineage,
  type LineageOutcome,
} from "./lineage.js";

export {
  reconcileLaunches,
  type ReconcileOptions,
  type ReconcileResult,
} from "./reconcile.js";

export {
  CLAIM_MAX_LIFETIME_SECONDS,
  claimProgram,
  configHashForSlug,
  eligibleAuthor,
  readProgramClaim,
  readProgramClaims,
  renameProgram,
  type ClaimContext,
  type ClaimOutcome,
  type ClaimRefusal,
  type ClaimRequest,
  type ClaimedProgram,
  type Eligibility,
} from "./claims.js";

export {
  programClaimNonces,
  programSlugHistory,
} from "./schema.js";
