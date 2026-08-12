/**
 * Which agent event this indexer does what with.
 *
 * A declaration, separate from the handlers that act on it, and free of any import
 * from `ponder:registry` — which is what makes it testable. Importing `src/agents.ts`
 * from a test would run `ponder.on` and need the whole Ponder runtime; importing this
 * needs nothing.
 *
 * ## Why a list at all
 *
 * Because the failure this guards against is silence. An agent event with no handler
 * produces no error, no log and no row: the indexer runs, reports healthy, and an
 * agent's feed is simply missing something that happened. That is invisible from the
 * inside, and it is exactly what happens when a contract gains an event and nobody
 * remembers this file.
 *
 * So every event across the seven agent contracts appears below exactly once, either
 * with the activity type it produces or with a reason it produces none.
 * `agent-events.test.ts` reads the emitted ABIs and fails if the two sets differ in
 * either direction — an event missing from here, or an entry here for an event that no
 * longer exists.
 */

// From the schema module directly rather than through `ponder:schema`. The virtual
// module only exists inside a Ponder process, and the whole point of this file is that
// it can be imported by a test that has no Ponder runtime. Same symbol either way:
// `ponder:schema` re-exports this module.
import { AgentActivityType } from "../ponder.schema.ts";

/** `contract:event`, as Ponder names them. */
export type AgentEventName = keyof typeof AGENT_EVENTS;

/**
 * What each event produces.
 *
 * An `AgentActivityType` for the ones that appear in an agent's feed, or a `skip` with
 * the reason. A skip is a decision recorded, not an event forgotten.
 */
export const AGENT_EVENTS = {
  // --- creation -----------------------------------------------------------

  "AgentLaunchFactory:AgentLaunched": AgentActivityType.Created,

  /**
   * Emitted by the registry inside `createAgent`, before the factory has emitted
   * `AgentLaunched` with the four addresses. It carries the developer, the treasury and
   * the commitment — all of which `AgentLaunched` also carries — so there is nothing to
   * write that the launch handler does not write, and no row to write it to yet.
   */
  "AgentIdentityRegistry:AgentRegistered": {
    skip: "duplicates AgentLaunched within the same transaction, and arrives before the agent row exists",
  },

  // --- lifecycle ----------------------------------------------------------

  /**
   * Handled, except for the bootstrap emission where an agent moves from `Created` to
   * `Created`. `AgentLifecycle.canTransition` refuses self-transitions because they are
   * not events, and the handler drops them for the same reason.
   */
  "AgentIdentityRegistry:AgentStateChanged": AgentActivityType.StateChanged,
  "AgentIdentityRegistry:MarketBound": AgentActivityType.MarketLaunched,
  "AgentIdentityRegistry:MetadataUpdated": AgentActivityType.MetadataUpdated,

  "AgentMandate:MandateRevoked": AgentActivityType.MandateRevoked,

  // --- treasury -----------------------------------------------------------

  "AgentTreasury:PausedSet": AgentActivityType.TreasuryPauseChanged,
  "AgentTreasury:Received": AgentActivityType.TreasuryFunded,
  "AgentTreasury:Spent": AgentActivityType.TreasurySpent,
  "AgentTreasury:PeriodRolled": AgentActivityType.TreasuryPeriodRolled,

  // --- services -----------------------------------------------------------

  "AgentServiceRegistry:ServiceRegistered": AgentActivityType.ServiceRegistered,
  "AgentServiceRegistry:ServiceUpdated": AgentActivityType.ServiceUpdated,
  "AgentServiceRegistry:ServiceRetired": AgentActivityType.ServiceRetired,

  // --- execution ----------------------------------------------------------

  "AgentExecutionModule:ServicePaid": AgentActivityType.ServicePaid,

  // --- revenue ------------------------------------------------------------

  "AgentRevenueRouter:RevenueRecognised": AgentActivityType.RevenueRecognised,
  "AgentRevenueRouter:Allocated": AgentActivityType.RevenueAllocated,
  "AgentRevenueRouter:Settled": AgentActivityType.RevenueSettled,
  "AgentRevenueRouter:MarketFeesClaimed": AgentActivityType.MarketFeesClaimed,
  "AgentRevenueRouter:MarketSplitterBound": AgentActivityType.MarketSplitterBound,
} as const satisfies Record<string, AgentActivityType | { readonly skip: string }>;

/**
 * The four legs, by the index `Settled` reports, as the column each one settles into.
 *
 * `RevenueAllocationLib`'s order. A settlement arrives as a number, so something has to
 * turn 2 into the developer's column, and having it here rather than inline means the
 * order can be checked against the library without running the indexer.
 */
export const LEG_SETTLED_COLUMN = [
  "operationsSettled",
  "buybacksSettled",
  "developerSettled",
  "protocolSettled",
] as const;

/** The same four, as the column each one is allocated into. */
export const LEG_ALLOCATED_COLUMN = [
  "operationsAllocated",
  "buybacksAllocated",
  "developerAllocated",
  "protocolAllocated",
] as const;

/**
 * Whether an entry is a recorded decision not to index.
 *
 * Generic over the entry rather than typed to the union, so that narrowing it out of
 * `Object.values(AGENT_EVENTS)` leaves the activity types behind rather than the whole
 * union. The literal `skip` strings are part of the const type, which a predicate
 * fixed to `{ skip: string }` cannot be assignable to.
 */
export function isSkipped<T extends AgentActivityType | { readonly skip: string }>(
  entry: T,
): entry is T & { readonly skip: string } {
  return typeof entry === "object";
}
