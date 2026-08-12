/**
 * An agent's off-chain runtime configuration, and the gate that reads it.
 *
 * Nothing here is a financial permission. The chain holds those: the mandate bounds
 * spending, the lifecycle bounds execution, and the guardian can stop both. What this
 * file controls is *reasoning behaviour* — how often to think, how sure to be before
 * acting, and which of the runtime's actions are switched on at all.
 *
 * The distinction matters when something goes wrong. If this configuration were the
 * only thing standing between a confused model and the treasury, then a bad row in a
 * database would be a loss of funds. It is not: every check in this file is a *second*
 * refusal in front of a chain that would refuse anyway. Turning all of it off makes an
 * agent noisy and wasteful, not dangerous.
 *
 * They are still worth having, and worth being strict about, because the on-chain
 * refusals are expensive: they cost gas, they land in a public log, and they arrive
 * after the decision rather than before it.
 */

import type { Address, Hex } from "viem";

import { RUNTIME_ACTIONS, RuntimeAction } from "./intent.js";

/**
 * What a runtime is told to do, and how much rope it has.
 *
 * `agentId` is the on-chain id, so this row is meaningless without an agent and cannot
 * outlive one. Deliberately: a runtime config that could exist on its own would be a
 * place to accumulate agents that the registry has never heard of.
 */
export interface AgentRuntimeConfig {
  readonly agentId: Hex;

  /** Who may change this row. The agent's developer, as the registry records it. */
  readonly owner: Address;

  /**
   * What the agent is for, in the operator's words.
   *
   * Shown in the interface and passed to the model as data — never as instruction.
   * See `prompt.ts`: an objective is quoted inside a fence, because an objective is
   * editable through the API and an objective spliced into a system prompt would be a
   * way to rewrite the system prompt.
   */
  readonly objective: string;

  /** Extra operator guidance. Same treatment, same reason. */
  readonly systemInstructions: string;

  /** The master switch. False means no evaluation happens at all. */
  readonly enabled: boolean;

  /**
   * The operator's stop button, separate from `enabled`.
   *
   * Two flags rather than one because they are set by different people at different
   * times for different reasons, and collapsing them loses the distinction that
   * matters during an incident: `enabled` is a preference, `emergencyStopped` is an
   * assertion that something is wrong. Re-enabling after an incident should not be a
   * side effect of flipping a scheduling preference back on.
   */
  readonly emergencyStopped: boolean;

  /** Which provider to reason with, resolved by the service against its own registry. */
  readonly provider: string;
  /** The model name that provider understands. Opaque here. */
  readonly model: string;

  /** Seconds between evaluations. Floored by `MIN_EVALUATION_INTERVAL`. */
  readonly evaluationInterval: number;

  /** Refuse to act below this. 0..1. */
  readonly minConfidence: number;

  /**
   * Which actions this agent may take. A subset of what the runtime implements.
   *
   * `NO_ACTION` does not need to be listed and is always permitted: refusing an agent
   * permission to do nothing would leave a model that wants to abstain with no legal
   * answer, and "no legal answer" is how a constrained model is pushed into a bad one.
   */
  readonly allowedActions: readonly RuntimeAction[];

  /** How many value-moving actions may execute per `actionPeriod`. */
  readonly maxActionsPerPeriod: number;
  /** The window `maxActionsPerPeriod` is counted over, in seconds. */
  readonly actionPeriod: number;

  /**
   * The most the runtime's own wallet may spend on a launch's first buy, in wei.
   *
   * This is the compensating control for the one thing the chain does not bound. The
   * mandate bounds the treasury; it says nothing about the developer key's own
   * balance, and a launch's first buy is paid by the sender. So the ceiling lives
   * here, is compared against the plan before anything is signed, and is the reason
   * the launch wallet should be funded with what one launch costs rather than with a
   * float.
   */
  readonly maxLaunchSpendWei: bigint;

  /** Unix seconds. Null before the first run. */
  readonly lastRunAt: number | null;
  /** Unix seconds. When the scheduler may next pick this agent up. */
  readonly nextRunAt: number | null;

  /** Consecutive failures, for the backoff. Reset by any successful evaluation. */
  readonly consecutiveFailures: number;
}

/**
 * The floor on how often an agent may think.
 *
 * Not a rate limit for the model's sake — it is the thing that stops a
 * misconfiguration (`evaluationInterval: 0`) from becoming a spend loop, a bill, or a
 * self-inflicted denial of service against an RPC. Sixty seconds is short enough that
 * nobody needs to work around it and long enough that a runaway is visible before it
 * is expensive.
 */
export const MIN_EVALUATION_INTERVAL = 60;

/** Ceilings that exist so a typo cannot become an outage. */
export const CONFIG_BOUNDS = {
  objectiveMaxLength: 2_000,
  systemInstructionsMaxLength: 4_000,
  minEvaluationInterval: MIN_EVALUATION_INTERVAL,
  maxEvaluationInterval: 7 * 24 * 60 * 60,
  minActionPeriod: 60,
  maxActionPeriod: 30 * 24 * 60 * 60,
  maxActionsPerPeriodCeiling: 100,
} as const;

/**
 * The longest the backoff can push the next run out.
 *
 * The backoff doubles, so without a ceiling a handful of failures overnight would
 * schedule the next attempt after the heat death of the operator's patience. Capped at
 * an hour: long enough to stop hammering a broken provider, short enough that a fixed
 * problem is picked up while somebody is still watching.
 */
export const MAX_BACKOFF = 60 * 60;

/** How long after a failure to wait, before the interval is applied. */
export function backoffFor(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const doubled = MIN_EVALUATION_INTERVAL * 2 ** Math.min(consecutiveFailures - 1, 10);
  return Math.min(doubled, MAX_BACKOFF);
}

// --- validation -----------------------------------------------------------

export interface ConfigProblem {
  readonly field: string;
  readonly detail: string;
}

/**
 * Everything wrong with a config, rather than the first thing.
 *
 * A form is the caller here, and a form that reveals one problem per submission is a
 * form people fight with.
 */
export function validateRuntimeConfig(
  config: AgentRuntimeConfig,
): readonly ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const bounds = CONFIG_BOUNDS;

  if (config.objective.trim().length === 0) {
    problems.push({ field: "objective", detail: "an objective is required" });
  }
  if (config.objective.length > bounds.objectiveMaxLength) {
    problems.push({
      field: "objective",
      detail: `at most ${bounds.objectiveMaxLength} characters`,
    });
  }
  if (config.systemInstructions.length > bounds.systemInstructionsMaxLength) {
    problems.push({
      field: "systemInstructions",
      detail: `at most ${bounds.systemInstructionsMaxLength} characters`,
    });
  }

  if (
    !Number.isInteger(config.evaluationInterval) ||
    config.evaluationInterval < bounds.minEvaluationInterval ||
    config.evaluationInterval > bounds.maxEvaluationInterval
  ) {
    problems.push({
      field: "evaluationInterval",
      detail:
        `whole seconds between ${bounds.minEvaluationInterval} and ` +
        `${bounds.maxEvaluationInterval}`,
    });
  }

  if (
    !Number.isFinite(config.minConfidence) ||
    config.minConfidence < 0 ||
    config.minConfidence > 1
  ) {
    problems.push({ field: "minConfidence", detail: "a number in 0..1" });
  }

  for (const action of config.allowedActions) {
    if (!RUNTIME_ACTIONS.includes(action)) {
      problems.push({
        field: "allowedActions",
        detail: `${String(action)} is not an action this runtime performs`,
      });
    }
  }

  if (
    !Number.isInteger(config.maxActionsPerPeriod) ||
    config.maxActionsPerPeriod < 0 ||
    config.maxActionsPerPeriod > bounds.maxActionsPerPeriodCeiling
  ) {
    problems.push({
      field: "maxActionsPerPeriod",
      detail: `a whole number from 0 to ${bounds.maxActionsPerPeriodCeiling}`,
    });
  }

  if (
    !Number.isInteger(config.actionPeriod) ||
    config.actionPeriod < bounds.minActionPeriod ||
    config.actionPeriod > bounds.maxActionPeriod
  ) {
    problems.push({
      field: "actionPeriod",
      detail:
        `whole seconds between ${bounds.minActionPeriod} and ${bounds.maxActionPeriod}`,
    });
  }

  if (config.maxLaunchSpendWei < 0n) {
    problems.push({ field: "maxLaunchSpendWei", detail: "cannot be negative" });
  }

  return problems;
}

/**
 * A config with every switch in its most conservative position.
 *
 * Not "sensible defaults" — deliberately timid ones. An agent created by a caller that
 * forgot a field should be one that thinks rarely, demands high confidence and cannot
 * spend, because the alternative is that forgetting a field is how an agent becomes
 * more autonomous than anybody chose.
 */
export function defaultRuntimeConfig({
  agentId,
  owner,
  objective,
}: {
  readonly agentId: Hex;
  readonly owner: Address;
  readonly objective: string;
}): AgentRuntimeConfig {
  return {
    agentId,
    owner,
    objective,
    systemInstructions: "",
    enabled: false,
    emergencyStopped: false,
    provider: "rules",
    model: "market-scout-v0",
    evaluationInterval: 15 * 60,
    minConfidence: 0.75,
    allowedActions: [RuntimeAction.NoAction],
    maxActionsPerPeriod: 1,
    actionPeriod: 24 * 60 * 60,
    maxLaunchSpendWei: 0n,
    lastRunAt: null,
    nextRunAt: null,
    consecutiveFailures: 0,
  };
}
