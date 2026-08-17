/**
 * The owner's controls over an autonomous agent.
 *
 * Everything here is owner-authenticated. None of it is reachable with an agent
 * API key, and none of it is reachable by the agent itself: an agent cannot write
 * its own objective, widen its own policy, turn itself on, or approve its own
 * proposals. That separation is the whole shape of the feature — the mandate is
 * something done *to* the agent, and the agent is the one thing that must not be
 * able to edit it.
 *
 * Hard permissions are not represented here at all, on purpose. A mandate is a
 * sentence about intent; `permissions.ts` is the set of rules that hold whatever
 * the sentence says. Nothing an owner writes in a mandate can widen a permission,
 * because the mandate is never consulted when a permission is checked.
 */

import { getAddress, parseEther, type Address } from "viem";

import { decisionFromPayload, type DecisionContext } from "./decision";
import { AgentError } from "./errors";
import { executeDecision, type ExecutionResult } from "./executor";
import { assertAgentOperable, instantLaunchBlocker } from "./permissions";
import { owned } from "./service";
import { agentStore, type AgentStore } from "./store";
import { readTreasury } from "./treasury";
import { autonomyGloballyPaused } from "./runner";
import type {
  AgentAutonomy,
  AgentDecision,
  AgentFeedback,
  AgentMandate,
  AgentPolicy,
  AgentRecord,
  ExecutionMode,
  FeedbackVerdict,
  RevenuePolicy,
} from "./types";
import {
  AUTONOMY_MAX_INTERVAL_SECONDS,
  AUTONOMY_MIN_INTERVAL_SECONDS,
  EXECUTION_MODES,
  FEEDBACK_VERDICTS,
  MANDATE_MAX_LENGTH,
  REVENUE_POLICIES,
} from "./types";

/* ------------------------------------------------------------------ *
 * Mandate.
 * ------------------------------------------------------------------ */

export function parseMandate(input: unknown): string {
  if (typeof input !== "string") {
    throw new AgentError("VALIDATION_FAILED", "An objective is a piece of writing.");
  }
  const text = input.trim();
  if (text.length < 20) {
    throw new AgentError(
      "VALIDATION_FAILED",
      "An objective needs to say enough to act on — at least a sentence.",
    );
  }
  if (text.length > MANDATE_MAX_LENGTH) {
    throw new AgentError(
      "VALIDATION_FAILED",
      `An objective must be under ${String(MANDATE_MAX_LENGTH)} characters.`,
    );
  }
  return text;
}

export function setAgentMandate(
  owner: Address,
  agentId: string,
  input: unknown,
  store: AgentStore = agentStore(),
): AgentMandate {
  const agent = owned(store, owner, agentId);
  const text = parseMandate(input);
  const mandate = store.setMandate(agent.id, text, getAddress(owner));

  store.recordActivity({
    agentId: agent.id,
    type: "mandate_updated",
    payload: { version: mandate.version, length: text.length },
  });

  return mandate;
}

/* ------------------------------------------------------------------ *
 * The switch and the schedule.
 * ------------------------------------------------------------------ */

export function setAgentAutonomy(
  owner: Address,
  agentId: string,
  input: Record<string, unknown>,
  store: AgentStore = agentStore(),
): AgentAutonomy {
  const agent = owned(store, owner, agentId);
  const current = store.getAutonomy(agent.id);

  const patch: { enabled?: boolean; mode?: ExecutionMode; intervalSeconds?: number; nextRunAt?: number } = {};

  if (input.mode !== undefined) {
    const mode = String(input.mode);
    if (!(EXECUTION_MODES as readonly string[]).includes(mode)) {
      throw new AgentError("VALIDATION_FAILED", `"${mode}" is not an execution mode.`, {
        details: { modes: EXECUTION_MODES },
      });
    }
    patch.mode = mode as ExecutionMode;
  }

  if (input.intervalSeconds !== undefined) {
    const seconds = Number(input.intervalSeconds);
    if (
      !Number.isFinite(seconds) ||
      seconds < AUTONOMY_MIN_INTERVAL_SECONDS ||
      seconds > AUTONOMY_MAX_INTERVAL_SECONDS
    ) {
      throw new AgentError(
        "VALIDATION_FAILED",
        `A cycle runs no more often than every ${String(AUTONOMY_MIN_INTERVAL_SECONDS / 60)} minutes.`,
        { limit: String(AUTONOMY_MIN_INTERVAL_SECONDS) },
      );
    }
    patch.intervalSeconds = Math.floor(seconds);
  }

  if (input.enabled !== undefined) {
    const enabled = input.enabled === true;

    // Turning it on is the moment the objective stops being a note to yourself.
    if (enabled && (store.getMandate(agent.id)?.text.trim() ?? "") === "") {
      throw new AgentError(
        "MANDATE_MISSING",
        "Give this agent an objective before switching it on.",
      );
    }
    if (enabled) assertAgentOperable(agent);

    patch.enabled = enabled;
    patch.nextRunAt = enabled
      ? Math.floor(Date.now() / 1000) + (patch.intervalSeconds ?? current.intervalSeconds)
      : 0;
  }

  const next = store.setAutonomy(agent.id, {
    ...patch,
    ...(patch.nextRunAt === 0 ? { nextRunAt: null } : {}),
  });

  if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
    store.recordActivity({
      agentId: agent.id,
      type: patch.enabled ? "autonomy_enabled" : "autonomy_disabled",
      payload: { mode: next.mode, intervalSeconds: next.intervalSeconds },
    });
  }
  if (patch.mode !== undefined && patch.mode !== current.mode) {
    store.recordActivity({
      agentId: agent.id,
      type: "autonomy_mode_changed",
      payload: { from: current.mode, to: patch.mode },
    });
  }

  return next;
}

/* ------------------------------------------------------------------ *
 * Economic policy.
 * ------------------------------------------------------------------ */

export function setAgentPolicy(
  owner: Address,
  agentId: string,
  input: Record<string, unknown>,
  store: AgentStore = agentStore(),
): AgentPolicy {
  const agent = owned(store, owner, agentId);
  const patch: { -readonly [K in keyof Omit<AgentPolicy, "agentId" | "updatedAt">]?: AgentPolicy[K] } = {};

  if (input.treasuryReserveEth !== undefined) {
    patch.treasuryReserveWei = parseEth(input.treasuryReserveEth, "treasuryReserveEth");
  }

  if (input.revenuePolicy !== undefined) {
    const value = String(input.revenuePolicy);
    if (!(REVENUE_POLICIES as readonly string[]).includes(value)) {
      throw new AgentError("VALIDATION_FAILED", `"${value}" is not a revenue policy.`);
    }
    // Reinvestment needs a swap path the agent layer does not have. Rather than
    // accept a setting that would quietly behave as `claim`, it is refused until
    // the path exists and has been reviewed on its own terms.
    if (value === "claim_and_reinvest") {
      throw new AgentError(
        "VALIDATION_FAILED",
        "Reinvesting revenue is not available yet. An agent can hold or claim.",
      );
    }
    patch.revenuePolicy = value as RevenuePolicy;
  }

  if (input.boostAllowed !== undefined) patch.boostAllowed = input.boostAllowed === true;

  if (input.maxRunsPerDay !== undefined) {
    patch.maxRunsPerDay = boundedInt(input.maxRunsPerDay, 1, 48, "maxRunsPerDay");
  }
  if (input.maxModelCallsPerDay !== undefined) {
    patch.maxModelCallsPerDay = boundedInt(input.maxModelCallsPerDay, 1, 200, "maxModelCallsPerDay");
  }
  if (input.launchCooldownSeconds !== undefined) {
    patch.launchCooldownSeconds = boundedInt(input.launchCooldownSeconds, 0, 7 * 24 * 60 * 60, "launchCooldownSeconds");
  }

  const next = store.setPolicy(agent.id, patch);
  store.recordActivity({
    agentId: agent.id,
    type: "policy_updated",
    payload: { fields: Object.keys(patch) },
  });
  return next;
}

/* ------------------------------------------------------------------ *
 * Approvals.
 * ------------------------------------------------------------------ */

export interface ApprovalResult {
  readonly decision: AgentDecision;
  readonly executed: ExecutionResult | null;
}

/**
 * Carry out something the agent proposed.
 *
 * The stored payload is re-validated rather than replayed. An approval can arrive
 * hours after the cycle that proposed it, and in that time the agent may have
 * spent its budget, lost a permission, or already launched the market in
 * question. Re-validating means the approval is checked against the world as it
 * is now, not as it was when the model was asked.
 */
export async function approveDecision(
  owner: Address,
  agentId: string,
  decisionId: string,
  store: AgentStore = agentStore(),
  options: {
    readonly execute?: typeof executeDecision;
    readonly readBalanceWei?: (agent: AgentRecord) => Promise<bigint>;
  } = {},
): Promise<ApprovalResult> {
  const agent = owned(store, owner, agentId);

  const paused = autonomyGloballyPaused(store);
  if (paused !== null) throw new AgentError("AUTONOMY_GLOBALLY_PAUSED", paused);
  assertAgentOperable(agent);

  const record = store.getDecision(decisionId);
  if (record === null || record.agentId !== agent.id) {
    throw new AgentError("DECISION_NOT_FOUND", "There is no such proposal for this agent.");
  }
  if (record.status !== "proposed") {
    throw new AgentError(
      "DECISION_NOT_PENDING",
      `That proposal is already ${record.status}.`,
      { details: { status: record.status } },
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const permissions = store.getPermissions(agent.id);
  const policy = store.getPolicy(agent.id);
  const allowance = store.allowance(agent.id, permissions);
  const readBalance =
    options.readBalanceWei ?? (async (record: AgentRecord) => BigInt((await readTreasury(record)).ethWei));
  const balanceWei = await readBalance(agent);
  const aboveReserve = balanceWei > policy.treasuryReserveWei ? balanceWei - policy.treasuryReserveWei : 0n;
  const spendableWei =
    aboveReserve < allowance.spendRemainingWei ? aboveReserve : allowance.spendRemainingWei;

  const context: DecisionContext = { store, agent, permissions, policy, spendableWei };

  try {
    const decision = decisionFromPayload(
      record.kind,
      record.payload,
      record.rationale,
      record.confidence,
      context,
    );

    const execute = options.execute ?? executeDecision;
    const executed = await execute(store, agent, decision);
    const done = store.updateDecision(record.id, {
      status: "executed",
      decidedAt: now,
      decidedBy: getAddress(owner),
      executedAt: Math.floor(Date.now() / 1000),
      result: { summary: executed.summary, ...executed.detail },
    });

    store.recordActivity({
      agentId: agent.id,
      type: "decision_approved",
      payload: { decisionId: record.id, kind: record.kind, summary: executed.summary },
    });

    return { decision: done, executed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = store.updateDecision(record.id, {
      status: "failed",
      decidedAt: now,
      decidedBy: getAddress(owner),
      error: message,
    });
    store.recordActivity({
      agentId: agent.id,
      type: "decision_failed",
      payload: { decisionId: record.id, kind: record.kind, message },
    });
    void failed;
    throw error;
  }
}

export function rejectDecision(
  owner: Address,
  agentId: string,
  decisionId: string,
  note: unknown,
  store: AgentStore = agentStore(),
): AgentDecision {
  const agent = owned(store, owner, agentId);
  const record = store.getDecision(decisionId);
  if (record === null || record.agentId !== agent.id) {
    throw new AgentError("DECISION_NOT_FOUND", "There is no such proposal for this agent.");
  }
  if (record.status !== "proposed") {
    throw new AgentError("DECISION_NOT_PENDING", `That proposal is already ${record.status}.`);
  }

  const text = typeof note === "string" ? note.trim().slice(0, 1_000) : "";
  const rejected = store.updateDecision(record.id, {
    status: "rejected",
    decidedAt: Math.floor(Date.now() / 1000),
    decidedBy: getAddress(owner),
    error: text === "" ? "The owner declined this proposal." : text,
  });

  store.recordActivity({
    agentId: agent.id,
    type: "decision_rejected",
    payload: { decisionId: record.id, kind: record.kind },
  });

  // A rejection with a reason is the most useful thing an owner ever writes, so
  // it is kept where a future planner will look rather than only in the log.
  if (text !== "") {
    store.insertFeedback({
      agentId: agent.id,
      decisionId: record.id,
      verdict: "bad",
      note: text,
      ownerAddress: getAddress(owner),
    });
  }

  return rejected;
}

/* ------------------------------------------------------------------ *
 * Feedback.
 * ------------------------------------------------------------------ */

export function recordOwnerFeedback(
  owner: Address,
  agentId: string,
  input: Record<string, unknown>,
  store: AgentStore = agentStore(),
): AgentFeedback {
  const agent = owned(store, owner, agentId);

  const verdict = String(input.verdict ?? "note");
  if (!(FEEDBACK_VERDICTS as readonly string[]).includes(verdict)) {
    throw new AgentError("VALIDATION_FAILED", `"${verdict}" is not a verdict.`);
  }

  const note = typeof input.note === "string" ? input.note.trim().slice(0, 1_000) : "";
  if (note === "") throw new AgentError("VALIDATION_FAILED", "Feedback needs something written in it.");

  let decisionId: string | null = null;
  if (typeof input.decisionId === "string" && input.decisionId !== "") {
    const record = store.getDecision(input.decisionId);
    if (record === null || record.agentId !== agent.id) {
      throw new AgentError("DECISION_NOT_FOUND", "There is no such decision for this agent.");
    }
    decisionId = record.id;
  }

  const feedback = store.insertFeedback({
    agentId: agent.id,
    decisionId,
    verdict: verdict as FeedbackVerdict,
    note,
    ownerAddress: getAddress(owner),
  });

  store.recordActivity({
    agentId: agent.id,
    type: "owner_feedback",
    payload: { feedbackId: feedback.id, verdict, decisionId },
  });

  return feedback;
}

/* ------------------------------------------------------------------ *
 * Read model.
 * ------------------------------------------------------------------ */

export interface AutonomyView {
  readonly enabled: boolean;
  readonly mode: ExecutionMode;
  readonly intervalSeconds: number;
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly running: boolean;
  readonly globallyPaused: boolean;
  readonly mandate: { readonly text: string; readonly version: number; readonly updatedAt: number } | null;
  readonly policy: Record<string, unknown>;
  readonly lastDecision: Record<string, unknown> | null;
  readonly pending: readonly Record<string, unknown>[];
  readonly modelCallsToday: number;
  /**
   * Things stopping this agent acting, that permissions and the mandate do not
   * explain. Empty for a healthy agent. Without this an owner watching an agent
   * decide "no action" forever has no way to find out that it simply has no
   * picture, because nothing failed — the action was never offered.
   */
  readonly blockers: readonly string[];
}

export function autonomyView(store: AgentStore, agentId: string): AutonomyView {
  const autonomy = store.getAutonomy(agentId);
  const policy = store.getPolicy(agentId);
  const mandate = store.getMandate(agentId);
  const last = store.lastDecision(agentId);
  const now = Math.floor(Date.now() / 1000);

  const agent = store.getAgent(agentId);
  const permissions = store.getPermissions(agentId);
  const launchBlocker = agent === null ? null : instantLaunchBlocker(agent);
  const blockers =
    permissions.instantAllowed && launchBlocker !== null ? [launchBlocker] : [];

  return {
    enabled: autonomy.enabled,
    mode: autonomy.mode,
    intervalSeconds: autonomy.intervalSeconds,
    nextRunAt: autonomy.nextRunAt,
    lastRunAt: autonomy.lastRunAt,
    running: autonomy.leaseExpiresAt !== null && autonomy.leaseExpiresAt > now,
    globallyPaused: autonomyGloballyPaused(store) !== null,
    mandate:
      mandate === null
        ? null
        : { text: mandate.text, version: mandate.version, updatedAt: mandate.updatedAt },
    policy: {
      treasuryReserveWei: policy.treasuryReserveWei.toString(),
      revenuePolicy: policy.revenuePolicy,
      boostAllowed: policy.boostAllowed,
      maxRunsPerDay: policy.maxRunsPerDay,
      maxModelCallsPerDay: policy.maxModelCallsPerDay,
      launchCooldownSeconds: policy.launchCooldownSeconds,
    },
    lastDecision: last === null ? null : publicDecision(last),
    pending: store.listPendingDecisions(agentId).map(publicDecision),
    modelCallsToday: store.modelUsage(agentId).calls,
    blockers,
  };
}

export function publicDecision(decision: AgentDecision): Record<string, unknown> {
  return {
    id: decision.id,
    kind: decision.kind,
    status: decision.status,
    rationale: decision.rationale,
    confidence: decision.confidence,
    payload: decision.payload,
    createdAt: decision.createdAt,
    executedAt: decision.executedAt,
    result: decision.result,
    error: decision.error,
  };
}

function parseEth(value: unknown, field: string): bigint {
  const text = typeof value === "number" ? value.toString() : String(value ?? "").trim();
  try {
    const wei = parseEther(text as `${number}`);
    if (wei < 0n) throw new Error("negative");
    return wei;
  } catch {
    throw new AgentError("VALIDATION_FAILED", `${field} must be an amount of ETH.`);
  }
}

function boundedInt(value: unknown, low: number, high: number, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < low || parsed > high) {
    throw new AgentError(
      "VALIDATION_FAILED",
      `${field} must be between ${String(low)} and ${String(high)}.`,
      { limit: `${String(low)}..${String(high)}` },
    );
  }
  return Math.floor(parsed);
}
