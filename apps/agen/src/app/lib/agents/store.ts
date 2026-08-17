/**
 * Durable agent state.
 *
 * Instant and Programmable already persist as JSON files on the Railway volume.
 * Agent accounting cannot: two simultaneous launch requests must not both pass a
 * remaining-budget check, and a file rewrite is not a transaction. SQLite on the
 * same volume (`generated/_agents/agents.db`) gives `BEGIN IMMEDIATE` without a
 * new hosted database, and migrations are applied on open so a deploy cannot
 * boot against a half-upgraded schema.
 *
 * `node:sqlite` is built into Node 22+, which this host already requires.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getAddress, isAddress, type Address } from "viem";

import { GENERATED_ROOT } from "../builds";
import { AgentError } from "./errors";
import { hashesEqual, hashSecret } from "./keys";
import type {
  AgentActivity,
  AgentActivityType,
  AgentApiKeyRecord,
  AgentAutonomy,
  AgentBuildLink,
  AgentDecision,
  AgentFeedback,
  AgentLaunchRecord,
  AgentMandate,
  AgentMemory,
  AgentPermissions,
  AgentPolicy,
  AgentRecord,
  AgentRevenueRow,
  AgentRun,
  AgentStatus,
  AgentWalletRecord,
  DailyAllowance,
  DecisionKind,
  DecisionStatus,
  ExecutionMode,
  FeedbackVerdict,
  LaunchKind,
  MemoryKind,
  MemorySource,
  ModelUsageDay,
  Reservation,
  RevenuePolicy,
  RunOutcome,
  RunStatus,
  RunTrigger,
  SpendDay,
} from "./types";
import { AUTONOMY_LEASE_SECONDS, DEFAULT_AUTONOMY, DEFAULT_PERMISSIONS, DEFAULT_POLICY } from "./types";

const MIGRATIONS: readonly { readonly version: number; readonly sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        image_url TEXT,
        owner_address TEXT NOT NULL,
        wallet_address TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_wallets (
        agent_id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        nonce TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_permissions (
        agent_id TEXT PRIMARY KEY,
        instant_allowed INTEGER NOT NULL,
        programmable_allowed INTEGER NOT NULL,
        max_eth_per_launch_wei TEXT NOT NULL,
        max_launches_per_day INTEGER NOT NULL,
        max_eth_per_day_wei TEXT NOT NULL,
        max_creator_buy_wei TEXT NOT NULL,
        can_claim_creator_fees INTEGER NOT NULL,
        external_transfers INTEGER NOT NULL,
        approved_contracts_only INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_api_keys (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        prefix TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_used_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS agent_spend_days (
        agent_id TEXT NOT NULL,
        day TEXT NOT NULL,
        launches INTEGER NOT NULL DEFAULT 0,
        spent_wei TEXT NOT NULL DEFAULT '0',
        reserved_launches INTEGER NOT NULL DEFAULT 0,
        reserved_wei TEXT NOT NULL DEFAULT '0',
        PRIMARY KEY (agent_id, day)
      );

      CREATE TABLE IF NOT EXISTS agent_reservations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        day TEXT NOT NULL,
        kind TEXT NOT NULL,
        launches INTEGER NOT NULL,
        wei TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_launches (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_wallet TEXT NOT NULL,
        kind TEXT NOT NULL,
        token TEXT,
        pool TEXT,
        tx_hash TEXT,
        job_id TEXT,
        name TEXT,
        symbol TEXT,
        spend_wei TEXT NOT NULL,
        fee_recipient TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_builds (
        job_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_activity (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_api_usage (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        key_id TEXT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status INTEGER NOT NULL,
        code TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_revenue (
        agent_id TEXT NOT NULL,
        token TEXT NOT NULL,
        lifetime_wei TEXT NOT NULL DEFAULT '0',
        claimed_wei TEXT NOT NULL DEFAULT '0',
        PRIMARY KEY (agent_id, token)
      );

      CREATE TABLE IF NOT EXISTS owner_challenges (
        nonce TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_address);
      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
      CREATE INDEX IF NOT EXISTS idx_launches_agent ON agent_launches(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_launches_token ON agent_launches(token);
      CREATE INDEX IF NOT EXISTS idx_activity_agent ON agent_activity(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_created ON agent_api_usage(created_at);
      CREATE INDEX IF NOT EXISTS idx_keys_agent ON agent_api_keys(agent_id);
    `,
  },
  {
    // Phase 2. Autonomy state only. Nothing here alters a Phase 1 table, so an
    // agent that never turns autonomy on behaves exactly as it did before.
    //
    // No row is backfilled. Absence reads as `DEFAULT_AUTONOMY`, which is off —
    // so every agent that already exists is off by construction rather than by
    // an UPDATE that could have missed one.
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_mandates (
        agent_id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_autonomy (
        agent_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'observe',
        interval_seconds INTEGER NOT NULL,
        next_run_at INTEGER,
        last_run_at INTEGER,
        last_decision_id TEXT,
        lease_holder TEXT,
        lease_expires_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_policies (
        agent_id TEXT PRIMARY KEY,
        treasury_reserve_wei TEXT NOT NULL,
        revenue_policy TEXT NOT NULL,
        reinvest_bps INTEGER NOT NULL,
        boost_allowed INTEGER NOT NULL,
        max_runs_per_day INTEGER NOT NULL,
        max_model_calls_per_day INTEGER NOT NULL,
        launch_cooldown_seconds INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        trigger TEXT NOT NULL,
        outcome TEXT,
        decision_id TEXT,
        model_calls INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        UNIQUE (agent_id, scheduled_for)
      );

      CREATE TABLE IF NOT EXISTS agent_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        rationale TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        mandate_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT,
        executed_at INTEGER,
        result TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_memory (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        run_id TEXT,
        weight REAL NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS agent_feedback (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        decision_id TEXT,
        verdict TEXT NOT NULL,
        note TEXT NOT NULL,
        owner_address TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_model_usage (
        agent_id TEXT NOT NULL,
        day TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, day)
      );

      CREATE TABLE IF NOT EXISTS platform_controls (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_runs_agent ON agent_runs(agent_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON agent_runs(status);
      CREATE INDEX IF NOT EXISTS idx_decisions_agent ON agent_decisions(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_decisions_status ON agent_decisions(agent_id, status);
      CREATE INDEX IF NOT EXISTS idx_decisions_run ON agent_decisions(run_id);
      CREATE INDEX IF NOT EXISTS idx_memory_agent ON agent_memory(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_feedback_agent ON agent_feedback(agent_id, created_at);
    `,
  },
];

const STALE_RESERVATION_SECONDS = 10 * 60;

export function utcDay(at = Math.floor(Date.now() / 1000)): string {
  return new Date(at * 1000).toISOString().slice(0, 10);
}

function asAddress(value: string): Address {
  if (!isAddress(value, { strict: false })) {
    throw new AgentError("VALIDATION_FAILED", "That is not an address.");
  }
  return getAddress(value);
}

function permissionsFromRow(row: Record<string, unknown>): AgentPermissions {
  return {
    instantAllowed: Number(row.instant_allowed) === 1,
    programmableAllowed: Number(row.programmable_allowed) === 1,
    maxEthPerLaunchWei: BigInt(String(row.max_eth_per_launch_wei)),
    maxLaunchesPerDay: Number(row.max_launches_per_day),
    maxEthPerDayWei: BigInt(String(row.max_eth_per_day_wei)),
    maxCreatorBuyWei: BigInt(String(row.max_creator_buy_wei)),
    canClaimCreatorFees: Number(row.can_claim_creator_fees) === 1,
    externalTransfers: Number(row.external_transfers) === 1,
    approvedContractsOnly: Number(row.approved_contracts_only) === 1,
  };
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mandateFromRow(row: Record<string, unknown>): AgentMandate {
  return {
    agentId: String(row.agent_id),
    text: String(row.text),
    version: Number(row.version),
    updatedAt: Number(row.updated_at),
    updatedBy: asAddress(String(row.updated_by)),
  };
}

function autonomyFromRow(row: Record<string, unknown>): AgentAutonomy {
  return {
    agentId: String(row.agent_id),
    enabled: Number(row.enabled) === 1,
    mode: String(row.mode) as ExecutionMode,
    intervalSeconds: Number(row.interval_seconds),
    nextRunAt: nullableNumber(row.next_run_at),
    lastRunAt: nullableNumber(row.last_run_at),
    lastDecisionId: nullableString(row.last_decision_id),
    leaseHolder: nullableString(row.lease_holder),
    leaseExpiresAt: nullableNumber(row.lease_expires_at),
    updatedAt: Number(row.updated_at),
  };
}

function policyFromRow(row: Record<string, unknown>): AgentPolicy {
  return {
    agentId: String(row.agent_id),
    treasuryReserveWei: BigInt(String(row.treasury_reserve_wei)),
    revenuePolicy: String(row.revenue_policy) as RevenuePolicy,
    reinvestBps: Number(row.reinvest_bps),
    boostAllowed: Number(row.boost_allowed) === 1,
    maxRunsPerDay: Number(row.max_runs_per_day),
    maxModelCallsPerDay: Number(row.max_model_calls_per_day),
    launchCooldownSeconds: Number(row.launch_cooldown_seconds),
    updatedAt: Number(row.updated_at),
  };
}

function runFromRow(row: Record<string, unknown>): AgentRun {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    scheduledFor: Number(row.scheduled_for),
    startedAt: Number(row.started_at),
    finishedAt: nullableNumber(row.finished_at),
    status: String(row.status) as RunStatus,
    mode: String(row.mode) as ExecutionMode,
    trigger: String(row.trigger) as RunTrigger,
    outcome: nullableString(row.outcome) as RunOutcome | null,
    decisionId: nullableString(row.decision_id),
    modelCalls: Number(row.model_calls),
    error: nullableString(row.error),
  };
}

function decisionFromRow(row: Record<string, unknown>): AgentDecision {
  const decidedBy = nullableString(row.decided_by);
  const result = nullableString(row.result);
  return {
    id: String(row.id),
    runId: String(row.run_id),
    agentId: String(row.agent_id),
    kind: String(row.kind) as DecisionKind,
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    rationale: String(row.rationale),
    confidence: Number(row.confidence),
    status: String(row.status) as DecisionStatus,
    mandateVersion: Number(row.mandate_version),
    createdAt: Number(row.created_at),
    decidedAt: nullableNumber(row.decided_at),
    decidedBy: decidedBy === null ? null : asAddress(decidedBy),
    executedAt: nullableNumber(row.executed_at),
    result: result === null ? null : (JSON.parse(result) as Record<string, unknown>),
    error: nullableString(row.error),
  };
}

function agentFromRow(row: Record<string, unknown>): AgentRecord {
  return {
    id: String(row.id),
    username: String(row.username),
    name: String(row.name),
    description: String(row.description),
    imageUrl: row.image_url === null || row.image_url === undefined ? null : String(row.image_url),
    ownerAddress: asAddress(String(row.owner_address)),
    walletAddress: asAddress(String(row.wallet_address)),
    status: String(row.status) as AgentStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function launchFromRow(row: Record<string, unknown>): AgentLaunchRecord {
  const token = row.token === null || row.token === undefined ? null : String(row.token);
  const pool = row.pool === null || row.pool === undefined ? null : String(row.pool);
  const tx = row.tx_hash === null || row.tx_hash === undefined ? null : String(row.tx_hash);
  const fee = row.fee_recipient === null || row.fee_recipient === undefined ? null : String(row.fee_recipient);

  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    agentWallet: asAddress(String(row.agent_wallet)),
    kind: String(row.kind) as LaunchKind,
    token: token === null ? null : asAddress(token),
    pool: pool === null ? null : (pool as `0x${string}`),
    txHash: tx === null ? null : (tx as `0x${string}`),
    jobId: row.job_id === null || row.job_id === undefined ? null : String(row.job_id),
    name: row.name === null || row.name === undefined ? null : String(row.name),
    symbol: row.symbol === null || row.symbol === undefined ? null : String(row.symbol),
    spendWei: BigInt(String(row.spend_wei)),
    feeRecipient: fee === null ? null : asAddress(fee),
    status: String(row.status) as AgentLaunchRecord["status"],
    createdAt: Number(row.created_at),
    error: row.error === null || row.error === undefined ? null : String(row.error),
  };
}

export class AgentStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
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

  insertAgent(input: {
    readonly agent: AgentRecord;
    readonly wallet: AgentWalletRecord;
    readonly permissions: AgentPermissions;
  }): AgentRecord {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(
          `INSERT INTO agents
            (id, username, name, description, image_url, owner_address, wallet_address, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.agent.id,
          input.agent.username,
          input.agent.name,
          input.agent.description,
          input.agent.imageUrl,
          input.agent.ownerAddress,
          input.agent.walletAddress,
          input.agent.status,
          input.agent.createdAt,
          input.agent.updatedAt,
        );

      this.db
        .prepare(
          `INSERT INTO agent_wallets (agent_id, address, ciphertext, nonce, salt, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.wallet.agentId,
          input.wallet.address,
          input.wallet.ciphertext,
          input.wallet.nonce,
          input.wallet.salt,
          input.wallet.createdAt,
        );

      this.writePermissions(input.agent.id, input.permissions);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE") && message.includes("username")) {
        throw new AgentError("USERNAME_UNAVAILABLE", "That username is already taken.", {
          permission: "username",
        });
      }
      throw error;
    }

    return input.agent;
  }

  private writePermissions(agentId: string, permissions: AgentPermissions): void {
    this.db
      .prepare(
        `INSERT INTO agent_permissions (
           agent_id, instant_allowed, programmable_allowed, max_eth_per_launch_wei,
           max_launches_per_day, max_eth_per_day_wei, max_creator_buy_wei,
           can_claim_creator_fees, external_transfers, approved_contracts_only
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           instant_allowed = excluded.instant_allowed,
           programmable_allowed = excluded.programmable_allowed,
           max_eth_per_launch_wei = excluded.max_eth_per_launch_wei,
           max_launches_per_day = excluded.max_launches_per_day,
           max_eth_per_day_wei = excluded.max_eth_per_day_wei,
           max_creator_buy_wei = excluded.max_creator_buy_wei,
           can_claim_creator_fees = excluded.can_claim_creator_fees,
           external_transfers = excluded.external_transfers,
           approved_contracts_only = excluded.approved_contracts_only`,
      )
      .run(
        agentId,
        permissions.instantAllowed ? 1 : 0,
        permissions.programmableAllowed ? 1 : 0,
        permissions.maxEthPerLaunchWei.toString(),
        permissions.maxLaunchesPerDay,
        permissions.maxEthPerDayWei.toString(),
        permissions.maxCreatorBuyWei.toString(),
        permissions.canClaimCreatorFees ? 1 : 0,
        permissions.externalTransfers ? 1 : 0,
        permissions.approvedContractsOnly ? 1 : 0,
      );
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : agentFromRow(row);
  }

  getAgentByUsername(username: string): AgentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE username = ? COLLATE NOCASE")
      .get(username) as Record<string, unknown> | undefined;
    return row === undefined ? null : agentFromRow(row);
  }

  listPublicAgents(): readonly AgentRecord[] {
    return this.db
      .prepare("SELECT * FROM agents WHERE status != 'archived' ORDER BY created_at DESC")
      .all()
      .map((row) => agentFromRow(row as Record<string, unknown>));
  }

  listOwnerAgents(owner: Address): readonly AgentRecord[] {
    return this.db
      .prepare("SELECT * FROM agents WHERE owner_address = ? COLLATE NOCASE ORDER BY created_at DESC")
      .all(getAddress(owner))
      .map((row) => agentFromRow(row as Record<string, unknown>));
  }

  updateAgent(
    id: string,
    patch: Partial<Pick<AgentRecord, "name" | "description" | "imageUrl" | "status">>,
  ): AgentRecord {
    const current = this.getAgent(id);
    if (current === null) throw new AgentError("AGENT_NOT_FOUND", "No such agent.");

    const next: AgentRecord = {
      ...current,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      imageUrl: patch.imageUrl === undefined ? current.imageUrl : patch.imageUrl,
      status: patch.status ?? current.status,
      updatedAt: Math.floor(Date.now() / 1000),
    };

    this.db
      .prepare(
        `UPDATE agents SET name = ?, description = ?, image_url = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(next.name, next.description, next.imageUrl, next.status, next.updatedAt, id);

    return next;
  }

  getPermissions(agentId: string): AgentPermissions {
    const row = this.db.prepare("SELECT * FROM agent_permissions WHERE agent_id = ?").get(agentId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? DEFAULT_PERMISSIONS : permissionsFromRow(row);
  }

  setPermissions(agentId: string, permissions: AgentPermissions): AgentPermissions {
    if (this.getAgent(agentId) === null) throw new AgentError("AGENT_NOT_FOUND", "No such agent.");
    this.writePermissions(agentId, permissions);
    return permissions;
  }

  getWallet(agentId: string): AgentWalletRecord | null {
    const row = this.db.prepare("SELECT * FROM agent_wallets WHERE agent_id = ?").get(agentId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    return {
      agentId: String(row.agent_id),
      address: asAddress(String(row.address)),
      ciphertext: String(row.ciphertext),
      nonce: String(row.nonce),
      salt: String(row.salt),
      createdAt: Number(row.created_at),
    };
  }

  insertApiKey(record: AgentApiKeyRecord): void {
    this.db
      .prepare(
        `INSERT INTO agent_api_keys (id, agent_id, prefix, hash, created_at, revoked_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.agentId,
        record.prefix,
        record.hash,
        record.createdAt,
        record.revokedAt,
        record.lastUsedAt,
      );
  }

  listApiKeys(agentId: string): readonly AgentApiKeyRecord[] {
    return this.db
      .prepare("SELECT * FROM agent_api_keys WHERE agent_id = ? ORDER BY created_at DESC")
      .all(agentId)
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: String(r.id),
          agentId: String(r.agent_id),
          prefix: String(r.prefix),
          hash: String(r.hash),
          createdAt: Number(r.created_at),
          revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
          lastUsedAt: r.last_used_at === null || r.last_used_at === undefined ? null : Number(r.last_used_at),
        };
      });
  }

  findApiKeyBySecret(secret: string): AgentApiKeyRecord | null {
    const hash = hashSecret(secret);
    const rows = this.db.prepare("SELECT * FROM agent_api_keys").all() as Record<string, unknown>[];
    for (const row of rows) {
      if (!hashesEqual(String(row.hash), hash)) continue;
      return {
        id: String(row.id),
        agentId: String(row.agent_id),
        prefix: String(row.prefix),
        hash: String(row.hash),
        createdAt: Number(row.created_at),
        revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
        lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
      };
    }
    return null;
  }

  touchApiKey(id: string): void {
    this.db
      .prepare("UPDATE agent_api_keys SET last_used_at = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000), id);
  }

  revokeApiKey(id: string, agentId: string): AgentApiKeyRecord | null {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare("UPDATE agent_api_keys SET revoked_at = ? WHERE id = ? AND agent_id = ? AND revoked_at IS NULL")
      .run(now, id, agentId);
    return this.listApiKeys(agentId).find((key) => key.id === id) ?? null;
  }

  getSpendDay(agentId: string, day = utcDay()): SpendDay {
    const row = this.db
      .prepare("SELECT * FROM agent_spend_days WHERE agent_id = ? AND day = ?")
      .get(agentId, day) as Record<string, unknown> | undefined;

    if (row === undefined) {
      return {
        agentId,
        day,
        launches: 0,
        spentWei: 0n,
        reservedLaunches: 0,
        reservedWei: 0n,
      };
    }

    return {
      agentId,
      day,
      launches: Number(row.launches),
      spentWei: BigInt(String(row.spent_wei)),
      reservedLaunches: Number(row.reserved_launches),
      reservedWei: BigInt(String(row.reserved_wei)),
    };
  }

  allowance(agentId: string, permissions: AgentPermissions, day = utcDay()): DailyAllowance {
    const spend = this.getSpendDay(agentId, day);
    const usedLaunches = spend.launches + spend.reservedLaunches;
    const usedWei = spend.spentWei + spend.reservedWei;
    return {
      day,
      launchesUsed: spend.launches,
      launchesReserved: spend.reservedLaunches,
      launchesRemaining: Math.max(0, permissions.maxLaunchesPerDay - usedLaunches),
      spentWei: spend.spentWei,
      reservedWei: spend.reservedWei,
      spendRemainingWei:
        permissions.maxEthPerDayWei > usedWei ? permissions.maxEthPerDayWei - usedWei : 0n,
    };
  }

  /**
   * Atomically reserve a launch against daily and per-launch limits.
   *
   * `BEGIN IMMEDIATE` takes the write lock before the read, so two concurrent
   * requests cannot both observe the same remaining budget.
   */
  reserveSpend(input: {
    readonly agentId: string;
    readonly kind: LaunchKind;
    readonly wei: bigint;
    readonly permissions: AgentPermissions;
  }): Reservation {
    const now = Math.floor(Date.now() / 1000);
    const day = utcDay(now);
    const id = crypto.randomUUID();

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.releaseStaleReservations(input.agentId, day, now);

      const spend = this.getSpendDay(input.agentId, day);
      const usedLaunches = spend.launches + spend.reservedLaunches;
      const usedWei = spend.spentWei + spend.reservedWei;

      if (usedLaunches + 1 > input.permissions.maxLaunchesPerDay) {
        throw new AgentError(
          "PERMISSION_MAX_LAUNCHES_PER_DAY",
          `This agent may launch ${String(input.permissions.maxLaunchesPerDay)} time(s) per day and has none remaining.`,
          {
            permission: "maxLaunchesPerDay",
            limit: String(input.permissions.maxLaunchesPerDay),
            requested: String(usedLaunches + 1),
          },
        );
      }

      if (input.wei > input.permissions.maxEthPerLaunchWei) {
        throw new AgentError(
          "PERMISSION_MAX_ETH_PER_LAUNCH",
          `This launch would spend ${input.wei.toString()} wei, which exceeds the per-launch limit.`,
          {
            permission: "maxEthPerLaunch",
            limit: input.permissions.maxEthPerLaunchWei.toString(),
            requested: input.wei.toString(),
          },
        );
      }

      if (usedWei + input.wei > input.permissions.maxEthPerDayWei) {
        throw new AgentError(
          "PERMISSION_MAX_ETH_PER_DAY",
          `This launch would push today's spend past the daily ETH budget.`,
          {
            permission: "maxEthPerDay",
            limit: input.permissions.maxEthPerDayWei.toString(),
            requested: (usedWei + input.wei).toString(),
          },
        );
      }

      const nextReservedLaunches = spend.reservedLaunches + 1;
      const nextReservedWei = spend.reservedWei + input.wei;
      this.db
        .prepare(
          `INSERT INTO agent_spend_days (agent_id, day, launches, spent_wei, reserved_launches, reserved_wei)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, day) DO UPDATE SET
             reserved_launches = excluded.reserved_launches,
             reserved_wei = excluded.reserved_wei`,
        )
        .run(
          input.agentId,
          day,
          spend.launches,
          spend.spentWei.toString(),
          nextReservedLaunches,
          nextReservedWei.toString(),
        );

      this.db
        .prepare(
          `INSERT INTO agent_reservations (id, agent_id, day, kind, launches, wei, status, created_at)
           VALUES (?, ?, ?, ?, 1, ?, 'reserved', ?)`,
        )
        .run(id, input.agentId, day, input.kind, input.wei.toString(), now);

      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }

    return {
      id,
      agentId: input.agentId,
      day,
      kind: input.kind,
      launches: 1,
      wei: input.wei,
      status: "reserved",
      createdAt: now,
    };
  }

  finalizeReservation(id: string, outcome: "committed" | "released"): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.db.prepare("SELECT * FROM agent_reservations WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      if (row === undefined || String(row.status) !== "reserved") {
        this.db.exec("COMMIT;");
        return;
      }

      const wei = BigInt(String(row.wei));
      const agentId = String(row.agent_id);
      const day = String(row.day);

      const spend = this.getSpendDay(agentId, day);
      if (outcome === "committed") {
        this.db
          .prepare(
            `UPDATE agent_spend_days SET
               launches = ?,
               spent_wei = ?,
               reserved_launches = ?,
               reserved_wei = ?
             WHERE agent_id = ? AND day = ?`,
          )
          .run(
            spend.launches + 1,
            (spend.spentWei + wei).toString(),
            Math.max(0, spend.reservedLaunches - 1),
            (spend.reservedWei > wei ? spend.reservedWei - wei : 0n).toString(),
            agentId,
            day,
          );
      } else {
        this.db
          .prepare(
            `UPDATE agent_spend_days SET
               reserved_launches = ?,
               reserved_wei = ?
             WHERE agent_id = ? AND day = ?`,
          )
          .run(
            Math.max(0, spend.reservedLaunches - 1),
            (spend.reservedWei > wei ? spend.reservedWei - wei : 0n).toString(),
            agentId,
            day,
          );
      }

      this.db.prepare("UPDATE agent_reservations SET status = ? WHERE id = ?").run(outcome, id);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private releaseStaleReservations(agentId: string, day: string, now: number): void {
    const stale = this.db
      .prepare(
        `SELECT * FROM agent_reservations
         WHERE agent_id = ? AND day = ? AND status = 'reserved' AND created_at < ?`,
      )
      .all(agentId, day, now - STALE_RESERVATION_SECONDS) as Record<string, unknown>[];

    for (const row of stale) {
      const wei = BigInt(String(row.wei));
      const spend = this.getSpendDay(agentId, day);
      this.db
        .prepare(
          `UPDATE agent_spend_days SET reserved_launches = ?, reserved_wei = ? WHERE agent_id = ? AND day = ?`,
        )
        .run(
          Math.max(0, spend.reservedLaunches - 1),
          (spend.reservedWei > wei ? spend.reservedWei - wei : 0n).toString(),
          agentId,
          day,
        );
      this.db
        .prepare("UPDATE agent_reservations SET status = 'released' WHERE id = ?")
        .run(String(row.id));
    }
  }

  insertLaunch(record: AgentLaunchRecord): AgentLaunchRecord {
    this.db
      .prepare(
        `INSERT INTO agent_launches (
           id, agent_id, agent_wallet, kind, token, pool, tx_hash, job_id, name, symbol,
           spend_wei, fee_recipient, status, created_at, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.agentId,
        record.agentWallet,
        record.kind,
        record.token,
        record.pool,
        record.txHash,
        record.jobId,
        record.name,
        record.symbol,
        record.spendWei.toString(),
        record.feeRecipient,
        record.status,
        record.createdAt,
        record.error,
      );
    return record;
  }

  updateLaunch(id: string, patch: Partial<AgentLaunchRecord>): AgentLaunchRecord {
    const current = this.getLaunch(id);
    if (current === null) throw new AgentError("LAUNCH_NOT_FOUND", "No such launch.");
    const next: AgentLaunchRecord = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE agent_launches SET
           token = ?, pool = ?, tx_hash = ?, job_id = ?, name = ?, symbol = ?,
           spend_wei = ?, fee_recipient = ?, status = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        next.token,
        next.pool,
        next.txHash,
        next.jobId,
        next.name,
        next.symbol,
        next.spendWei.toString(),
        next.feeRecipient,
        next.status,
        next.error,
        id,
      );
    return next;
  }

  getLaunch(id: string): AgentLaunchRecord | null {
    const row = this.db.prepare("SELECT * FROM agent_launches WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : launchFromRow(row);
  }

  listLaunches(agentId: string): readonly AgentLaunchRecord[] {
    return this.db
      .prepare("SELECT * FROM agent_launches WHERE agent_id = ? ORDER BY created_at DESC")
      .all(agentId)
      .map((row) => launchFromRow(row as Record<string, unknown>));
  }

  launchByToken(token: string): AgentLaunchRecord | null {
    if (!isAddress(token, { strict: false })) return null;
    const row = this.db
      .prepare("SELECT * FROM agent_launches WHERE token = ? COLLATE NOCASE AND status = 'succeeded'")
      .get(getAddress(token)) as Record<string, unknown> | undefined;
    return row === undefined ? null : launchFromRow(row);
  }

  linkBuild(link: AgentBuildLink): void {
    this.db
      .prepare("INSERT OR REPLACE INTO agent_builds (job_id, agent_id, created_at) VALUES (?, ?, ?)")
      .run(link.jobId, link.agentId, link.createdAt);
  }

  buildOwner(jobId: string): string | null {
    const row = this.db.prepare("SELECT agent_id FROM agent_builds WHERE job_id = ?").get(jobId) as
      | { agent_id: string }
      | undefined;
    return row?.agent_id ?? null;
  }

  recordActivity(input: {
    readonly agentId: string;
    readonly type: AgentActivityType;
    readonly payload?: Record<string, unknown>;
  }): AgentActivity {
    const activity: AgentActivity = {
      id: crypto.randomUUID(),
      agentId: input.agentId,
      type: input.type,
      payload: sanitisePayload(input.payload ?? {}),
      createdAt: Math.floor(Date.now() / 1000),
    };

    this.db
      .prepare("INSERT INTO agent_activity (id, agent_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(activity.id, activity.agentId, activity.type, JSON.stringify(activity.payload), activity.createdAt);

    return activity;
  }

  listActivity(agentId: string, limit = 100): readonly AgentActivity[] {
    return this.db
      .prepare("SELECT * FROM agent_activity WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(agentId, limit)
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: String(r.id),
          agentId: String(r.agent_id),
          type: String(r.type) as AgentActivityType,
          payload: JSON.parse(String(r.payload)) as Record<string, unknown>,
          createdAt: Number(r.created_at),
        };
      });
  }

  recordUsage(input: {
    readonly agentId: string;
    readonly keyId: string | null;
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly code: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_api_usage (id, agent_id, key_id, method, path, status, code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        input.agentId,
        input.keyId,
        input.method,
        input.path,
        input.status,
        input.code,
        Math.floor(Date.now() / 1000),
      );
  }

  recentUsageCount(keyId: string, windowSeconds: number): number {
    const since = Math.floor(Date.now() / 1000) - windowSeconds;
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM agent_api_usage WHERE key_id = ? AND created_at >= ?")
      .get(keyId, since) as { n: number };
    return Number(row.n);
  }

  upsertRevenue(row: {
    readonly agentId: string;
    readonly token: Address;
    readonly lifetimeWei: bigint;
    readonly claimedWei: bigint;
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_revenue (agent_id, token, lifetime_wei, claimed_wei)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, token) DO UPDATE SET
           lifetime_wei = excluded.lifetime_wei,
           claimed_wei = excluded.claimed_wei`,
      )
      .run(row.agentId, row.token, row.lifetimeWei.toString(), row.claimedWei.toString());
  }

  listRevenue(agentId: string): readonly AgentRevenueRow[] {
    return this.db
      .prepare("SELECT * FROM agent_revenue WHERE agent_id = ?")
      .all(agentId)
      .map((row) => {
        const r = row as Record<string, unknown>;
        const lifetimeWei = BigInt(String(r.lifetime_wei));
        const claimedWei = BigInt(String(r.claimed_wei));
        return {
          token: asAddress(String(r.token)),
          lifetimeWei,
          claimedWei,
          claimableWei: lifetimeWei > claimedWei ? lifetimeWei - claimedWei : 0n,
        };
      });
  }

  addClaimed(agentId: string, token: Address, wei: bigint): void {
    const current = this.listRevenue(agentId).find((row) => row.token.toLowerCase() === token.toLowerCase());
    const claimed = (current?.claimedWei ?? 0n) + wei;
    const lifetime = current?.lifetimeWei ?? 0n;
    this.upsertRevenue({ agentId, token: getAddress(token), lifetimeWei: lifetime, claimedWei: claimed });
  }

  putChallenge(nonce: string, address: Address, expiresAt: number): void {
    this.db
      .prepare("INSERT INTO owner_challenges (nonce, address, expires_at) VALUES (?, ?, ?)")
      .run(nonce, getAddress(address), expiresAt);
  }

  takeChallenge(nonce: string): { readonly address: Address; readonly expiresAt: number } | null {
    const row = this.db.prepare("SELECT * FROM owner_challenges WHERE nonce = ?").get(nonce) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    this.db.prepare("DELETE FROM owner_challenges WHERE nonce = ?").run(nonce);
    return { address: asAddress(String(row.address)), expiresAt: Number(row.expires_at) };
  }

  /* ---------------------------------------------------------------- *
   * Phase 2: mandate, autonomy, policy.
   * ---------------------------------------------------------------- */

  getMandate(agentId: string): AgentMandate | null {
    const row = this.db.prepare("SELECT * FROM agent_mandates WHERE agent_id = ?").get(agentId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : mandateFromRow(row);
  }

  setMandate(agentId: string, text: string, updatedBy: Address): AgentMandate {
    const now = Math.floor(Date.now() / 1000);
    const version = (this.getMandate(agentId)?.version ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO agent_mandates (agent_id, text, version, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           text = excluded.text,
           version = excluded.version,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(agentId, text, version, now, getAddress(updatedBy));
    return { agentId, text, version, updatedAt: now, updatedBy: getAddress(updatedBy) };
  }

  /**
   * Absence of a row means autonomy is off. Every agent created before Phase 2
   * therefore reads as off without a backfill having to reach it.
   */
  getAutonomy(agentId: string): AgentAutonomy {
    const row = this.db.prepare("SELECT * FROM agent_autonomy WHERE agent_id = ?").get(agentId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) {
      return { ...DEFAULT_AUTONOMY, agentId, updatedAt: 0 };
    }
    return autonomyFromRow(row);
  }

  setAutonomy(
    agentId: string,
    patch: Partial<Omit<AgentAutonomy, "agentId" | "updatedAt">>,
  ): AgentAutonomy {
    const now = Math.floor(Date.now() / 1000);
    const next: AgentAutonomy = { ...this.getAutonomy(agentId), ...patch, agentId, updatedAt: now };
    this.writeAutonomy(next);
    return next;
  }

  private writeAutonomy(next: AgentAutonomy): void {
    this.db
      .prepare(
        `INSERT INTO agent_autonomy
           (agent_id, enabled, mode, interval_seconds, next_run_at, last_run_at,
            last_decision_id, lease_holder, lease_expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           enabled = excluded.enabled,
           mode = excluded.mode,
           interval_seconds = excluded.interval_seconds,
           next_run_at = excluded.next_run_at,
           last_run_at = excluded.last_run_at,
           last_decision_id = excluded.last_decision_id,
           lease_holder = excluded.lease_holder,
           lease_expires_at = excluded.lease_expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        next.agentId,
        next.enabled ? 1 : 0,
        next.mode,
        next.intervalSeconds,
        next.nextRunAt,
        next.lastRunAt,
        next.lastDecisionId,
        next.leaseHolder,
        next.leaseExpiresAt,
        next.updatedAt,
      );
  }

  getPolicy(agentId: string): AgentPolicy {
    const row = this.db.prepare("SELECT * FROM agent_policies WHERE agent_id = ?").get(agentId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) {
      return { ...DEFAULT_POLICY, agentId, updatedAt: 0 };
    }
    return policyFromRow(row);
  }

  setPolicy(agentId: string, patch: Partial<Omit<AgentPolicy, "agentId" | "updatedAt">>): AgentPolicy {
    const now = Math.floor(Date.now() / 1000);
    const next: AgentPolicy = { ...this.getPolicy(agentId), ...patch, agentId, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO agent_policies
           (agent_id, treasury_reserve_wei, revenue_policy, reinvest_bps, boost_allowed,
            max_runs_per_day, max_model_calls_per_day, launch_cooldown_seconds, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           treasury_reserve_wei = excluded.treasury_reserve_wei,
           revenue_policy = excluded.revenue_policy,
           reinvest_bps = excluded.reinvest_bps,
           boost_allowed = excluded.boost_allowed,
           max_runs_per_day = excluded.max_runs_per_day,
           max_model_calls_per_day = excluded.max_model_calls_per_day,
           launch_cooldown_seconds = excluded.launch_cooldown_seconds,
           updated_at = excluded.updated_at`,
      )
      .run(
        next.agentId,
        next.treasuryReserveWei.toString(),
        next.revenuePolicy,
        next.reinvestBps,
        next.boostAllowed ? 1 : 0,
        next.maxRunsPerDay,
        next.maxModelCallsPerDay,
        next.launchCooldownSeconds,
        next.updatedAt,
      );
    return next;
  }

  /* ---------------------------------------------------------------- *
   * Phase 2: runs.
   * ---------------------------------------------------------------- */

  /**
   * Claim the right to run one cycle.
   *
   * Two things must be impossible: two cycles running at once, and one schedule
   * slot producing two cycles because the process restarted between claiming and
   * finishing. The first is a lease with an expiry; the second is the UNIQUE key
   * on `(agent_id, scheduled_for)`, which survives any restart because it is a
   * constraint rather than a variable.
   *
   * A lease found expired means the holder died mid-cycle. Its run is closed as
   * `interrupted` here rather than left `running` forever, and — because its slot
   * is already taken — it is never silently retried.
   */
  acquireRun(input: {
    readonly agentId: string;
    readonly scheduledFor: number;
    readonly holder: string;
    readonly mode: ExecutionMode;
    readonly trigger: RunTrigger;
    readonly leaseSeconds?: number;
  }): AgentRun {
    const now = Math.floor(Date.now() / 1000);
    const lease = input.leaseSeconds ?? AUTONOMY_LEASE_SECONDS;
    const id = crypto.randomUUID();

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const autonomy = this.getAutonomy(input.agentId);

      if (autonomy.leaseExpiresAt !== null && autonomy.leaseExpiresAt > now) {
        throw new AgentError(
          "RUN_IN_PROGRESS",
          "This agent is already running a cycle.",
          { details: { leaseExpiresAt: autonomy.leaseExpiresAt } },
        );
      }

      if (autonomy.leaseHolder !== null) {
        this.db
          .prepare(
            `UPDATE agent_runs SET status = 'interrupted', finished_at = ?, outcome = 'error',
               error = 'The process holding this run stopped before it finished.'
             WHERE agent_id = ? AND status = 'running'`,
          )
          .run(now, input.agentId);
      }

      const taken = this.db
        .prepare("SELECT id FROM agent_runs WHERE agent_id = ? AND scheduled_for = ?")
        .get(input.agentId, input.scheduledFor) as Record<string, unknown> | undefined;
      if (taken !== undefined) {
        throw new AgentError(
          "RUN_ALREADY_RECORDED",
          "A cycle has already been recorded for this slot.",
          { details: { runId: String(taken.id), scheduledFor: input.scheduledFor } },
        );
      }

      this.db
        .prepare(
          `INSERT INTO agent_runs
             (id, agent_id, scheduled_for, started_at, finished_at, status, mode, trigger,
              outcome, decision_id, model_calls, error)
           VALUES (?, ?, ?, ?, NULL, 'running', ?, ?, NULL, NULL, 0, NULL)`,
        )
        .run(id, input.agentId, input.scheduledFor, now, input.mode, input.trigger);

      this.writeAutonomy({
        ...autonomy,
        leaseHolder: input.holder,
        leaseExpiresAt: now + lease,
        updatedAt: now,
      });

      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }

    return {
      id,
      agentId: input.agentId,
      scheduledFor: input.scheduledFor,
      startedAt: now,
      finishedAt: null,
      status: "running",
      mode: input.mode,
      trigger: input.trigger,
      outcome: null,
      decisionId: null,
      modelCalls: 0,
      error: null,
    };
  }

  /**
   * Take the same lease a cycle takes, without recording a cycle.
   *
   * For owner operations that must not interleave with a run — emptying the
   * treasury while a launch is mid-flight would race the reservation it already
   * took. Reusing the run lease rather than inventing a second one is what makes
   * "these two things cannot happen at once" true rather than intended.
   */
  acquireLease(agentId: string, holder: string, seconds = AUTONOMY_LEASE_SECONDS): void {
    const now = Math.floor(Date.now() / 1000);

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const autonomy = this.getAutonomy(agentId);
      if (autonomy.leaseExpiresAt !== null && autonomy.leaseExpiresAt > now) {
        throw new AgentError(
          "RUN_IN_PROGRESS",
          "This agent is busy with a cycle. Try again once it finishes.",
          { details: { leaseExpiresAt: autonomy.leaseExpiresAt } },
        );
      }
      this.writeAutonomy({
        ...autonomy,
        leaseHolder: holder,
        leaseExpiresAt: now + seconds,
        updatedAt: now,
      });
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  releaseLease(agentId: string, holder: string): void {
    const autonomy = this.getAutonomy(agentId);
    if (autonomy.leaseHolder !== holder) return;
    this.writeAutonomy({ ...autonomy, leaseHolder: null, leaseExpiresAt: null });
  }

  /** Close a run and drop its lease in one transaction, so neither can outlive the other. */
  finishRun(input: {
    readonly agentId: string;
    readonly runId: string;
    readonly status: RunStatus;
    readonly outcome: RunOutcome;
    readonly decisionId?: string | null;
    readonly modelCalls?: number;
    readonly error?: string | null;
    readonly nextRunAt?: number | null;
  }): AgentRun {
    const now = Math.floor(Date.now() / 1000);

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(
          `UPDATE agent_runs
             SET status = ?, outcome = ?, decision_id = ?, model_calls = ?, error = ?, finished_at = ?
           WHERE id = ?`,
        )
        .run(
          input.status,
          input.outcome,
          input.decisionId ?? null,
          input.modelCalls ?? 0,
          input.error ?? null,
          now,
          input.runId,
        );

      const autonomy = this.getAutonomy(input.agentId);
      this.writeAutonomy({
        ...autonomy,
        lastRunAt: now,
        lastDecisionId: input.decisionId ?? autonomy.lastDecisionId,
        nextRunAt: input.nextRunAt === undefined ? autonomy.nextRunAt : input.nextRunAt,
        leaseHolder: null,
        leaseExpiresAt: null,
        updatedAt: now,
      });

      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }

    const run = this.getRun(input.runId);
    if (run === null) {
      throw new AgentError("CONFLICT", "That run disappeared while it was being closed.");
    }
    return run;
  }

  /**
   * Agents whose next cycle is due and which nothing is currently running.
   *
   * Ordered oldest-due first so an agent that has been waiting longest is not
   * starved by one whose interval is short. The lease column is checked here as
   * well as in `acquireRun`; this one is an optimisation, that one is the rule.
   */
  dueAgents(now = Math.floor(Date.now() / 1000), limit = 25): readonly AgentRecord[] {
    return this.db
      .prepare(
        `SELECT a.* FROM agents a
           JOIN agent_autonomy t ON t.agent_id = a.id
         WHERE t.enabled = 1
           AND a.status = 'active'
           AND t.next_run_at IS NOT NULL
           AND t.next_run_at <= ?
           AND (t.lease_expires_at IS NULL OR t.lease_expires_at <= ?)
         ORDER BY t.next_run_at ASC
         LIMIT ?`,
      )
      .all(now, now, limit)
      .map((row) => agentFromRow(row as Record<string, unknown>));
  }

  /**
   * When the next agent anywhere is due, or null if none are.
   *
   * The one number that answers "is the scheduler going to do anything, ever
   * again" at a glance. A timestamp in the past means agents are due right now
   * and something is wrong if the heartbeat is fresh.
   */
  nextScheduledRun(): number | null {
    const row = this.db
      .prepare(
        `SELECT MIN(t.next_run_at) AS next FROM agent_autonomy t
           JOIN agents a ON a.id = t.agent_id
         WHERE t.enabled = 1 AND a.status = 'active' AND t.next_run_at IS NOT NULL`,
      )
      .get() as Record<string, unknown> | undefined;
    const next = row?.next;
    return next === null || next === undefined ? null : Number(next);
  }

  /**
   * Clean up after a process that died mid-cycle.
   *
   * Without this an agent wedges permanently, and the way it wedges is worth
   * spelling out. A killed cycle leaves its run row `running` and its slot
   * consumed, but `next_run_at` was never advanced — that happens in
   * `finishRun`, which never ran. So the agent stays due forever at a slot that
   * is already taken, and every future attempt is refused as a duplicate.
   *
   * The repair is to close the run and move the schedule past the dead slot, in
   * one transaction. The cost of a crash is therefore one interval, and the
   * cycle that died is never retried — which is the behaviour we want, because
   * it may have broadcast a transaction before it stopped.
   */
  reapAbandonedRuns(now = Math.floor(Date.now() / 1000)): readonly string[] {
    const abandoned = this.db
      .prepare(
        `SELECT agent_id, interval_seconds FROM agent_autonomy
         WHERE lease_holder IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .all(now) as Record<string, unknown>[];

    if (abandoned.length === 0) return [];

    const reaped: string[] = [];
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const row of abandoned) {
        const agentId = String(row.agent_id);
        const interval = Number(row.interval_seconds);

        this.db
          .prepare(
            `UPDATE agent_runs SET status = 'interrupted', finished_at = ?, outcome = 'error',
               error = 'The process running this cycle stopped before it finished.'
             WHERE agent_id = ? AND status = 'running'`,
          )
          .run(now, agentId);

        const autonomy = this.getAutonomy(agentId);
        this.writeAutonomy({
          ...autonomy,
          nextRunAt: now + interval,
          leaseHolder: null,
          leaseExpiresAt: null,
          updatedAt: now,
        });

        reaped.push(agentId);
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }

    return reaped;
  }

  /**
   * How many cycles in a row have failed, most recent first.
   *
   * Feeds the scheduler's backoff. A single failure is ordinary; a run of them
   * usually means something the next cycle will not fix either, and the point of
   * counting is to stop paying a model to find that out every interval.
   */
  consecutiveFailures(agentId: string): number {
    const rows = this.db
      .prepare("SELECT status FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 20")
      .all(agentId) as Record<string, unknown>[];

    let count = 0;
    for (const row of rows) {
      const status = String(row.status);
      if (status === "failed" || status === "interrupted") count += 1;
      else break;
    }
    return count;
  }

  getRun(id: string): AgentRun | null {
    const row = this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : runFromRow(row);
  }

  listRuns(agentId: string, limit = 50): readonly AgentRun[] {
    return this.db
      .prepare("SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(agentId, limit)
      .map((row) => runFromRow(row as Record<string, unknown>));
  }

  countRunsSince(agentId: string, since: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE agent_id = ? AND started_at >= ?")
      .get(agentId, since) as Record<string, unknown>;
    return Number(row.n);
  }

  /* ---------------------------------------------------------------- *
   * Phase 2: decisions.
   * ---------------------------------------------------------------- */

  insertDecision(input: {
    readonly runId: string;
    readonly agentId: string;
    readonly kind: DecisionKind;
    readonly payload: Record<string, unknown>;
    readonly rationale: string;
    readonly confidence: number;
    readonly status: DecisionStatus;
    readonly mandateVersion: number;
  }): AgentDecision {
    const now = Math.floor(Date.now() / 1000);
    const decision: AgentDecision = {
      id: crypto.randomUUID(),
      runId: input.runId,
      agentId: input.agentId,
      kind: input.kind,
      payload: input.payload,
      rationale: input.rationale,
      confidence: input.confidence,
      status: input.status,
      mandateVersion: input.mandateVersion,
      createdAt: now,
      decidedAt: null,
      decidedBy: null,
      executedAt: null,
      result: null,
      error: null,
    };

    this.db
      .prepare(
        `INSERT INTO agent_decisions
           (id, run_id, agent_id, kind, payload, rationale, confidence, status,
            mandate_version, created_at, decided_at, decided_by, executed_at, result, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(
        decision.id,
        decision.runId,
        decision.agentId,
        decision.kind,
        JSON.stringify(decision.payload),
        decision.rationale,
        decision.confidence,
        decision.status,
        decision.mandateVersion,
        decision.createdAt,
      );

    return decision;
  }

  updateDecision(
    id: string,
    patch: Partial<Pick<AgentDecision, "status" | "decidedAt" | "decidedBy" | "executedAt" | "result" | "error">>,
  ): AgentDecision {
    const current = this.getDecision(id);
    if (current === null) {
      throw new AgentError("DECISION_NOT_FOUND", "That decision does not exist.");
    }
    const next: AgentDecision = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE agent_decisions
           SET status = ?, decided_at = ?, decided_by = ?, executed_at = ?, result = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.decidedAt,
        next.decidedBy,
        next.executedAt,
        next.result === null ? null : JSON.stringify(next.result),
        next.error,
        id,
      );
    return next;
  }

  getDecision(id: string): AgentDecision | null {
    const row = this.db.prepare("SELECT * FROM agent_decisions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : decisionFromRow(row);
  }

  listDecisions(agentId: string, limit = 50): readonly AgentDecision[] {
    return this.db
      .prepare("SELECT * FROM agent_decisions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(agentId, limit)
      .map((row) => decisionFromRow(row as Record<string, unknown>));
  }

  listPendingDecisions(agentId: string): readonly AgentDecision[] {
    return this.db
      .prepare("SELECT * FROM agent_decisions WHERE agent_id = ? AND status = 'proposed' ORDER BY created_at DESC")
      .all(agentId)
      .map((row) => decisionFromRow(row as Record<string, unknown>));
  }

  lastDecision(agentId: string): AgentDecision | null {
    const row = this.db
      .prepare("SELECT * FROM agent_decisions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(agentId) as Record<string, unknown> | undefined;
    return row === undefined ? null : decisionFromRow(row);
  }

  /* ---------------------------------------------------------------- *
   * Phase 2: memory, feedback, model accounting, platform controls.
   * ---------------------------------------------------------------- */

  insertMemory(input: {
    readonly agentId: string;
    readonly kind: MemoryKind;
    readonly content: string;
    readonly source: MemorySource;
    readonly runId?: string | null;
    readonly weight?: number;
    readonly expiresAt?: number | null;
  }): AgentMemory {
    const memory: AgentMemory = {
      id: crypto.randomUUID(),
      agentId: input.agentId,
      kind: input.kind,
      content: input.content,
      source: input.source,
      runId: input.runId ?? null,
      weight: input.weight ?? 1,
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: input.expiresAt ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO agent_memory (id, agent_id, kind, content, source, run_id, weight, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.agentId,
        memory.kind,
        memory.content,
        memory.source,
        memory.runId,
        memory.weight,
        memory.createdAt,
        memory.expiresAt,
      );
    return memory;
  }

  listMemory(agentId: string, limit = 100): readonly AgentMemory[] {
    const now = Math.floor(Date.now() / 1000);
    return this.db
      .prepare(
        `SELECT * FROM agent_memory
         WHERE agent_id = ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, now, limit)
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: String(r.id),
          agentId: String(r.agent_id),
          kind: String(r.kind) as MemoryKind,
          content: String(r.content),
          source: String(r.source) as MemorySource,
          runId: nullableString(r.run_id),
          weight: Number(r.weight),
          createdAt: Number(r.created_at),
          expiresAt: nullableNumber(r.expires_at),
        };
      });
  }

  insertFeedback(input: {
    readonly agentId: string;
    readonly decisionId: string | null;
    readonly verdict: FeedbackVerdict;
    readonly note: string;
    readonly ownerAddress: Address;
  }): AgentFeedback {
    const feedback: AgentFeedback = {
      id: crypto.randomUUID(),
      agentId: input.agentId,
      decisionId: input.decisionId,
      verdict: input.verdict,
      note: input.note,
      ownerAddress: getAddress(input.ownerAddress),
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.db
      .prepare(
        `INSERT INTO agent_feedback (id, agent_id, decision_id, verdict, note, owner_address, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        feedback.id,
        feedback.agentId,
        feedback.decisionId,
        feedback.verdict,
        feedback.note,
        feedback.ownerAddress,
        feedback.createdAt,
      );
    return feedback;
  }

  listFeedback(agentId: string, limit = 50): readonly AgentFeedback[] {
    return this.db
      .prepare("SELECT * FROM agent_feedback WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(agentId, limit)
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: String(r.id),
          agentId: String(r.agent_id),
          decisionId: nullableString(r.decision_id),
          verdict: String(r.verdict) as FeedbackVerdict,
          note: String(r.note),
          ownerAddress: asAddress(String(r.owner_address)),
          createdAt: Number(r.created_at),
        };
      });
  }

  modelUsage(agentId: string, day = utcDay()): ModelUsageDay {
    const row = this.db
      .prepare("SELECT * FROM agent_model_usage WHERE agent_id = ? AND day = ?")
      .get(agentId, day) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return { agentId, day, calls: 0, inputTokens: 0, outputTokens: 0 };
    }
    return {
      agentId,
      day,
      calls: Number(row.calls),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
    };
  }

  /**
   * Counted before the call is made, not after, so a crashed or hung request
   * still costs the agent its budget. A model that cannot be billed for is
   * exactly the one worth being strict about.
   */
  recordModelCall(agentId: string, day = utcDay()): ModelUsageDay {
    this.db
      .prepare(
        `INSERT INTO agent_model_usage (agent_id, day, calls, input_tokens, output_tokens)
         VALUES (?, ?, 1, 0, 0)
         ON CONFLICT(agent_id, day) DO UPDATE SET calls = calls + 1`,
      )
      .run(agentId, day);
    return this.modelUsage(agentId, day);
  }

  /** Attributed to a call already counted by `recordModelCall`, so it adds no call. */
  addModelTokens(input: {
    readonly agentId: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly day?: string;
  }): void {
    const day = input.day ?? utcDay();
    this.db
      .prepare(
        `INSERT INTO agent_model_usage (agent_id, day, calls, input_tokens, output_tokens)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(agent_id, day) DO UPDATE SET
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(input.agentId, day, input.inputTokens, input.outputTokens);
  }

  getControl(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM platform_controls WHERE key = ?").get(key) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : String(row.value);
  }

  setControl(key: string, value: string, updatedBy: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO platform_controls (key, value, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(key, value, Math.floor(Date.now() / 1000), updatedBy);
  }
}

const SECRET_KEYS = /secret|private[_-]?key|ciphertext|authorization|bearer|signature|api[_-]?key/i;

function sanitisePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SECRET_KEYS.test(key)) continue;
    if (typeof value === "string" && value.startsWith("agn_") && value.length > 16) continue;
    clean[key] = value;
  }
  return clean;
}

/**
 * One store per process, not one per bundle.
 *
 * Next compiles route handlers and the instrumentation hook into separate bundles,
 * so a plain module-level singleton is instantiated once in each — which would mean
 * the scheduler and the API opening two SQLite connections to the same file and
 * contending for the write lock. The whole design assumes a single writer, so the
 * handle is parked on the global object, which is genuinely shared.
 */
const STORE_KEY = Symbol.for("agen.agents.store");

interface StoreGlobal {
  [STORE_KEY]?: AgentStore | null;
}

function slot(): StoreGlobal {
  return globalThis as unknown as StoreGlobal;
}

export function defaultStorePath(): string {
  const override = process.env["AGEN_AGENT_DB"]?.trim();
  if (override !== undefined && override !== "") return override;
  return resolve(GENERATED_ROOT, "_agents", "agents.db");
}

export function agentStore(): AgentStore {
  const shared = slot();
  shared[STORE_KEY] ??= new AgentStore(defaultStorePath());
  return shared[STORE_KEY];
}

export function resetAgentStoreForTests(store: AgentStore | null): void {
  slot()[STORE_KEY] = store;
}
