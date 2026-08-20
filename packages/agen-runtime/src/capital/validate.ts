/**
 * The check that stands between a plan and a transaction.
 *
 * Deliberately a second implementation of the same limits the planner applied. That duplication is the
 * point and should not be refactored away: a validator that called the planner's helpers would agree
 * with the planner by construction, including when the planner is wrong, and would catch nothing. Here
 * the limits are re-derived from the policy and the balance, and the plan is treated as an untrusted
 * document that arrived from somewhere.
 *
 * It matters that it is untrusted, because a plan does not have to come from `planAllocation`. A model
 * asked to propose one, a retried scheduler run replaying an old one, or a future surface posting one
 * over HTTP all produce the same shape, and none of them is more trustworthy than this function's
 * refusal to accept it.
 *
 * ## Refuse, do not repair
 *
 * Nothing here trims an oversized position down to the cap. A plan that breaches a limit is evidence
 * that whatever produced it was working from different rules, and quietly correcting it would execute a
 * plan nobody proposed while hiding the disagreement. The plan is rejected with every violation listed,
 * and the caller decides whether to fall back to all cash.
 */

import { type Policy } from "./policy";
import { ineligibility, type Opportunity } from "./opportunity";
import { riskBand } from "./scoring";
import type { AllocationPlan } from "./allocation";

export interface Violation {
  /** Stable enough to switch on, in the code that decides how loudly to complain. */
  readonly code:
    | "NEGATIVE_AMOUNT"
    | "UNKNOWN_OPPORTUNITY"
    | "INELIGIBLE_OPPORTUNITY"
    | "DUPLICATE_POSITION"
    | "POSITION_CAP_EXCEEDED"
    | "HIGH_RISK_CAP_EXCEEDED"
    | "CASH_FLOOR_BREACHED"
    | "TOTAL_EXCEEDS_BALANCE"
    | "LEVERAGE_FORBIDDEN";
  readonly message: string;
}

export type Validation =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly Violation[] };

/** Rounded down, matching the direction a ceiling has to round to stay a ceiling. */
function floorPct(amountWei: bigint, percent: number): bigint {
  return (amountWei * BigInt(Math.max(0, Math.round(percent)))) / 100n;
}

/** Rounded up, matching the direction a floor has to round to stay a floor. */
function ceilPct(amountWei: bigint, percent: number): bigint {
  const scaled = amountWei * BigInt(Math.max(0, Math.round(percent)));
  return scaled % 100n === 0n ? scaled / 100n : scaled / 100n + 1n;
}

function eth(amountWei: bigint): string {
  // Four decimal places, which is enough to recognise an amount without pretending to wei precision in
  // a sentence a person is going to read.
  const whole = amountWei / 10n ** 18n;
  const frac = ((amountWei % 10n ** 18n) * 10_000n) / 10n ** 18n;
  return `${String(whole)}.${String(frac).padStart(4, "0")} ETH`;
}

/**
 * Check a plan against the policy that is supposed to govern it.
 *
 * `leveraged` is passed in rather than inferred, because leverage is a property of the execution route
 * and not of the plan's arithmetic. A caller that cannot say returns `false` and the check is a no-op;
 * a caller building a borrowed position must say `true`, and under every policy this system currently
 * produces that is a refusal.
 */
export function validatePlan({
  plan,
  balanceWei,
  policy,
  opportunities,
  leveraged = false,
}: {
  readonly plan: AllocationPlan;
  readonly balanceWei: bigint;
  readonly policy: Policy;
  readonly opportunities: readonly Opportunity[];
  readonly leveraged?: boolean;
}): Validation {
  const violations: Violation[] = [];

  if (leveraged && !policy.allowLeverage) {
    violations.push({
      code: "LEVERAGE_FORBIDDEN",
      message: "this plan uses leverage and the policy does not allow it",
    });
  }

  const byId = new Map(opportunities.map((opportunity) => [opportunity.id, opportunity]));
  const positionCapWei = floorPct(balanceWei, policy.maxPositionPct);
  const highRiskCapWei = floorPct(balanceWei, policy.maxHighRiskPct);
  const cashFloorWei = ceilPct(balanceWei, policy.minCashPct);

  const seen = new Set<string>();
  let deployedWei = 0n;
  let highRiskWei = 0n;

  for (const position of plan.positions) {
    if (position.amountWei <= 0n) {
      violations.push({
        code: "NEGATIVE_AMOUNT",
        message: `${position.opportunityId} is allocated ${eth(position.amountWei)}`,
      });
      continue;
    }

    if (seen.has(position.opportunityId)) {
      violations.push({
        code: "DUPLICATE_POSITION",
        message: `${position.opportunityId} appears more than once, which would let one venue hold two allocations`,
      });
      continue;
    }
    seen.add(position.opportunityId);

    const opportunity = byId.get(position.opportunityId);
    if (opportunity === undefined) {
      violations.push({
        code: "UNKNOWN_OPPORTUNITY",
        message: `${position.opportunityId} is not in the set of discovered opportunities`,
      });
      continue;
    }

    const reason = ineligibility(opportunity, policy);
    if (reason !== null) {
      violations.push({
        code: "INELIGIBLE_OPPORTUNITY",
        message: `${opportunity.label} is not allowed: ${reason}`,
      });
    }

    if (position.amountWei > positionCapWei) {
      violations.push({
        code: "POSITION_CAP_EXCEEDED",
        message:
          `${opportunity.label} is allocated ${eth(position.amountWei)}, over the ` +
          `${String(policy.maxPositionPct)}% ceiling of ${eth(positionCapWei)}`,
      });
    }

    deployedWei += position.amountWei;
    if (riskBand(opportunity) === "high") highRiskWei += position.amountWei;
  }

  if (highRiskWei > highRiskCapWei) {
    violations.push({
      code: "HIGH_RISK_CAP_EXCEEDED",
      message:
        `${eth(highRiskWei)} is in high-risk positions, over the ` +
        `${String(policy.maxHighRiskPct)}% allowance of ${eth(highRiskCapWei)}`,
    });
  }

  if (deployedWei > balanceWei) {
    violations.push({
      code: "TOTAL_EXCEEDS_BALANCE",
      message: `the plan deploys ${eth(deployedWei)} from a balance of ${eth(balanceWei)}`,
    });
  }

  // Checked against the balance minus what is deployed rather than against the plan's own `cashWei`,
  // so a plan that simply misreports its cash cannot pass by claiming a figure it does not leave.
  const actualCashWei = balanceWei - deployedWei;
  if (actualCashWei < cashFloorWei) {
    violations.push({
      code: "CASH_FLOOR_BREACHED",
      message:
        `the plan leaves ${eth(actualCashWei)} liquid, below the ` +
        `${String(policy.minCashPct)}% floor of ${eth(cashFloorWei)}`,
    });
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
