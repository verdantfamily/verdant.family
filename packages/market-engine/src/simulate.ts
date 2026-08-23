/**
 * Real economic simulation, run before anything is signed.
 *
 * The stage this replaces was a placeholder. `pipeline.ts` recorded, honestly, "No
 * economic simulation was run; this build was judged on its tests and gates" — so a
 * creator approving a market had never been shown what it would charge for a specific
 * trade. This module answers that, and it answers it from the same canonical
 * configuration that will be encoded and deployed, so the answer cannot be about a
 * different market than the one that launches.
 *
 * ## Boundaries are generated, not chosen
 *
 * Every threshold in the configuration automatically produces three cases: one base unit
 * below it, exactly on it, and one base unit above. That triple is where every
 * inclusive/exclusive mistake lives, and it is the specific thing a creator writing "a
 * sell of exactly 1% must pay 4%" is asking to be sure of. Because `compile.ts` has
 * already folded `GT` into `GTE`, the case exactly on the threshold always pays the
 * tier — and if the prompt meant strictly greater, the threshold itself is one unit
 * higher and the triple sits one unit higher with it.
 *
 * "One base unit" is the smallest real distinction the axis has: one token for a size
 * threshold, one second for a time stage, one base unit of the quote asset for a volume
 * stage. Nothing is scaled or rounded to make a nicer-looking number, because the whole
 * point is to test the exact edge.
 */

import type { Evaluation, SwapContext } from "./evaluate.js";
import { evaluate, maximumFeePpm } from "./evaluate.js";
import type { CanonicalConfig, Side } from "./spec.js";
import { exactAmount, thresholdPhrase } from "./threshold.js";
import { formatPercent } from "./units.js";

/** One simulated trade and what it costs. */
export interface SimulationCase {
  /** What this case is testing, for a person reading the review screen. */
  readonly label: string;
  /** Which rule decided the rate, in the same words the cards use. */
  readonly because: string;
  readonly context: SwapContext;
  readonly evaluation: Evaluation;
}

export interface Simulation {
  readonly cases: readonly SimulationCase[];
  /** The highest rate any case could reach. Equal to the configuration's own maximum. */
  readonly maximumFeePpm: number;
}

/**
 * A nominal quote leg: one whole unit of the quote asset.
 *
 * The fee is a percentage of the quote leg, and there is no price here to derive a real
 * one from — a simulation is run before the pool exists. One whole unit makes the
 * resulting amounts read directly as the rate (2% of one unit is 0.02), which is what a
 * creator checking a review screen is actually comparing against their prompt.
 */
function nominalQuote(config: CanonicalConfig): bigint {
  return 10n ** BigInt(config.quoteAsset.decimals);
}

function describe(config: CanonicalConfig, side: Side, evaluation: Evaluation): string {
  if (evaluation.blocked !== null) {
    return `refused: ${side.toLowerCase()}s are capped at ${exactAmount(config, evaluation.blocked.limitTokens)}`;
  }

  const tiers = side === "BUY" ? config.buyTiers : config.sellTiers;

  if (evaluation.tierIndex !== null) {
    const tier = tiers[evaluation.tierIndex]!;

    /*
     * Phrased by the shared describer rather than here.
     *
     * This used to append a literal "or more", which made every `GT` tier read as inclusive in
     * the one table whose entire purpose is to show what happens at a threshold — including on
     * the row immediately below it, where the rate proves the opposite. The boundary triple is
     * the reason this table exists; describing it wrongly defeats it.
     */
    return (
      `the ${side.toLowerCase()} size tier at ${thresholdPhrase(config, tier.thresholdTokens)}, ` +
      `which replaces the ${formatPercent(evaluation.stageFeePpm)} stage rate`
    );
  }

  if (config.ladderAxis === null || evaluation.stageIndex === 0) {
    return `the base rate`;
  }

  const stage = config.stages[evaluation.stageIndex]!;
  return config.ladderAxis === "TIME"
    ? `the stage that begins ${stage.threshold.toString()} seconds after launch`
    : `the stage that begins after ${stage.threshold.toString()} base units of ${config.quoteAsset.symbol} volume`;
}

function caseFor(
  config: CanonicalConfig,
  label: string,
  context: SwapContext,
): SimulationCase {
  const evaluation = evaluate(config, context);
  return { label, because: describe(config, context.side, evaluation), context, evaluation };
}

/** A context with everything at its opening value, which the callers then vary one field of. */
function opening(config: CanonicalConfig, side: Side, grossTokenAmount: bigint): SwapContext {
  return {
    side,
    grossTokenAmount,
    grossQuoteAmount: nominalQuote(config),
    elapsedSeconds: 0n,
    cumulativeQuoteVolume: 0n,
  };
}

/**
 * Every case worth showing for this configuration.
 *
 * Ordered so it reads as an argument rather than a dump: the ordinary trade first, then
 * each boundary in ascending order, then the ladder, then the ceilings.
 */
export function simulate(config: CanonicalConfig): Simulation {
  const cases: SimulationCase[] = [];

  for (const side of ["BUY", "SELL"] as const) {
    const tiers = side === "BUY" ? config.buyTiers : config.sellTiers;

    // An ordinary trade: below every tier, so it pays the stage rate. One millionth of
    // supply is small enough to sit under any tier a real prompt states.
    const ordinary = config.referenceSupply / 1_000_000n;
    if (ordinary > 0n) {
      cases.push(
        caseFor(
          config,
          `an ordinary ${side.toLowerCase()} of ${exactAmount(config, ordinary)}`,
          opening(config, side, ordinary),
        ),
      );
    }

    for (const tier of tiers) {
      const at = tier.thresholdTokens;
      const share = exactAmount(config, at);

      if (at > 1n) {
        cases.push(
          caseFor(
            config,
            `a ${side.toLowerCase()} one token below the ${share} tier`,
            opening(config, side, at - 1n),
          ),
        );
      }
      cases.push(
        // `exactAmount` already says "of supply" where the amount is a share, so this does not.
        caseFor(config, `a ${side.toLowerCase()} of exactly ${share}`, opening(config, side, at)),
      );
      cases.push(
        caseFor(
          config,
          `a ${side.toLowerCase()} one token above the ${share} tier`,
          opening(config, side, at + 1n),
        ),
      );
    }
  }

  // The ladder, at each stage boundary, on both sides. Uses a trade small enough that no
  // tier interferes, so each case isolates the stage.
  if (config.ladderAxis !== null) {
    const small = config.referenceSupply / 1_000_000n;

    for (const [index, stage] of config.stages.entries()) {
      if (index === 0) continue;

      for (const side of ["BUY", "SELL"] as const) {
        const axis = config.ladderAxis;
        const unit = axis === "TIME" ? "second" : `base unit of ${config.quoteAsset.symbol}`;

        const withProgress = (progress: bigint): SwapContext => ({
          ...opening(config, side, small),
          ...(axis === "TIME" ? { elapsedSeconds: progress } : { cumulativeQuoteVolume: progress }),
        });

        if (stage.threshold > 0n) {
          cases.push(
            caseFor(
              config,
              `a ${side.toLowerCase()} one ${unit} before stage ${String(index)} begins`,
              withProgress(stage.threshold - 1n),
            ),
          );
        }
        cases.push(
          caseFor(
            config,
            `a ${side.toLowerCase()} exactly as stage ${String(index)} begins`,
            withProgress(stage.threshold),
          ),
        );
      }
    }
  }

  // The ceilings: the largest permitted trade, and the smallest refused one.
  for (const side of ["BUY", "SELL"] as const) {
    const ceiling = side === "BUY" ? config.maxBuyTokens : config.maxSellTokens;
    if (ceiling === null) continue;

    cases.push(
      caseFor(
        config,
        `a ${side.toLowerCase()} exactly at the ${exactAmount(config, ceiling)} ceiling`,
        opening(config, side, ceiling),
      ),
    );
    cases.push(
      caseFor(
        config,
        `a ${side.toLowerCase()} one token above the ceiling`,
        opening(config, side, ceiling + 1n),
      ),
    );
  }

  return { cases, maximumFeePpm: maximumFeePpm(config) };
}
