/**
 * Deciding what to do with capital that is already deployed.
 *
 * Six actions and nothing else. A model may be asked to explain a decision to the holder, and may be
 * asked whether one looks wrong, but it cannot produce one: the decision is a function of the position,
 * the venue's current metrics, the alternatives, and the mandate. This is the difference between an
 * automation whose behaviour can be reasoned about before it runs and one that has to be watched.
 *
 * ## Churn is the failure mode
 *
 * The obvious version of this feature moves capital whenever something scores higher, and loses money
 * doing it: every move pays gas twice, slippage twice, and re-enters at a worse price than the quote
 * implied. So a move has to beat the cost of making it *and* a margin on top, and the margin is the
 * holder's `minImprovementBps` rather than a constant. A rebalancer that is not allowed to be indecisive
 * is a rebalancer that is allowed to be expensive.
 *
 * ## Exits are not rebalances
 *
 * `autoRebalance: false` stops the optimisation and does not stop the exits. Somebody who said "leave it
 * alone" was declining to have their capital chased around venues; they were not waiving the stop that
 * gets them out when liquidity collapses. Conflating the two would honour the letter of an instruction
 * by ignoring the reason for it, and the daily rebalance cap works the same way.
 */

import { type Policy } from "./policy";
import { ineligibility, type Opportunity } from "./opportunity";
import { forwardScore, type Score, type ScoringConfig, DEFAULT_SCORING } from "./scoring";

export type ActionKind = "stay" | "reduce" | "exit" | "rebalance" | "increase" | "hold_cash";

export interface Position {
  readonly opportunityId: string;
  /** What went in, which is the basis performance is measured against. */
  readonly costBasisWei: bigint;
  /** What it is worth now, excluding fees already taken. */
  readonly valueWei: bigint;
  readonly feesEarnedWei: bigint;
  readonly enteredAt: number;
}

/**
 * The stop conditions, as numbers rather than as judgement.
 *
 * Configurable and documented because they are the difference between an autonomous exit and an
 * arbitrary one. A model is never asked whether liquidity has collapsed; it is compared to a floor that
 * was set before the position was entered.
 */
export interface ExitConditions {
  /** Exit when the position is down this much against basis, including fees earned. */
  readonly maxDrawdownPct: number;
  /** Exit when venue liquidity falls below this. Being unable to leave is the risk, not the rate. */
  readonly minLiquidityWei: bigint;
  /** Exit when a fee-earning venue stops trading, since fees are paid on turnover and nothing else. */
  readonly minVolume24hWei: bigint;
}

export const DEFAULT_EXITS: ExitConditions = {
  // A fifth of the position. Tight enough to matter and loose enough not to fire on ordinary movement
  // in an asset the holder chose to hold.
  maxDrawdownPct: 20,
  // A tenth of an ether. Below this a position of any size is trapped rather than invested.
  minLiquidityWei: 10n ** 17n,
  // A venue paying fees on no volume is paying nothing, whatever its advertised rate says.
  minVolume24hWei: 0n,
};

export interface Decision {
  readonly action: ActionKind;
  readonly opportunityId: string;
  /** Where to move to, for `rebalance` only. */
  readonly targetOpportunityId: string | null;
  /** How much to move, reduce, or add. Null when the action does not move anything. */
  readonly amountWei: bigint | null;
  /** Why, in one sentence, for the holder and for the audit log. */
  readonly reason: string;
}

function floorPct(amountWei: bigint, percent: number): bigint {
  return (amountWei * BigInt(Math.max(0, Math.round(percent)))) / 100n;
}

function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0;
  const scale = 1_000_000n;
  return Number((numerator * scale) / denominator) / Number(scale);
}

/**
 * What a position is worth against what went in, as a decimal.
 *
 * Fees earned count. A liquidity position that is down two percent on price and has earned three in fees
 * is up, and a drawdown stop that ignored the fees would exit a position that is working.
 */
export function performance(position: Position): number {
  if (position.costBasisWei === 0n) return 0;
  const total = position.valueWei + position.feesEarnedWei;
  return ratio(total, position.costBasisWei) - 1;
}

/**
 * Decide one position's fate.
 *
 * `current` is the venue as it is *now*, re-measured, not as it was when the position was entered. Null
 * means the venue is no longer discoverable at all, which is treated as the most urgent exit there is:
 * something that cannot be measured cannot be held deliberately.
 */
export function decidePosition({
  position,
  current,
  alternatives,
  policy,
  balanceWei,
  rebalancesToday = 0,
  exits = DEFAULT_EXITS,
  config = DEFAULT_SCORING,
}: {
  readonly position: Position;
  readonly current: Opportunity | null;
  /**
   * Every other eligible venue.
   *
   * Opportunities rather than scores, because the comparison has to be made on a forward basis and a
   * score handed in from the allocator was computed on an entry basis. Taking the raw venues means this
   * function cannot be given the wrong kind of number.
   */
  readonly alternatives: readonly Opportunity[];
  readonly policy: Policy;
  readonly balanceWei: bigint;
  readonly rebalancesToday?: number;
  readonly exits?: ExitConditions;
  readonly config?: ScoringConfig;
}): Decision {
  const held = position.opportunityId;

  if (current === null) {
    return {
      action: "exit",
      opportunityId: held,
      targetOpportunityId: null,
      amountWei: position.valueWei,
      reason: "the venue can no longer be read, so the position is not one i can keep watching",
    };
  }

  const metrics = current.metrics;

  if (metrics.liquidityWei < exits.minLiquidityWei) {
    return {
      action: "exit",
      opportunityId: held,
      targetOpportunityId: null,
      amountWei: position.valueWei,
      reason: `liquidity in ${current.label} collapsed, and being unable to leave is the risk`,
    };
  }

  if (current.kind !== "cash" && metrics.volume24hWei <= exits.minVolume24hWei) {
    return {
      action: "exit",
      opportunityId: held,
      targetOpportunityId: null,
      amountWei: position.valueWei,
      reason: `${current.label} has stopped trading, so it has stopped paying fees`,
    };
  }

  const drawdown = performance(position);
  if (drawdown <= -(exits.maxDrawdownPct / 100)) {
    return {
      action: "exit",
      opportunityId: held,
      targetOpportunityId: null,
      amountWei: position.valueWei,
      reason: `down ${(-drawdown * 100).toFixed(1)}% including fees, past the ${String(exits.maxDrawdownPct)}% stop`,
    };
  }

  // A policy change can make a held position ineligible — `only use ETH` after entering something else.
  // The mandate is current, so the position is not.
  const reason = ineligibility(current, policy);
  if (reason !== null) {
    return {
      action: "exit",
      opportunityId: held,
      targetOpportunityId: null,
      amountWei: position.valueWei,
      reason: `${current.label} is no longer allowed by your policy: ${reason}`,
    };
  }

  // Forward-looking: what continuing to hold this is worth, with the sunk entry cost ignored and the exit
  // cost left to the migration comparison below.
  const currently = forwardScore(current, position.valueWei, config);

  if (currently.score <= 0) {
    return {
      action: "exit",
      opportunityId: held,
      targetOpportunityId: null,
      amountWei: position.valueWei,
      reason: `${current.label} is no longer expected to earn anything after costs and risk`,
    };
  }

  // Everything below this line is optimisation, and optimisation is what the holder can switch off.
  const capWei = floorPct(balanceWei, policy.maxPositionPct);
  if (position.valueWei > capWei) {
    return {
      action: "reduce",
      opportunityId: held,
      targetOpportunityId: null,
      amountWei: position.valueWei - capWei,
      reason: `the position grew past the ${String(policy.maxPositionPct)}% ceiling, so i am trimming it back`,
    };
  }

  if (!policy.autoRebalance) {
    return {
      action: "stay",
      opportunityId: held,
      targetOpportunityId: null,
      amountWei: null,
      reason: "still earning, and you asked me not to move it",
    };
  }

  if (rebalancesToday >= policy.maxDailyRebalances) {
    return {
      action: "stay",
      opportunityId: held,
      targetOpportunityId: null,
      amountWei: null,
      reason: `already moved ${String(rebalancesToday)} times today, which is the limit`,
    };
  }

  const candidates = alternatives
    .filter((candidate) => candidate.id !== held)
    .map((candidate) => ({
      opportunity: candidate,
      score: forwardScore(candidate, position.valueWei, config),
    }))
    .sort((left, right) => right.score.score - left.score.score);

  const best: { readonly opportunity: Opportunity; readonly score: Score } | undefined = candidates[0];

  if (best !== undefined && best.score.score > currently.score) {
    // The cost of moving, annualised the same way the scores are, so the comparison is like for like.
    // Both legs: getting out of where the money is, and getting into where it would go. Leaving either
    // out is what makes a rebalancer chase a rate it will never recover the cost of reaching.
    const moveCostWei = metrics.exitCostWei + best.opportunity.metrics.entryCostWei;
    const moveCostRate =
      ratio(moveCostWei, position.valueWei) * (365 / config.holdingPeriodDays);

    const margin = policy.minImprovementBps / 10_000;
    const improvement = best.score.score - currently.score;

    if (improvement > moveCostRate + margin) {
      return {
        action: "rebalance",
        opportunityId: held,
        targetOpportunityId: best.opportunity.id,
        amountWei: position.valueWei,
        reason:
          `${best.opportunity.label} is ${(improvement * 100).toFixed(2)}% a year better, which clears ` +
          `the ${(moveCostRate * 100).toFixed(2)}% cost of moving and your ${(margin * 100).toFixed(2)}% margin`,
      };
    }

    return {
      action: "stay",
      opportunityId: held,
      targetOpportunityId: null,
      amountWei: null,
      reason:
        `${best.opportunity.label} looks ${(improvement * 100).toFixed(2)}% better, which does not cover ` +
        `the ${(moveCostRate * 100).toFixed(2)}% cost of moving`,
    };
  }

  return {
    action: "stay",
    opportunityId: held,
    targetOpportunityId: null,
    amountWei: null,
    reason: `${current.label} is still the best eligible venue for this money`,
  };
}

/**
 * Decide what to do with capital that is sitting liquid.
 *
 * The counterpart to {@link decidePosition}, and the reason `hold_cash` is an action rather than the
 * absence of one. An account holding everything in cash because nothing cleared its costs is in a state
 * the system chose and can explain, not a state it failed to leave.
 */
export function decideCash({
  cashWei,
  balanceWei,
  policy,
  alternatives,
}: {
  readonly cashWei: bigint;
  readonly balanceWei: bigint;
  readonly policy: Policy;
  readonly alternatives: readonly { readonly opportunity: Opportunity; readonly score: Score }[];
}): Decision {
  const floorWei = (balanceWei * BigInt(policy.minCashPct)) / 100n;
  const freeWei = cashWei > floorWei ? cashWei - floorWei : 0n;

  if (freeWei <= 0n) {
    return {
      action: "hold_cash",
      opportunityId: "cash:eth",
      targetOpportunityId: null,
      amountWei: null,
      reason: `all of the liquid balance is the ${String(policy.minCashPct)}% you asked me to keep`,
    };
  }

  const best = [...alternatives].sort((left, right) => right.score.score - left.score.score)[0];

  if (best === undefined || best.score.score <= 0) {
    return {
      action: "hold_cash",
      opportunityId: "cash:eth",
      targetOpportunityId: null,
      amountWei: null,
      reason: "nothing eligible is expected to beat holding ether after costs and risk",
    };
  }

  const capWei = (balanceWei * BigInt(policy.maxPositionPct)) / 100n;

  return {
    action: "increase",
    opportunityId: best.opportunity.id,
    targetOpportunityId: best.opportunity.id,
    amountWei: freeWei < capWei ? freeWei : capWei,
    reason: `${best.opportunity.label} clears its costs, so the spare liquid balance goes there`,
  };
}
