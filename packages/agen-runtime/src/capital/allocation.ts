/**
 * Turning a balance, a mandate and a set of scores into a plan.
 *
 * The plan is a proposal. It is not permission to do anything, and it does not become permission by
 * looking reasonable — {@link validatePlan} in `validate.ts` is a separate implementation of the same
 * limits, and a plan that fails it is discarded rather than trimmed. This module is therefore allowed
 * to be the clever half: greedy, ordered by score, with the arithmetic in one place.
 *
 * ## Cash is a decision
 *
 * The plan always states what stays liquid, and the number is arrived at rather than left over. When
 * nothing scores above zero, the plan is all cash with a note saying so, which is a real answer to
 * `put my money to work` and a much better one than a position in the least bad venue available.
 *
 * ## Sizing before scoring
 *
 * Scores depend on size — costs are fixed amounts and depth is relative — so a candidate size has to be
 * chosen before anything can be ranked. The candidate is the per-position ceiling, which is the largest
 * the position could be, and therefore the size at which costs look most favourable and depth looks
 * worst. Scoring the largest permitted size means a venue that only clears its costs when small is
 * ranked on the version of itself the plan would actually build.
 */

import { type Policy } from "./policy";
import { eligible, type Opportunity } from "./opportunity";
import { rankOpportunities, type Score, type ScoringConfig, DEFAULT_SCORING } from "./scoring";

export interface PlannedPosition {
  readonly opportunityId: string;
  readonly amountWei: bigint;
  /** Why this venue, at this size. Recorded with the position and shown to the holder afterwards. */
  readonly reason: string;
}

export interface AllocationPlan {
  readonly cashWei: bigint;
  readonly positions: readonly PlannedPosition[];
  /** What the planner wants the holder to know, including why it declined to deploy. */
  readonly notes: readonly string[];
}

/** A percentage of an amount, rounded down. Used for ceilings, where rounding down is the safe direction. */
function floorPct(amountWei: bigint, percent: number): bigint {
  return (amountWei * BigInt(Math.max(0, Math.round(percent)))) / 100n;
}

/** A percentage of an amount, rounded up. Used for the cash floor, where rounding up is the safe direction. */
function ceilPct(amountWei: bigint, percent: number): bigint {
  const scaled = amountWei * BigInt(Math.max(0, Math.round(percent)));
  return scaled % 100n === 0n ? scaled / 100n : scaled / 100n + 1n;
}

/**
 * Build an allocation plan.
 *
 * `existing` is the set of opportunity ids the account already holds. They are excluded from new
 * allocation because this function decides where *uncommitted* capital goes; moving capital that is
 * already deployed is a rebalance, which is a different decision with a different threshold and lives
 * in `rebalance.ts`.
 */
export function planAllocation({
  balanceWei,
  policy,
  opportunities,
  existing = [],
  config = DEFAULT_SCORING,
}: {
  readonly balanceWei: bigint;
  readonly policy: Policy;
  readonly opportunities: readonly Opportunity[];
  readonly existing?: readonly string[];
  readonly config?: ScoringConfig;
}): AllocationPlan {
  const notes: string[] = [];

  if (balanceWei <= 0n) {
    return { cashWei: 0n, positions: [], notes: ["there is nothing in the account to allocate"] };
  }

  const reserveWei = ceilPct(balanceWei, policy.minCashPct);
  const positionCapWei = floorPct(balanceWei, policy.maxPositionPct);
  const highRiskCapWei = floorPct(balanceWei, policy.maxHighRiskPct);

  let deployableWei = balanceWei - reserveWei;
  if (deployableWei <= 0n) {
    return {
      cashWei: balanceWei,
      positions: [],
      notes: [`the policy keeps ${String(policy.minCashPct)}% liquid, which is all of it`],
    };
  }

  const permitted = eligible(opportunities, policy).filter(
    (opportunity) => opportunity.kind !== "cash" && !existing.includes(opportunity.id),
  );

  if (permitted.length === 0) {
    return {
      cashWei: balanceWei,
      positions: [],
      notes: ["nothing eligible to deploy into, so all of it stays liquid"],
    };
  }

  const byId = new Map(permitted.map((opportunity) => [opportunity.id, opportunity]));
  const candidateSize = positionCapWei < deployableWei ? positionCapWei : deployableWei;
  const ranked: readonly Score[] = rankOpportunities(permitted, candidateSize, config);

  const positions: PlannedPosition[] = [];
  let highRiskWei = 0n;

  for (const score of ranked) {
    if (deployableWei <= 0n) break;

    const opportunity = byId.get(score.opportunityId);
    if (opportunity === undefined) continue;

    // Cash beats a negative expectation, always. This is the line that stops a headline rate from
    // buying its way into the plan: whatever the APR was, the score is what is left after costs and
    // risk, and if that is negative the venue is worse than doing nothing.
    if (score.score <= 0) {
      notes.push(`skipped ${opportunity.label}: ${score.explanation[score.explanation.length - 1] ?? "no expected return"}`);
      continue;
    }

    let amountWei = deployableWei < positionCapWei ? deployableWei : positionCapWei;

    if (score.band === "high") {
      const roomWei = highRiskCapWei - highRiskWei;
      if (roomWei <= 0n) {
        notes.push(
          `skipped ${opportunity.label}: the ${String(policy.maxHighRiskPct)}% high-risk allowance is used up`,
        );
        continue;
      }
      if (roomWei < amountWei) amountWei = roomWei;
    }

    if (amountWei <= 0n) continue;

    positions.push({
      opportunityId: opportunity.id,
      amountWei,
      reason: `${opportunity.label}: ${score.explanation.join("; ")}`,
    });

    deployableWei -= amountWei;
    if (score.band === "high") highRiskWei += amountWei;
  }

  if (positions.length === 0) {
    notes.push("nothing cleared its costs, so all of it stays liquid");
  }

  return {
    // Whatever was not deployed is liquid, which includes the reserve and anything the caps left over.
    cashWei: balanceWei - positions.reduce((total, position) => total + position.amountWei, 0n),
    positions,
    notes,
  };
}
