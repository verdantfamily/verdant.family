/**
 * How a size threshold is stated to a person.
 *
 * ## Why this is its own module
 *
 * Because there were three copies of it. `review.ts`, `graph.ts` and `simulate.ts` each turned
 * a threshold into a phrase, each by the same integer division, and the three had already
 * drifted: the review recovered whether a threshold was inclusive and the other two hardcoded
 * *"or more"*, so a market compiled from *"more than 1%"* read correctly on one screen and
 * incorrectly on the other two. An adversarial audit found it by comparing them.
 *
 * A threshold is one fact. Three renderings of it is three chances to describe a market the
 * chain does not run, so there is now one function and the three call it.
 *
 * ## What the canonical form does and does not remember
 *
 * `CanonicalConfig` stores `thresholdTokens` and nothing else. That is deliberate and correct
 * — it is the number the chain compares against, and every other form of the threshold is a
 * way of saying it. But it means the phrasing has to be *recovered* from that number rather
 * than read off a flag, and there are two things to recover.
 *
 * **Inclusivity.** `compile.ts` folds `GT` into `GTE` by adding one base unit, which is exact
 * over integers. A threshold landing exactly on a whole share of supply is one the creator
 * stated inclusively; one sitting a hair above the nearest share is the `+1` that `GT` became.
 *
 * **Whether a percentage says anything at all.** A threshold given in absolute tokens has no
 * reason to be a round share of supply, and against a 10^27 supply a threshold of a thousand
 * tokens is 0.0000000000000001% — which truncates to zero and renders as *"more than 0% of
 * supply"*, a sentence that describes every trade ever made. So the percentage is used only
 * when it is faithful, and the token amount, which is always exact, is used when it is not.
 *
 * ## Faithful, precisely
 *
 * A percentage is faithful when converting it back yields the threshold itself, or the
 * threshold less one base unit — the second being the `GT` case, where the stated percentage
 * is right and the phrasing carries the difference. Anything else and the percentage would be
 * a rounded stand-in for a number the chain compares exactly, so the tokens are stated instead.
 */

import type { CanonicalConfig } from "./spec.js";
import { formatPercent } from "./units.js";

const PPM = 1_000_000n;

/** How a threshold reads, decomposed so each caller can phrase it in its own voice. */
export interface ThresholdWords {
  /** `1%`, or `1,000 EXCT` where a percentage would be a rounded stand-in. */
  readonly amount: string;
  /** True where the threshold is met *at* `amount`, false where it must be exceeded. */
  readonly inclusive: boolean;
  /** True where `amount` is a share of supply, false where it is a token quantity. */
  readonly isShare: boolean;
}

export function thresholdWords(config: CanonicalConfig, tokens: bigint): ThresholdWords {
  const ppm = Number((tokens * PPM) / config.referenceSupply);
  const exact = (config.referenceSupply * BigInt(ppm)) / PPM;

  if (ppm > 0 && exact === tokens) {
    return { amount: formatPercent(ppm), inclusive: true, isShare: true };
  }

  // One base unit above a whole share: the `+1` that `GT` compiled to. The percentage is the
  // one the creator stated, and "more than" is what makes it true.
  if (ppm > 0 && exact === tokens - 1n) {
    return { amount: formatPercent(ppm), inclusive: false, isShare: true };
  }

  return { amount: tokenAmount(config, tokens), inclusive: true, isShare: false };
}

/**
 * A threshold as a whole sentence: *"A sell of more than 1% of supply"*.
 *
 * The review screen's phrasing, exported because the execution graph wants the same words for
 * the same fact and a second phrasing is a second thing to keep true.
 */
export function thresholdSentence(config: CanonicalConfig, tokens: bigint, side: "BUY" | "SELL"): string {
  const words = thresholdWords(config, tokens);
  const noun = side === "BUY" ? "buy" : "sell";
  const of = words.isShare ? " of supply" : "";

  return words.inclusive
    ? `A ${noun} of ${words.amount}${of} or more`
    : `A ${noun} of more than ${words.amount}${of}`;
}

/** The same fact as a bare phrase, for a graph node or a table cell that supplies its own frame. */
export function thresholdPhrase(config: CanonicalConfig, tokens: bigint): string {
  const words = thresholdWords(config, tokens);
  const of = words.isShare ? " of supply" : "";

  return words.inclusive ? `${words.amount}${of} or more` : `more than ${words.amount}${of}`;
}

/**
 * A bare amount, exactly: `1%` where that is faithful, `1,000 EXCT` where it is not.
 *
 * For a ceiling rather than a tier. A ceiling is a plain quantity — the trade above it is
 * refused — with no `GT` folded into it and therefore no inclusivity to recover, so running it
 * through `thresholdWords` would apply a heuristic to a number that has no history. It would
 * usually agree and would occasionally invent a *"more than"* from an accident of arithmetic.
 *
 * What it shares with `thresholdWords` is the part that matters: a percentage is used only
 * when converting it back yields exactly this number, and the token quantity otherwise. So an
 * absolute ceiling is never rendered as the 0% it truncates to.
 */
export function exactAmount(config: CanonicalConfig, tokens: bigint): string {
  const ppm = Number((tokens * PPM) / config.referenceSupply);
  const exact = (config.referenceSupply * BigInt(ppm)) / PPM;

  return ppm > 0 && exact === tokens
    ? `${formatPercent(ppm)} of supply`
    : tokenAmount(config, tokens);
}

/**
 * A token quantity with its decimals applied.
 *
 * Eighteen, which is what the factory deploys and what `referenceSupply` is denominated in.
 * Written as a named constant rather than inline so that the day a launch takes a decimals
 * argument, this is the line that fails to compile.
 */
const LAUNCHED_TOKEN_DECIMALS = 18;

function tokenAmount(config: CanonicalConfig, base: bigint): string {
  const scale = 10n ** BigInt(LAUNCHED_TOKEN_DECIMALS);
  const whole = base / scale;
  const fraction = base % scale;

  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (fraction === 0n) return `${grouped} ${config.launchedTokenSymbol}`;

  const digits = fraction
    .toString()
    .padStart(LAUNCHED_TOKEN_DECIMALS, "0")
    .replace(/0+$/, "");

  return `${grouped}.${digits} ${config.launchedTokenSymbol}`;
}
