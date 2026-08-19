/**
 * The agent layer's own types.
 *
 * Distinct from `packages/sdk/src/agents`, which is the on-chain Agent protocol
 * (Mandate, Treasury, ExecutionModule). This file is agen.space's product identity:
 * a named account with an isolated wallet that launches through Instant and
 * Programmable. The two must not share type names.
 */

export const AGENT_STATUSES = ["active", "paused", "archived"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const LAUNCH_KINDS = ["instant", "programmable"] as const;
export type LaunchKind = (typeof LAUNCH_KINDS)[number];

export interface AgentPermissions {
  readonly instantAllowed: boolean;
  readonly programmableAllowed: boolean;
  /** Inclusive. Gas is not counted; the launch's explicit ETH spend is. */
  readonly maxEthPerLaunchWei: bigint;
  readonly maxLaunchesPerDay: number;
  readonly maxEthPerDayWei: bigint;
  readonly maxCreatorBuyWei: bigint;
  readonly canClaimCreatorFees: boolean;
  /** Phase 1: always false. Stored so the rule is explicit rather than implied. */
  readonly externalTransfers: boolean;
  /** Phase 1: always true. The signer refuse anything outside the Agen allowlist. */
  readonly approvedContractsOnly: boolean;
}

export const DEFAULT_PERMISSIONS: AgentPermissions = {
  instantAllowed: true,
  programmableAllowed: true,
  maxEthPerLaunchWei: 50_000_000_000_000_000n, // 0.05 ETH
  maxLaunchesPerDay: 3,
  maxEthPerDayWei: 150_000_000_000_000_000n, // 0.15 ETH
  maxCreatorBuyWei: 50_000_000_000_000_000n,
  canClaimCreatorFees: false,
  externalTransfers: false,
  approvedContractsOnly: true,
};

export interface AgentRecord {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly description: string;
  readonly imageUrl: string | null;
  readonly ownerAddress: `0x${string}`;
  readonly walletAddress: `0x${string}`;
  readonly status: AgentStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentWalletRecord {
  readonly agentId: string;
  readonly address: `0x${string}`;
  readonly ciphertext: string;
  readonly nonce: string;
  readonly salt: string;
  readonly createdAt: number;
}

export interface AgentApiKeyRecord {
  readonly id: string;
  readonly agentId: string;
  readonly prefix: string;
  readonly hash: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly lastUsedAt: number | null;
}

export interface IssuedApiKey {
  readonly id: string;
  readonly prefix: string;
  readonly secret: string;
  readonly createdAt: number;
}

export interface SpendDay {
  readonly agentId: string;
  readonly day: string;
  readonly launches: number;
  readonly spentWei: bigint;
  readonly reservedLaunches: number;
  readonly reservedWei: bigint;
}

export interface Reservation {
  readonly id: string;
  readonly agentId: string;
  readonly day: string;
  readonly kind: LaunchKind;
  readonly launches: number;
  readonly wei: bigint;
  readonly status: "reserved" | "committed" | "released";
  readonly createdAt: number;
}

export interface AgentLaunchRecord {
  readonly id: string;
  readonly agentId: string;
  readonly agentWallet: `0x${string}`;
  readonly kind: LaunchKind;
  readonly token: `0x${string}` | null;
  readonly pool: `0x${string}` | null;
  readonly txHash: `0x${string}` | null;
  readonly jobId: string | null;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly spendWei: bigint;
  readonly feeRecipient: `0x${string}` | null;
  readonly status: "requested" | "submitted" | "succeeded" | "failed";
  readonly createdAt: number;
  readonly error: string | null;
}

export interface AgentBuildLink {
  readonly jobId: string;
  readonly agentId: string;
  readonly createdAt: number;
}

export interface AgentActivity {
  readonly id: string;
  readonly agentId: string;
  readonly type: AgentActivityType;
  readonly payload: Record<string, unknown>;
  readonly createdAt: number;
}

export type AgentActivityType =
  | "api_accepted"
  | "api_rejected"
  | "launch_requested"
  | "build_started"
  | "clarification_requested"
  | "clarification_answered"
  | "build_ready"
  | "launch_submitted"
  | "launch_succeeded"
  | "launch_failed"
  | "permission_rejected"
  | "treasury_spend"
  | "creator_fee_claim"
  | "agent_created"
  | "agent_updated"
  | "agent_paused"
  | "agent_resumed"
  | "agent_archived"
  | "key_created"
  | "key_revoked"
  | "permissions_updated"
  // Phase 2.
  | "mandate_updated"
  | "autonomy_enabled"
  | "autonomy_disabled"
  | "autonomy_mode_changed"
  | "policy_updated"
  | "run_started"
  | "run_finished"
  | "decision_made"
  | "decision_approved"
  | "decision_rejected"
  | "decision_executed"
  | "decision_failed"
  | "owner_feedback"
  | "treasury_recovered"
  // Phase 3: the agent reading its own results back.
  | "market_noticed";

export interface DailyAllowance {
  readonly day: string;
  readonly launchesUsed: number;
  readonly launchesReserved: number;
  readonly launchesRemaining: number;
  readonly spentWei: bigint;
  readonly reservedWei: bigint;
  readonly spendRemainingWei: bigint;
}

export interface AgentRevenueRow {
  readonly token: `0x${string}`;
  readonly lifetimeWei: bigint;
  readonly claimedWei: bigint;
  readonly claimableWei: bigint;
}

/* ------------------------------------------------------------------ *
 * Phase 2: autonomy.
 *
 * The layer above owns *what* an agent wants to do. Everything below —
 * wallets, permissions, reservations, the signer allowlist — is unchanged
 * and remains the only thing that decides whether it may.
 *
 * Naming note, per the header: the on-chain protocol's `Mandate` is a
 * different concept. This one is a sentence an owner wrote.
 * ------------------------------------------------------------------ */

/**
 * What the agent is allowed to do with a decision once it has made one.
 * Not a permission — permissions still apply on top of every mode.
 */
export const EXECUTION_MODES = ["observe", "approve", "autonomous"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export interface AgentMandate {
  readonly agentId: string;
  readonly text: string;
  /** Bumped on every edit so a decision can name the mandate it was made under. */
  readonly version: number;
  readonly updatedAt: number;
  readonly updatedBy: `0x${string}`;
}

export const MANDATE_MAX_LENGTH = 2_000;

export interface AgentAutonomy {
  readonly agentId: string;
  /** Off for every agent that existed before Phase 2, and for every new one. */
  readonly enabled: boolean;
  readonly mode: ExecutionMode;
  readonly intervalSeconds: number;
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly lastDecisionId: string | null;
  /** Held for the duration of a cycle. Expiry is what makes a killed process recoverable. */
  readonly leaseHolder: string | null;
  readonly leaseExpiresAt: number | null;
  readonly updatedAt: number;
}

export const AUTONOMY_MIN_INTERVAL_SECONDS = 15 * 60;
export const AUTONOMY_MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60;
export const AUTONOMY_LEASE_SECONDS = 10 * 60;

export const DEFAULT_AUTONOMY: Omit<AgentAutonomy, "agentId" | "updatedAt"> = {
  enabled: false,
  mode: "observe",
  intervalSeconds: 6 * 60 * 60,
  nextRunAt: null,
  lastRunAt: null,
  lastDecisionId: null,
  leaseHolder: null,
  leaseExpiresAt: null,
};

export const REVENUE_POLICIES = ["hold", "claim", "claim_and_reinvest"] as const;
export type RevenuePolicy = (typeof REVENUE_POLICIES)[number];

/**
 * Owner economics. Separate from `AgentAutonomy` because this changes when an
 * owner edits it and that changes on every run; mixing them would make every
 * cycle rewrite the owner's rules.
 */
export interface AgentPolicy {
  readonly agentId: string;
  /** Treasury the agent may never spend below. Checked before any reservation. */
  readonly treasuryReserveWei: bigint;
  readonly revenuePolicy: RevenuePolicy;
  /** Share of claimed revenue the agent may put back to work, in basis points. */
  readonly reinvestBps: number;
  readonly boostAllowed: boolean;
  readonly maxRunsPerDay: number;
  readonly maxModelCallsPerDay: number;
  /** Floor between two launches, on top of the daily launch cap. */
  readonly launchCooldownSeconds: number;
  readonly updatedAt: number;
}

export const DEFAULT_POLICY: Omit<AgentPolicy, "agentId" | "updatedAt"> = {
  treasuryReserveWei: 10_000_000_000_000_000n, // 0.01 ETH kept back for gas
  revenuePolicy: "hold",
  reinvestBps: 0,
  boostAllowed: false,
  maxRunsPerDay: 8,
  maxModelCallsPerDay: 32,
  launchCooldownSeconds: 60 * 60,
};

export const RUN_STATUSES = ["running", "succeeded", "failed", "interrupted"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * `no_action` is a success, not a failure. An agent with nothing worth doing
 * that does nothing is behaving correctly.
 */
export const RUN_OUTCOMES = [
  "no_action",
  "proposed",
  "executed",
  "blocked",
  "error",
  "skipped",
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const RUN_TRIGGERS = ["owner", "worker", "test"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export interface AgentRun {
  readonly id: string;
  readonly agentId: string;
  /**
   * The schedule slot this run belongs to. Unique per agent, which is what stops
   * a restart or two callers from running the same slot twice.
   */
  readonly scheduledFor: number;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly status: RunStatus;
  readonly mode: ExecutionMode;
  readonly trigger: RunTrigger;
  readonly outcome: RunOutcome | null;
  readonly decisionId: string | null;
  readonly modelCalls: number;
  readonly error: string | null;
}

export const DECISION_KINDS = [
  "no_action",
  "instant_launch",
  "programmable_build",
  "answer_clarification",
  "claim_revenue",
  "reinvest",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DECISION_STATUSES = [
  "observed",
  "proposed",
  "approved",
  "rejected",
  "executed",
  "failed",
  "expired",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface AgentDecision {
  readonly id: string;
  readonly runId: string;
  readonly agentId: string;
  readonly kind: DecisionKind;
  /** The validated decision. Never calldata, never an address the model invented. */
  readonly payload: Record<string, unknown>;
  readonly rationale: string;
  readonly confidence: number;
  readonly status: DecisionStatus;
  readonly mandateVersion: number;
  readonly createdAt: number;
  readonly decidedAt: number | null;
  readonly decidedBy: `0x${string}` | null;
  readonly executedAt: number | null;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
}

export const MEMORY_KINDS = ["fact", "outcome", "preference", "feedback"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_SOURCES = ["owner", "run", "system"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/**
 * Something the agent carries from one cycle into the next.
 *
 * Two things write here. An owner does, through chat or the memory API, and those rows are
 * instructions with `source: "owner"`. A cycle does, through `outcomes.ts`, and those rows
 * are dated observations about the agent's own markets with `source: "run"` — figures read
 * from the market feed, never a conclusion the model reached about itself.
 */
export interface AgentMemory {
  readonly id: string;
  readonly agentId: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly source: MemorySource;
  readonly runId: string | null;
  readonly weight: number;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

export const CHAT_ROLES = ["owner", "agent"] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

/**
 * One thing said, by one of the two people who can say anything here.
 *
 * `memoryId` is set on an owner's turn when that turn was filed as a standing instruction
 * the agent will read on its next cycle. It is how the screen can show which sentences the
 * agent is actually working from, rather than asking the owner to take that on trust.
 */
export interface AgentChatTurn {
  readonly id: string;
  readonly agentId: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly memoryId: string | null;
  readonly createdAt: number;
}

export const FEEDBACK_VERDICTS = ["good", "bad", "note"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export interface AgentFeedback {
  readonly id: string;
  readonly agentId: string;
  readonly decisionId: string | null;
  readonly verdict: FeedbackVerdict;
  readonly note: string;
  readonly ownerAddress: `0x${string}`;
  readonly createdAt: number;
}

export interface ModelUsageDay {
  readonly agentId: string;
  readonly day: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Operator kill switch, readable without a redeploy. */
export const PLATFORM_AUTONOMY_PAUSED = "autonomy_paused";

export const RESERVED_USERNAMES = new Set([
  "agen",
  "admin",
  "support",
  "root",
  "api",
  "agent",
  "agents",
  "instant",
  "programmable",
  "launch",
  "markets",
  "market",
  "profile",
  "docs",
  "metrics",
  "health",
  "www",
  "app",
]);

export const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;
