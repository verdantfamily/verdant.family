/**
 * Launch attempts: reading, writing, and the one clock in the registry.
 *
 * An attempt is the record that a launch was prepared. It exists because lineage is not recoverable
 * from the chain — no event, table or contract says that one configuration came from another — so
 * the claim has to be written down at the only moment anybody knows it, and carried across the gap
 * between the calldata leaving the server and a market appearing in the indexer.
 *
 * ## The state machine is the X path's
 *
 * `reserved → sending → launched`, with `failed` and `indeterminate` as the two ways it ends
 * otherwise. Copied from `apps/agen/src/app/lib/x/types.ts` rather than invented, including the
 * distinction that matters most: `failed` means no transaction was ever sent and `indeterminate`
 * means one was and nobody knows what happened to it. That is not a nicety. `indeterminate` is the
 * status that must never be retried automatically, and a schema that could not express it would
 * turn one abandoned launch into two markets.
 *
 * Transitions only ever move forward. Every mutation below is guarded on the statuses it is allowed
 * to move *from*, so a late callback cannot pull a settled attempt back into flight, and "no attempt
 * is left in `sending`" becomes a property of the writes rather than of the order they arrived in.
 *
 * ## Nothing here reads a clock
 *
 * Every function that needs the time takes it as an argument. Expiry is the one piece of registry
 * behaviour where being wrong about the time changes what is stored, so a test has to be able to
 * state the time exactly rather than mock a global.
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Hex, LineageKind, SchemaVersion } from "@verdant/registry";

import { launchAttempts } from "./schema.js";
import type { RegistryDatabase } from "./programs.js";

/**
 * Where an attempt is in its life. The X path's vocabulary, with the X path's meanings.
 *
 * `reserved` — calldata prepared and handed to a wallet. No transaction is known.
 * `sending` — a transaction hash has been reported. Its receipt has not been seen.
 * `launched` — the market has been found on chain. Terminal.
 * `failed` — the window passed with nothing ever sent. Terminal.
 * `indeterminate` — a transaction was sent and its outcome is unknown. Terminal, never retried.
 */
export type LaunchAttemptStatus = "reserved" | "sending" | "launched" | "failed" | "indeterminate";

/** The two statuses an attempt can still move out of. */
const IN_FLIGHT: readonly LaunchAttemptStatus[] = ["reserved", "sending"];

/**
 * What a creator said their market came from, as an attempt stores it.
 *
 * Captured when the build was started and carried unchanged from there. `parentConfigHash` may name
 * a Program this registry has never seen, and `kind` is authorship rather than shape — a `REVISION`
 * is the same author changing their own economics, a `FORK` is somebody else starting from them.
 * Neither field is ever derived from anything; `no-inference.test.ts` asserts there is no function
 * on this path that could produce one.
 *
 * ## Not `@verdant/market-compiler`'s `LineageClaim`, and named so it cannot be mistaken for it
 *
 * The compiler has a claim type too — the one that lives on a job — and it spells the same 32 bytes
 * `parentProgramId`, because that is what a creator picked from a list rather than a hash they
 * computed. Here it is `parentConfigHash`, matching `program_lineage.parent_config_hash` and the rest
 * of this schema.
 *
 * Both spellings are right in their own package and a single shared name would be wrong in one of
 * them, so the *types* are named apart instead. This repository already has three functions called
 * `prepareLaunch` and two called `implementationHash`, and the cost of that is a real one: a
 * transposition between two same-named things is invisible at the import and fatal at the far end.
 * The conversion happens once, in `apps/agen/src/app/lib/registry/attempt.ts`, where both names are
 * in view on adjacent lines.
 */
export interface AttemptLineageClaim {
  readonly parentConfigHash: Hex;
  readonly kind: LineageKind;
}

/** Everything an attempt is written with. The status and the timestamps are not the caller's. */
export interface NewLaunchAttempt {
  readonly id: string;
  readonly jobId: string;
  readonly chainId: number;
  readonly configHash: Hex;
  readonly implementationHash: Hex;
  readonly encodedConfig: Hex;
  readonly schemaVersion: SchemaVersion;
  readonly creator: Hex;
  readonly feeReceiver: Hex;
  readonly factory: Hex;
  readonly predictedVault: Hex | null;
  readonly calldataHash: Hex;
  /** The chain head when the calldata was prepared. The origin of the matching window. */
  readonly observedBlock: number;
  readonly lineage: AttemptLineageClaim | null;
  /** Unix seconds. Supplied, never read from a clock here. */
  readonly preparedAt: number;
}

/** An attempt as it is stored. */
export interface LaunchAttempt extends NewLaunchAttempt {
  readonly status: LaunchAttemptStatus;
  readonly txHash: Hex | null;
  readonly sentAt: number | null;
  readonly updatedAt: number;
  readonly error: string | null;
}

/**
 * How long calldata sitting in a browser stays matchable.
 *
 * Half an hour. A `reserved` attempt is a wallet dialog open over a review screen, which is a
 * decision measured in seconds to minutes; this is generous for that and short enough that an
 * abandoned tab does not leave a row which a later launch of the same economics by the same wallet
 * could be matched against.
 */
export const ATTEMPT_RESERVED_TTL_SECONDS = 30 * 60;

/**
 * How long a sent transaction is given to confirm before its outcome is called unknown.
 *
 * A day. Unlike the window above, this is not about the creator's attention — the transaction
 * exists, and whether it lands is a fact about the chain. Long enough that one stuck behind a gas
 * spike confirms inside it, and bounded because `indeterminate` is a real answer and "still sending
 * after a week" is not an answer at all.
 */
export const ATTEMPT_SENDING_TTL_SECONDS = 24 * 60 * 60;

/**
 * How far past its origin block an attempt may be matched.
 *
 * Robinhood Chain mines roughly eight blocks a second — the engine's deployment at 44,230,687 and
 * the audit's observation at 44,931,335 bracket about 700,000 blocks in a day — so a day is around
 * 700,000 blocks and this is the next round number above it.
 *
 * It covers the *sending* window rather than the reserved one, because a transaction accepted at
 * preparation may confirm at any point before it expires, and a window shorter than that would lose
 * the lineage of exactly the slow launches the sweep exists to catch. It is bounded all the same:
 * the window is what stops an attempt matching an unrelated market by the same creator with the same
 * economics months later, which is the failure decision 7 forbids.
 */
export const ATTEMPT_BLOCK_WINDOW = 1_000_000;

function claimOf(row: typeof launchAttempts.$inferSelect): AttemptLineageClaim | null {
  // The check constraint guarantees these are both set or both null, so one test decides both. A
  // half-read claim would be worse than none: it would put an edge on the wrong Program.
  if (row.lineageParentConfigHash === null || row.lineageKind === null) return null;

  return {
    parentConfigHash: row.lineageParentConfigHash as Hex,
    kind: row.lineageKind as LineageKind,
  };
}

function hydrate(row: typeof launchAttempts.$inferSelect): LaunchAttempt {
  return {
    id: row.id,
    jobId: row.jobId,
    chainId: row.chainId,
    configHash: row.configHash as Hex,
    implementationHash: row.implementationHash as Hex,
    encodedConfig: row.encodedConfig as Hex,
    schemaVersion: row.schemaVersion as SchemaVersion,
    creator: row.creator as Hex,
    feeReceiver: row.feeReceiver as Hex,
    factory: row.factory as Hex,
    predictedVault: row.predictedVault === null ? null : (row.predictedVault as Hex),
    calldataHash: row.calldataHash as Hex,
    observedBlock: row.observedBlock,
    lineage: claimOf(row),
    preparedAt: row.preparedAt,
    status: row.status as LaunchAttemptStatus,
    txHash: row.txHash === null ? null : (row.txHash as Hex),
    sentAt: row.sentAt,
    updatedAt: row.updatedAt,
    error: row.error,
  };
}

/**
 * Write an attempt, before anything is signed.
 *
 * Idempotent on its own id, so a preparation that is retried — a creator double-clicking, a route
 * called twice behind a flaky connection — writes one row rather than two. `onConflictDoNothing`
 * rather than an upsert: the first write recorded the claim, and a second arriving later has nothing
 * new to say and must not reset the clock the expiry rule measures from.
 *
 * Addresses and hashes are lowercased here rather than at the call sites, so the matching query has
 * one form to compare against. EIP-55 case is a checksum, not data.
 */
export async function reserveAttempt(
  db: RegistryDatabase,
  attempt: NewLaunchAttempt,
): Promise<void> {
  await db
    .insert(launchAttempts)
    .values({
      id: attempt.id,
      jobId: attempt.jobId,
      chainId: attempt.chainId,
      configHash: attempt.configHash.toLowerCase(),
      implementationHash: attempt.implementationHash.toLowerCase(),
      encodedConfig: attempt.encodedConfig.toLowerCase(),
      schemaVersion: attempt.schemaVersion,
      creator: attempt.creator.toLowerCase(),
      feeReceiver: attempt.feeReceiver.toLowerCase(),
      factory: attempt.factory.toLowerCase(),
      predictedVault: attempt.predictedVault === null ? null : attempt.predictedVault.toLowerCase(),
      calldataHash: attempt.calldataHash.toLowerCase(),
      observedBlock: attempt.observedBlock,
      lineageParentConfigHash:
        attempt.lineage === null ? null : attempt.lineage.parentConfigHash.toLowerCase(),
      lineageKind: attempt.lineage === null ? null : attempt.lineage.kind,
      status: "reserved",
      txHash: null,
      preparedAt: attempt.preparedAt,
      sentAt: null,
      updatedAt: attempt.preparedAt,
      error: null,
    })
    .onConflictDoNothing({ target: launchAttempts.id });
}

/**
 * Record that a transaction exists, before its receipt is known.
 *
 * The hash-on-callback step, and the reason `indeterminate` is reachable rather than theoretical.
 * Guarded on `reserved`, so a hash arriving after the attempt has already been settled — by the
 * sweep, or by expiry — is ignored rather than reopening it.
 *
 * Returns whether it moved anything, so a caller can tell "recorded" from "too late" without
 * reading the row back.
 */
export async function markAttemptSending(
  db: RegistryDatabase,
  request: { readonly id: string; readonly txHash: Hex; readonly now: number },
): Promise<boolean> {
  const moved = await db
    .update(launchAttempts)
    .set({
      status: "sending",
      txHash: request.txHash.toLowerCase(),
      sentAt: request.now,
      updatedAt: request.now,
    })
    .where(and(eq(launchAttempts.id, request.id), eq(launchAttempts.status, "reserved")))
    .returning({ id: launchAttempts.id });

  return moved.length > 0;
}

/**
 * Record a hash against a build, when the caller knows the build and not the attempt.
 *
 * The browser reports "this build's launch is transaction 0x…" — it has a job id, because that is
 * what its URL is, and no idea that attempts exist. So the attempt has to be found, and a build may
 * have more than one: a creator who prepared a launch, walked away, and prepared it again has two.
 *
 * The most recent `reserved` attempt is the one chosen, and that is the correct reading rather than a
 * convenience. Preparing a launch again supersedes the calldata prepared before it — the earlier
 * calldata is still valid on chain, but the wallet now holding a dialog is holding the newer one, so a
 * hash arriving now is far more likely to be its. The superseded attempt is left alone and expires on
 * its own, which is what `failed` is for.
 *
 * Returns the attempt it moved, or null if there was nothing in `reserved` to move — a build whose
 * attempt was never written because the registry was down, or one already settled by the sweep.
 */
export async function markAttemptSentForJob(
  db: RegistryDatabase,
  request: { readonly jobId: string; readonly txHash: Hex; readonly now: number },
): Promise<LaunchAttempt | null> {
  const rows = await db
    .select()
    .from(launchAttempts)
    .where(and(eq(launchAttempts.jobId, request.jobId), eq(launchAttempts.status, "reserved")))
    .orderBy(desc(launchAttempts.preparedAt), desc(launchAttempts.id))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  const moved = await markAttemptSending(db, {
    id: row.id,
    txHash: request.txHash,
    now: request.now,
  });

  return moved ? await readAttempt(db, row.id) : null;
}

/**
 * Settle an attempt against a market that exists.
 *
 * Guarded on the two in-flight statuses, which is what makes reconciliation idempotent: a second run
 * finds the attempt already `launched`, moves nothing, and therefore does not touch `updated_at`. A
 * byte-identical snapshot across two runs depends on this guard rather than on the caller
 * remembering to check first.
 */
export async function markAttemptLaunched(
  db: RegistryDatabase,
  request: { readonly id: string; readonly txHash: Hex; readonly now: number },
): Promise<boolean> {
  const moved = await db
    .update(launchAttempts)
    .set({ status: "launched", txHash: request.txHash.toLowerCase(), updatedAt: request.now })
    .where(and(eq(launchAttempts.id, request.id), inArray(launchAttempts.status, [...IN_FLIGHT])))
    .returning({ id: launchAttempts.id });

  return moved.length > 0;
}

export interface ExpiryOptions {
  readonly now: number;
  readonly reservedTtlSeconds?: number;
  readonly sendingTtlSeconds?: number;
}

/** What an expiry pass moved, by the status it moved things to. */
export interface ExpiryResult {
  readonly failed: number;
  readonly indeterminate: number;
}

/**
 * End the attempts whose windows have passed, each in the way that is true of it.
 *
 * Two statements rather than one, because the two cases are different facts and take their windows
 * from different columns. A `reserved` attempt is measured from `prepared_at` and becomes `failed`:
 * nothing was ever sent, so there is no outcome to be unsure about. A `sending` attempt is measured
 * from `sent_at` and becomes `indeterminate`: a transaction exists and this process will never learn
 * how it went.
 *
 * Expiry is a clock and not a cancellation. Nothing on chain honours it, so a wallet that signs an
 * hour after its attempt expired still produces a market — and the sweep still finds it, still
 * matches it on economics, creator and block window, and still writes its claim. What expiry
 * guarantees is only that no attempt sits in a non-terminal status for ever, which is what makes
 * "never stuck in `sending`" checkable.
 */
export async function expireAttempts(
  db: RegistryDatabase,
  options: ExpiryOptions,
): Promise<ExpiryResult> {
  const reservedTtl = options.reservedTtlSeconds ?? ATTEMPT_RESERVED_TTL_SECONDS;
  const sendingTtl = options.sendingTtlSeconds ?? ATTEMPT_SENDING_TTL_SECONDS;

  const failed = await db
    .update(launchAttempts)
    .set({
      status: "failed",
      updatedAt: options.now,
      error: "no transaction was reported before this attempt's window closed",
    })
    .where(
      and(
        eq(launchAttempts.status, "reserved"),
        lt(launchAttempts.preparedAt, options.now - reservedTtl),
      ),
    )
    .returning({ id: launchAttempts.id });

  const indeterminate = await db
    .update(launchAttempts)
    .set({
      status: "indeterminate",
      updatedAt: options.now,
      error: "a transaction was sent and no market was ever found for it",
    })
    .where(
      and(
        eq(launchAttempts.status, "sending"),
        /*
         * From `sent_at`, falling back to `prepared_at` only if it is somehow absent. The fallback
         * cannot be reached through `markAttemptSending`, which always sets both — it is here so
         * that a row written by some future path with a null `sent_at` still expires rather than
         * becoming the one attempt that lives for ever.
         */
        or(
          and(
            isNotNull(launchAttempts.sentAt),
            lt(launchAttempts.sentAt, options.now - sendingTtl),
          ),
          and(
            isNull(launchAttempts.sentAt),
            lt(launchAttempts.preparedAt, options.now - sendingTtl),
          ),
        ),
      ),
    )
    .returning({ id: launchAttempts.id });

  return { failed: failed.length, indeterminate: indeterminate.length };
}

/** One attempt by its id, or null. */
export async function readAttempt(
  db: RegistryDatabase,
  id: string,
): Promise<LaunchAttempt | null> {
  const rows = await db.select().from(launchAttempts).where(eq(launchAttempts.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : hydrate(row);
}

/** Every attempt, oldest first. At this population there is no reason to page. */
export async function listAttempts(
  db: RegistryDatabase,
  options: { readonly status?: readonly LaunchAttemptStatus[] } = {},
): Promise<readonly LaunchAttempt[]> {
  const rows =
    options.status === undefined
      ? await db
          .select()
          .from(launchAttempts)
          .orderBy(asc(launchAttempts.preparedAt), asc(launchAttempts.id))
      : await db
          .select()
          .from(launchAttempts)
          .where(inArray(launchAttempts.status, [...options.status]))
          .orderBy(asc(launchAttempts.preparedAt), asc(launchAttempts.id));

  return rows.map(hydrate);
}

/**
 * The attempts that could still be the launch of a given set of economics by a given wallet.
 *
 * Both conditions in the query, and the block window applied by the caller against the market it is
 * holding. Never `configHash` alone: `deployMarket` is permissionless and a configuration is public,
 * so two people launching byte-identical economics is expected rather than exceptional, and matching
 * on economics alone would hand one creator's claim to another's market.
 */
export async function attemptsFor(
  db: RegistryDatabase,
  key: { readonly chainId: number; readonly configHash: Hex; readonly creator: Hex },
): Promise<readonly LaunchAttempt[]> {
  const rows = await db
    .select()
    .from(launchAttempts)
    .where(
      and(
        eq(launchAttempts.chainId, key.chainId),
        eq(launchAttempts.configHash, key.configHash.toLowerCase()),
        eq(launchAttempts.creator, key.creator.toLowerCase()),
        inArray(launchAttempts.status, [...IN_FLIGHT]),
      ),
    )
    .orderBy(asc(launchAttempts.preparedAt), asc(launchAttempts.id));

  return rows.map(hydrate);
}
