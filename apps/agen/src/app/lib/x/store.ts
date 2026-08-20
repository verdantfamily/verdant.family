import "server-only";

/**
 * Durable state for the X bot.
 *
 * Its own SQLite database beside the agent one, on the same Railway volume, for the reason
 * `agents/store.ts` gives about why file writes were not enough: two deliveries of the same
 * mention must not both pass an "already handled" check, and a JSON rewrite is not a
 * transaction. `BEGIN IMMEDIATE` takes the write lock before the read, so the loser of a
 * race sees the winner's row.
 *
 * ## Why a second database rather than three more tables in the first
 *
 * The agent store is the agent product's accounting and it is 2,000 lines of it. This is a
 * different feature with a different lifecycle, and keeping it separate means the X bot
 * cannot break an agent's spend ledger by holding a write lock or by a migration that fails
 * halfway. They share nothing, so nothing is lost by separating them.
 *
 * ## The one table that matters most
 *
 * `x_mentions` has `command_post_id` as its primary key and every path to a launch goes
 * through {@link XStore.reserveMention} first. That is the whole duplicate-launch defence:
 * not a check followed by an insert, which two processes can both pass, but an insert whose
 * failure *is* the check. Everything else here is accounting.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getAddress, isAddress, type Address, type Hex } from "viem";

import { GENERATED_ROOT } from "../builds";
import { XError } from "./errors";
import type { XClaimStatus, XIntent, XLaunchRecord, XLaunchStatus } from "./types";

const MIGRATIONS: readonly { readonly version: number; readonly sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      -- Every mention the bot has ever claimed, whatever came of it. The primary key is
      -- the post id, so a second delivery of the same post cannot insert a second row and
      -- therefore cannot reach the launcher.
      CREATE TABLE IF NOT EXISTS x_mentions (
        command_post_id TEXT PRIMARY KEY,
        x_user_id TEXT NOT NULL,
        x_username TEXT NOT NULL,
        source_post_id TEXT,
        intent TEXT,
        outcome TEXT NOT NULL,
        code TEXT,
        reply_post_id TEXT,
        claimed_at INTEGER NOT NULL,
        settled_at INTEGER,
        error TEXT
      );

      -- Raw delivery envelopes, so a webhook redelivery is dropped before it is even parsed
      -- into a mention. Separate from x_mentions because one envelope can carry several
      -- posts and because a replay may arrive for a post that was never a mention at all.
      CREATE TABLE IF NOT EXISTS x_events (
        event_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS x_launches (
        id TEXT PRIMARY KEY,
        command_post_id TEXT NOT NULL UNIQUE,
        x_user_id TEXT NOT NULL,
        x_username TEXT NOT NULL,
        source_post_id TEXT,
        token TEXT,
        pool_id TEXT,
        tx_hash TEXT,
        seat TEXT,
        vault TEXT,
        name TEXT,
        ticker TEXT,
        status TEXT NOT NULL,
        claim_status TEXT NOT NULL DEFAULT 'unclaimed',
        claim_wallet TEXT,
        claimed_at INTEGER,
        gas_spent_wei TEXT NOT NULL DEFAULT '0',
        reply_post_id TEXT,
        created_at INTEGER NOT NULL,
        error TEXT
      );

      -- What is known about an X account, keyed on the id that cannot change. The seat is
      -- here rather than only on the launch because it is per-account: every launch by one
      -- account names the same seat, so one handover claims all of them at once.
      CREATE TABLE IF NOT EXISTS x_identities (
        x_user_id TEXT PRIMARY KEY,
        x_username TEXT NOT NULL,
        seat TEXT,
        seat_deployed INTEGER NOT NULL DEFAULT 0,
        claim_wallet TEXT,
        claimed_at INTEGER,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      -- Platform-wide spend per UTC day. Reserved columns are held between the decision to
      -- launch and the receipt, so two concurrent launches cannot both fit under the same
      -- remaining budget.
      CREATE TABLE IF NOT EXISTS x_days (
        day TEXT PRIMARY KEY,
        launches INTEGER NOT NULL DEFAULT 0,
        reserved_launches INTEGER NOT NULL DEFAULT 0,
        gas_wei TEXT NOT NULL DEFAULT '0',
        reserved_gas_wei TEXT NOT NULL DEFAULT '0'
      );

      CREATE TABLE IF NOT EXISTS x_user_days (
        x_user_id TEXT NOT NULL,
        day TEXT NOT NULL,
        launches INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (x_user_id, day)
      );

      -- Runtime switches. The kill switch lives here as well as in the environment so it
      -- can be thrown in a second; either one stops launches.
      CREATE TABLE IF NOT EXISTS x_controls (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT
      );

      CREATE TABLE IF NOT EXISTS x_blocklist (
        x_user_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL DEFAULT '',
        added_at INTEGER NOT NULL
      );

      -- One row, holding the newest mention already seen, so a poll asks X for what came
      -- after it instead of re-reading the timeline.
      CREATE TABLE IF NOT EXISTS x_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        since_id TEXT,
        polled_at INTEGER
      );

      -- In-flight "sign in with X" attempts. The verifier never leaves the server, which is
      -- what makes the PKCE exchange worth doing at all.
      CREATE TABLE IF NOT EXISTS x_oauth_states (
        state TEXT PRIMARY KEY,
        verifier TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_x_launches_user ON x_launches(x_user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_x_launches_token ON x_launches(token);
      CREATE INDEX IF NOT EXISTS idx_x_launches_status ON x_launches(status);
      CREATE INDEX IF NOT EXISTS idx_x_mentions_user ON x_mentions(x_user_id, claimed_at);
      CREATE INDEX IF NOT EXISTS idx_x_events_seen ON x_events(seen_at);
    `,
  },
];

/** UTC, like the agent store's, so a day boundary is the same one everywhere. */
export function utcDay(at = Math.floor(Date.now() / 1000)): string {
  return new Date(at * 1000).toISOString().slice(0, 10);
}

const KILL_SWITCH_KEY = "launches_paused";

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function optionalAddress(value: unknown): Address | null {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  return isAddress(raw, { strict: false }) ? getAddress(raw) : null;
}

function optionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function optionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function launchFromRow(row: Record<string, unknown>): XLaunchRecord {
  return {
    id: String(row.id),
    xUserId: String(row.x_user_id),
    xUsername: String(row.x_username),
    sourcePostId: optionalString(row.source_post_id),
    commandPostId: String(row.command_post_id),
    token: optionalAddress(row.token),
    poolId: optionalString(row.pool_id) as Hex | null,
    txHash: optionalString(row.tx_hash) as Hex | null,
    seat: optionalAddress(row.seat),
    vault: optionalAddress(row.vault),
    name: optionalString(row.name),
    ticker: optionalString(row.ticker),
    status: String(row.status) as XLaunchStatus,
    claimStatus: String(row.claim_status) as XClaimStatus,
    claimWallet: optionalAddress(row.claim_wallet),
    claimedAt: optionalNumber(row.claimed_at),
    gasSpentWei: BigInt(String(row.gas_spent_wei)),
    replyPostId: optionalString(row.reply_post_id),
    createdAt: Number(row.created_at),
    error: optionalString(row.error),
  };
}

/** What a day's budget looks like once reservations are counted against it. */
export interface XDayUsage {
  readonly day: string;
  readonly launches: number;
  readonly gasWei: bigint;
}

export interface XIdentityRow {
  readonly xUserId: string;
  readonly xUsername: string;
  readonly seat: Address | null;
  readonly seatDeployed: boolean;
  readonly claimWallet: Address | null;
  readonly claimedAt: number | null;
}

export class XStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const applied = new Set(
      this.db
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((row) => Number((row as { version: number }).version)),
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
        this.db.exec("COMMIT;");
      } catch (error) {
        this.db.exec("ROLLBACK;");
        throw error;
      }
    }
  }

  // --- delivery idempotency --------------------------------------------------

  /**
   * Record a delivery envelope, and say whether it is new.
   *
   * False means this exact envelope has been seen and the caller should stop. The first
   * line of defence against a webhook redelivery, and cheap enough to run before parsing.
   */
  markEvent(eventKey: string, kind: string): boolean {
    const changes = this.db
      .prepare("INSERT OR IGNORE INTO x_events (event_key, kind, seen_at) VALUES (?, ?, ?)")
      .run(eventKey, kind, now()).changes;
    return Number(changes) === 1;
  }

  /**
   * Claim a mention, or refuse because somebody already has.
   *
   * The insert *is* the lock. Two processes handed the same post both attempt it, exactly
   * one inserts, and the other is told `ALREADY_HANDLED` — which is why a launch cannot
   * happen twice for one post even if the delivery method reports it a hundred times.
   *
   * Returns false rather than throwing, because a duplicate delivery is ordinary traffic
   * and not an error worth an exception at every call site.
   */
  reserveMention(input: {
    readonly commandPostId: string;
    readonly xUserId: string;
    readonly xUsername: string;
    readonly sourcePostId: string | null;
  }): boolean {
    const changes = this.db
      .prepare(
        `INSERT OR IGNORE INTO x_mentions
           (command_post_id, x_user_id, x_username, source_post_id, outcome, claimed_at)
         VALUES (?, ?, ?, ?, 'claimed', ?)`,
      )
      .run(
        input.commandPostId,
        input.xUserId,
        input.xUsername,
        input.sourcePostId,
        now(),
      ).changes;

    return Number(changes) === 1;
  }

  /** How a mention ended, for the record and for the operator reading it later. */
  settleMention(input: {
    readonly commandPostId: string;
    readonly intent: XIntent | null;
    readonly outcome: "launched" | "answered" | "ignored" | "refused" | "failed";
    readonly code: string | null;
    readonly replyPostId: string | null;
    readonly error: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE x_mentions
            SET intent = ?, outcome = ?, code = ?, reply_post_id = ?, settled_at = ?, error = ?
          WHERE command_post_id = ?`,
      )
      .run(
        input.intent,
        input.outcome,
        input.code,
        input.replyPostId,
        now(),
        input.error,
        input.commandPostId,
      );
  }

  /**
   * Release a claim so the post can be tried again.
   *
   * Only ever called for a failure that happened *before* a transaction was sent. A mention
   * whose launch is `indeterminate` is never released, because releasing it is precisely how
   * one post would become two tokens.
   */
  releaseMention(commandPostId: string): void {
    this.db.prepare("DELETE FROM x_mentions WHERE command_post_id = ?").run(commandPostId);
  }

  mentionExists(commandPostId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM x_mentions WHERE command_post_id = ?")
      .get(commandPostId);
    return row !== undefined;
  }

  /** Mentions this account has had claimed in the last `seconds`. The per-user rate limit. */
  recentMentionCount(xUserId: string, seconds: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM x_mentions WHERE x_user_id = ? AND claimed_at >= ?")
      .get(xUserId, now() - seconds) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  // --- switches and the blocklist -------------------------------------------

  launchesPaused(): boolean {
    const row = this.db
      .prepare("SELECT value FROM x_controls WHERE key = ?")
      .get(KILL_SWITCH_KEY) as { value: string } | undefined;
    return row?.value === "1";
  }

  setLaunchesPaused(paused: boolean, by: string | null): void {
    this.db
      .prepare(
        `INSERT INTO x_controls (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                        updated_at = excluded.updated_at,
                                        updated_by = excluded.updated_by`,
      )
      .run(KILL_SWITCH_KEY, paused ? "1" : "0", now(), by);
  }

  isBlocked(xUserId: string): boolean {
    return (
      this.db.prepare("SELECT 1 AS found FROM x_blocklist WHERE x_user_id = ?").get(xUserId) !==
      undefined
    );
  }

  block(xUserId: string, reason: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO x_blocklist (x_user_id, reason, added_at) VALUES (?, ?, ?)")
      .run(xUserId, reason, now());
  }

  unblock(xUserId: string): void {
    this.db.prepare("DELETE FROM x_blocklist WHERE x_user_id = ?").run(xUserId);
  }

  // --- the polling cursor ---------------------------------------------------

  sinceId(): string | null {
    const row = this.db.prepare("SELECT since_id FROM x_cursor WHERE id = 1").get() as
      | { since_id: string | null }
      | undefined;
    return row?.since_id ?? null;
  }

  /**
   * Move the cursor forward, and never back.
   *
   * A poll that returned older posts than the cursor — which happens when deliveries
   * interleave — must not rewind it, or the same window is read forever.
   */
  advanceCursor(sinceId: string): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.sinceId();
      const forward = current === null || bigger(sinceId, current);
      this.db
        .prepare(
          `INSERT INTO x_cursor (id, since_id, polled_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET since_id = excluded.since_id, polled_at = excluded.polled_at`,
        )
        .run(forward ? sinceId : current, now());
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  // --- budget ---------------------------------------------------------------

  usage(day = utcDay()): XDayUsage {
    const row = this.db.prepare("SELECT * FROM x_days WHERE day = ?").get(day) as
      | Record<string, unknown>
      | undefined;

    if (row === undefined) return { day, launches: 0, gasWei: 0n };

    return {
      day,
      launches: Number(row.launches) + Number(row.reserved_launches),
      gasWei: BigInt(String(row.gas_wei)) + BigInt(String(row.reserved_gas_wei)),
    };
  }

  userLaunchesToday(xUserId: string, day = utcDay()): number {
    const row = this.db
      .prepare("SELECT launches FROM x_user_days WHERE x_user_id = ? AND day = ?")
      .get(xUserId, day) as { launches: number } | undefined;
    return Number(row?.launches ?? 0);
  }

  /**
   * Take room for one launch out of every budget at once, or refuse.
   *
   * One transaction over all four checks, because they are one decision. Checking them
   * separately and then writing is the race this exists to close: two mentions arriving
   * together would both read a budget with room for one.
   *
   * `estimateWei` is reserved rather than charged. {@link recordGasSpent} converts it into
   * the real figure once the receipt is in, and {@link releaseReservation} gives it back if
   * no transaction was sent.
   */
  reserveLaunch(input: {
    readonly xUserId: string;
    readonly estimateWei: bigint;
    readonly maxPerUserPerDay: number;
    readonly maxPerDay: number;
    readonly maxGasPerDayWei: bigint;
    readonly cooldownSeconds: number;
  }): void {
    const day = utcDay();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const used = this.usage(day);
      if (used.launches >= input.maxPerDay) {
        throw new XError("PLATFORM_DAILY_LIMIT", "Agen has sponsored its limit of launches today.");
      }
      if (used.gasWei + input.estimateWei > input.maxGasPerDayWei) {
        throw new XError("GAS_BUDGET_EXHAUSTED", "Today's sponsored gas budget is spent.");
      }

      const mine = this.userLaunchesToday(input.xUserId, day);
      if (mine >= input.maxPerUserPerDay) {
        throw new XError("USER_DAILY_LIMIT", "That account has reached its launches for today.");
      }

      if (input.cooldownSeconds > 0) {
        const last = this.db
          .prepare(
            `SELECT created_at FROM x_launches
              WHERE x_user_id = ? AND status IN ('sending', 'launched', 'indeterminate')
              ORDER BY created_at DESC LIMIT 1`,
          )
          .get(input.xUserId) as { created_at: number } | undefined;

        if (last !== undefined && now() - Number(last.created_at) < input.cooldownSeconds) {
          throw new XError("COOLDOWN", "That account launched a moment ago.");
        }
      }

      // Wei is summed here rather than in SQL. A day's gas total can pass SQLite's signed
      // 64-bit ceiling, and `CAST(... AS INTEGER)` on a decimal string silently saturates
      // rather than failing — a budget that stops growing is a budget that stops limiting.
      const reserved = this.reservedGas(day) + input.estimateWei;
      this.db
        .prepare(
          `INSERT INTO x_days (day, reserved_launches, reserved_gas_wei) VALUES (?, 1, ?)
           ON CONFLICT(day) DO UPDATE
             SET reserved_launches = reserved_launches + 1,
                 reserved_gas_wei = excluded.reserved_gas_wei`,
        )
        .run(day, reserved.toString());

      this.db
        .prepare(
          `INSERT INTO x_user_days (x_user_id, day, launches) VALUES (?, ?, 1)
           ON CONFLICT(x_user_id, day) DO UPDATE SET launches = launches + 1`,
        )
        .run(input.xUserId, day);

      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  /** What is reserved but not yet spent on `day`, in wei. */
  private reservedGas(day: string): bigint {
    const row = this.db.prepare("SELECT reserved_gas_wei FROM x_days WHERE day = ?").get(day) as
      | { reserved_gas_wei: string }
      | undefined;
    return row === undefined ? 0n : BigInt(String(row.reserved_gas_wei));
  }

  private spentGas(day: string): bigint {
    const row = this.db.prepare("SELECT gas_wei FROM x_days WHERE day = ?").get(day) as
      | { gas_wei: string }
      | undefined;
    return row === undefined ? 0n : BigInt(String(row.gas_wei));
  }

  /** Give a reservation back, for a launch that never sent a transaction. */
  releaseReservation(xUserId: string, estimateWei: bigint, day = utcDay()): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const remaining = this.reservedGas(day) - estimateWei;
      this.db
        .prepare(
          `UPDATE x_days
              SET reserved_launches = MAX(reserved_launches - 1, 0),
                  reserved_gas_wei = ?
            WHERE day = ?`,
        )
        .run((remaining > 0n ? remaining : 0n).toString(), day);
      this.db
        .prepare(
          `UPDATE x_user_days SET launches = MAX(launches - 1, 0) WHERE x_user_id = ? AND day = ?`,
        )
        .run(xUserId, day);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  /** Turn a reservation into what the launch actually cost. */
  recordGasSpent(estimateWei: bigint, actualWei: bigint, day = utcDay()): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const spent = this.spentGas(day) + actualWei;
      const held = this.reservedGas(day) - estimateWei;
      this.db
        .prepare(
          `INSERT INTO x_days (day, launches, gas_wei, reserved_gas_wei) VALUES (?, 1, ?, '0')
           ON CONFLICT(day) DO UPDATE
             SET launches = launches + 1,
                 gas_wei = excluded.gas_wei,
                 reserved_launches = MAX(reserved_launches - 1, 0),
                 reserved_gas_wei = ?`,
        )
        .run(day, spent.toString(), (held > 0n ? held : 0n).toString());
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  // --- identities and seats -------------------------------------------------

  /**
   * Note that this account exists and what it is currently called.
   *
   * The username is overwritten on every sighting on purpose: it is display metadata, so
   * the freshest one is the right one, and nothing is keyed on it.
   */
  touchIdentity(xUserId: string, xUsername: string): void {
    const at = now();
    this.db
      .prepare(
        `INSERT INTO x_identities (x_user_id, x_username, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(x_user_id) DO UPDATE
           SET x_username = excluded.x_username, last_seen_at = excluded.last_seen_at`,
      )
      .run(xUserId, xUsername, at, at);
  }

  identity(xUserId: string): XIdentityRow | null {
    const row = this.db.prepare("SELECT * FROM x_identities WHERE x_user_id = ?").get(xUserId) as
      | Record<string, unknown>
      | undefined;

    if (row === undefined) return null;

    return {
      xUserId: String(row.x_user_id),
      xUsername: String(row.x_username),
      seat: optionalAddress(row.seat),
      seatDeployed: Number(row.seat_deployed) === 1,
      claimWallet: optionalAddress(row.claim_wallet),
      claimedAt: optionalNumber(row.claimed_at),
    };
  }

  /**
   * Record where this account's seat is.
   *
   * Written before the launch that names it, so that a crash between deploying a seat and
   * launching leaves the seat findable rather than orphaned. The address is derived, so
   * re-deriving it would give the same answer — this is a cache of a fact, not the fact.
   */
  setSeat(xUserId: string, seat: Address, deployed: boolean): void {
    this.db
      .prepare("UPDATE x_identities SET seat = ?, seat_deployed = ? WHERE x_user_id = ?")
      .run(seat, deployed ? 1 : 0, xUserId);
  }

  /** The wallet a verified creator asked their fees to go to. */
  setClaimWallet(xUserId: string, wallet: Address): void {
    this.db
      .prepare("UPDATE x_identities SET claim_wallet = ?, claimed_at = ? WHERE x_user_id = ?")
      .run(wallet, now(), xUserId);
  }

  // --- launches -------------------------------------------------------------

  insertLaunch(record: XLaunchRecord): void {
    this.db
      .prepare(
        `INSERT INTO x_launches
           (id, command_post_id, x_user_id, x_username, source_post_id, token, pool_id, tx_hash,
            seat, vault, name, ticker, status, claim_status, claim_wallet, claimed_at,
            gas_spent_wei, reply_post_id, created_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.commandPostId,
        record.xUserId,
        record.xUsername,
        record.sourcePostId,
        record.token,
        record.poolId,
        record.txHash,
        record.seat,
        record.vault,
        record.name,
        record.ticker,
        record.status,
        record.claimStatus,
        record.claimWallet,
        record.claimedAt,
        record.gasSpentWei.toString(),
        record.replyPostId,
        record.createdAt,
        record.error,
      );
  }

  updateLaunch(
    id: string,
    patch: {
      readonly status?: XLaunchStatus;
      readonly token?: Address | null;
      readonly poolId?: Hex | null;
      readonly txHash?: Hex | null;
      readonly vault?: Address | null;
      readonly seat?: Address | null;
      readonly name?: string | null;
      readonly ticker?: string | null;
      readonly gasSpentWei?: bigint;
      readonly replyPostId?: string | null;
      readonly error?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    const put = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.status !== undefined) put("status", patch.status);
    if (patch.token !== undefined) put("token", patch.token);
    if (patch.poolId !== undefined) put("pool_id", patch.poolId);
    if (patch.txHash !== undefined) put("tx_hash", patch.txHash);
    if (patch.vault !== undefined) put("vault", patch.vault);
    if (patch.seat !== undefined) put("seat", patch.seat);
    if (patch.name !== undefined) put("name", patch.name);
    if (patch.ticker !== undefined) put("ticker", patch.ticker);
    if (patch.gasSpentWei !== undefined) put("gas_spent_wei", patch.gasSpentWei.toString());
    if (patch.replyPostId !== undefined) put("reply_post_id", patch.replyPostId);
    if (patch.error !== undefined) put("error", patch.error);

    if (sets.length === 0) return;

    values.push(id);
    this.db.prepare(`UPDATE x_launches SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  /**
   * Mark every one of this account's launches as offered to, or taken by, a wallet.
   *
   * Per account rather than per launch, because a seat is per account: one `take` moves
   * every market that named it, so recording it per row would invite a UI that shows some
   * of them claimed and the rest not.
   */
  setClaimStatusForUser(
    xUserId: string,
    status: XClaimStatus,
    wallet: Address | null,
  ): void {
    this.db
      .prepare(
        `UPDATE x_launches SET claim_status = ?, claim_wallet = ?, claimed_at = ?
          WHERE x_user_id = ? AND status = 'launched'`,
      )
      .run(status, wallet, status === "claimed" ? now() : null, xUserId);
  }

  launchById(id: string): XLaunchRecord | null {
    const row = this.db.prepare("SELECT * FROM x_launches WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : launchFromRow(row);
  }

  launchByCommandPost(commandPostId: string): XLaunchRecord | null {
    const row = this.db
      .prepare("SELECT * FROM x_launches WHERE command_post_id = ?")
      .get(commandPostId) as Record<string, unknown> | undefined;
    return row === undefined ? null : launchFromRow(row);
  }

  /** Every launch by one X account, newest first. What `/useagen` lists. */
  launchesByUser(xUserId: string): readonly XLaunchRecord[] {
    return this.db
      .prepare("SELECT * FROM x_launches WHERE x_user_id = ? ORDER BY created_at DESC")
      .all(xUserId)
      .map((row) => launchFromRow(row as Record<string, unknown>));
  }

  /**
   * Launches whose outcome was never established.
   *
   * The queue for a reconciler, and the reason `indeterminate` exists as a status rather
   * than being folded into `failed`: these have to be resolved by reading the chain, and a
   * failure that is indistinguishable from them would be resolved by sending again.
   */
  indeterminateLaunches(): readonly XLaunchRecord[] {
    return this.db
      .prepare("SELECT * FROM x_launches WHERE status IN ('sending', 'indeterminate')")
      .all()
      .map((row) => launchFromRow(row as Record<string, unknown>));
  }

  // --- oauth ----------------------------------------------------------------

  putOauthState(state: string, verifier: string, expiresAt: number): void {
    this.db
      .prepare("INSERT INTO x_oauth_states (state, verifier, expires_at) VALUES (?, ?, ?)")
      .run(state, verifier, expiresAt);
  }

  /**
   * Read a verifier and delete it in one transaction.
   *
   * Single use, which is the property that matters: a state replayed after a successful
   * sign-in finds nothing, so an intercepted callback URL is worth one attempt at most.
   */
  takeOauthState(state: string): { readonly verifier: string; readonly expiresAt: number } | null {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.db
        .prepare("SELECT verifier, expires_at FROM x_oauth_states WHERE state = ?")
        .get(state) as { verifier: string; expires_at: number } | undefined;

      this.db.prepare("DELETE FROM x_oauth_states WHERE state = ?").run(state);
      this.db.prepare("DELETE FROM x_oauth_states WHERE expires_at < ?").run(now());
      this.db.exec("COMMIT;");

      return row === undefined
        ? null
        : { verifier: row.verifier, expiresAt: Number(row.expires_at) };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
}

/** Numeric comparison of two X snowflake ids, which are too large for `Number`. */
function bigger(left: string, right: string): boolean {
  try {
    return BigInt(left) > BigInt(right);
  } catch {
    return false;
  }
}

const STORE_KEY = Symbol.for("agen.x.store");

interface Slot {
  [STORE_KEY]?: XStore | null;
}

function slot(): Slot {
  return globalThis as unknown as Slot;
}

function defaultStorePath(): string {
  const override = process.env["AGEN_X_DB"]?.trim();
  if (override !== undefined && override !== "") return override;
  return resolve(GENERATED_ROOT, "_x", "x.db");
}

export function xStore(): XStore {
  const shared = slot();
  shared[STORE_KEY] ??= new XStore(defaultStorePath());
  return shared[STORE_KEY];
}

export function resetXStoreForTests(store: XStore | null): void {
  slot()[STORE_KEY] = store;
}
