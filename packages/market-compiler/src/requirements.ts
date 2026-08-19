/**
 * Numbers the creator stated, checked against the market Agen locked.
 *
 * Everything else in this pipeline reasons about the market Agen decided to build. This file
 * reasons about the one thing that is not up for interpretation: a rate the creator wrote down.
 * "Sells pay 0.5%" is not a preference to be balanced against what the model found convenient,
 * and a build that reaches the launch button charging something else — or charging it while
 * nothing checks — is a worse outcome than a build that fails.
 *
 * SPEC is why this exists. Its prompt states 0.5% three ways, in words, in ppm and again as a
 * ceiling; interpretation locked it correctly; and it launched twice with that rate asserted by
 * nothing at all, because the function that writes the fee assertions could not read the shape
 * the effect happened to use. The market was right both times. It was right because the model
 * behaved, not because anything held it to what was asked, and that distinction is the whole
 * reason this check is not measured by the pass rate.
 *
 * ## Deliberately about presence, not flatness
 *
 * The requirement checked is that a stated rate is *somewhere* in the locked market: some rule,
 * some fee effect, that rate. Not that it applies unconditionally, because plenty of prompts ask
 * for a rate and then qualify it — "0.5% on sells, waived after three buys" is one market with
 * one rate and two rules, and demanding a flat reading would refuse it for being what it says.
 *
 * ## Deliberately narrow about what counts as a stated rate
 *
 * A false refusal is the worst outcome available here: a market that was asked for, could be
 * built, and was turned away over a number this file misread out of a sentence. So a rate is only
 * taken when the words around it say it is a fee on a trade, and the shapes that look like rates
 * without being one — a share of a fee already taken, a supply percentage, a slippage bound — are
 * left alone. Anything unrecognised is silence, and silence here means "no requirement to check".
 */

import type { MarketSpecification, Rule } from "./spec.js";

/** A rate the creator wrote down, in parts per million, with the words it was written in. */
export interface StatedRate {
  readonly ppm: number;
  /** The phrase it was read from, for an error message that can be checked against the prompt. */
  readonly phrase: string;
}

/** Words that make a number next to them a fee on a trade. */
const FEE_WORDS = /\b(?:fee|fees|tax|taxed|taxes|charge|charged|charges|toll|skim|cut|takes?|take)\b/i;

/**
 * Words that make a number *not* a fee on a trade, even next to a fee word.
 *
 * Each of these is a real sentence from a real prompt. "80% of the fee goes to the creator"
 * divides a fee that was already taken; "burn 1% of supply" is not a trade fee at all; "up to 3%
 * slippage" is a bound on execution. Reading any of them as a fee would refuse a market for
 * failing to charge something nobody asked it to charge.
 */
/**
 * What the number is a percentage *of*, when that makes it something other than a trade fee.
 *
 * Matched against the words immediately following the number, not the sentence around it. That
 * distinction is the whole rule: CNPY says "if somebody sells more than 1% of current liquidity,
 * charge an additional 2%", where a window wide enough to see "charge" from the 1% is also wide
 * enough to see "of current liquidity" from the 2% — so a check on the sentence throws away the
 * real fee along with the threshold. What follows a number belongs to that number.
 */
const PERCENTAGE_OF = new RegExp(
  [
    // A share of a fee already taken. KING's "20% of all trading fees go into a reward pool" is a
    // division of the fee; read as a fee it demands a market taking a fifth of every trade.
    String.raw`^\s*of (?:the |that |all |collected |those )?(?:trading |swap |hook )?fees?\b`,
    String.raw`^\s*of (?:the )?(?:revenue|proceeds|takings|rewards?)\b`,
    // A threshold measured in percent, which is what CNPY's 1% is.
    String.raw`^\s*of (?:the )?(?:current )?(?:liquidity|pool|reserves|market ?cap|volume)\b`,
    String.raw`^\s*of (?:the )?(?:total |circulating )?supply\b`,
    String.raw`^\s*of (?:the )?holders\b`,
    String.raw`^\s*of (?:the )?treasury\b`,
  ].join("|"),
  "i",
);

/** Rates that are not trade fees whatever they are attached to. */
const NOT_A_FEE_AT_ALL = /\b(?:slippage|apy|apr|discount|bonus|royalty|inflation)\b/i;

/**
 * Quantities written as words, because people describing a market do not write digits.
 *
 * This guard is only as good as the rates it can see, and a rate it cannot see is not a rate it
 * passes — it is a rate it never compared. STORY says "you pay a small fee, half a percent", and
 * every pattern below this point needs a digit, so nothing was extracted, nothing was compared,
 * and the check that exists to stop a market launching at the wrong rate had no opinion. The
 * market launched charging nothing on sells against a prompt that asked for 0.5%, which is the
 * exact outcome this file was written to prevent.
 *
 * Ordered longest first where the phrases overlap, so "a half percent" is read as a half rather
 * than as "a percent" with a stray word in front of it.
 */
const WORDED_QUANTITIES: readonly (readonly [string, number])[] = [
  ["one and a half", 1.5],
  ["two and a half", 2.5],
  ["three quarters", 0.75],
  ["one quarter", 0.25],
  ["a quarter", 0.25],
  ["one half", 0.5],
  ["a half", 0.5],
  ["quarter", 0.25],
  ["half", 0.5],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["a", 1],
];

/**
 * `half a percent`, `three quarters of a percent`, `a half percent`, `one percent`.
 *
 * The filler between the quantity and the unit is part of the phrase rather than a separate
 * number: in "half a percent" the "a" belongs to the percent, and reading it as the quantity
 * would turn half a percent into one percent.
 */
const WORDED_PERCENT = new RegExp(
  String.raw`\b(` +
    WORDED_QUANTITIES.map(([phrase]) => phrase.replaceAll(" ", String.raw`\s+`)).join("|") +
    String.raw`)\s+(?:of\s+(?:a|one)\s+|a\s+)?per\s?cent\b`,
  "gi",
);

const wordedValue = (raw: string): number | null => {
  const phrase = raw.trim().toLowerCase().replaceAll(/\s+/g, " ");
  return WORDED_QUANTITIES.find(([candidate]) => candidate === phrase)?.[1] ?? null;
};

/**
 * The rates a prompt states, in ppm.
 *
 * Read from the words, never from the size of the number: `50` is fifty ppm or half a percent
 * depending entirely on what follows it, and guessing between them is the difference between a
 * market that charges nothing and one that charges a hundred times too much.
 */
export function statedRates(prompt: string): readonly StatedRate[] {
  const found = new Map<number, string>();

  const patterns: readonly {
    readonly re: RegExp;
    readonly scale: number;
    /** How the captured text becomes a number, where it is not itself a numeral. */
    readonly read?: (raw: string) => number | null;
  }[] = [
    { re: /(\d+(?:\.\d+)?)\s*%/g, scale: 10_000 },
    { re: /(\d+(?:\.\d+)?)\s*percent\b/gi, scale: 10_000 },
    { re: /(\d+(?:[\d_,]*\d)?)\s*(?:ppm|parts per million)\b/gi, scale: 1 },
    { re: /(\d+(?:[\d_,]*\d)?)\s*(?:bps|basis points?)\b/gi, scale: 100 },
    { re: WORDED_PERCENT, scale: 10_000, read: wordedValue },
  ];

  for (const { re, scale, read } of patterns) {
    for (const match of prompt.matchAll(re)) {
      const at = match.index ?? 0;
      // The sentence around it, which is what decides whether this is a fee at all. A window
      // rather than the whole prompt: a prompt that mentions a fee somewhere does not make every
      // number in it a rate.
      const context = prompt.slice(Math.max(0, at - 90), at + match[0].length + 90);
      // What the number itself is about, as opposed to what the sentence is about.
      const after = prompt.slice(at + match[0].length, at + match[0].length + 40);

      if (!FEE_WORDS.test(context)) continue;
      if (PERCENTAGE_OF.test(after)) continue;
      if (NOT_A_FEE_AT_ALL.test(after) || NOT_A_FEE_AT_ALL.test(context)) continue;

      const value = read === undefined ? Number(match[1]!.replaceAll(/[_,]/g, "")) : read(match[1]!);
      if (value === null || !Number.isFinite(value) || value <= 0) continue;

      const ppm = value * scale;
      if (!Number.isInteger(ppm) || ppm > 1_000_000) continue;

      if (!found.has(ppm)) found.set(ppm, match[0].trim());
    }
  }

  return [...found].map(([ppm, phrase]) => ({ ppm, phrase }));
}

/**
 * Every rate the locked specification states anywhere, in ppm.
 *
 * Wide on purpose, and the opposite bias to `statedRates`: this side of the comparison is looking
 * for a reason to say the requirement survived, so it reads every fee-ish effect, both declared
 * ceilings, and any rate a parameter names in any unit.
 */
export function lockedRates(specification: MarketSpecification): ReadonlySet<number> {
  const rates = new Set<number>();

  const add = (value: number | null | undefined): void => {
    if (value !== null && value !== undefined && Number.isInteger(value) && value > 0) {
      rates.add(value);
    }
  };

  add(specification.baseFeePpm);
  add(specification.maxFeePpm);

  for (const rule of specification.rules) {
    for (const effect of rule.then) {
      for (const ppm of ratesIn(effect.parameters)) add(ppm);
    }
    for (const condition of rule.conditions) {
      for (const ppm of ratesIn(condition.parameters)) add(ppm);
    }
  }

  return rates;
}

/** Every number in a parameter bag that names a unit, converted to ppm. */
function ratesIn(parameters: Rule["then"][number]["parameters"]): readonly number[] {
  const found: number[] = [];

  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (typeof value !== "number") continue;

    const name = key.toLowerCase();
    const ppm = name.includes("ppm")
      ? value
      : name.includes("bps") || name.includes("basispoint")
        ? value * 100
        : name.includes("percent") || name.includes("pct")
          ? value * 10_000
          : null;

    if (ppm !== null && Number.isInteger(ppm)) found.push(ppm);
  }

  return found;
}

/**
 * Rates the creator stated that the locked market does not contain.
 *
 * Empty is the answer for almost every prompt, including every prompt that states no rate at all.
 * A non-empty answer is a build that must stop: the market Agen is about to write is not the
 * market that was asked for, and no amount of it working proves otherwise.
 */
export function unmetRates(
  prompt: string,
  specification: MarketSpecification,
): readonly StatedRate[] {
  const locked = lockedRates(specification);

  return statedRates(prompt).filter((rate) => !locked.has(rate.ppm));
}
