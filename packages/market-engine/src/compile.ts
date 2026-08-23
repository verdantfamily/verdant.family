/**
 * `AgenMarketSpec` -> `CanonicalConfig`. Validation, normalization, canonicalization.
 *
 * Pure, total, and deterministic: the same specification and binding always produce the
 * same canonical configuration, byte for byte, and nothing here reads a clock, a chain
 * or a random source.
 *
 * ## The line between representation and economics
 *
 * Canonicalization is allowed to rewrite *how* a market is written down and forbidden to
 * change *what it does*. Four rewrites happen here, and each is exact rather than
 * approximate:
 *
 *  - **`GT` becomes `GTE`.** `> T` and `>= T + 1` admit precisely the same set of trades,
 *    because token amounts are integers and nothing lies between `T` and `T + 1`. The
 *    runtime then has one comparison instead of two, and the Solidity cannot disagree
 *    with the TypeScript about which operator a tier meant.
 *
 *  - **The base rate becomes stage 0.** A market with one rate is a ladder with one
 *    stage. This is why there is no precedence question between "the base fee" and "the
 *    ladder" — there is only the ladder.
 *
 *  - **Percentages of supply become token amounts.** Resolved once, against the frozen
 *    reference supply, so the swap path never divides and never calls `totalSupply()`.
 *
 *  - **Repeated recipients merge.** `[creator 50%, creator 50%]` and `[creator 100%]` are
 *    the same market and must hash the same. Merging is economics-preserving by
 *    construction: addition is not a judgement.
 *
 * Ordering is imposed on tiers, stages and recipients, which is what makes a reordered
 * answer from the model produce an identical hash.
 *
 * ## What this refuses to decide
 *
 * Nothing is defaulted. Not the base rate, not a threshold, not where the money goes. A
 * market whose fee is non-zero and whose distribution is empty is refused rather than
 * pointed at a treasury, because the interpretation layer above is the place where a
 * sensible default can be proposed *and shown to the creator as an assumption*. A
 * default applied down here would be a decision nobody was told about.
 */

import { MAX_RECIPIENTS, MAX_STAGES, MAX_TIERS_PER_SIDE, MAX_TIME_HORIZON_SECONDS, MIN_TIME_STAGE_GAP_SECONDS } from "./bounds.js";
import type { EngineProblem } from "./errors.js";
import type {
  AgenMarketSpec,
  CanonicalConfig,
  CanonicalShare,
  CanonicalStage,
  CanonicalTier,
  MarketBinding,
  Recipient,
  Side,
  SizeAmount,
  SizeMeasure,
} from "./spec.js";
import { MAX_FEE_PPM, PPM_ONE, formatPercent, percentToPpm, supplyPercentToTokens } from "./units.js";

export type CompileResult =
  | { readonly ok: true; readonly config: CanonicalConfig }
  | { readonly ok: false; readonly problems: readonly EngineProblem[] };

class Faults {
  readonly problems: EngineProblem[] = [];

  add(code: EngineProblem["code"], path: string, detail: string): void {
    this.problems.push({ code, path, detail });
  }

  get failed(): boolean {
    return this.problems.length > 0;
  }
}

/**
 * A rate as ppm, refusing anything out of range or finer than one ppm.
 *
 * Never clamps. A market asking for 40% is not a market asking for 10%, and quietly
 * turning one into the other is the single most expensive thing this function could do.
 */
function rate(percent: string, path: string, faults: Faults): number {
  const ppm = percentToPpm(percent);

  if (ppm === null) {
    faults.add(
      "INVALID_FEE",
      path,
      `"${percent}" is not a rate the engine can represent exactly. Rates are decimal ` +
        `percentages no finer than 0.0001%, which is one part per million — the unit Uniswap ` +
        `itself counts fees in.`,
    );
    return 0;
  }

  if (ppm > MAX_FEE_PPM) {
    faults.add(
      "INVALID_FEE",
      path,
      `${formatPercent(ppm)} is above the engine's ceiling of ${formatPercent(MAX_FEE_PPM)}. ` +
        `The ceiling is not clamped to: a market that asked for this rate did not ask for the ` +
        `ceiling, so it is refused rather than quietly reduced.`,
    );
    return 0;
  }

  return ppm;
}

/** A size measure as an inclusive token threshold, with `GT` folded into `GTE`. */
function threshold(
  measure: SizeMeasure,
  binding: MarketBinding,
  path: string,
  faults: Faults,
): bigint {
  const base = amountOf(measure, binding, path, faults);

  // `> T` admits exactly the trades `>= T + 1` does, over integers.
  const inclusive = measure.operator === "GT" ? base + 1n : base;

  if (inclusive <= 0n) {
    faults.add(
      "INVALID_THRESHOLD",
      path,
      `a threshold of ${inclusive.toString()} matches every trade, which makes it the base ` +
        `rate rather than a tier. State it as the base rate instead.`,
    );
    return 1n;
  }

  if (inclusive > binding.referenceSupply) {
    faults.add(
      "INVALID_THRESHOLD",
      path,
      `this threshold is ${inclusive.toString()} tokens, which is more than the whole supply of ` +
        `${binding.referenceSupply.toString()}. No trade can reach it, so the rule could never fire.`,
    );
    return 1n;
  }

  return inclusive;
}

/** The token amount a measure or ceiling names. */
function amountOf(
  measure: SizeMeasure | SizeAmount,
  binding: MarketBinding,
  path: string,
  faults: Faults,
): bigint {
  if (measure.kind === "PERCENT_REFERENCE_SUPPLY") {
    const ppm = percentToPpm(measure.percent);
    if (ppm === null || ppm <= 0 || ppm > PPM_ONE) {
      faults.add(
        "INVALID_THRESHOLD",
        `${path}.percent`,
        `"${measure.percent}" is not a share of supply the engine can represent. It has to be ` +
          `above zero, at most 100%, and no finer than 0.0001%.`,
      );
      return 1n;
    }
    return supplyPercentToTokens(binding.referenceSupply, ppm);
  }

  let tokens: bigint;
  try {
    tokens = BigInt(measure.tokens);
  } catch {
    faults.add("INVALID_THRESHOLD", `${path}.tokens`, `"${measure.tokens}" is not a whole number.`);
    return 1n;
  }
  return tokens;
}

/**
 * The ladder as canonical stages, stage 0 first.
 *
 * Stage 0 is the base rate at threshold 0 and always exists. Later stages must advance
 * strictly, which is what makes "the last stage whose threshold has been passed" a
 * total function rather than a question about ordering.
 */
function stagesOf(spec: AgenMarketSpec, faults: Faults): readonly CanonicalStage[] {
  const base: CanonicalStage = {
    threshold: 0n,
    buyFeePpm: rate(spec.baseRate.buy, "baseRate.buy", faults),
    sellFeePpm: rate(spec.baseRate.sell, "baseRate.sell", faults),
  };

  if (spec.ladder === null) return [base];

  const later: CanonicalStage[] = [];

  if (spec.ladder.axis === "TIME") {
    spec.ladder.stages.forEach((stage, index) => {
      const path = `ladder.stages[${String(index)}]`;

      if (stage.afterSeconds <= 0) {
        faults.add(
          "INVALID_THRESHOLD",
          `${path}.afterSeconds`,
          `a stage at ${String(stage.afterSeconds)} seconds is the opening rate, which is the ` +
            `base rate. Later stages start strictly after the pool opens.`,
        );
        return;
      }
      if (stage.afterSeconds > MAX_TIME_HORIZON_SECONDS) {
        faults.add(
          "INVALID_THRESHOLD",
          `${path}.afterSeconds`,
          `a stage ${String(stage.afterSeconds)} seconds out is beyond the engine's two-year horizon.`,
        );
        return;
      }

      later.push({
        threshold: BigInt(stage.afterSeconds),
        buyFeePpm: rate(stage.rate.buy, `${path}.rate.buy`, faults),
        sellFeePpm: rate(stage.rate.sell, `${path}.rate.sell`, faults),
      });
    });
  } else {
    spec.ladder.stages.forEach((stage, index) => {
      const path = `ladder.stages[${String(index)}]`;

      let amount: bigint;
      try {
        amount = BigInt(stage.afterQuoteAmount);
      } catch {
        faults.add("INVALID_THRESHOLD", `${path}.afterQuoteAmount`, "not a whole number of base units.");
        return;
      }

      if (amount <= 0n) {
        faults.add(
          "INVALID_THRESHOLD",
          `${path}.afterQuoteAmount`,
          `a volume stage at ${amount.toString()} is the opening rate, which is the base rate.`,
        );
        return;
      }

      later.push({
        threshold: amount,
        buyFeePpm: rate(stage.rate.buy, `${path}.rate.buy`, faults),
        sellFeePpm: rate(stage.rate.sell, `${path}.rate.sell`, faults),
      });
    });
  }

  const sorted = [...later].sort((left, right) => (left.threshold < right.threshold ? -1 : left.threshold > right.threshold ? 1 : 0));

  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;

    if (current.threshold === previous.threshold) {
      faults.add(
        "DUPLICATE_THRESHOLD",
        `ladder.stages[${String(index)}]`,
        `two stages start at ${current.threshold.toString()}. Which rate applies at that point ` +
          `would depend on the order they happened to be written in.`,
      );
    } else if (
      spec.ladder.axis === "TIME" &&
      current.threshold - previous.threshold < BigInt(MIN_TIME_STAGE_GAP_SECONDS)
    ) {
      faults.add(
        "CONFLICTING_RULES",
        `ladder.stages[${String(index)}]`,
        `two stages are ${(current.threshold - previous.threshold).toString()} seconds apart, ` +
          `closer than the engine's ${String(MIN_TIME_STAGE_GAP_SECONDS)}-second minimum. A gap ` +
          `that small is usually one instruction read as two.`,
      );
    }
  }

  const stages = [base, ...sorted];

  if (stages.length > MAX_STAGES) {
    faults.add(
      "TOO_MANY_RULES",
      "ladder.stages",
      `${String(stages.length)} stages including the base rate, and the engine evaluates at most ` +
        `${String(MAX_STAGES)}. The limit exists so a swap's cost can be stated rather than measured.`,
    );
  }

  return stages;
}

/** One side's tiers, ascending, deduplicated, with equal-and-different refused. */
function tiersOf(
  spec: AgenMarketSpec,
  side: Side,
  binding: MarketBinding,
  faults: Faults,
): readonly CanonicalTier[] {
  const mine: CanonicalTier[] = [];

  spec.sizeTiers.forEach((tier, index) => {
    if (tier.side !== side) return;
    const path = `sizeTiers[${String(index)}]`;
    mine.push({
      thresholdTokens: threshold(tier.measure, binding, `${path}.measure`, faults),
      feePpm: rate(tier.rate, `${path}.rate`, faults),
    });
  });

  const sorted = [...mine].sort((left, right) =>
    left.thresholdTokens < right.thresholdTokens ? -1 : left.thresholdTokens > right.thresholdTokens ? 1 : 0,
  );

  const canonical: CanonicalTier[] = [];
  for (const tier of sorted) {
    const previous = canonical[canonical.length - 1];

    if (previous !== undefined && previous.thresholdTokens === tier.thresholdTokens) {
      if (previous.feePpm === tier.feePpm) {
        // The same rule twice. Dropping the duplicate changes nothing.
        continue;
      }
      faults.add(
        "DUPLICATE_THRESHOLD",
        `sizeTiers`,
        `two ${side.toLowerCase()} tiers both start at ${tier.thresholdTokens.toString()} tokens ` +
          `and charge different rates (${formatPercent(previous.feePpm)} and ` +
          `${formatPercent(tier.feePpm)}). Which one applies would depend on the order they were ` +
          `written in, so the market is ambiguous rather than merely redundant.`,
      );
      continue;
    }

    canonical.push(tier);
  }

  if (canonical.length > MAX_TIERS_PER_SIDE) {
    faults.add(
      "TOO_MANY_RULES",
      "sizeTiers",
      `${String(canonical.length)} tiers on ${side.toLowerCase()}s, and the engine evaluates at ` +
        `most ${String(MAX_TIERS_PER_SIDE)} per side.`,
    );
  }

  return canonical;
}

/** A stable total order on recipients, so canonical form does not depend on input order. */
function recipientOrder(recipient: Recipient): string {
  switch (recipient.kind) {
    case "CREATOR":
      return "1:creator";
    case "TREASURY":
      return "2:treasury";
    case "ADDRESS":
      return `3:${recipient.address.toLowerCase()}`;
    default: {
      const exhaustive: never = recipient;
      return exhaustive;
    }
  }
}

function sameRecipient(left: Recipient, right: Recipient): boolean {
  return recipientOrder(left) === recipientOrder(right);
}

/**
 * The distribution, merged and ordered, totalling exactly one whole.
 *
 * "Exactly" is the requirement. 99% is not a rounding problem, it is a percent of every
 * fee this market will ever collect going nowhere, and 101% is a splitter that cannot
 * pay what it promised.
 */
function distributionOf(
  spec: AgenMarketSpec,
  anyFee: boolean,
  faults: Faults,
): readonly CanonicalShare[] {
  const merged: CanonicalShare[] = [];

  spec.distribution.forEach((entry, index) => {
    const path = `distribution[${String(index)}]`;
    const ppm = percentToPpm(entry.share);

    if (ppm === null || ppm <= 0 || ppm > PPM_ONE) {
      faults.add(
        "INVALID_DISTRIBUTION",
        `${path}.share`,
        `"${entry.share}" is not a share the engine can represent. A share is above zero, at ` +
          `most 100%, and no finer than 0.0001%.`,
      );
      return;
    }

    if (entry.recipient.kind === "ADDRESS" && /^0x0{40}$/i.test(entry.recipient.address)) {
      faults.add(
        "INVALID_RECIPIENT",
        `${path}.recipient.address`,
        `the zero address is not a recipient. Sending a fee there destroys it, which is a burn ` +
          `written as a payout — engine v1 does not implement burns.`,
      );
      return;
    }

    const existing = merged.find((share) => sameRecipient(share.recipient, entry.recipient));
    if (existing === undefined) {
      merged.push({ recipient: entry.recipient, sharePpm: ppm });
    } else {
      // Two shares to the same recipient are one share. Addition is not a judgement.
      merged[merged.indexOf(existing)] = { recipient: existing.recipient, sharePpm: existing.sharePpm + ppm };
    }
  });

  if (merged.length === 0) {
    if (anyFee) {
      faults.add(
        "INVALID_DISTRIBUTION",
        "distribution",
        `this market charges a fee and says nothing about where it goes. The engine will not ` +
          `choose a recipient: a fee whose destination nobody stated is a fee the creator has ` +
          `not agreed to.`,
      );
    }
    return [];
  }

  if (merged.length > MAX_RECIPIENTS) {
    faults.add(
      "TOO_MANY_RULES",
      "distribution",
      `${String(merged.length)} recipients, and the engine settles at most ${String(MAX_RECIPIENTS)}. ` +
        `Each one is a settlement on the fee path, so this bound is what decides what a swap costs.`,
    );
  }

  const total = merged.reduce((sum, share) => sum + share.sharePpm, 0);
  if (total !== PPM_ONE) {
    faults.add(
      "INVALID_DISTRIBUTION",
      "distribution",
      `the shares total ${formatPercent(total)}, not 100%. ` +
        (total < PPM_ONE
          ? `${formatPercent(PPM_ONE - total)} of every fee this market collects would have no ` +
            `destination.`
          : `The market would owe more than it collected.`),
    );
  }

  return [...merged].sort((left, right) => recipientOrder(left.recipient).localeCompare(recipientOrder(right.recipient)));
}

/** The per-side trade ceilings named by the protections. */
function ceilingsOf(
  spec: AgenMarketSpec,
  binding: MarketBinding,
  faults: Faults,
): { readonly buy: bigint | null; readonly sell: bigint | null } {
  let buy: bigint | null = null;
  let sell: bigint | null = null;

  spec.protections.forEach((protection, index) => {
    const path = `protections[${String(index)}]`;
    const tokens = amountOf(protection.amount, binding, `${path}.amount`, faults);

    if (tokens <= 0n) {
      faults.add(
        "INVALID_THRESHOLD",
        `${path}.amount`,
        `a ceiling of ${tokens.toString()} tokens would stop every trade, which closes the market ` +
          `rather than protecting it.`,
      );
      return;
    }

    const applyTo = (existing: bigint | null): bigint => (existing === null ? tokens : existing < tokens ? existing : tokens);

    if (protection.side === "BUY" || protection.side === "BOTH") buy = applyTo(buy);
    if (protection.side === "SELL" || protection.side === "BOTH") sell = applyTo(sell);
  });

  return { buy, sell };
}

/** A tier above its side's ceiling can never fire, which means the market is contradictory. */
function checkReachable(
  tiers: readonly CanonicalTier[],
  ceiling: bigint | null,
  side: Side,
  faults: Faults,
): void {
  if (ceiling === null) return;

  for (const tier of tiers) {
    if (tier.thresholdTokens > ceiling) {
      faults.add(
        "CONFLICTING_RULES",
        "sizeTiers",
        `a ${side.toLowerCase()} tier starts at ${tier.thresholdTokens.toString()} tokens, but ` +
          `${side.toLowerCase()}s are capped at ${ceiling.toString()}. The rate could never apply, ` +
          `so one of the two rules is not what was meant.`,
      );
    }
  }
}

/**
 * Compile a specification against its launch binding.
 *
 * Every problem is collected rather than thrown at the first fault, because a creator
 * fixing a market wants the whole list and a retry prompt is only useful if it names
 * everything that was wrong.
 */
export function compile(spec: AgenMarketSpec, binding: MarketBinding): CompileResult {
  const faults = new Faults();

  if (binding.referenceSupply <= 0n) {
    return {
      ok: false,
      problems: [
        {
          code: "INVALID_REFERENCE_SUPPLY",
          path: "binding.referenceSupply",
          detail:
            `the reference supply is ${binding.referenceSupply.toString()}. Every percentage ` +
            `threshold in the market is measured against it, so there is nothing to compile ` +
            `until the launch supplies the supply of the token it is about to deploy.`,
        },
      ],
    };
  }

  const stages = stagesOf(spec, faults);
  const buyTiers = tiersOf(spec, "BUY", binding, faults);
  const sellTiers = tiersOf(spec, "SELL", binding, faults);
  const ceilings = ceilingsOf(spec, binding, faults);

  checkReachable(buyTiers, ceilings.buy, "BUY", faults);
  checkReachable(sellTiers, ceilings.sell, "SELL", faults);

  const anyFee =
    stages.some((stage) => stage.buyFeePpm > 0 || stage.sellFeePpm > 0) ||
    buyTiers.some((tier) => tier.feePpm > 0) ||
    sellTiers.some((tier) => tier.feePpm > 0);

  const distribution = distributionOf(spec, anyFee, faults);

  if (faults.failed) return { ok: false, problems: faults.problems };

  /*
   * The fee currency is forced, not chosen. See `orientation.ts` for the four-case table
   * behind it: a size tier is measured on the token leg, a fee has to be taken from a leg
   * that is knowable in whichever callback can settle it, and only a token-denominated fee
   * satisfies both for all four swap shapes. A market with no tiers has no such
   * constraint, so it collects in the asset a creator would rather hold.
   */
  const feeCurrency = buyTiers.length > 0 || sellTiers.length > 0 ? "TOKEN" : "QUOTE";

  return {
    ok: true,
    config: {
      engineVersion: 1,
      referenceSupply: binding.referenceSupply,
      quoteAsset: binding.quoteAsset,
      launchedTokenSymbol: binding.launchedTokenSymbol,
      feeCurrency,
      ladderAxis: spec.ladder === null ? null : spec.ladder.axis,
      stages,
      buyTiers,
      sellTiers,
      distribution,
      maxBuyTokens: ceilings.buy,
      maxSellTokens: ceilings.sell,
    },
  };
}
