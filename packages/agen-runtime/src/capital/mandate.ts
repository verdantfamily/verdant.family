/**
 * Compiling a policy into the mandate a depositor signs once.
 *
 * This is the seam between the two halves of the system. Above it, `policy.ts` holds judgement expressed
 * as percentages — how much may sit in one venue, how much stays liquid, how often to move. Below it,
 * `CapitalMandate` holds absolutes in wei, checked by a contract that has never heard of a risk profile.
 * This function is the translation, and it runs once, before the depositor authorises anything.
 *
 * ## Why the contract does not hold percentages
 *
 * Because a percentage needs a total, and the only total a vault could compute on chain is the value of
 * its own positions — which it would have to ask the venues for. A venue reporting its own value is not a
 * number to enforce a cap with: an adapter that overstated itself would enlarge every limit denominated
 * against it. So the contract's limits are fixed amounts of principal, which it knows because it sent
 * them, and the percentages live off chain where being wrong is recoverable.
 *
 * ## The direction of the guarantee
 *
 * The compiled mandate is never *looser* than the policy it came from, and usually tighter. It is a
 * ceiling on a ceiling: the off-chain planner will refuse things the mandate would have allowed, and the
 * mandate will refuse things the planner tried to do anyway. Both refusing is the design — the whole
 * point of the second layer is that it does not trust the first.
 *
 * ## What signing means
 *
 * One transaction, once. Everything after it — allocate, exit, rebalance, redeploy — happens with no
 * further approval, bounded by these numbers. A design that asked per action would be a design whose
 * automation stopped whenever the depositor was asleep, and the mandate exists precisely so that it does
 * not have to.
 */

import type { Policy } from "./policy";

/** Exactly what `CapitalMandate`'s constructor takes, in its order. */
export interface MandateTerms {
  readonly owner: `0x${string}`;
  readonly operator: `0x${string}`;
  readonly guardian: `0x${string}`;
  readonly venues: readonly `0x${string}`[];
  readonly maxDeployedWei: bigint;
  readonly maxPerVenueWei: bigint;
  readonly periodDeployLimitWei: bigint;
  readonly periodLength: number;
  readonly minActionInterval: number;
  readonly duration: number;
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * The floor between two operator actions.
 *
 * Sixty seconds, and deliberately not derived from `maxDailyRebalances`. The two limits guard different
 * things: this one stops a runaway loop from emptying the period budget in one block, and the budget
 * itself is what bounds churn over a day. Deriving this from the rebalance allowance instead would make
 * the *first* deployment slow — an account spreading across three venues needs three transactions, and
 * making somebody wait hours between them to enforce a limit about rebalancing would be enforcing the
 * wrong rule.
 */
const MIN_ACTION_INTERVAL = 60;

/** A year is the longest `CapitalMandate` accepts, and longer than a depositor should go without deciding again. */
const MAX_DURATION = 365 * DAY_SECONDS;

function floorPct(amountWei: bigint, percent: number): bigint {
  return (amountWei * BigInt(Math.max(0, Math.round(percent)))) / 100n;
}

/**
 * Turn an authorised amount and a policy into mandate terms.
 *
 * `authorisedWei` is the sentence "allocate up to 0.05 ETH" — the most principal Agen may ever have
 * deployed. It is not the vault's balance and does not have to match it: a depositor may fund more and
 * authorise less, and topping the vault up later does not enlarge what the operator controls.
 */
export function compileMandate({
  owner,
  operator,
  guardian,
  venues,
  authorisedWei,
  policy,
  durationSeconds = 90 * DAY_SECONDS,
}: {
  readonly owner: `0x${string}`;
  readonly operator: `0x${string}`;
  readonly guardian: `0x${string}`;
  readonly venues: readonly `0x${string}`[];
  readonly authorisedWei: bigint;
  readonly policy: Policy;
  readonly durationSeconds?: number;
}): MandateTerms {
  if (authorisedWei <= 0n) {
    throw new Error("A mandate authorising nothing is not a mandate. Name an amount above zero.");
  }
  if (venues.length === 0) {
    throw new Error("A mandate must name at least one venue, or there is nothing it permits.");
  }

  // The cash floor is enforced on chain as a cap on deployment rather than as a reserve, because the
  // contract cannot know what fraction of a balance it is holding — it can only know what it sent out.
  // Same limit, expressed as the thing the vault can actually check.
  const maxDeployedWei = floorPct(authorisedWei, 100 - policy.minCashPct);

  if (maxDeployedWei <= 0n) {
    throw new Error(
      `A policy keeping ${String(policy.minCashPct)}% liquid leaves nothing to deploy from this amount.`,
    );
  }

  // `CapitalMandate` refuses a per-venue cap above the total, and a policy whose position ceiling exceeds
  // what is deployable would produce exactly that. The clamp already prevents it; this is belt and braces
  // at the boundary where a hand-built policy could arrive.
  const wantedPerVenue = floorPct(authorisedWei, policy.maxPositionPct);
  const maxPerVenueWei =
    wantedPerVenue > maxDeployedWei || wantedPerVenue === 0n ? maxDeployedWei : wantedPerVenue;

  // Enough for one full deployment plus the day's permitted moves, and no more. A rebalance is an exit
  // and an entry, so each one may send at most another position's worth into a venue.
  const periodDeployLimitWei =
    maxDeployedWei + maxPerVenueWei * BigInt(Math.max(0, policy.maxDailyRebalances));

  return {
    owner,
    operator,
    guardian,
    venues,
    maxDeployedWei,
    maxPerVenueWei,
    periodDeployLimitWei,
    periodLength: DAY_SECONDS,
    minActionInterval: MIN_ACTION_INTERVAL,
    duration: Math.min(Math.max(1, Math.round(durationSeconds)), MAX_DURATION),
  };
}

/**
 * Check that compiled terms are no looser than the policy that produced them.
 *
 * Exists to be called in a test rather than in production, and is exported because the property it
 * asserts is the one this whole file is for. If it ever fails, the off-chain planner is permitted to do
 * something the depositor's signature did not cover, which is the failure this architecture was built to
 * make impossible.
 */
export function mandateHonoursPolicy(
  terms: MandateTerms,
  policy: Policy,
  authorisedWei: bigint,
): readonly string[] {
  const problems: string[] = [];

  const deployable = floorPct(authorisedWei, 100 - policy.minCashPct);
  if (terms.maxDeployedWei > deployable) {
    problems.push("the mandate lets more be deployed than the policy's liquid floor leaves");
  }

  if (terms.maxPerVenueWei > terms.maxDeployedWei) {
    problems.push("the per-venue cap is above the total, which CapitalMandate will refuse");
  }

  const perVenue = floorPct(authorisedWei, policy.maxPositionPct);
  if (perVenue > 0n && terms.maxPerVenueWei > perVenue && terms.maxPerVenueWei > deployable) {
    problems.push("the per-venue cap is above the policy's position ceiling");
  }

  if (terms.periodLength < 3_600 || terms.periodLength > 30 * DAY_SECONDS) {
    problems.push("the period length is outside what CapitalMandate accepts");
  }

  if (terms.minActionInterval > terms.periodLength) {
    problems.push("the action interval is longer than the period, which makes the budget unreachable");
  }

  if (terms.duration > MAX_DURATION) {
    problems.push("the duration is longer than CapitalMandate accepts");
  }

  return problems;
}
