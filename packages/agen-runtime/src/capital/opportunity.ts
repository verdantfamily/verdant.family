/**
 * Somewhere capital could go, and everything measurable about it.
 *
 * An opportunity is deliberately not "a pool" or "a lending market". It is a set of numbers that the
 * scoring layer can compare, produced by a {@link OpportunitySource} that knows how to read one kind
 * of venue. Adding a venue means writing a source; nothing downstream of this file learns a new
 * concept, which is what makes the abstraction worth having rather than an indirection.
 *
 * ## Every metric is required
 *
 * There are no optional fields. A source that cannot measure volatility must say what it is claiming —
 * and if it does not know, the honest claim is the pessimistic one, not `undefined`. Optional metrics
 * would let a venue score well by declining to report the thing that made it risky, and the scoring
 * layer would have no way to tell "low volatility" from "unmeasured volatility".
 *
 * ## What exists on this chain today
 *
 * One source: {@link idleCashSource}. Robinhood Chain has no lending protocol, and every Agen pool
 * refuses third-party liquidity in its hook — `beforeAddLiquidity` reverts unless the initiator is the
 * factory, so exactly one position ever exists in an Instant pool and it is the locked one. There is
 * therefore no LP source and no lending source to write, and the honest eligible set is cash.
 *
 * This is written down here rather than left implicit because the shape of this file invites somebody
 * to add `uniswapV4Source` and find it returning nothing. It would return nothing because the venue
 * does not admit outside liquidity, not because the source was wrong.
 */

import type { Policy, ProtocolTier } from "./policy";

export type OpportunityKind = "lp" | "lending" | "cash";

/**
 * Normalised, comparable measurements.
 *
 * Rates are decimals — `0.12` is 12% a year, not 12. Amounts are wei. Everything on a 0–1 scale is a
 * proportion where 1 is the worst case, so a reader never has to remember which direction a particular
 * metric points.
 */
export interface OpportunityMetrics {
  /** Headline annual rate before any cost or risk is taken off. Never used for ranking on its own. */
  readonly grossApr: number;
  /** How deep the venue is. Thin venues cost more to leave than to enter. */
  readonly liquidityWei: bigint;
  /** Turnover over the last day, which is what a fee-earning position is actually paid on. */
  readonly volume24hWei: bigint;
  /** Annualised volatility of the position's value, as a decimal. */
  readonly volatility: number;
  /** Exposure to divergence loss, 0 for a single-asset position and 1 for the pathological case. */
  readonly ilExposure: number;
  /** How concentrated the underlying holding is, 0 broad and 1 effectively one holder. */
  readonly concentration: number;
  /** The share of {@link grossApr} that comes from incentives rather than fees, 0 to 1. */
  readonly incentiveDependence: number;
  readonly protocolTier: ProtocolTier;
  /** Gas plus expected slippage to enter, in wei, at the size being considered. */
  readonly entryCostWei: bigint;
  /** The same to leave. Usually the larger of the two, and the one people forget. */
  readonly exitCostWei: bigint;
}

export interface Opportunity {
  /** Stable across evaluations, so a position can be matched to the thing it was entered from. */
  readonly id: string;
  readonly kind: OpportunityKind;
  /** Short and human: `ETH/USDC 0.05%`, `idle ETH`. Goes in front of the holder. */
  readonly label: string;
  /** The asset symbol a holder would recognise, matched against the policy's allowlist. */
  readonly asset: string;
  readonly metrics: OpportunityMetrics;
}

/**
 * Something that knows how to find one kind of venue.
 *
 * Async because a real source reads a chain or an indexer. Failure is the source's business: a source
 * that cannot reach its data returns nothing rather than throwing, because one unreachable venue is not
 * a reason to stop managing an account.
 */
export interface OpportunitySource {
  readonly id: string;
  discover(): Promise<readonly Opportunity[]>;
}

/** The identifier the idle-cash opportunity always has, so callers can recognise it without matching labels. */
export const CASH_ID = "cash:eth";

/**
 * Holding ether and doing nothing with it.
 *
 * Present as a first-class opportunity rather than as the absence of one, because the allocator has to
 * be able to *choose* cash over a venue that does not clear its costs. If cash were merely the
 * remainder, "everything scored badly" and "everything was allocated" would look identical in the plan.
 *
 * Its return is zero rather than a money-market rate. There is nowhere on this chain paying one.
 */
export function cashOpportunity(): Opportunity {
  return {
    id: CASH_ID,
    kind: "cash",
    label: "idle ETH",
    asset: "ETH",
    metrics: {
      grossApr: 0,
      // Cash has no venue depth to report. Zero would make the liquidity penalty treat the safest
      // holding as the thinnest, so the honest encoding of "there is no venue to be trapped in" is the
      // maximum rather than nothing.
      liquidityWei: 2n ** 127n,
      volume24hWei: 0n,
      volatility: 0,
      ilExposure: 0,
      concentration: 0,
      incentiveDependence: 0,
      protocolTier: "verified",
      entryCostWei: 0n,
      exitCostWei: 0n,
    },
  };
}

/** The only source this chain supports. Documented at the top of this file. */
export const idleCashSource: OpportunitySource = {
  id: "idle-cash",
  discover: async () => [cashOpportunity()],
};

/**
 * Ask every source what it has, and keep going when one fails.
 *
 * A source that throws is dropped with its opportunities. The alternative — one bad indexer aborting
 * the whole evaluation — turns a degraded read into an account that stops being managed, which is
 * strictly worse than an account managed against fewer options.
 */
export async function discoverOpportunities(
  sources: readonly OpportunitySource[],
): Promise<readonly Opportunity[]> {
  const found: Opportunity[] = [];

  for (const source of sources) {
    try {
      found.push(...(await source.discover()));
    } catch {
      // Deliberately silent to the caller and loud in the audit log the caller keeps: this function
      // has no opinion about how a deployment reports a degraded source.
    }
  }

  // Two sources reporting the same venue would otherwise let one opportunity hold two allocations and
  // quietly exceed the per-position ceiling.
  const seen = new Set<string>();
  return found.filter((opportunity) => {
    if (seen.has(opportunity.id)) return false;
    seen.add(opportunity.id);
    return true;
  });
}

/** Why an opportunity is not allowed, or null when it is. Prose, because it is shown to the holder. */
export function ineligibility(opportunity: Opportunity, policy: Policy): string | null {
  if (!policy.allowedAssets.includes(opportunity.asset.toUpperCase())) {
    return `${opportunity.asset} is not in the allowed assets`;
  }

  if (!policy.allowedProtocols.includes(opportunity.metrics.protocolTier)) {
    return `${opportunity.metrics.protocolTier} venues are not allowed by this policy`;
  }

  return null;
}

/** The opportunities a policy permits at all, before anything is scored. */
export function eligible(
  opportunities: readonly Opportunity[],
  policy: Policy,
): readonly Opportunity[] {
  return opportunities.filter((opportunity) => ineligibility(opportunity, policy) === null);
}
