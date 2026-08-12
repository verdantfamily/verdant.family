/**
 * What a run leaves behind.
 *
 * An autonomous system that cannot account for itself is not autonomous, it is
 * unsupervised. Every evaluation writes a run; every run that produced a decision
 * writes one; every decision that reached a chain writes an execution. Refusals are
 * recorded as loudly as successes, because "the runtime declined to act 400 times last
 * night" is the sentence an operator most needs to be able to read.
 *
 * ## What is deliberately not stored
 *
 * The model's chain of thought. Not truncated, not encrypted — not requested. Storing
 * it would mean a database full of an intermediate artefact that is frequently wrong in
 * ways the conclusion is not, that reads as authoritative to anyone who finds it, and
 * that would end up on a public agent page the first time somebody built one. What is
 * kept is the one-sentence summary the intent carried, which the model wrote knowing it
 * was public.
 *
 * The prompt is also not stored, only its hash. That is enough to prove two runs saw
 * the same world, or to prove one did not, without keeping a copy of every market
 * description ever fed to a model.
 */

import type { Address, Hex } from "viem";

import type { RuntimeAction } from "./intent.js";

/** How a run ended. One of these, always, including when nothing happened. */
export const RunStatus = {
  /** The model chose to do nothing. A successful run. */
  NoAction: "NO_ACTION",
  /** A gate refused: config, chain state, rate limit, confidence, schema. */
  Rejected: "REJECTED",
  /** The transaction was simulated and would revert. Nothing was sent. */
  SimulationFailed: "SIMULATION_FAILED",
  /** Broadcast, not yet confirmed. */
  Submitted: "SUBMITTED",
  /** Mined, status 1. */
  Confirmed: "CONFIRMED",
  /** Mined, status 0. Money spent, nothing achieved. */
  Reverted: "REVERTED",
  /** The runtime itself failed: provider down, RPC unreachable, a bug. */
  RuntimeError: "RUNTIME_ERROR",
  /** The scheduler declined to evaluate at all — disabled, stopped, too soon. */
  Skipped: "SKIPPED",
} as const;

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/**
 * Which statuses mean a value-moving action actually happened.
 *
 * Used by the rate limiter, and the membership is chosen carefully: a submitted
 * transaction counts even before it confirms, because a limiter that only counted
 * confirmations would let a stuck transaction be followed by another, and another.
 * A revert counts too — it spent gas and it hit the chain.
 */
export const ACTED: readonly RunStatus[] = [
  RunStatus.Submitted,
  RunStatus.Confirmed,
  RunStatus.Reverted,
];

export function counted(status: RunStatus): boolean {
  return ACTED.includes(status);
}

/** One evaluation, from the scheduler picking the agent up to the outcome. */
export interface AgentRun {
  readonly id: string;
  readonly agentId: Hex;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly status: RunStatus;
  /** The objective as it read when this run began, so a later edit cannot rewrite history. */
  readonly objectiveSnapshot: string;
  /** Hash of the rendered prompt. Proves what the model saw without storing it. */
  readonly contextHash: Hex;
  /** The provider and model actually used. */
  readonly provider: string;
  readonly model: string;
  /** Why it ended this way, in one line. Enumerated reason plus detail. */
  readonly reason: string | null;
}

/** What the model asked for, once it had passed schema validation. */
export interface AgentDecision {
  readonly id: string;
  readonly runId: string;
  readonly action: RuntimeAction;
  /**
   * The intent's own parameters, as JSON.
   *
   * Recorded because a rejected decision is only diagnosable if you can see what was
   * asked for. Not read back to build anything — the transaction is built from the
   * plan, and by the time this row exists the parameters have already been checked
   * against it.
   */
  readonly parameters: string;
  readonly reasoningSummary: string;
  readonly confidence: number;
}

/** What was sent, or why it was not. */
export interface AgentExecution {
  readonly id: string;
  readonly decisionId: string;
  readonly status: RunStatus;
  readonly txHash: Hex | null;
  /** The enumerated refusal or revert reason. Stable enough to alert on. */
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly submittedAt: number | null;
  readonly confirmedAt: number | null;
  /** Which wallet signed. Never a key, and never a key's derivation. */
  readonly signer: Address | null;
  /** What it sent, in wei. */
  readonly value: bigint;
}

/**
 * The whole outcome of one `runAgent` call.
 *
 * Returned rather than written, so the library stays free of storage. The service
 * persists it; the tests read it.
 */
export interface RunOutcome {
  readonly run: AgentRun;
  readonly decision: AgentDecision | null;
  readonly execution: AgentExecution | null;
}
