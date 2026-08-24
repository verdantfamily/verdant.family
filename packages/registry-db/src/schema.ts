/**
 * The Program registry's tables.
 *
 * Four tables mirroring the four types in `@verdant/registry`, in its own database — not
 * Ponder's. The separation is the point: Ponder's tables are chain observations, owned and
 * migrated by Ponder, rebuilt from the start block on a reindex and re-keyed whenever the chain
 * turns out to work differently than assumed. Author-authored rows cannot live there, and rows
 * that *read* from there would break silently the next time a column moved.
 *
 * ## Everything is text, and that is deliberate
 *
 * Hashes, addresses and canonical bytes are stored as `text` rather than `bytea`. Three reasons,
 * in order of weight. The values are `0x`-prefixed hex everywhere else in the system — in the
 * indexer's JSON, in `@verdant/registry`'s types, in viem — so `bytea` would mean encoding on
 * the way in and decoding on the way out, at two places that can disagree. A `text` column
 * compares and indexes identically for a fixed-width hex string. And a row is readable in
 * `psql` without a decode step, which matters the one time somebody is looking at this during an
 * incident.
 *
 * Amounts are the opposite case and are not stored at all: the only large integer here is inside
 * `dedupe_key`, already a decimal string, because a supply of 10^27 fits no integer column and
 * no JSON number.
 *
 * ## No constraint knows which engine exists
 *
 * `schema_version` and `engine_version` are plain integers with no `check`. A market's engine
 * version is data — see Decision D1 — and a constraint pinning it to 1 would be correct today
 * and would need migrating away the day engine v2 ships. `migrate.test.ts` asserts no such
 * constraint exists, so this cannot be tightened by accident.
 */

import { relations } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * One Program: one set of economics, identified by the hash of its canonical form.
 *
 * The primary key is the `configHash` itself rather than a surrogate id, which is the schema
 * saying what `@verdant/registry` says in prose: a Program *is* its hash. Two creators who
 * independently launch identical economics collide on this key, and the collision is the correct
 * outcome — the first observed hash owns the identity and the second launch becomes a row in
 * `program_markets` under the Program that already exists.
 */
export const programs = pgTable(
  "programs",
  {
    /** `keccak256` of the canonical encoding. 66 characters including `0x`. */
    configHash: text("config_hash").primaryKey(),

    /** Which canonical-config schema the hash was taken over. Data, never a constant. */
    schemaVersion: integer("schema_version").notNull(),

    /**
     * The order-independent normal form, from `dedupeKeyFor`.
     *
     * Stored beside the hash because the two answer different questions: `config_hash` is exact
     * and the chain agrees with it, and this also matches a configuration that was written down
     * differently — a different key order, a rate as a string, rules in another sequence — which
     * is what a submission needs checking against before it becomes a launch.
     */
    dedupeKey: text("dedupe_key").notNull(),

    /** The deployer, lowercased. The only authorship fact that exists on chain. */
    authorAddress: text("author_address").notNull(),

    /**
     * A label, and null until some surface sets one.
     *
     * Nullable and unpopulated on purpose. Names are outside the commitment — two markets
     * differing only in what their token is called are the same Program — so a name can never be
     * load-bearing, and there is nowhere to get one from yet.
     */
    name: text("name"),
    description: text("description"),

    /** Unix seconds, from the launch that first carried these economics. */
    firstObservedAt: bigint("first_observed_at", { mode: "number" }).notNull(),

    // The market whose launch created this identity. Held as its natural key rather than as a
    // foreign key into `program_markets`, because that table's rows point back here — a circular
    // reference would make either table impossible to insert into first.
    firstObservedChainId: integer("first_observed_chain_id").notNull(),
    firstObservedPoolId: text("first_observed_pool_id").notNull(),
  },
  (table) => [
    // "Have we seen these economics under any spelling", which is the submission-time question.
    index("programs_dedupe_key_idx").on(table.dedupeKey),
    index("programs_author_idx").on(table.authorAddress),
    index("programs_first_observed_at_idx").on(table.firstObservedAt),
  ],
);

/**
 * One point in a Program's history.
 *
 * A version is itself a Program — it has its own economics and therefore its own hash — so this
 * table records membership of a lineage rather than a mutable record a Program points at. There
 * is deliberately no "current version" column anywhere: a market runs the configuration it
 * launched with, immutably, and nothing recorded here can change what a deployed market does.
 *
 * `encoded_config` is what makes a version readable. Anything holding those bytes can recover
 * every rate, threshold, recipient and ceiling through `decodeConfig`, with no model and no
 * second implementation of what the rules mean.
 */
export const programVersions = pgTable(
  "program_versions",
  {
    /** This version's own identity, and a `programs.config_hash` in its own right. */
    configHash: text("config_hash")
      .primaryKey()
      .references(() => programs.configHash, { onDelete: "cascade" }),

    /** The lineage root: the first Program in this chain of revisions. */
    rootConfigHash: text("root_config_hash")
      .notNull()
      .references(() => programs.configHash, { onDelete: "cascade" }),

    schemaVersion: integer("schema_version").notNull(),

    /** The canonical bytes the identity was taken over. */
    encodedConfig: text("encoded_config").notNull(),

    /**
     * Distance from the root, counting from 0.
     *
     * Ordering for a display, and not an identity: two siblings forked from one parent share an
     * ordinal, which is correct — they are the same distance from the root — and is why
     * `program_lineage` is what actually describes the shape.
     */
    ordinal: integer("ordinal").notNull(),

    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [index("program_versions_root_idx").on(table.rootConfigHash, table.ordinal)],
);

/**
 * One live market that runs a Program.
 *
 * A reference, not a copy. Price, volume, holders and fees taken all belong to the indexer and
 * are not restated here — this table carries only what is needed to find the market and to prove
 * it runs these economics.
 *
 * Both hashes are kept because they answer different questions and a row that kept one could not
 * check the other. `config_hash` says which economics; `implementation_hash` binds those
 * economics to a chain, an engine address and an engine version, so it is what establishes that
 * this market's rules are the Program's rules *as executed here*.
 *
 * Keyed by chain and pool, because a `configHash` is chain-independent by construction: the same
 * Program can run on two chains, and a pool id alone would collide across them.
 */
export const programMarkets = pgTable(
  "program_markets",
  {
    chainId: integer("chain_id").notNull(),
    /** The v4 pool id: `keccak256(abi.encode(poolKey))`. */
    poolId: text("pool_id").notNull(),

    configHash: text("config_hash")
      .notNull()
      .references(() => programs.configHash, { onDelete: "cascade" }),

    token: text("token").notNull(),
    /** `AgenMarketRegistry`'s index, which is also creation order. */
    marketIndex: integer("market_index").notNull(),
    engineVersion: integer("engine_version").notNull(),
    /** The commitment: economics bound to chain, engine and version. */
    implementationHash: text("implementation_hash").notNull(),

    launchTx: text("launch_tx").notNull(),
    launchBlock: bigint("launch_block", { mode: "number" }).notNull(),
    launchedAt: bigint("launched_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.poolId] }),
    // "Every market running these economics" — the question the whole registry exists to answer,
    // and the one the indexer cannot: it has no index on `configHash` at all.
    index("program_markets_config_hash_idx").on(table.configHash),
    index("program_markets_token_idx").on(table.token),
  ],
);

/**
 * How one Program came from another. **Ships empty.**
 *
 * Structurally complete and deliberately unpopulated, because lineage is not observable from the
 * chain: no event, table or contract records that one configuration was derived from another.
 * Only the surface that accepted an edit knows it happened, and it can only be recorded at that
 * moment — which means the two markets that already exist have no recoverable lineage, ever.
 *
 * Edges rather than a parent column on `programs`, because the same hash can be arrived at from
 * more than one direction: two people editing different parents can land on identical economics,
 * at which point one Program genuinely has two parents and a single pointer would discard one.
 *
 * `kind` distinguishes a `REVISION` — the same author changing their own economics — from a
 * `FORK`, someone else taking them as a starting point. The distinction is authorship, not
 * shape: the configurations differ either way, so it is recorded rather than derived.
 */
export const programLineage = pgTable(
  "program_lineage",
  {
    parentConfigHash: text("parent_config_hash")
      .notNull()
      .references(() => programs.configHash, { onDelete: "cascade" }),
    childConfigHash: text("child_config_hash")
      .notNull()
      .references(() => programs.configHash, { onDelete: "cascade" }),

    kind: text("kind").notNull(),

    /** Who made the edit. A `FORK` is by definition not the parent's author. */
    authorAddress: text("author_address").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.parentConfigHash, table.childConfigHash] }),
    index("program_lineage_child_idx").on(table.childConfigHash),
    // The vocabulary is closed, and unlike engine version it is not going to grow with a
    // deployment — a third kind would be a product decision, which is what a migration is for.
    check("program_lineage_kind_check", sql`${table.kind} in ('REVISION', 'FORK')`),
    // An edge from a Program to itself is not a revision, it is a bug upstream.
    check(
      "program_lineage_no_self_edge_check",
      sql`${table.parentConfigHash} <> ${table.childConfigHash}`,
    ),
  ],
);

/**
 * One launch, recorded before it was signed.
 *
 * ## Why a launch has to be written down before it happens
 *
 * Everything else in this schema can be rebuilt from the chain. Lineage cannot: no event, table or
 * contract records that one configuration was derived from another, and the only moment anybody
 * knows is when the creator said so. By the time a market is indexed, the claim is gone. So this
 * table exists to carry that one fact across the gap between "a creator asked for this launch" and
 * "a market exists", and reconciliation is what closes the gap.
 *
 * The gap is real and both ends of it can fail. A creator can be handed calldata and never sign.
 * They can sign and the receipt can never reach the app. Neither is exceptional, which is why an
 * attempt has a lifecycle rather than a boolean.
 *
 * ## The vocabulary is the X path's, deliberately
 *
 * `reserved`, `sending`, `launched`, `failed`, `indeterminate` — the same five
 * `apps/agen/src/app/lib/x/types.ts` uses for sponsored Instant launches, with the same meanings.
 * That path has been running against this chain for months and the distinction it draws is the one
 * that matters: `failed` means no transaction was ever sent, `indeterminate` means one was and its
 * outcome is unknown. A single "gave up" status would merge them, and the merge is how one launch
 * gets retried into two markets.
 *
 * Here, `reserved` is written by `prepareEngineLaunch` as the calldata leaves the server, and
 * `sending` when the browser reports a transaction hash. Nothing in this repository signs on a
 * creator's behalf on this path, so the server never observes a send directly — which is exactly
 * why the hash is reported back rather than assumed, and why `indeterminate` is reachable.
 *
 * ## No foreign key to `programs`, and that is the point
 *
 * An attempt is written *before* the Program exists — it is the thing that will create it. A
 * reference into `programs` would make every first launch of a new configuration fail, which is
 * every launch that matters. The claimed parent is likewise a plain column: a creator may claim a
 * parent this registry has never seen, and that has to degrade to a missing edge rather than to a
 * refused launch.
 *
 * So nothing here is validated by the database against another table, and reconciliation is where
 * a claim meets the constraints on `program_lineage`. That ordering is not a weakness of the schema;
 * it is decision 5 — the registry must never be able to fail a launch — expressed as an absence of
 * constraints on the one table the launch path writes to.
 */
export const launchAttempts = pgTable(
  "launch_attempts",
  {
    /** The server's own id for this attempt. Not the job's: one job may be prepared twice. */
    id: text("id").primaryKey(),

    /**
     * Which build this launch is of.
     *
     * Not unique. A creator who prepares a launch, walks away, and comes back to prepare it again
     * has two attempts for one build, and only one of them is going to land. Reconciliation decides
     * which by looking at the chain, so the ambiguity is resolved by evidence rather than forbidden
     * by a constraint that would refuse the second preparation.
     */
    jobId: text("job_id").notNull(),

    chainId: integer("chain_id").notNull(),

    /** The economics, as the identity the launch will produce. Lowercased. */
    configHash: text("config_hash").notNull(),
    /** The commitment the creator signed: economics bound to this chain and this engine. */
    implementationHash: text("implementation_hash").notNull(),
    /**
     * The canonical bytes, so an attempt is readable without the indexer.
     *
     * There is deliberately no `dedupe_key` beside it, unlike `programs`. That value is derived from
     * these bytes by `@verdant/registry`, and reconciliation derives it from the market's own copy of
     * them — so a column here would be a second answer to what these economics normalise to, written
     * on the one path where being wrong is permanent and read by nothing. The bytes are the artefact;
     * the key is a function of them and is computed once, where it is used.
     */
    encodedConfig: text("encoded_config").notNull(),
    schemaVersion: integer("schema_version").notNull(),

    /** `msg.sender` at launch, and therefore the market's creator. Lowercased. */
    creator: text("creator").notNull(),
    /** Who collects the liquidity position's fees. Not the programmable recipients. */
    feeReceiver: text("fee_receiver").notNull(),
    /** The engine factory the calldata was addressed to. From the environment; see decision 8. */
    factory: text("factory").notNull(),
    /** Where the fee vault was predicted to land. Null where the caller could not say. */
    predictedVault: text("predicted_vault"),

    /**
     * `keccak256` of the calldata that was handed over, and never the calldata itself.
     *
     * The bytes are recoverable from `encoded_config` and the launch parameters, so storing them
     * would be storing a derived value twice. The hash is here because it is the one artefact that
     * ties this row to the exact transaction a wallet was asked to sign, which is what makes an
     * attempt auditable after the fact.
     */
    calldataHash: text("calldata_hash").notNull(),

    /**
     * The chain head when the calldata was prepared. The origin of the matching window.
     *
     * Not null, and an attempt that could not obtain one is not written at all. Decision 7 requires
     * matching on economics *and* creator *and* a bounded block range; without this column the
     * range does not exist, and matching on the first two alone is how a creator's second launch of
     * the same mechanic inherits the first one's claim.
     */
    observedBlock: bigint("observed_block", { mode: "number" }).notNull(),

    /**
     * The claim, or nothing.
     *
     * Two nullable columns rather than a `jsonb` document, because these are the two things a claim
     * is and a check constraint can then require them to be present or absent together. A claim
     * with a parent and no kind is not a partial claim, it is a bug upstream.
     *
     * Never derived. The parent is whatever the creator's build carried from the moment it was
     * started, and `no-inference.test.ts` asserts there is no function anywhere on this path that
     * could produce one any other way.
     */
    lineageParentConfigHash: text("lineage_parent_config_hash"),
    lineageKind: text("lineage_kind"),

    status: text("status").notNull(),

    /** Set when the browser reports the hash, before any receipt is read. */
    txHash: text("tx_hash"),

    /** Unix seconds, when the calldata left the server. The reserved window measures from here. */
    preparedAt: bigint("prepared_at", { mode: "number" }).notNull(),
    /**
     * When the transaction hash arrived. The sending window measures from here, not from
     * preparation: a creator who leaves the review screen open for an hour and then signs has an
     * old preparation and a seconds-old transaction, and measuring from the former would call it
     * indeterminate the moment it was sent.
     */
    sentAt: bigint("sent_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),

    /** Why it ended where it did, for a terminal status that had a reason. */
    error: text("error"),
  },
  (table) => [
    // The matching query, in the order it filters: these economics, by this creator.
    index("launch_attempts_config_creator_idx").on(table.configHash, table.creator),
    // The expiry sweep, which reads only the two non-terminal statuses.
    index("launch_attempts_status_idx").on(table.status),
    index("launch_attempts_job_idx").on(table.jobId),
    check(
      "launch_attempts_status_check",
      sql`${table.status} in ('reserved', 'sending', 'launched', 'failed', 'indeterminate')`,
    ),
    check(
      "launch_attempts_lineage_kind_check",
      sql`${table.lineageKind} is null or ${table.lineageKind} in ('REVISION', 'FORK')`,
    ),
    // A parent without a kind, or a kind without a parent, is half a claim. Neither is storable.
    check(
      "launch_attempts_lineage_complete_check",
      sql`(${table.lineageParentConfigHash} is null) = (${table.lineageKind} is null)`,
    ),
  ],
);

export const programRelations = relations(programs, ({ many }) => ({
  markets: many(programMarkets),
  versions: many(programVersions),
}));

export const programMarketRelations = relations(programMarkets, ({ one }) => ({
  program: one(programs, {
    fields: [programMarkets.configHash],
    references: [programs.configHash],
  }),
}));
