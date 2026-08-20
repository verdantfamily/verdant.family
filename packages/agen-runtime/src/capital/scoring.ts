/**
 * Ranking opportunities by what they are actually expected to return.
 *
 * Everything here is arithmetic on measured inputs. A model may read the output and explain it, argue
 * with it, or decide the whole set is unattractive — but it cannot change a score, because the number
 * that decides where capital goes must be reproducible from the metrics and the coefficients alone.
 * Given the same inputs this function returns the same answer next week, which is the property that
 * makes an audit log worth keeping.
 *
 * ## Why not sort by APR
 *
 * Because the highest APR on any chain is reliably attached to the thing most likely to lose the
 * principal, and usually to a rate that is mostly incentives and will not survive the month. A headline
 * rate is one input of nine here, and every other one subtracts.
 *
 * ## The coefficients are guesses, and they are labelled as such
 *
 * Each default below has a stated reason, and none is claimed to be optimal. They are conservative:
 * where a coefficient could plausibly be higher or lower, it is set so that the error is refusing a
 * good venue rather than entering a bad one. They live in {@link DEFAULT_SCORING} and are passed in
 * rather than read from module scope, so a deployment can change them, a test can pin them, and nobody
 * has to grep for a magic number.
 *
 * ## Units
 *
 * Every rate is a decimal fraction per year. Penalties are in the same unit as the return they are
 * subtracted from, so a score of `0.04` means "expected to net four percent a year after everything
 * this model knows how to charge it for" — and a negative score means the venue is expected to lose
 * money, which is a thing the allocator needs to be able to see rather than a rate of zero.
 */

import type { ProtocolTier } from "./policy";
import type { Opportunity } from "./opportunity";

export interface ScoringConfig {
  /**
   * How hard divergence loss is charged, multiplied by exposure and by volatility.
   *
   * IL is a function of how far the pair moves, so charging it as a flat rate would over-penalise a
   * stable pair and under-penalise a volatile one. At 1.0 a fully exposed position in a venue with 50%
   * annual volatility is charged 50 basis points of return for every 1% of volatility.
   */
  readonly ilWeight: number;
  /**
   * How much volatility alone costs, independent of divergence.
   *
   * Below 1 because volatility is not itself a loss — a position that ends where it started earned its
   * fees regardless of the path. It is charged because a volatile position is one the holder may need to
   * exit at a bad moment, and because our own exit is not instant.
   */
  readonly volatilityWeight: number;
  /**
   * How much being large relative to the venue costs.
   *
   * The dominant term for small accounts in thin venues, which is most of what this system will see.
   * A position that is a meaningful fraction of the liquidity pays its own exit slippage twice: once in
   * the price it gets, and once in the price it moves.
   */
  readonly liquidityWeight: number;
  /** How much a concentrated underlying holding costs. A venue is only as good as what is in it. */
  readonly concentrationWeight: number;
  /**
   * The share of incentive-derived yield treated as not real.
   *
   * At 0.8, a rate that is entirely incentives is counted at a fifth of its headline. Incentives end,
   * usually without notice and usually once enough capital has arrived to make them expensive.
   */
  readonly incentiveHaircut: number;
  /** What each tier of venue costs in expected return, as an annual rate. */
  readonly protocolPenalty: Record<ProtocolTier, number>;
  /**
   * How long a position is assumed to be held, for turning one-off costs into an annual rate.
   *
   * Short on purpose. Assuming a long hold makes entry and exit costs look negligible, which is how an
   * automated rebalancer talks itself into moves that only pay off if it never moves again.
   */
  readonly holdingPeriodDays: number;
  /**
   * How many times the position size the venue's liquidity must be before depth stops being charged.
   *
   * At 20, putting 5% of a venue's liquidity to work is the point where the penalty reaches zero.
   */
  readonly minLiquidityMultiple: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  ilWeight: 1,
  volatilityWeight: 0.25,
  liquidityWeight: 0.5,
  concentrationWeight: 0.1,
  incentiveHaircut: 0.8,
  protocolPenalty: {
    // Reviewed, and the contracts are ones this repository deployed or reads directly.
    verified: 0,
    // Known and widely used, but not reviewed here. Two percent a year is roughly the cost of being
    // wrong about a contract once a lifetime.
    recognised: 0.02,
    // Unreviewed. Priced so that only an exceptional rate can survive it, which is the intent.
    unverified: 0.25,
  },
  holdingPeriodDays: 30,
  minLiquidityMultiple: 20,
};

export type RiskBand = "low" | "medium" | "high";

export interface ScorePenalties {
  readonly impermanentLoss: number;
  readonly volatility: number;
  readonly liquidity: number;
  readonly concentration: number;
  readonly protocol: number;
  /** One-off entry and exit costs, expressed as an annual rate over the assumed holding period. */
  readonly cost: number;
}

export interface Score {
  readonly opportunityId: string;
  /** Headline rate after the incentive haircut, before penalties. */
  readonly expectedGrossApr: number;
  /** What the model expects to keep, per year, after every charge below. */
  readonly score: number;
  readonly penalties: ScorePenalties;
  readonly band: RiskBand;
  /** Why the score is what it is, in the order the terms were applied. Shown to the holder. */
  readonly explanation: readonly string[];
}

/**
 * A ratio of two wei amounts as a `Number`, without losing the answer to floating point.
 *
 * `Number(10n ** 18n)` is already past the point where integers are exact, so dividing two wei values
 * by converting each one first is wrong for exactly the magnitudes this system deals in. Dividing as
 * integers first and scaling afterwards keeps six decimal places, which is more than any coefficient
 * here can justify.
 */
function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0;
  const scale = 1_000_000n;
  return Number((numerator * scale) / denominator) / Number(scale);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

/**
 * How risky a venue is, as one of three words.
 *
 * Separate from the score because a cap on high-risk allocation is a different question from a
 * ranking: a venue can score well *and* be high risk, and the policy limits how much of the balance
 * may sit in that class regardless of how attractive it looks. Collapsing the two would let a good
 * score buy its way past the holder's risk limit.
 */
export function riskBand(opportunity: Opportunity): RiskBand {
  const { volatility, ilExposure, concentration, protocolTier } = opportunity.metrics;

  if (protocolTier === "unverified") return "high";
  if (volatility >= 0.5 || ilExposure >= 0.5 || concentration >= 0.7) return "high";
  if (volatility >= 0.15 || ilExposure >= 0.15 || protocolTier === "recognised") return "medium";
  return "low";
}

/**
 * Score one opportunity at one size.
 *
 * Size matters and is not optional: entry and exit costs are fixed amounts, and depth is relative, so
 * the same venue is a good idea for a small position and a bad one for a large one. A scoring function
 * that ignored size would rank a venue the account cannot fit into above one it can.
 */
export function scoreOpportunity(
  opportunity: Opportunity,
  amountWei: bigint,
  config: ScoringConfig = DEFAULT_SCORING,
): Score {
  const metrics = opportunity.metrics;
  const explanation: string[] = [];

  const expectedGrossApr =
    metrics.grossApr * (1 - config.incentiveHaircut * clamp01(metrics.incentiveDependence));

  if (metrics.incentiveDependence > 0) {
    explanation.push(
      `${pct(metrics.grossApr)} headline, ${pct(expectedGrossApr)} after discounting ` +
        `${pct(metrics.incentiveDependence)} incentive-dependent yield`,
    );
  } else if (metrics.grossApr > 0) {
    explanation.push(`${pct(expectedGrossApr)} expected fee yield`);
  }

  // One-off costs, annualised. A position held for the assumed period pays these once, so the rate a
  // longer hold would show is lower — and assuming the longer hold is how a rebalancer justifies a
  // move it is about to undo.
  const costFraction = amountWei === 0n ? 0 : ratio(metrics.entryCostWei + metrics.exitCostWei, amountWei);
  const cost = costFraction * (365 / config.holdingPeriodDays);

  const impermanentLoss = config.ilWeight * clamp01(metrics.ilExposure) * Math.max(0, metrics.volatility);
  const volatility = config.volatilityWeight * Math.max(0, metrics.volatility);
  const concentration = config.concentrationWeight * clamp01(metrics.concentration);
  const protocol = config.protocolPenalty[metrics.protocolTier];

  // Depth is charged on the shortfall against the multiple, so a venue many times the position's size
  // costs nothing and one the position would dominate costs the full weight.
  const wanted = amountWei * BigInt(Math.max(1, Math.round(config.minLiquidityMultiple)));
  const shortfall = wanted === 0n ? 0 : clamp01(1 - ratio(metrics.liquidityWei, wanted));
  const liquidity = config.liquidityWeight * shortfall;

  const penalties: ScorePenalties = {
    impermanentLoss,
    volatility,
    liquidity,
    concentration,
    protocol,
    cost,
  };

  const score =
    expectedGrossApr - impermanentLoss - volatility - liquidity - concentration - protocol - cost;

  if (cost > 0) explanation.push(`${pct(cost)} a year in entry and exit costs at this size`);
  if (liquidity > 0) explanation.push(`${pct(liquidity)} charged for thin liquidity relative to the position`);
  if (impermanentLoss > 0) explanation.push(`${pct(impermanentLoss)} charged for divergence exposure`);
  if (volatility > 0) explanation.push(`${pct(volatility)} charged for volatility`);
  if (protocol > 0) explanation.push(`${pct(protocol)} charged for an unreviewed venue`);
  if (concentration > 0) explanation.push(`${pct(concentration)} charged for a concentrated holding`);

  explanation.push(
    score >= 0
      ? `net ${pct(score)} a year risk-adjusted`
      : `expected to lose ${pct(-score)} a year after costs and risk`,
  );

  return {
    opportunityId: opportunity.id,
    expectedGrossApr,
    score,
    penalties,
    band: riskBand(opportunity),
    explanation,
  };
}

/**
 * Score a venue for somebody who is already in it.
 *
 * Entering and continuing are different questions, and the difference is the costs. The entry cost of a
 * position already held is sunk — it was paid, and no decision available now can unpay it. The exit cost
 * is deferred rather than avoided: it will be paid on the way out whenever that is, so it is not a cost
 * of *continuing*, and it is charged against the alternative in `rebalance.ts` as part of the price of
 * moving.
 *
 * Using {@link scoreOpportunity} for a held position instead of this gets the comparison exactly wrong:
 * the held venue is charged its exit cost, the migration is charged the same exit cost again, and the two
 * cancel, so a venue that is expensive to leave becomes *easier* to talk yourself out of. That is backwards
 * — being expensive to leave is a reason to stay.
 */
export function forwardScore(
  opportunity: Opportunity,
  amountWei: bigint,
  config: ScoringConfig = DEFAULT_SCORING,
): Score {
  return scoreOpportunity(
    { ...opportunity, metrics: { ...opportunity.metrics, entryCostWei: 0n, exitCostWei: 0n } },
    amountWei,
    config,
  );
}

/**
 * Score a set at one size, best first.
 *
 * Ties break on identifier rather than being left to sort stability, so two venues that genuinely
 * score the same produce the same ordering on every run and a plan can be compared to the one before it.
 */
export function rankOpportunities(
  opportunities: readonly Opportunity[],
  amountWei: bigint,
  config: ScoringConfig = DEFAULT_SCORING,
): readonly Score[] {
  return [...opportunities]
    .map((opportunity) => scoreOpportunity(opportunity, amountWei, config))
    .sort((left, right) =>
      right.score === left.score
        ? left.opportunityId.localeCompare(right.opportunityId)
        : right.score - left.score,
    );
}
