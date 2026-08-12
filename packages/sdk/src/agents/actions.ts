/**
 * The action an agent may propose, and the checks that decide whether it will be
 * accepted.
 *
 * The twin of `AgentActionLib.sol` and of the validation inside
 * `AgentExecutionModule.sol`. ADR-011 records why an agent proposes a value of
 * this type rather than calldata; this file is the half of that decision the
 * interface runs.
 *
 * ## Why the SDK repeats checks the chain will do anyway
 *
 * Because the chain's answer arrives after somebody has been asked to sign.
 * An agent proposing an action that the mandate will refuse should be told so on
 * the page, with the rule it broke named — not sent to a wallet to discover it as
 * a revert. So every rule here exists on chain too, in the same order, with the
 * same reason code, and `simulate` returns the codes rather than a boolean.
 *
 * The SDK is **not** the authority, and nothing here is a security control. It
 * is a mirror; if it and the contract ever disagree, the contract is right and
 * this file has a bug.
 *
 * ## What an action deliberately cannot say
 *
 * It cannot name a recipient: the destination is whatever the provider's service
 * resolves to in `AgentServiceRegistry`, and the copy the quote carries is
 * compared against that rather than used. It cannot name a price, an asset or a
 * version freely: each must equal what the registry lists. A compromised runtime
 * therefore cannot invent a destination, cannot overpay an approved one, and
 * cannot pay against a price the provider has since changed.
 */

import type { Address, Hex } from "viem";

import { AgentState, mayExecute } from "./lifecycle.js";

// --- action types ---------------------------------------------------------

/**
 * The actions that exist. One.
 *
 * `PayDeveloper` and `PayProtocol` were here and are gone, and their absence is a
 * security property rather than a simplification: those two legs are fixed at
 * launch and computed from revenue that has already arrived, so routing them
 * through an agent action gave whoever held the operator key the ability to
 * decide *when* somebody else got paid, and to consume the period limit doing it.
 * They are now permissionless settlement calls on `AgentRevenueRouter`, callable
 * by anybody in any lifecycle state — see `claimDeveloperEntitlement`.
 *
 * Buybacks arrive later with their own limits and are deliberately not reserved
 * here: an unused variant is a variant nobody tested.
 */
export const AgentActionType = {
  PayService: "PayService",
} as const;

export type AgentActionType =
  (typeof AgentActionType)[keyof typeof AgentActionType];

/**
 * A priced, expiring offer to buy one service once.
 *
 * Every field is checked against the registry at execution, so a quote that has
 * gone stale between being built and being submitted fails rather than silently
 * paying a different price.
 */
export interface PayServiceAction {
  readonly actionType: typeof AgentActionType.PayService;
  /** The paying agent. */
  readonly agentId: Hex;
  /** The selling agent. Checked against the service's owner. */
  readonly providerAgentId: Hex;
  readonly serviceId: Hex;
  /** Which revision of the service this price came from. */
  readonly serviceVersion: number;
  /**
   * Where payment goes. Checked against the registry's own answer, so a quote
   * naming a different address is refused rather than honoured.
   */
  readonly provider: Address;
  /** Which asset leaves the treasury. Must be one the mandate approved. */
  readonly asset: Address;
  /** Exactly the listed price, in the asset's own units. Not a maximum. */
  readonly amount: bigint;
  /** Ties the payment to the request it settles, so one request is paid once. */
  readonly requestId: Hex;
  /** Per-agent, strictly increasing. Makes an action executable once. */
  readonly nonce: bigint;
  /** Unix seconds after which the action is refused. */
  readonly deadline: number;
}

export type AgentAction = PayServiceAction;

// --- the mandate ----------------------------------------------------------

/** A per-asset limit pair. Assets differ in decimals, so limits are per asset. */
export interface AssetLimit {
  readonly asset: Address;
  /** The most one action may move. */
  readonly maxActionValue: bigint;
  /** The most that may move within one period. */
  readonly periodLimit: bigint;
}

/**
 * What an agent is permitted to do, fixed at launch.
 *
 * Every field here is immutable on chain. There is no setter, for the agent, the
 * developer, the guardian or anyone else — ADR-012 records why the only
 * privileged action in the agent layer is stopping one.
 */
export interface Mandate {
  readonly agentId: Hex;
  /** Assets the treasury may spend, with a limit pair each. */
  readonly limits: readonly AssetLimit[];
  /** Addresses a payment may resolve to. Empty means the agent buys nothing. */
  readonly approvedTargets: readonly Address[];
  /** Seconds that must pass between two actions. */
  readonly minActionInterval: number;
  /** Unix seconds after which nothing executes. Zero means no expiry. */
  readonly expiry: number;
  /** Length of the spending period in seconds. */
  readonly periodLength: number;
}

/**
 * A provider's service, as the registry lists it.
 *
 * The paying agent supplies none of this. It names a service and the registry
 * answers with the payee, the asset, the price and the version, all of which the
 * execution module then requires the action to match exactly.
 */
export interface ServiceListing {
  /** The agent that owns it. Checked against the action's `providerAgentId`. */
  readonly agentId: Hex;
  /** Bumped on every write, so a quote priced before a change is refused. */
  readonly version: number;
  /** Where payment goes: the provider's revenue router. */
  readonly payee: Address;
  readonly paymentAsset: Address;
  readonly price: bigint;
  /** False for a retired service, or one whose agent is paused or revoked. */
  readonly active: boolean;
}

/**
 * Everything about the agent's current position that a check reads.
 *
 * Separate from the mandate because the mandate never changes and this changes
 * constantly. Fetched by the caller; this module does no I/O.
 *
 * Named `AgentPosition` rather than `AgentState` because `AgentState` is the
 * lifecycle enum, imported from `lifecycle.ts`. Two things called the same name,
 * one of them five integers and the other a snapshot of everything, is how a
 * consumer ends up comparing a struct to an ordinal.
 */
export interface AgentPosition {
  /** The lifecycle state, by the ordinal the chain uses. */
  readonly state: AgentState;
  /** True once the mandate's own revocation has been pulled. */
  readonly mandateRevoked: boolean;
  /** True once the guardian has stopped the treasury. A second, separate stop. */
  readonly treasuryPaused: boolean;
  /** The next nonce the execution module will accept. */
  readonly nextNonce: bigint;
  /** When the agent last executed anything, in unix seconds. Zero if never. */
  readonly lastActionAt: number;
  /** Treasury balance per asset. */
  readonly balances: ReadonlyMap<Address, bigint>;
  /** Spent so far in the current period, per asset. */
  readonly periodSpent: ReadonlyMap<Address, bigint>;
  /** When the current period began, in unix seconds. Zero if never. */
  readonly periodStartedAt: number;
  /** Request ids already settled, so a request is not paid twice. */
  readonly settledRequests: ReadonlySet<Hex>;
  /** What the registry says about each service this agent might buy. */
  readonly services: ReadonlyMap<Hex, ServiceListing>;
}

// --- reasons --------------------------------------------------------------

/**
 * Why an action would be refused.
 *
 * Identical to the Solidity error names, across both contracts that check. The
 * interface shows these, so a person reading "this period's limit for ether is
 * already spent" and a transaction reverting with `PeriodLimitExceeded` are the
 * same event described once.
 */
export const RefusalReason = {
  WrongAgent: "WrongAgent",
  AgentNotActive: "AgentNotActive",
  MandateIsRevoked: "MandateIsRevoked",
  MandateExpired: "MandateExpired",
  QuoteExpired: "QuoteExpired",
  NonceOutOfOrder: "NonceOutOfOrder",
  UnknownService: "UnknownService",
  ServiceNotOwnedBy: "ServiceNotOwnedBy",
  ServiceInactive: "ServiceInactive",
  ServiceVersionStale: "ServiceVersionStale",
  ServiceAssetMismatch: "ServiceAssetMismatch",
  ServicePriceMismatch: "ServicePriceMismatch",
  ProviderMismatch: "ProviderMismatch",
  TargetNotApproved: "TargetNotApproved",
  RequestAlreadySettled: "RequestAlreadySettled",
  ActionTooSoon: "ActionTooSoon",
  TreasuryPaused: "TreasuryPaused",
  ZeroAmount: "ZeroAmount",
  AssetNotApproved: "AssetNotApproved",
  ActionValueExceeded: "ActionValueExceeded",
  PeriodLimitExceeded: "PeriodLimitExceeded",
  InsufficientBalance: "InsufficientBalance",
} as const;

export type RefusalReason =
  (typeof RefusalReason)[keyof typeof RefusalReason];

/** The outcome of checking an action. */
export interface Simulation {
  readonly valid: boolean;
  /** Every rule the action breaks, in the order the contract checks them. */
  readonly refusals: readonly RefusalReason[];
  /** Where the value would go, once resolved. Absent if it cannot be resolved. */
  readonly target: Address | undefined;
}

// --- checks ---------------------------------------------------------------

function limitFor(
  mandate: Mandate,
  asset: Address,
): AssetLimit | undefined {
  const wanted = asset.toLowerCase();
  return mandate.limits.find((limit) => limit.asset.toLowerCase() === wanted);
}

function approves(targets: readonly Address[], target: Address): boolean {
  const wanted = target.toLowerCase();
  return targets.some((entry) => entry.toLowerCase() === wanted);
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * The address an action would pay, or `undefined` if it cannot be determined.
 *
 * Resolved from the registry, never from the action. `undefined` is not a failure
 * by itself — it means the service is not listed, which `simulate` reports as
 * `UnknownService`.
 */
export function targetOf(
  action: AgentAction,
  state: AgentPosition,
): Address | undefined {
  return state.services.get(action.serviceId)?.payee;
}

/**
 * How much of `asset` has been spent in the period covering `now`.
 *
 * The period rolls: once `periodLength` has elapsed since it started, the
 * counter is stale and the answer is zero. The contract does the same reset
 * lazily, when an action arrives, rather than needing a keeper to turn the day
 * over.
 */
export function spentInPeriod(
  state: AgentPosition,
  mandate: Mandate,
  asset: Address,
  now: number,
): bigint {
  // A period that never started has not rolled. Zero means "never acted", not
  // "acted at the epoch", and treating the two alike would report every agent as
  // mid-period since 1970.
  if (state.periodStartedAt === 0) return 0n;
  if (now >= state.periodStartedAt + mandate.periodLength) return 0n;
  return state.periodSpent.get(asset) ?? 0n;
}

export interface SimulateContext {
  readonly mandate: Mandate;
  readonly state: AgentPosition;
  /** Unix seconds to evaluate against. */
  readonly now: number;
}

/**
 * Check an action against everything that would refuse it.
 *
 * Collects every violated rule rather than stopping at the first, because the
 * page should be able to say "this is over the per-action limit and the asset is
 * not approved" in one pass. The contract stops at the first — it has nothing to
 * display and every extra check costs gas.
 *
 * **The order below is the contract's order**, across both contracts that check:
 * `AgentExecutionModule.payService` down to the interval, then `AgentTreasury`
 * for everything about the money. That is what makes `refusals[0]` the error the
 * transaction would actually carry, rather than merely one of the things wrong
 * with it.
 *
 * One rule is not mirrored: the module refuses any caller that is not the
 * operator. The SDK does not know who will send the transaction, and guessing
 * would produce a refusal the chain might not make.
 */
export function simulate(
  action: AgentAction,
  context: SimulateContext,
): Simulation {
  const { mandate, state, now } = context;
  const refusals: RefusalReason[] = [];

  // --- the execution module ---

  if (action.agentId !== mandate.agentId) {
    refusals.push(RefusalReason.WrongAgent);
  }

  // Asked through the lifecycle's own predicate rather than compared to `Active`
  // here, so there is one place that decides what "may act" means.
  if (!mayExecute(state.state)) {
    refusals.push(RefusalReason.AgentNotActive);
  }

  if (state.mandateRevoked) {
    refusals.push(RefusalReason.MandateIsRevoked);
  }

  if (mandate.expiry !== 0 && now >= mandate.expiry) {
    refusals.push(RefusalReason.MandateExpired);
  }

  if (action.deadline < now) {
    refusals.push(RefusalReason.QuoteExpired);
  }

  if (action.nonce !== state.nextNonce) {
    refusals.push(RefusalReason.NonceOutOfOrder);
  }

  const listing = state.services.get(action.serviceId);
  const target = listing?.payee;

  if (listing === undefined) {
    refusals.push(RefusalReason.UnknownService);
  } else {
    if (listing.agentId !== action.providerAgentId) {
      refusals.push(RefusalReason.ServiceNotOwnedBy);
    }
    if (!listing.active) {
      refusals.push(RefusalReason.ServiceInactive);
    }
    // Before the price, because a stale version is the *reason* a price would
    // differ, and reporting the cause is more useful than reporting the symptom.
    if (listing.version !== action.serviceVersion) {
      refusals.push(RefusalReason.ServiceVersionStale);
    }
    if (!sameAddress(listing.paymentAsset, action.asset)) {
      refusals.push(RefusalReason.ServiceAssetMismatch);
    }
    // Exactly the listed price, not at most: overpaying an approved provider
    // is the cheapest way to move value out of a mandated treasury.
    if (listing.price !== action.amount) {
      refusals.push(RefusalReason.ServicePriceMismatch);
    }
    // The quote carries a copy of the payee so a human approved the same address
    // the chain will pay. The copy is compared, never used.
    if (!sameAddress(listing.payee, action.provider)) {
      refusals.push(RefusalReason.ProviderMismatch);
    }
    if (!approves(mandate.approvedTargets, listing.payee)) {
      refusals.push(RefusalReason.TargetNotApproved);
    }
  }

  if (state.settledRequests.has(action.requestId)) {
    refusals.push(RefusalReason.RequestAlreadySettled);
  }

  if (
    state.lastActionAt !== 0 &&
    now < state.lastActionAt + mandate.minActionInterval
  ) {
    refusals.push(RefusalReason.ActionTooSoon);
  }

  // --- the treasury ---

  if (state.treasuryPaused) {
    refusals.push(RefusalReason.TreasuryPaused);
  }

  if (action.amount === 0n) {
    refusals.push(RefusalReason.ZeroAmount);
  }

  const limit = limitFor(mandate, action.asset);
  if (limit === undefined) {
    refusals.push(RefusalReason.AssetNotApproved);
  } else {
    if (action.amount > limit.maxActionValue) {
      refusals.push(RefusalReason.ActionValueExceeded);
    }

    const spent = spentInPeriod(state, mandate, action.asset, now);
    if (spent + action.amount > limit.periodLimit) {
      refusals.push(RefusalReason.PeriodLimitExceeded);
    }
  }

  const balance = state.balances.get(action.asset) ?? 0n;
  if (action.amount > balance) {
    refusals.push(RefusalReason.InsufficientBalance);
  }

  return { valid: refusals.length === 0, refusals, target };
}

/** Non-collecting form: the first reason an action would be refused. */
export function firstRefusal(
  action: AgentAction,
  context: SimulateContext,
): RefusalReason | undefined {
  return simulate(action, context).refusals[0];
}

// --- headroom -------------------------------------------------------------

/**
 * The largest amount of `asset` this agent could move right now.
 *
 * The minimum of the per-action limit, what is left of the period's limit, and
 * the balance. Shown on the agent page so a reader can see how much room a
 * mandate actually leaves, rather than reading three numbers and doing the
 * arithmetic themselves.
 *
 * Returns zero for an asset the mandate does not approve, which is the true
 * answer rather than an error: the agent can move none of it.
 */
export function headroom(
  mandate: Mandate,
  state: AgentPosition,
  asset: Address,
  now: number,
): bigint {
  const limit = limitFor(mandate, asset);
  if (limit === undefined) return 0n;

  const spent = spentInPeriod(state, mandate, asset, now);
  const remaining = limit.periodLimit > spent ? limit.periodLimit - spent : 0n;
  const balance = state.balances.get(asset) ?? 0n;

  return [limit.maxActionValue, remaining, balance].reduce((low, value) =>
    value < low ? value : low,
  );
}

/**
 * When the agent may act again, in unix seconds.
 *
 * Zero if it may act now. Does not consider limits or balance — this answers the
 * interval question only, which is the one a countdown needs.
 */
export function nextActionAt(mandate: Mandate, state: AgentPosition): number {
  if (state.lastActionAt === 0) return 0;
  return state.lastActionAt + mandate.minActionInterval;
}
