/**
 * One autonomous cycle, start to finish.
 *
 * A cycle is: check that this agent is allowed to think at all, claim the right
 * to run, work out what it can afford, ask the planner, validate the answer,
 * record it, and — only in `autonomous` mode, and only after every Phase 1 rule
 * has agreed — carry it out.
 *
 * Nothing in this file starts a cycle by itself. A cycle happens when a caller
 * asks for one, and `scheduler.ts` is the caller that asks on a timer. Keeping
 * the loop out of here is what lets an owner's "run now", a test, and the
 * scheduler all take the same path: there is one way to run an agent, so there
 * is one place where the rules about running one live.
 *
 * The ordering below is deliberate and worth keeping. Cheap refusals come before
 * expensive ones, the lease is taken before any model spend, and the treasury and
 * permission checks happen before the planner rather than after — so an agent that
 * cannot afford to act does not pay a vendor to find that out.
 */

import { AgentError } from "./errors";
import { decisionPayload, validateDecision, type DecisionContext, type ValidatedDecision } from "./decision";
import { executeDecision, type ExecutionResult } from "./executor";
import { assertAgentOperable } from "./permissions";
import { defaultPlanner, type Planner } from "./planner";
import type { AgentStore } from "./store";
import { readTreasury } from "./treasury";
import type { AgentDecision, AgentRecord, AgentRun, DecisionStatus, RunTrigger } from "./types";
import { PLATFORM_AUTONOMY_PAUSED } from "./types";

export interface CycleOptions {
  readonly trigger: RunTrigger;
  readonly planner?: Planner;
  /** Injected in tests so a cycle can be exercised without a chain. */
  readonly readBalanceWei?: (agent: AgentRecord) => Promise<bigint>;
  readonly execute?: typeof executeDecision;
  readonly holder?: string;
}

export interface CycleReport {
  readonly run: AgentRun;
  readonly decision: AgentDecision | null;
  readonly executed: ExecutionResult | null;
  readonly note: string;
}

/**
 * Whether autonomy is switched off for the whole platform.
 *
 * Two independent switches, and both must be open. The environment variable is
 * for an operator who needs everything to stop before a database is reachable;
 * the stored control is for stopping it without a deploy. Neither can be
 * overridden by an agent, an owner, or a model.
 */
export function autonomyGloballyPaused(store: AgentStore): string | null {
  if (process.env["AGENT_AUTONOMY_DISABLED"] === "1") {
    return "Autonomous agents are switched off on this deployment.";
  }
  if (store.getControl(PLATFORM_AUTONOMY_PAUSED) === "1") {
    return "Autonomous agents are paused platform-wide.";
  }
  return null;
}

/** Six hours. Long enough that a broken agent costs almost nothing, short enough
 * that a fixed one comes back the same day without anyone touching it. */
const MAX_BACKOFF_SECONDS = 6 * 60 * 60;

/**
 * How long to wait after a cycle fails.
 *
 * One failure is ordinary — a flaky RPC, a model timeout — so the first retry
 * comes at the normal interval. A run of them usually means something the next
 * cycle will not fix either, so the wait doubles. The agent is never abandoned,
 * only slowed, and the thing being conserved is model spend.
 */
export function backoffSeconds(intervalSeconds: number, consecutiveFailures: number): number {
  const doublings = Math.min(Math.max(consecutiveFailures - 1, 0), 10);
  // The floor matters for agents whose own interval is already longer than the
  // cap: backing off must never schedule a failing agent sooner than a healthy one.
  return Math.max(intervalSeconds, Math.min(intervalSeconds * 2 ** doublings, MAX_BACKOFF_SECONDS));
}

export async function runAgentCycle(
  store: AgentStore,
  agent: AgentRecord,
  options: CycleOptions,
): Promise<CycleReport> {
  const now = Math.floor(Date.now() / 1000);

  // ---- Guards that need no lease. Refusing here leaves no run record, because
  // a cycle that was never allowed to begin is not a cycle that happened.

  const paused = autonomyGloballyPaused(store);
  if (paused !== null) throw new AgentError("AUTONOMY_GLOBALLY_PAUSED", paused);

  assertAgentOperable(agent);

  const autonomy = store.getAutonomy(agent.id);
  if (!autonomy.enabled) {
    throw new AgentError("AUTONOMY_DISABLED", "Autonomy is switched off for this agent.");
  }

  const mandate = store.getMandate(agent.id);
  if (mandate === null || mandate.text.trim() === "") {
    throw new AgentError(
      "MANDATE_MISSING",
      "This agent has no objective, so there is nothing for it to act on.",
    );
  }

  const policy = store.getPolicy(agent.id);
  const runsToday = store.countRunsSince(agent.id, now - 24 * 60 * 60);
  if (runsToday >= policy.maxRunsPerDay) {
    throw new AgentError(
      "RUN_BUDGET_EXHAUSTED",
      `This agent has used its ${String(policy.maxRunsPerDay)} cycles for the day.`,
      { limit: String(policy.maxRunsPerDay), requested: String(runsToday + 1) },
    );
  }

  // A worker is replaying a schedule slot and must not run one twice; an owner is
  // asking now, and "now" is its own slot. The UNIQUE key does the rest.
  const scheduledFor = options.trigger === "worker" ? (autonomy.nextRunAt ?? now) : now;

  const run = store.acquireRun({
    agentId: agent.id,
    scheduledFor,
    holder: options.holder ?? `${String(process.pid)}:${crypto.randomUUID().slice(0, 8)}`,
    mode: autonomy.mode,
    trigger: options.trigger,
  });

  store.recordActivity({
    agentId: agent.id,
    type: "run_started",
    payload: { runId: run.id, mode: autonomy.mode, trigger: options.trigger },
  });

  const nextRunAt = now + autonomy.intervalSeconds;
  let modelCalls = 0;

  try {
    // ---- What the agent can afford, before anyone is asked to think.

    const readBalance = options.readBalanceWei ?? defaultBalance;
    const balanceWei = await readBalance(agent);
    const permissions = store.getPermissions(agent.id);
    const allowance = store.allowance(agent.id, permissions);

    const aboveReserve =
      balanceWei > policy.treasuryReserveWei ? balanceWei - policy.treasuryReserveWei : 0n;
    const spendableWei = min(aboveReserve, allowance.spendRemainingWei);

    const context: DecisionContext = { store, agent, permissions, policy, spendableWei };

    // ---- Ask.

    const planner = options.planner ?? defaultPlanner();
    const planned = await planner.plan({
      store,
      agent,
      mandate,
      permissions,
      policy,
      spendableWei,
      launchesRemaining: allowance.launchesRemaining,
    });
    modelCalls = planned.modelCalls;

    const decision = validateDecision(planned.raw, context);

    // ---- Record before acting, always. A decision that is executed and then
    // lost to a crash is indistinguishable from one that never happened.

    const status = statusFor(autonomy.mode, decision);
    const record = store.insertDecision({
      runId: run.id,
      agentId: agent.id,
      kind: decision.kind,
      payload: decisionPayload(decision),
      rationale: decision.rationale,
      confidence: decision.confidence,
      status,
      mandateVersion: mandate.version,
    });

    store.recordActivity({
      agentId: agent.id,
      type: "decision_made",
      payload: { runId: run.id, decisionId: record.id, kind: decision.kind, status },
    });

    if (decision.kind === "no_action") {
      const finished = store.finishRun({
        agentId: agent.id,
        runId: run.id,
        status: "succeeded",
        outcome: "no_action",
        decisionId: record.id,
        modelCalls,
        nextRunAt,
      });
      return finish(store, agent, finished, record, null, "Nothing worth doing this cycle.");
    }

    if (status === "observed") {
      const finished = store.finishRun({
        agentId: agent.id,
        runId: run.id,
        status: "succeeded",
        outcome: "blocked",
        decisionId: record.id,
        modelCalls,
        nextRunAt,
      });
      return finish(
        store,
        agent,
        finished,
        record,
        null,
        "Observe mode: the decision was recorded and not carried out.",
      );
    }

    if (status === "proposed") {
      const finished = store.finishRun({
        agentId: agent.id,
        runId: run.id,
        status: "succeeded",
        outcome: "proposed",
        decisionId: record.id,
        modelCalls,
        nextRunAt,
      });
      return finish(store, agent, finished, record, null, "Waiting for the owner to approve.");
    }

    // ---- Autonomous. Everything below still has to get past Phase 1.

    const repetition = repetitionProblem(store, agent, policy.launchCooldownSeconds, decision, now);
    if (repetition !== null) {
      const blocked = store.updateDecision(record.id, {
        status: "rejected",
        decidedAt: now,
        error: repetition,
      });
      const finished = store.finishRun({
        agentId: agent.id,
        runId: run.id,
        status: "succeeded",
        outcome: "blocked",
        decisionId: record.id,
        modelCalls,
        nextRunAt,
      });
      return finish(store, agent, finished, blocked, null, repetition);
    }

    const execute = options.execute ?? executeDecision;
    const executed = await execute(store, agent, decision);

    const done = store.updateDecision(record.id, {
      status: "executed",
      decidedAt: now,
      executedAt: Math.floor(Date.now() / 1000),
      result: { summary: executed.summary, ...executed.detail },
    });

    store.recordActivity({
      agentId: agent.id,
      type: "decision_executed",
      payload: { runId: run.id, decisionId: record.id, kind: decision.kind, summary: executed.summary },
    });

    const finished = store.finishRun({
      agentId: agent.id,
      runId: run.id,
      status: "succeeded",
      outcome: "executed",
      decisionId: record.id,
      modelCalls,
      nextRunAt,
    });
    return finish(store, agent, finished, done, executed, executed.summary);
  } catch (error) {
    // A cycle that fails is a cycle that ends. There is no retry ladder: the
    // failure is recorded, the schedule still advances, and the next cycle gets
    // to decide again with fresher information. Retrying a launch that may or may
    // not have reached the chain is the one thing worth never doing automatically.
    const message = error instanceof Error ? error.message : String(error);
    const finished = store.finishRun({
      agentId: agent.id,
      runId: run.id,
      status: "failed",
      outcome: "error",
      modelCalls,
      error: message,
      nextRunAt: now + backoffSeconds(autonomy.intervalSeconds, store.consecutiveFailures(agent.id) + 1),
    });
    store.recordActivity({
      agentId: agent.id,
      type: "run_finished",
      payload: { runId: run.id, outcome: "error", message },
    });
    throw error instanceof AgentError
      ? error
      : new AgentError("VALIDATION_FAILED", message, { details: { runId: finished.id } });
  }
}

function finish(
  store: AgentStore,
  agent: AgentRecord,
  run: AgentRun,
  decision: AgentDecision,
  executed: ExecutionResult | null,
  note: string,
): CycleReport {
  store.recordActivity({
    agentId: agent.id,
    type: "run_finished",
    payload: { runId: run.id, outcome: run.outcome, note },
  });
  return { run, decision, executed, note };
}

function statusFor(mode: string, decision: ValidatedDecision): DecisionStatus {
  if (decision.kind === "no_action") return "observed";
  if (mode === "observe") return "observed";
  if (mode === "approve") return "proposed";
  return "approved";
}

/**
 * Stops an agent turning one good idea into twenty identical markets.
 *
 * The daily launch cap already bounds the damage; this bounds the embarrassment.
 * A model asked the same question every cycle with the same state will tend to
 * give the same answer, and without this the correct-looking behaviour is a run
 * of near-duplicate tokens.
 */
function repetitionProblem(
  store: AgentStore,
  agent: AgentRecord,
  cooldownSeconds: number,
  decision: ValidatedDecision,
  now: number,
): string | null {
  if (decision.kind !== "instant_launch") return null;

  const launches = store.listLaunches(agent.id);
  const recent = launches.filter((launch) => launch.status !== "failed");

  const last = recent[0];
  if (last !== undefined && now - last.createdAt < cooldownSeconds) {
    const wait = cooldownSeconds - (now - last.createdAt);
    return `This agent created a market ${String(now - last.createdAt)}s ago and waits ${String(wait)}s more.`;
  }

  const symbol = decision.symbol.toUpperCase();
  const name = normalise(decision.name);
  const clash = recent.find(
    (launch) =>
      (launch.symbol ?? "").toUpperCase() === symbol || normalise(launch.name ?? "") === name,
  );
  if (clash !== undefined) {
    return `This agent has already created a market called ${clash.name ?? symbol}.`;
  }

  return null;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function defaultBalance(agent: AgentRecord): Promise<bigint> {
  const treasury = await readTreasury(agent);
  return BigInt(treasury.ethWei);
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
