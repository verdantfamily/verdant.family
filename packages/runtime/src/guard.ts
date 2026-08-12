/**
 * Whether an agent may act, whether it may act *now*, and whether it may act *still*.
 *
 * Three questions, and the third is the one that gets forgotten. Between a model
 * deciding to launch and a transaction being mined, a guardian can revoke the agent, a
 * developer can transfer nothing but a database row can change, an executor can
 * expire, and a market can be bound by somebody else. A runtime that checked its
 * permissions once, at the top of the run, would be acting on a snapshot of a world
 * that has moved.
 *
 * So the chain view is read twice: once before reasoning, to decide whether to spend a
 * model call at all, and once immediately before signing, against the same rules. The
 * second read is not a formality — `assertStillPermitted` exists precisely to catch a
 * revocation that landed while the model was thinking, and its tests stage exactly
 * that.
 *
 * None of this is the security boundary. The contracts are: a revoked agent's
 * execution module refuses, a bound market cannot be rebound, and a commitment
 * mismatch reverts. What this file buys is that the refusal happens before a
 * transaction is signed, which makes it free, private and legible instead of costly,
 * public and cryptic.
 */

import type { Address, Hex } from "viem";
import { agents } from "@verdant/sdk";

import type { AgentRuntimeConfig } from "./config.js";
import { RuntimeAction } from "./intent.js";

/**
 * Which credential an action needs.
 *
 * Enumerated because the answer is surprising and load-bearing. Under these contracts
 * the mandate-bounded operator key can do exactly one thing — pay for a service — and
 * it is not one of V0's actions. Launching needs the developer key, and moving revenue
 * needs no authority at all.
 *
 * Naming that explicitly, per action, is what stops a later action being added with a
 * quiet assumption that "the runtime's key" is one key with one set of powers.
 */
export const Credential = {
  /**
   * The developer key. Can launch the committed market, bind it, activate, repoint
   * metadata and manage services. Cannot move treasury funds, change the mandate, or
   * pause, resume or revoke — verified against the three developer-gated functions in
   * the agent layer, not taken from documentation.
   */
  Developer: "developer",
  /** The mandate's operator. Can propose a `payService` quote and nothing else. */
  Operator: "operator",
  /** Anybody. The call is permissionless and its destination is immutable. */
  None: "none",
} as const;

export type Credential = (typeof Credential)[keyof typeof Credential];

export const CREDENTIAL_FOR: Readonly<Record<RuntimeAction, Credential>> = {
  [RuntimeAction.LaunchMarket]: Credential.Developer,
  // Permissionless on chain, and the split is immutable, so possessing this key grants
  // no discretion: it decides when the money moves, never where.
  [RuntimeAction.ClaimRevenue]: Credential.None,
  [RuntimeAction.NoAction]: Credential.None,
};

/**
 * What the chain says right now.
 *
 * A plain snapshot rather than a client, so that every rule below is a pure function of
 * data and can be tested without a node. The service reads it; this file judges it.
 */
export interface ChainView {
  /** When this view was read, in unix seconds, from the chain's own clock. */
  readonly at: number;
  readonly agentId: Hex;
  readonly developer: Address;
  readonly guardian: Address;
  readonly router: Address;
  readonly state: agents.lifecycle.AgentState;
  /** The bound market, or the zero hash while the agent is still `Created`. */
  readonly poolId: Hex;
  /**
   * `expectation.token`: the market this agent is committed to, from the registry.
   *
   * Carried in the view rather than looked up where it is needed, so that the token a
   * decision is checked against comes from the same read as the lifecycle state it was
   * checked with. Two reads could disagree; one cannot.
   */
  readonly expectedToken: Address;
  readonly mandateRevoked: boolean;
  readonly treasuryPaused: boolean;
  /** The mandate's operator, and when its authority lapses. */
  readonly operator: Address;
  /** Unix seconds. The mandate stops being usable at this instant. */
  readonly mandateExpiry: number;
}

export const GuardRefusal = {
  RuntimeDisabled: "RUNTIME_DISABLED",
  EmergencyStopped: "EMERGENCY_STOPPED",
  /** Called before the configured interval had elapsed. */
  TooSoon: "TOO_SOON",
  /** The action is not in this config's allow-list. */
  ActionNotAllowed: "ACTION_NOT_ALLOWED",
  /** Below the configured floor. */
  ConfidenceTooLow: "CONFIDENCE_TOO_LOW",
  /** This period's action budget is spent. */
  RateLimited: "RATE_LIMITED",

  /** The guardian has stopped the agent. */
  AgentPaused: "AGENT_PAUSED",
  /** Terminal. Nothing will execute again. */
  AgentRevoked: "AGENT_REVOKED",
  /** The mandate has been pulled. Treated as a stop signal for everything. */
  MandateRevoked: "MANDATE_REVOKED",
  /** The mandate's authority has lapsed. */
  ExecutorExpired: "EXECUTOR_EXPIRED",
  /** The treasury is stopped. */
  TreasuryPaused: "TREASURY_PAUSED",

  /** The wallet the runtime holds is not the one this action needs. */
  ExecutorNotAuthorised: "EXECUTOR_NOT_AUTHORISED",
  /** The agent's lifecycle state does not admit this action. */
  WrongLifecycleState: "WRONG_LIFECYCLE_STATE",
  /** A market is already bound. Launching is once and terminal. */
  MarketAlreadyBound: "MARKET_ALREADY_BOUND",
  /** Claiming revenue for an agent that has no market to earn from. */
  NoMarket: "NO_MARKET",
  /** The launch would spend more of the runtime's own funds than the cap allows. */
  LaunchBudgetExceeded: "LAUNCH_BUDGET_EXCEEDED",
  /** The wallet cannot pay for what it is about to send. */
  InsufficientExecutorBalance: "INSUFFICIENT_EXECUTOR_BALANCE",
} as const;

export type GuardRefusal = (typeof GuardRefusal)[keyof typeof GuardRefusal];

export type GuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: GuardRefusal; readonly detail: string };

const OK: GuardResult = { ok: true };

function deny(refusal: GuardRefusal, detail: string): GuardResult {
  return { ok: false, refusal, detail };
}

const ZERO_POOL = `0x${"0".repeat(64)}` as Hex;

function same(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

// --- before reasoning -----------------------------------------------------

/**
 * Whether to spend a model call on this agent at all.
 *
 * Cheap refusals before expensive ones, and every refusal here saves a token bill and
 * an RPC round trip. The order is deliberate: the operator's own switches come first,
 * because "we turned it off" should never be reported as "the chain refused".
 */
export function mayEvaluate({
  config,
  chain,
  now,
}: {
  readonly config: AgentRuntimeConfig;
  readonly chain: ChainView;
  readonly now: number;
}): GuardResult {
  if (config.emergencyStopped) {
    return deny(
      GuardRefusal.EmergencyStopped,
      "the operator has stopped this runtime; clear the stop to resume",
    );
  }

  if (!config.enabled) {
    return deny(GuardRefusal.RuntimeDisabled, "the runtime is disabled for this agent");
  }

  if (config.nextRunAt !== null && now < config.nextRunAt) {
    return deny(
      GuardRefusal.TooSoon,
      `the next evaluation is due at ${config.nextRunAt}, and it is ${now}`,
    );
  }

  return chainPermitsAnything(chain);
}

/**
 * The chain-side conditions that stop every action, whatever it is.
 *
 * Pause and revocation are on-chain statements that a human wants this agent to stop.
 * Neither of them actually blocks `claimMarketFees`, which is permissionless — but a
 * runtime that kept transacting on behalf of an agent its guardian had just paused
 * would be technically correct and obviously wrong. The stop button means stop.
 */
function chainPermitsAnything(chain: ChainView): GuardResult {
  const { AgentState } = agents.lifecycle;

  if (chain.state === AgentState.Revoked) {
    return deny(GuardRefusal.AgentRevoked, "the agent has been revoked; this is terminal");
  }
  if (chain.state === AgentState.Paused) {
    return deny(GuardRefusal.AgentPaused, "the guardian has paused the agent");
  }
  if (chain.mandateRevoked) {
    return deny(GuardRefusal.MandateRevoked, "the mandate has been revoked");
  }
  if (chain.treasuryPaused) {
    return deny(GuardRefusal.TreasuryPaused, "the treasury is paused");
  }

  // Zero means no expiry was set, which the mandate treats as "does not lapse". Reading
  // it as "expired at the epoch" would stop every agent whose developer left the field
  // alone — a config default becoming a shutdown.
  if (chain.mandateExpiry !== 0 && chain.at >= chain.mandateExpiry) {
    return deny(
      GuardRefusal.ExecutorExpired,
      `the mandate's authority lapsed at ${chain.mandateExpiry}, and the chain is at ${chain.at}`,
    );
  }

  return OK;
}

// --- after an intent ------------------------------------------------------

/** How many value-moving actions this agent has executed inside the window. */
export interface ActionBudget {
  /** Executions counted in the last `actionPeriod` seconds. */
  readonly usedInPeriod: number;
}

/**
 * Whether the decided action may proceed, given the config.
 *
 * Split from the chain checks so that "you did not allow this" and "the chain will not
 * have it" are different records. Both are refusals; only one of them is a
 * configuration change away from succeeding, and an operator reading a log needs to
 * know which.
 */
export function mayAct({
  action,
  confidence,
  config,
  budget,
}: {
  readonly action: RuntimeAction;
  readonly confidence: number;
  readonly config: AgentRuntimeConfig;
  readonly budget: ActionBudget;
}): GuardResult {
  // Doing nothing is always in budget, always allowed, and never rate limited. It costs
  // nothing and moves nothing, and gating it would leave an abstaining model with no
  // legal answer.
  if (action === RuntimeAction.NoAction) return OK;

  if (!config.allowedActions.includes(action)) {
    return deny(
      GuardRefusal.ActionNotAllowed,
      `${action} is not enabled for this agent`,
    );
  }

  if (confidence < config.minConfidence) {
    return deny(
      GuardRefusal.ConfidenceTooLow,
      `confidence ${confidence} is below the configured floor of ${config.minConfidence}`,
    );
  }

  if (budget.usedInPeriod >= config.maxActionsPerPeriod) {
    return deny(
      GuardRefusal.RateLimited,
      `${budget.usedInPeriod} of ${config.maxActionsPerPeriod} actions already used ` +
        `in the last ${config.actionPeriod}s`,
    );
  }

  return OK;
}

/**
 * Whether the chain, as it stands, admits this specific action.
 *
 * `wallet` is the address the runtime would actually sign with. Comparing it to the
 * chain's own record — rather than to a configured expectation — is what makes this an
 * authority check rather than a spelling check: if the runtime is holding a key that is
 * not this agent's developer, no amount of correct configuration makes the launch
 * bindable, and it should not be sent.
 */
export function mayActOnChain({
  action,
  chain,
  wallet,
  launchValue,
  walletBalance,
  config,
}: {
  readonly action: RuntimeAction;
  readonly chain: ChainView;
  readonly wallet: Address;
  /** What the launch would send, in wei. Zero for anything else. */
  readonly launchValue: bigint;
  /** The signing wallet's own balance, in wei. */
  readonly walletBalance: bigint;
  readonly config: AgentRuntimeConfig;
}): GuardResult {
  if (action === RuntimeAction.NoAction) return OK;

  const everything = chainPermitsAnything(chain);
  if (!everything.ok) return everything;

  const credential = CREDENTIAL_FOR[action];

  if (credential === Credential.Developer && !same(wallet, chain.developer)) {
    return deny(
      GuardRefusal.ExecutorNotAuthorised,
      `this runtime signs as ${wallet}, but the agent's developer is ${chain.developer}`,
    );
  }

  if (credential === Credential.Operator && !same(wallet, chain.operator)) {
    return deny(
      GuardRefusal.ExecutorNotAuthorised,
      `this runtime signs as ${wallet}, but the mandate's operator is ${chain.operator}`,
    );
  }

  const { AgentState } = agents.lifecycle;

  switch (action) {
    case RuntimeAction.LaunchMarket: {
      // Launching is once and terminal, and the registry proves it two ways: the
      // lifecycle refuses a second `Created -> MarketBound`, and `bindMarket` refuses a
      // pool that is already spoken for. Both are checked, because they can disagree —
      // a market launched but not yet bound leaves the state at `Created` with a pool
      // that exists, and sending a second launch there would burn the first buy.
      if (chain.state !== AgentState.Created) {
        return deny(
          GuardRefusal.WrongLifecycleState,
          `launching requires the agent to be in Created, and it is in ` +
            `${agents.lifecycle.agentStateName(chain.state)}`,
        );
      }
      if (chain.poolId !== ZERO_POOL) {
        return deny(
          GuardRefusal.MarketAlreadyBound,
          `a market is already bound to this agent: ${chain.poolId}`,
        );
      }

      if (launchValue > config.maxLaunchSpendWei) {
        return deny(
          GuardRefusal.LaunchBudgetExceeded,
          `the launch would spend ${launchValue} wei of the runtime's own funds, and ` +
            `the cap is ${config.maxLaunchSpendWei}`,
        );
      }

      // Balance rather than balance-plus-gas: the gas estimate belongs to the sender
      // and is not known here. This catches the wallet that was never funded, which is
      // the common case, and leaves the marginal case to the node's own error.
      if (walletBalance < launchValue) {
        return deny(
          GuardRefusal.InsufficientExecutorBalance,
          `the launch sends ${launchValue} wei and the wallet holds ${walletBalance}`,
        );
      }

      return OK;
    }

    case RuntimeAction.ClaimRevenue: {
      if (chain.poolId === ZERO_POOL) {
        return deny(
          GuardRefusal.NoMarket,
          "this agent has no bound market, so it has no fees to claim",
        );
      }
      return OK;
    }
  }
}

/**
 * The last gate before signing: is everything still true?
 *
 * Takes the view read *after* reasoning and compares the parts that can move. A
 * guardian revoking mid-run, a market bound by somebody else, an expiry crossed while
 * the model was thinking — each of those turns a valid decision into an invalid
 * transaction, and each is cheap to catch here and expensive to discover in a receipt.
 *
 * `before` is included so a change can be *named* rather than merely refused. "The
 * agent was revoked during this run" is an incident; "the agent is revoked" is a
 * status, and the log should be able to tell them apart.
 */
export function assertStillPermitted({
  action,
  before,
  after,
  wallet,
  launchValue,
  walletBalance,
  config,
}: {
  readonly action: RuntimeAction;
  readonly before: ChainView;
  readonly after: ChainView;
  readonly wallet: Address;
  readonly launchValue: bigint;
  readonly walletBalance: bigint;
  readonly config: AgentRuntimeConfig;
}): GuardResult {
  const still = mayActOnChain({
    action,
    chain: after,
    wallet,
    launchValue,
    walletBalance,
    config,
  });

  if (still.ok) return still;

  const changed = before.state !== after.state || before.poolId !== after.poolId;

  return changed
    ? deny(
        still.refusal,
        `${still.detail} — and this changed during the run: the agent was ` +
          `${agents.lifecycle.agentStateName(before.state)} when reasoning began`,
      )
    : still;
}
