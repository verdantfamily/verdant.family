/**
 * The five states an agent can be in, and the only moves between them.
 *
 * The twin of `packages/contracts/src/agents/AgentLifecycle.sol`, which says of
 * itself that it is "enforced by four contracts and mirrored by the SDK, the
 * indexer and the interface". This is that mirror, and it exists so the interface
 * can grey out a button without an RPC call and the indexer can label a state
 * change without a lookup table of its own.
 *
 * The contract remains authoritative. Nothing here is a control; if this file and
 * `AgentLifecycle.sol` ever disagree, the contract is right and this has a bug.
 * `lifecycle.test.ts` walks all twenty-five ordered pairs here and
 * `AgentLifecycle.t.sol` walks the same twenty-five against the authority — but each
 * of those suites states the matrix a second time and checks one implementation
 * against its own statement, so a clause transposed in both a mirror and its test
 * would be green twice. `src/agents/vectors/lifecycle.json` closes that: it is a
 * third statement of the rules, read by both suites, so a divergence between the two
 * implementations fails on one side or the other rather than on neither.
 *
 * ## Why the numbers and not just the names
 *
 * Because the numbering is part of the interface. `AgentLifecycle.sol` says so
 * explicitly — "the indexer stores it, the SDK maps it, and a reordering would
 * silently relabel history" — and an event carries the ordinal, not the name. A
 * string-only mirror would force every consumer to invent its own mapping from
 * `2` to `"Active"`, which is the same table written four times.
 */

/**
 * An agent's lifecycle state, by the ordinal the chain uses.
 *
 * Append only. Renumbering these would relabel every `AgentStateChanged` log ever
 * emitted.
 */
export const AgentState = {
  /** The agent's contracts exist and nothing else. No market, no execution. */
  Created: 0,
  /** A market, proved to belong to this agent. Execution is still off. */
  MarketBound: 1,
  /** Everything. Revenue arrives, approved actions execute, entitlements settle. */
  Active: 2,
  /** Revenue still arrives and still allocates. No discretionary action runs. */
  Paused: 3,
  /** Terminal. Nothing executes again, but fixed entitlements stay claimable. */
  Revoked: 4,
} as const;

export type AgentState = (typeof AgentState)[keyof typeof AgentState];

/**
 * The states, indexed by their ordinal.
 *
 * Positional on purpose: the index *is* the on-chain value, so reading a name is
 * an array access rather than a search, and a gap would be a compile error rather
 * than a silent `undefined`.
 */
export const AGENT_STATE_NAMES = [
  "Created",
  "MarketBound",
  "Active",
  "Paused",
  "Revoked",
] as const;

export type AgentStateName = (typeof AGENT_STATE_NAMES)[number];

/** Every state, in the chain's order. For exhaustive iteration. */
export const AGENT_STATES: readonly AgentState[] = [0, 1, 2, 3, 4];

/**
 * Whether `value` is a state this lifecycle defines.
 *
 * Worth having as a guard rather than a cast: the ordinal arrives from a log or
 * an API response, and a sixth state would mean the chain is ahead of this file.
 * Failing loudly at the boundary beats rendering "undefined" in a status pill.
 */
export function isAgentState(value: number): value is AgentState {
  return Number.isInteger(value) && value >= 0 && value <= 4;
}

/** The name of a state. Throws for an ordinal this version does not know. */
export function agentStateName(state: AgentState): AgentStateName {
  const name = AGENT_STATE_NAMES[state];
  if (name === undefined) {
    throw new RangeError(
      `unknown agent state ${state}. The chain has a state this SDK does not, ` +
        `which means AgentLifecycle.sol gained a variant and this mirror was not updated.`,
    );
  }
  return name;
}

/** The ordinal for a name. The inverse of `agentStateName`. */
export function agentStateFromName(name: AgentStateName): AgentState {
  const index = AGENT_STATE_NAMES.indexOf(name);
  // Unreachable through the type, but the cast below is only sound because of it.
  if (index < 0) throw new RangeError(`unknown agent state name ${name}`);
  return index as AgentState;
}

/**
 * Whether `from -> to` is a move this lifecycle allows.
 *
 * A port of `AgentLifecycle.canTransition`, in the same order, one clause per
 * source state. Kept as a chain of conditions rather than a lookup table so it
 * reads beside the Solidity line for line — a table would be more compact and
 * would no longer be checkable by eye against the authority.
 */
export function canTransition(from: AgentState, to: AgentState): boolean {
  // Re-entering the state you are already in is never a real event. Permitting it
  // would let `pause` on a paused agent put a state change in the feed that did
  // not happen.
  if (from === to) return false;

  // Terminal. Nothing leaves, for anybody, ever.
  if (from === AgentState.Revoked) return false;

  // Available from every live state, which is the whole point of an emergency
  // stop: it must not require the agent to be in a good state.
  if (to === AgentState.Revoked) return true;

  if (from === AgentState.Created) return to === AgentState.MarketBound;
  if (from === AgentState.MarketBound) return to === AgentState.Active;
  if (from === AgentState.Active) return to === AgentState.Paused;
  if (from === AgentState.Paused) return to === AgentState.Active;

  return false;
}

/** The transition `AgentLifecycle.IllegalTransition` refuses, as an error. */
export class IllegalTransitionError extends Error {
  readonly from: AgentState;
  readonly to: AgentState;

  constructor(from: AgentState, to: AgentState) {
    super(
      `an agent cannot move from ${agentStateName(from)} to ${agentStateName(to)}`,
    );
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Throws unless `from -> to` is permitted.
 *
 * The twin of `requireTransition`. Named for the Solidity rather than for the
 * TypeScript convention (`assert…`) so that a reader looking for the on-chain
 * function finds this one.
 */
export function requireTransition(from: AgentState, to: AgentState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/**
 * Every state reachable from `state` in one move.
 *
 * Not in the Solidity, because on chain nothing needs to ask. Derived from
 * `canTransition` rather than listed, so it cannot drift from it: an interface
 * offering a button this does not return would be offering a transition the chain
 * refuses.
 */
export function transitionsFrom(state: AgentState): readonly AgentState[] {
  return AGENT_STATES.filter((to) => canTransition(state, to));
}

/**
 * Whether an agent in this state may execute a discretionary action.
 *
 * `Active` and nothing else. Discretionary means an action the agent proposed —
 * paying for a service. It deliberately does not cover settling a fixed
 * entitlement, which is arithmetic the developer and the protocol are owed
 * regardless of what the agent is doing.
 */
export function mayExecute(state: AgentState): boolean {
  return state === AgentState.Active;
}

/**
 * Whether an agent in this state may have its services configured.
 *
 * From the moment it has a market until it is stopped. A `Created` agent has
 * nothing to sell against, and a paused or revoked one should not be changing its
 * price list while nobody can buy.
 */
export function mayConfigureServices(state: AgentState): boolean {
  return state === AgentState.MarketBound || state === AgentState.Active;
}

/**
 * Whether an agent in this state may still be paid. Always.
 *
 * A guardian who could stop money arriving could starve the developer and the
 * protocol of entitlements fixed at launch, so no state switches revenue off —
 * ADR-012. Present as a function rather than as an absence so the claim is stated
 * somewhere and can be tested.
 */
export function mayReceiveRevenue(_state: AgentState): boolean {
  return true;
}

/**
 * Whether a fixed entitlement may be settled in this state. Always, for the same
 * reason: the developer's and the protocol's shares are decided at launch and are
 * not the agent's to withhold.
 */
export function maySettleFixedEntitlement(_state: AgentState): boolean {
  return true;
}

/** Whether the agent has been stopped for good. */
export function isTerminal(state: AgentState): boolean {
  return state === AgentState.Revoked;
}

/** Whether the agent is running: bound, activated, and not stopped. */
export function isLive(state: AgentState): boolean {
  return state === AgentState.Active;
}
