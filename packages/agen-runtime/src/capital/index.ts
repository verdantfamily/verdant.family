/**
 * Autonomous capital management: the deterministic half.
 *
 * The pipeline the spec asks for, in the order it runs:
 *
 *   `readObjective`     English to a proposal, for the parts that are literal
 *   `clampPolicy`       proposal to an enforceable mandate, cut to platform limits
 *   `discoverOpportunities`  venues, from extensible sources
 *   `rankOpportunities` deterministic risk-adjusted scores at a given size
 *   `planAllocation`    balance plus mandate plus scores to a plan
 *   `validatePlan`      a second, independent implementation of the same limits
 *   `decidePosition`    what to do with capital already deployed
 *   `automationGate`    whether anything may act at all
 *   `mayAttempt`        whether this specific action may be tried
 *   `notifiable`        whether the holder should be told
 *
 * Everything here is pure. There is no signer, no chain client, no database and no execution: nothing in
 * this folder can move value, and there is no function to call that would. That is not an oversight — see
 * `availability.ts` for why the execution half is deliberately absent, and what has to exist before it can
 * be written.
 */

export {
  capitalAvailability,
  unavailableReply,
  type Availability as CapitalAvailability,
} from "./availability";
export {
  planAllocation,
  type AllocationPlan,
  type PlannedPosition,
} from "./allocation";
export {
  DUST_WEI,
  eventKindFor,
  notifiable,
  type CapitalEvent,
  type CapitalEventKind,
} from "./events";
export {
  actionKey,
  automationGate,
  mayAttempt,
  mayWithdraw,
  type AccountState,
  type Attempt,
  type ExecutionState,
  type Gate,
} from "./guard";
export {
  compileMandate,
  mandateHonoursPolicy,
  type MandateTerms,
} from "./mandate";
export {
  readObjective,
  type CapitalCommand,
  type Objective,
} from "./objective";
export {
  CASH_ID,
  cashOpportunity,
  discoverOpportunities,
  eligible,
  idleCashSource,
  ineligibility,
  type Opportunity,
  type OpportunityKind,
  type OpportunityMetrics,
  type OpportunitySource,
} from "./opportunity";
export {
  clampPolicy,
  deployablePct,
  PLATFORM_LIMITS,
  profilePolicy,
  revisePolicy,
  type Policy,
  type PolicyProposal,
  type ProtocolTier,
  type RiskProfile,
} from "./policy";
export {
  DEFAULT_EXITS,
  decideCash,
  decidePosition,
  performance,
  type ActionKind,
  type Decision,
  type ExitConditions,
  type Position,
} from "./rebalance";
export {
  DEFAULT_SCORING,
  forwardScore,
  rankOpportunities,
  riskBand,
  scoreOpportunity,
  type RiskBand,
  type Score,
  type ScorePenalties,
  type ScoringConfig,
} from "./scoring";
export { validatePlan, type Validation, type Violation } from "./validate";
