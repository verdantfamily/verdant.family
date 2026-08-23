/**
 * The reference evaluator. What a market charges, and where it goes.
 *
 * This is the authority. `AgenRuleLib.sol` is held to it by differential vectors, the
 * simulator drives it, and the review cards and execution graph describe it. If the
 * Solidity and this file disagree about a swap, the Solidity is wrong by definition.
 *
 * ## Which leg the fee is a percentage of
 *
 * `config.feeCurrency`, which the compiler derives rather than anyone choosing — see
 * ADR-018 and `orientation.ts`. A market with launched-token size tiers collects in the
 * launched token; one without collects in the quote asset.
 *
 * Size thresholds are always measured on the **token** leg, whatever the fee is
 * denominated in, because "a sell of at least 1% of supply" is a statement about tokens
 * and would mean something entirely different measured in ether.
 *
 * ## Every amount here is gross: pre-fee, always
 *
 * The rule that makes tier selection well defined at all. A size threshold is evaluated
 * against the launched-token amount attributable to the underlying pool swap **before
 * Agen's programmable fee is applied**. The fee never participates in deciding whether
 * its own tier activates, because that is circular: the rate would depend on the amount,
 * which would depend on the fee, which would depend on the rate.
 *
 * The sequence is fixed and has no other order:
 *
 *   derive side -> derive gross token amount -> evaluate threshold
 *   -> determine rate -> calculate fee -> settle fee
 *
 * and never:
 *
 *   apply fee -> alter token amount -> evaluate tier on the altered amount
 *
 * This holds identically for all four swap shapes and both currency orientations. What
 * "gross" resolves to on chain is the one thing that differs between them, and it is
 * `AgenEngineHook`'s job to supply it:
 *
 *  - **the token is the swap's specified currency** — gross is `|amountSpecified|`, the
 *    amount the trader named. The pool's own swap is then adjusted by exactly the fee via
 *    `BeforeSwapDelta`, so the named amount *is* the pre-fee figure by construction.
 *  - **the token is unspecified** — gross is the token component of the `BalanceDelta`,
 *    read in `afterSwap`. `beforeSwap` contributed no delta in this case, so the pool
 *    computed that leg without any knowledge of Agen's fee.
 *
 * It follows that classification cannot be moved by fee rounding, and cannot be moved by
 * the fee happening to be denominated in the launched token. There is a boundary test for
 * each of those in `evaluate.test.ts` and a real-swap test for each shape in
 * `EngineHook.swaps.t.sol`.
 *
 * ## Precedence, stated once
 *
 *   1. The active stage sets the rate for this side.
 *   2. The highest matching size tier for this side **replaces** it.
 *   3. Nothing is added to anything. There is no path where two rates combine.
 *
 * "Highest matching" is well defined because `compile.ts` sorts tiers ascending and
 * refuses two tiers at the same threshold with different rates. The result does not
 * depend on the order the model happened to emit them in.
 *
 * ## When the volume ladder advances
 *
 * A volume stage is chosen from the volume accumulated **before** this trade. Counting
 * the trade itself would make its own fee depend on its own size, which is circular and
 * would also mean a single large trade could pay a rate that no prior trade could have
 * predicted. Documented here because it is the sort of thing that is obvious in one
 * direction only after someone has picked the other.
 */

import type { CanonicalConfig, CanonicalStage, CanonicalTier, FeeCurrency, Recipient, Side } from "./spec.js";
import { PPM_ONE, feeOf, shareOf } from "./units.js";

/**
 * Everything the evaluator needs to know about one swap.
 *
 * Both leg amounts are **gross** — the pool swap's own figures, before Agen's fee is
 * applied to either. The names say so, because the whole correctness of tier selection
 * rests on it and a field called `tokenAmount` would not have told anybody which one it
 * meant.
 */
export interface SwapContext {
  readonly side: Side;
  /**
   * The launched-token leg before Agen's fee, in token base units.
   *
   * What tiers and ceilings are evaluated against. See this module's header for how the
   * hook resolves it in each of the four swap shapes.
   */
  readonly grossTokenAmount: bigint;
  /**
   * The quote leg before Agen's fee, in quote base units.
   *
   * The fee base on a `QUOTE` market, and — independently of the fee currency — what
   * `CUMULATIVE_QUOTE_VOLUME` accumulates. A market may perfectly well collect its fee in
   * the launched token while its volume trigger counts quote: the two are separate
   * concepts and neither is defined in terms of the other.
   */
  readonly grossQuoteAmount: bigint;
  /** Seconds since the pool was initialised. Read only on a `TIME` ladder. */
  readonly elapsedSeconds: bigint;
  /** Quote volume accumulated by *earlier* trades. Read only on a `QUOTE_VOLUME` ladder. */
  readonly cumulativeQuoteVolume: bigint;
}

/** Why a trade cannot proceed. The only deliberate revert on the swap path. */
export interface TradeBlock {
  readonly reason: "MAX_TRADE_SIZE";
  readonly side: Side;
  readonly limitTokens: bigint;
  readonly attemptedTokens: bigint;
}

export interface Payout {
  readonly recipient: Recipient;
  readonly sharePpm: number;
  /** In the market's fee currency, which `CanonicalConfig.feeCurrency` names. */
  readonly amount: bigint;
}

export interface Evaluation {
  readonly side: Side;
  /** Set when a protection refuses the trade. Every other field then describes what it *would* have cost. */
  readonly blocked: TradeBlock | null;
  readonly stageIndex: number;
  readonly stageFeePpm: number;
  /** Which tier won, as an index into this side's canonical tiers, or `null` for none. */
  readonly tierIndex: number | null;
  readonly effectiveFeePpm: number;
  /** Which leg the fee was taken from. Fixed by the configuration, not by the swap. */
  readonly feeCurrency: FeeCurrency;
  /** The fee, in `feeCurrency`. */
  readonly feeAmount: bigint;
  readonly payouts: readonly Payout[];
}

/** This side's tiers. */
function tiersFor(config: CanonicalConfig, side: Side): readonly CanonicalTier[] {
  return side === "BUY" ? config.buyTiers : config.sellTiers;
}

/** This side's ceiling, or `null`. */
function ceilingFor(config: CanonicalConfig, side: Side): bigint | null {
  return side === "BUY" ? config.maxBuyTokens : config.maxSellTokens;
}

function feeOfStage(stage: CanonicalStage, side: Side): number {
  return side === "BUY" ? stage.buyFeePpm : stage.sellFeePpm;
}

/**
 * The index of the active stage.
 *
 * Scans backwards and returns the first stage whose threshold has been passed, which is
 * the last stage in ascending order that qualifies. Stage 0's threshold is 0 and always
 * qualifies, so this is total: there is no input for which no stage is active.
 */
export function activeStageIndex(config: CanonicalConfig, context: SwapContext): number {
  if (config.ladderAxis === null) return 0;

  const progress = config.ladderAxis === "TIME" ? context.elapsedSeconds : context.cumulativeQuoteVolume;

  for (let index = config.stages.length - 1; index > 0; index--) {
    if (progress >= config.stages[index]!.threshold) return index;
  }
  return 0;
}

/**
 * The highest matching tier for this side, or `null`.
 *
 * Backwards for the same reason as stages: the last tier in ascending order whose
 * threshold is met is the one that wins, and scanning from the top returns it
 * immediately for the large trades that are the reason tiers exist.
 */
export function matchingTierIndex(
  tiers: readonly CanonicalTier[],
  tokenAmount: bigint,
): number | null {
  for (let index = tiers.length - 1; index >= 0; index--) {
    if (tokenAmount >= tiers[index]!.thresholdTokens) return index;
  }
  return null;
}

/**
 * Split a collected fee across the canonical distribution.
 *
 * Every share rounds **down**, and the remainder those roundings leave over goes to the
 * first recipient in canonical order. That is a stated rule rather than an accident: the
 * sum of the payouts equals the fee exactly, always, which is the one property a splitter
 * has to have. Rounding each share to nearest can pay out more than was collected.
 *
 * The remainder is at most `recipients - 1` base units, so at four recipients the
 * favoured party gains at most three wei of whatever the quote asset is.
 */
export function distribute(config: CanonicalConfig, feeAmount: bigint): readonly Payout[] {
  if (config.distribution.length === 0 || feeAmount === 0n) {
    return config.distribution.map((share) => ({
      recipient: share.recipient,
      sharePpm: share.sharePpm,
      amount: 0n,
    }));
  }

  const payouts = config.distribution.map((share) => ({
    recipient: share.recipient,
    sharePpm: share.sharePpm,
    amount: shareOf(feeAmount, share.sharePpm),
  }));

  const paid = payouts.reduce((sum, payout) => sum + payout.amount, 0n);
  const remainder = feeAmount - paid;

  if (remainder > 0n) {
    const first = payouts[0]!;
    payouts[0] = { ...first, amount: first.amount + remainder };
  }

  return payouts;
}

/**
 * What this swap costs under this configuration.
 *
 * Total: there is no valid configuration and context for which this throws or returns
 * nothing. A blocked trade still reports the fee it would have paid, so the simulator can
 * show a creator both facts about a trade at the ceiling.
 */
export function evaluate(config: CanonicalConfig, context: SwapContext): Evaluation {
  const stageIndex = activeStageIndex(config, context);
  const stageFeePpm = feeOfStage(config.stages[stageIndex]!, context.side);

  // Gross, so the fee cannot move the tier that decides the fee.
  const tiers = tiersFor(config, context.side);
  const tierIndex = matchingTierIndex(tiers, context.grossTokenAmount);

  const effectiveFeePpm = tierIndex === null ? stageFeePpm : tiers[tierIndex]!.feePpm;

  // Gross for the same reason: a ceiling is a statement about the trade the trader asked
  // for, not about what was left of it after Agen took a cut.
  const ceiling = ceilingFor(config, context.side);
  const blocked: TradeBlock | null =
    ceiling !== null && context.grossTokenAmount > ceiling
      ? {
          reason: "MAX_TRADE_SIZE",
          side: context.side,
          limitTokens: ceiling,
          attemptedTokens: context.grossTokenAmount,
        }
      : null;

  // The leg the fee comes out of is the configuration's, not the swap's. See ADR-018.
  const feeBase = config.feeCurrency === "QUOTE" ? context.grossQuoteAmount : context.grossTokenAmount;
  const feeAmount = feeOf(feeBase, effectiveFeePpm);

  return {
    side: context.side,
    blocked,
    stageIndex,
    stageFeePpm,
    tierIndex,
    effectiveFeePpm,
    feeCurrency: config.feeCurrency,
    feeAmount,
    payouts: distribute(config, feeAmount),
  };
}

/**
 * The highest rate this configuration can ever charge, in ppm.
 *
 * Used by the review screen to state a worst case, and by the fuzz invariants as the
 * bound no evaluation may exceed. Deliberately computed from the configuration rather
 * than carried as a field, so it cannot drift from the rules it summarises.
 */
export function maximumFeePpm(config: CanonicalConfig): number {
  let highest = 0;
  for (const stage of config.stages) {
    highest = Math.max(highest, stage.buyFeePpm, stage.sellFeePpm);
  }
  for (const tier of [...config.buyTiers, ...config.sellTiers]) {
    highest = Math.max(highest, tier.feePpm);
  }
  return highest;
}

/** Whether the distribution accounts for exactly one whole. Asserted by the invariants. */
export function distributionIsWhole(config: CanonicalConfig): boolean {
  if (config.distribution.length === 0) return maximumFeePpm(config) === 0;
  return config.distribution.reduce((sum, share) => sum + share.sharePpm, 0) === PPM_ONE;
}
