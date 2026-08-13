/**
 * Turning a specification into the words a trader reads.
 *
 * Every string a market card or token page shows about a mechanic is computed here,
 * from the specification, deterministically. Nothing is written per token and nothing
 * is written by a model at display time — which matters for a reason beyond tidiness:
 * the line on a card is a claim about what a contract does, and a claim generated
 * separately from the contract is a claim that can drift from it. Deriving both from
 * the same document is what makes "these are the rules" true rather than marketing.
 *
 * ## Why the phrasing is templated rather than free
 *
 * A model could write a better sentence. It could also write a different sentence for
 * the same market on two page loads, and a flattering one for a market that deserves a
 * plain one. Templates are duller and they are auditable: the same specification always
 * produces the same description, so a screenshot is evidence.
 *
 * ## The vocabulary is still open
 *
 * `kind` is a free string everywhere in the specification, so this cannot switch over a
 * closed set and be complete. Every function here has a fallback that uses the
 * specification's own `description` field — written when the mechanic was interpreted,
 * in the creator's terms. A mechanic nobody anticipated gets a worse sentence, not no
 * sentence, and never a wrong one.
 */

import type { Effect, MarketSpecification, Rule, Scalar, StateVariable } from "./spec.js";

/** Hundredths of a basis point, as a percentage a person would say. */
export function asPercent(ppm: number): string {
  const percent = ppm / 10_000;
  return `${percent % 1 === 0 ? percent.toFixed(0) : String(percent)}%`;
}

/** Seconds, in the largest unit that stays whole. */
export function asDuration(seconds: number): string {
  const units: readonly [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];

  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const count = seconds / size;
      return `${String(count)} ${name}${count === 1 ? "" : "s"}`;
    }
  }

  return `${String(seconds)} second${seconds === 1 ? "" : "s"}`;
}

function numberFrom(parameters: Readonly<Record<string, Scalar>> | undefined, key: string): number | null {
  const value = parameters?.[key];
  return typeof value === "number" ? value : null;
}

function textFrom(parameters: Readonly<Record<string, Scalar>> | undefined, key: string): string | null {
  const value = parameters?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * The one line a market card shows.
 *
 * Not the specification's `summary`, deliberately. That is written by the model at
 * interpretation time and is free text of arbitrary length and tone; this is computed
 * from the rules themselves and is bounded. Where the computation finds nothing worth
 * saying it falls back to the summary rather than to silence.
 */
export function headlineMechanic(specification: MarketSpecification): string {
  const rule = mostDistinctive(specification);
  if (rule === null) return specification.summary;

  const sentence = describeRule(rule);
  return sentence.length > 0 ? sentence : specification.summary;
}

/**
 * Which rule is the one worth putting on a card.
 *
 * Ranked by how unusual the mechanic is rather than by order. A market's first rule is
 * frequently its dullest — a base fee, a routing default — and the reason somebody
 * would look twice is the rule about hourly leaders or jackpots further down.
 */
function mostDistinctive(specification: MarketSpecification): Rule | null {
  if (specification.rules.length === 0) return null;

  // Ordinary machinery scores low; anything competitive, periodic or conditional on
  // absence scores high, because those are the mechanics a trader has not seen before.
  const interest: Readonly<Record<string, number>> = {
    inactivity: 5,
    consecutiveTrades: 4,
    newAllTimeHigh: 4,
    timeElapsed: 3,
    volumeThreshold: 3,
    marketCapThreshold: 3,
    priceThreshold: 3,
    phaseEntered: 3,
    externalEvent: 3,
    sell: 2,
    buy: 2,
    swap: 1,
    addLiquidity: 1,
    removeLiquidity: 1,
  };

  // What a rule *tests* is often more distinctive than what sets it off. "On a buy" is
  // the dullest trigger there is; "on a buy, when ten have happened in a row" is the
  // mechanic somebody came for. Scoring only triggers put a routine milestone above a
  // streak, which was the wrong line on the card.
  const conditionInterest: Readonly<Record<string, number>> = {
    consecutiveCount: 3,
    rollingCount: 3,
    rollingAverage: 3,
    walletHoldingDuration: 3,
    walletAge: 3,
    volatility: 3,
    withinDuration: 2,
    sinceEvent: 2,
    percentageChange: 2,
    tradeSizeVsLiquidity: 1,
    tradeSizeVsSupply: 1,
    tradeSizeAbsolute: 1,
    phaseIs: 1,
    flagIs: 0,
  };

  const scored = specification.rules.map((rule) => {
    const base = interest[rule.when.kind] ?? 4;

    // An unrecognised condition kind scores as interesting for the same reason an
    // unrecognised trigger does: it is a mechanic this codebase has no name for.
    const conditions = rule.conditions.reduce(
      (total, condition) => total + (conditionInterest[condition.kind] ?? 3),
      0,
    );

    const rare = rule.onceOnly === true ? 1 : 0;
    return { rule, score: base + conditions + rare };
  });

  scored.sort((left, right) => right.score - left.score);
  return scored[0]!.rule;
}

/** One rule as a sentence, in the present tense, without jargon. */
export function describeRule(rule: Rule): string {
  const trigger = describeTrigger(rule);
  const effects = rule.then.map(describeEffect).filter((text) => text.length > 0);

  if (effects.length === 0) return trigger;

  const joined =
    effects.length === 1
      ? effects[0]!
      : `${effects.slice(0, -1).join(", ")} and ${effects[effects.length - 1]!}`;

  return `${trigger}, ${joined}`;
}

function describeTrigger(rule: Rule): string {
  const { kind, parameters } = rule.when;
  const condition = rule.conditions[0];

  switch (kind) {
    case "sell": {
      const percent = numberFrom(condition?.parameters, "percent");
      return percent === null
        ? "On every sell"
        : `When someone sells more than ${String(percent)}% of liquidity`;
    }
    case "buy": {
      const streak = numberFrom(condition?.parameters, "value");
      return streak === null ? "On every buy" : `After ${String(streak)} buys in a row`;
    }
    case "swap":
      return "On every trade";
    case "inactivity": {
      const seconds = numberFrom(parameters, "seconds");
      return seconds === null
        ? "When the market goes quiet"
        : `After ${asDuration(seconds)} with no trade`;
    }
    case "timeElapsed": {
      const seconds = numberFrom(parameters, "seconds");
      return seconds === null ? "At the end of each period" : `Every ${asDuration(seconds)}`;
    }
    case "volumeThreshold": {
      const usd = numberFrom(parameters, "amountUsd");
      return usd === null
        ? "At a volume milestone"
        : `At $${usd.toLocaleString("en-US")} of volume`;
    }
    case "newAllTimeHigh":
      return "At a new all-time high";
    default:
      // The open case. The interpretation's own wording, lowercased into the sentence.
      return capitalise(rule.when.description.replace(/\.$/, ""));
  }
}

function describeEffect(effect: Effect): string {
  const { kind, parameters } = effect;

  switch (kind) {
    case "extraFee": {
      const ppm = numberFrom(parameters, "feePpm");
      return ppm === null ? "an extra fee applies" : `an extra ${asPercent(ppm)} applies`;
    }
    case "setFee": {
      const ppm = numberFrom(parameters, "feePpm");
      return ppm === null ? "the fee changes" : `the fee becomes ${asPercent(ppm)}`;
    }
    case "waiveFee":
      return "the trade pays no fee";
    case "routeFee": {
      const destination = textFrom(parameters, "destination");
      const share = numberFrom(parameters, "share");
      const where = destination === null ? "a reserve" : humanise(destination);
      return share === null || share === 100
        ? `it goes to ${where}`
        : `${String(share)}% of it goes to ${where}`;
    }
    case "buyback":
      return "the market buys back";
    case "burn":
      return "the tokens are burned";
    case "rewardWallet":
      return "the trader is rewarded";
    case "rewardGroup":
      return "holders are rewarded";
    case "transitionPhase": {
      const phase = textFrom(parameters, "phase");
      return phase === null ? "the market changes phase" : `the market enters ${humanise(phase)}`;
    }
    case "resetCounter":
      return "the count starts again";
    case "disableRulePermanently":
      return "the rule switches off for good";
    default:
      return lowerFirst(effect.description.replace(/\.$/, ""));
  }
}

/** `buybackReserve` reads as "buyback reserve" once it is on a page. */
function humanise(identifier: string): string {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .toLowerCase();
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

// --- how this market works -------------------------------------------------

/** A heading and the statements under it, for the token page. */
export interface MechanicSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

/**
 * The market explained, grouped.
 *
 * Grouped by what the rule reacts to rather than by rule order, because a trader is
 * asking "what happens when I sell?" and the answer should be in one place even when
 * three rules contribute to it.
 */
export function howThisMarketWorks(
  specification: MarketSpecification,
): readonly MechanicSection[] {
  const groups = new Map<string, string[]>();

  const headingFor = (rule: Rule): string => {
    switch (rule.when.kind) {
      case "sell":
        return "SELLING";
      case "buy":
        return "BUYING";
      case "swap":
        return "EVERY TRADE";
      case "inactivity":
        return "WHEN IT GOES QUIET";
      case "timeElapsed":
      case "phaseEntered":
        return "OVER TIME";
      case "volumeThreshold":
      case "marketCapThreshold":
      case "priceThreshold":
      case "newAllTimeHigh":
        return "MILESTONES";
      default:
        return rule.title;
    }
  };

  for (const rule of specification.rules) {
    const heading = headingFor(rule);
    const lines = groups.get(heading) ?? [];
    lines.push(`${describeRule(rule)}.`);
    groups.set(heading, lines);
  }

  const sections = [...groups.entries()].map(([heading, lines]) => ({ heading, lines }));

  // The base fee is what a trader pays when no rule fires, and it belongs first
  // because it is the number they are actually looking for. The ceiling belongs beside
  // it: Agen imposes no cap of its own, so the only thing standing between a trader and
  // an unpleasant surprise is that this figure is stated plainly and tested against.
  const fees = [`The base fee is ${asPercent(specification.baseFeePpm)} on every trade.`];

  if (specification.maxFeePpm > specification.baseFeePpm) {
    fees.push(
      `No trade can ever pay more than ${asPercent(specification.maxFeePpm)}, whichever ` +
        `rules apply.`,
    );
  }

  sections.unshift({ heading: "FEES", lines: fees });

  if (specification.externalDependencies.length > 0) {
    sections.push({
      heading: "OUTSIDE THE POOL",
      lines: specification.externalDependencies.map(
        (dependency) =>
          `${capitalise(dependency.description.replace(/\.$/, ""))}. If it is unavailable, ` +
          `${lowerFirst(dependency.failureBehaviour.replace(/\.$/, ""))}.`,
      ),
    });
  }

  return sections;
}

// --- the review cards ------------------------------------------------------

/**
 * One fact about the market, sized for a card.
 *
 * A heading, the number, and a line saying what the number means. The shape exists
 * because a review screen and a sentence want opposite things: "On every sell an extra
 * 0.75% applies and it goes to the fee vault" is a good sentence and a bad card, where
 * the reader is looking for the figure and has to parse a clause to find it.
 */
export interface BehaviourCard {
  readonly label: string;
  readonly value: string;
  readonly note: string;
}

/** What a side of the market charges, once every rule that touches the fee is applied. */
interface SideFee {
  /** Null where a rule changes the fee by an amount the specification does not state. */
  readonly ppm: number | null;
  readonly routed: string | null;
}

function feeFor(specification: MarketSpecification, side: "buy" | "sell"): SideFee {
  let ppm: number | null = specification.baseFeePpm;
  let routed: string | null = null;

  for (const rule of specification.rules) {
    // `swap` fires on both sides, so it counts towards each.
    if (rule.when.kind !== side && rule.when.kind !== "swap") continue;

    for (const effect of rule.then) {
      const stated = numberFrom(effect.parameters, "feePpm");

      if (effect.kind === "waiveFee") ppm = 0;
      if (effect.kind === "setFee") ppm = stated;
      if (effect.kind === "extraFee") ppm = stated === null || ppm === null ? null : ppm + stated;
      if (effect.kind === "routeFee") routed = textFrom(effect.parameters, "destination");
    }
  }

  return { ppm, routed };
}

/** Where a fee ends up, said the way somebody launching a token would say it. */
function routeNote(routed: string | null, side: "buy" | "sell"): string {
  if (routed === null) return `Charged on every ${side} and kept by the pool's liquidity.`;
  if (/fee|treasury|receiver|creator|owner/i.test(routed)) return "Sent to your fee receiver.";
  return `Collected into the ${humanise(routed)}.`;
}

/** The headline number for a rule that is not about fees. */
function triggerValue(rule: Rule): string {
  const streak = rule.conditions.find((condition) => condition.kind === "consecutiveCount");
  const count = numberFrom(streak?.parameters, "value");
  if (count !== null) {
    return `${String(count)} consecutive ${rule.when.kind === "sell" ? "sells" : "buys"}`;
  }

  switch (rule.when.kind) {
    case "buy":
      return "On every buy";
    case "sell":
      return "On every sell";
    case "swap":
      return "On every trade";
    case "timeElapsed": {
      const seconds = numberFrom(rule.when.parameters, "seconds");
      return seconds === null ? "Each period" : `Every ${asDuration(seconds)}`;
    }
    case "inactivity": {
      const seconds = numberFrom(rule.when.parameters, "seconds");
      return seconds === null ? "When it goes quiet" : `After ${asDuration(seconds)} quiet`;
    }
    case "volumeThreshold": {
      const usd = numberFrom(rule.when.parameters, "amountUsd");
      return usd === null ? "At a milestone" : `$${usd.toLocaleString("en-US")} of volume`;
    }
    case "newAllTimeHigh":
      return "At a new high";
    default:
      return capitalise(rule.when.description.replace(/\.$/, ""));
  }
}

/** The heading a non-fee effect deserves. */
const EFFECT_LABELS: Readonly<Record<string, string>> = {
  resetCounter: "RESET",
  rewardWallet: "REWARD",
  rewardGroup: "HOLDER REWARDS",
  accumulate: "REWARD POOL",
  buyback: "BUYBACK",
  burn: "BURN",
  transitionPhase: "PHASE CHANGE",
  waiveFee: "FEE-FREE TRADE",
  lockFunctionality: "LOCK",
  unlockFunctionality: "UNLOCK",
  disableRulePermanently: "ONE TIME ONLY",
};

const FEE_EFFECTS = new Set(["setFee", "extraFee", "routeFee"]);

/**
 * The market as three or four cards.
 *
 * The fees come first because they are what somebody checks, and both sides are shown
 * even when one of them is nothing — "BUY FEE / 0%" is a fact worth stating plainly, and
 * a card that is absent reads as a fee nobody mentioned rather than as no fee.
 *
 * After that, one card per rule that does something other than charge, in specification
 * order, up to a total of four. The cap is not cosmetic: a screen of eleven cards is a
 * report, which is the thing this is meant to replace, and the full set of rules is a
 * click away in the technical specification.
 */
export function behaviourCards(specification: MarketSpecification): readonly BehaviourCard[] {
  const cards: BehaviourCard[] = [];

  const buy = feeFor(specification, "buy");
  const sell = feeFor(specification, "sell");

  const asFee = (fee: SideFee, side: "buy" | "sell"): BehaviourCard => ({
    label: side === "buy" ? "BUY FEE" : "SELL FEE",
    value: fee.ppm === null ? "varies" : asPercent(fee.ppm),
    note:
      fee.ppm === 0
        ? `${capitalise(side)}s pay no hook fee.`
        : fee.ppm === null
          ? `This market changes the ${side} fee as it runs. The most any trade can pay is ` +
            `${asPercent(specification.maxFeePpm)}.`
          : routeNote(fee.routed, side),
  });

  cards.push(asFee(buy, "buy"), asFee(sell, "sell"));

  for (const rule of specification.rules) {
    if (cards.length >= 4) break;

    const effect = rule.then.find((candidate) => !FEE_EFFECTS.has(candidate.kind));
    if (effect === undefined) continue;

    // The rule's own title rather than its effect's `kind` when the effect is one this
    // codebase has no name for. A kind is an identifier — `setLeader` humanises to "SET
    // LEADER", which is the raw specification showing through on the one screen that
    // exists to keep it hidden — where the title was written for a person at
    // interpretation time and reads like one: "Hourly king".
    const label = EFFECT_LABELS[effect.kind] ?? rule.title.toUpperCase();
    if (cards.some((card) => card.label === label)) continue;

    cards.push({ label, value: triggerValue(rule), note: `${describeRule(rule)}.` });
  }

  return cards;
}

// --- live state ------------------------------------------------------------

/**
 * How a piece of market state should be presented, if a reader can fetch it.
 *
 * Derived from the specification's declared state, which is what makes "do not show
 * states a market does not have" automatic rather than a rule somebody has to remember:
 * a market with no jackpot declares no jackpot, so no jackpot row is generated.
 */
export interface StateDescriptor {
  readonly name: string;
  /** What to call it on the page. */
  readonly label: string;
  /** How to render the value once something reads it. */
  readonly format: "count" | "amount" | "address" | "flag" | "time" | "phase" | "text";
  /** The target, for state that is a progress bar rather than a number. */
  readonly target?: number;
}

/** The rows a token page should show, given what this market actually tracks. */
export function liveStateDescriptors(
  specification: MarketSpecification,
): readonly StateDescriptor[] {
  const targets = new Map<string, number>();

  // A counter compared against a threshold reads far better as "7 of 10" than as "7",
  // and the threshold is in the rule that reads it rather than in the declaration.
  for (const rule of specification.rules) {
    for (const condition of rule.conditions) {
      const state = textFrom(condition.parameters, "state");
      const value = numberFrom(condition.parameters, "value");
      if (state !== null && value !== null) targets.set(state, value);
    }
  }

  return specification.state.map((variable) => {
    const target = targets.get(variable.name);

    return {
      name: variable.name,
      label: humanise(variable.name),
      format: formatFor(variable),
      ...(target === undefined ? {} : { target }),
    };
  });
}

function formatFor(variable: StateVariable): StateDescriptor["format"] {
  switch (variable.type) {
    case "counter":
      return "count";
    case "accumulator":
    case "amount":
      return "amount";
    case "address":
      return "address";
    case "boolean":
      return "flag";
    case "timer":
      return "time";
    case "phase":
      return "phase";
    default:
      return "text";
  }
}

// --- cards -----------------------------------------------------------------

/** Everything a discovery card says about a market's mechanics. */
export interface MechanicSummary {
  /** The one line: "When someone sells more than 1% of liquidity, an extra 2% applies". */
  readonly headline: string;
  readonly ruleCount: number;
  readonly stateCount: number;
  /** True when the market's behaviour changes over its life rather than staying fixed. */
  readonly hasPhases: boolean;
  readonly hasExternalDependencies: boolean;
  /**
   * How unusual this market is, 0..1.
   *
   * Used to order a "most unique" shelf. Counts distinct rule triggers and effect kinds
   * rather than rules, because five rules that all adjust a fee is one idea written
   * five times, and two rules that introduce a leaderboard and a timeout is two.
   */
  readonly noveltyScore: number;
}

export function mechanicSummary(specification: MarketSpecification): MechanicSummary {
  const triggers = new Set(specification.rules.map((rule) => rule.when.kind));
  const effects = new Set(specification.rules.flatMap((rule) => rule.then.map((effect) => effect.kind)));
  const stateTypes = new Set(specification.state.map((variable) => variable.type));

  // Saturating at twenty distinct ideas. Twelve was the first guess and it was too low
  // — both reference markets pinned at 1.0, which makes the score useless for ordering
  // the shelf it exists to order.
  const distinct = triggers.size + effects.size + stateTypes.size;
  const novelty = Math.min(distinct, 20) / 20;

  return {
    headline: headlineMechanic(specification),
    ruleCount: specification.rules.length,
    stateCount: specification.state.length,
    hasPhases: specification.phases.length > 0,
    hasExternalDependencies: specification.externalDependencies.length > 0,
    noveltyScore: Number(novelty.toFixed(3)),
  };
}
