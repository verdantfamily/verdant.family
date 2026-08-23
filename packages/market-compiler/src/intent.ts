/**
 * The creator's request, before a model turns it into a market.
 *
 * A specification is not evidence that the prompt was understood: the contracts, cards and
 * tests can all agree with a specification that already dropped one sentence. This module
 * keeps the prompt beside the specification as small, source-linked requirements and reports
 * objective facts that did not survive interpretation.
 *
 * Free-form mechanics still need creator review. Facts with a deterministic reading — rates,
 * sides, thresholds, replacement/addition, splits, counts and durations — fail closed.
 */

import type { MarketSpecification, Rule, Scalar } from "./spec.js";
import {
  statedFreeSides,
  statedRates,
  statedThresholds,
  unmetRates,
  unmetSides,
  unmetThresholds,
} from "./requirements.js";
import { feeSchedule, type Side } from "./threshold.js";

export type IntentKind =
  | "fee"
  | "threshold"
  | "side"
  | "replacement"
  | "addition"
  | "split"
  | "count"
  | "duration"
  | "routing"
  | "phase"
  | "custom";

export interface IntentAtom {
  readonly id: string;
  readonly kind: IntentKind;
  /** Exact text from the prompt. */
  readonly quote: string;
  readonly start: number;
  readonly end: number;
  /** Rules whose own words most closely account for this clause. */
  readonly ruleIds: readonly string[];
  /**
   * Objective atoms are mechanically checked. A custom clause is still shown for approval,
   * but pretending a lexical match proves arbitrary natural language would be dishonest.
   */
  readonly objective: boolean;
  readonly status: "implemented" | "declared" | "missing";
}

export interface CreatorIntent {
  readonly prompt: string;
  readonly atoms: readonly IntentAtom[];
  /** Objective prompt facts that the specification does not implement. */
  readonly problems: readonly string[];
  readonly complete: boolean;
}

/** Build the source-linked intent record used by review and the semantic launch gate. */
export function creatorIntent(
  prompt: string,
  specification: MarketSpecification,
): CreatorIntent {
  const edits = (specification.edits ?? []).map((edit) => edit.instruction.trim()).filter(Boolean);
  const active = activeCreatorInstruction(prompt, specification);
  const fullPrompt = [prompt, ...edits].join("\n");
  const problems = objectiveProblems(active, specification);
  const rules = specification.rules.map((rule) => ({ rule, text: ruleText(rule) }));
  const sourceClauses = [
    ...clauses(prompt).map((clause) => ({ ...clause, superseded: edits.length > 0 })),
    ...edits.flatMap((edit) =>
      clauses(edit).map((clause) => ({
        ...clause,
        // Offsets inside an edit are local to that edit. The exact quote, not this display
        // offset, is the durable provenance.
        superseded: edit !== edits.at(-1),
      })),
    ),
  ];
  const atoms = sourceClauses.map((clause, index): IntentAtom => {
    const kind = kindOf(clause.quote);
    const objective = kind !== "custom" && !clause.superseded;
    const ruleIds = closestRules(clause.quote, rules);
    const accountedElsewhere =
      mentioned(clause.quote, specification.assumptions.map((entry) => `${entry.term} ${entry.interpretation}`)) ||
      mentioned(clause.quote, specification.ambiguities.map((entry) => `${entry.question} ${entry.why}`)) ||
      mentioned(clause.quote, specification.unsupported.map((entry) => `${entry.request} ${entry.reason}`));
    const missing = objective
      ? problems.some((problem) => related(problem, clause.quote))
      : ruleIds.length === 0 && !accountedElsewhere;

    return {
      id: `intent-${String(index + 1)}`,
      kind,
      quote: clause.quote,
      start: clause.start,
      end: clause.end,
      ruleIds,
      objective,
      status: missing ? "missing" : ruleIds.length > 0 ? "implemented" : "declared",
    };
  });

  return { prompt: fullPrompt, atoms, problems, complete: problems.length === 0 };
}

/**
 * The instruction whose exact facts currently outrank older wording.
 *
 * The full specification still has to preserve everything else, and the creator reviews it
 * again. This prevents an edit such as "make the sell fee 1%" being deterministically rewritten
 * back to the original 0.5% before generation.
 */
export function activeCreatorInstruction(
  originalPrompt: string,
  specification: MarketSpecification,
): string {
  return specification.edits?.at(-1)?.instruction.trim() || originalPrompt;
}

/**
 * Objective disagreements. These are suitable for a hard build failure because no judgement is
 * involved: 4% is not 4.5%, ten buys is not nine, and "instead" is not "in addition".
 */
export function objectiveProblems(
  prompt: string,
  specification: MarketSpecification,
): readonly string[] {
  const problems: string[] = [];

  problems.push(
    ...unmetRates(prompt, specification).map(
      (rate) => `${rate.phrase} requires the rate ${formatPpm(rate.ppm)}`,
    ),
    ...unmetThresholds(prompt, specification).map(
      ({ stated }) => `${stated.phrase} requires that exact trade-size threshold`,
    ),
    ...unmetSides(prompt, specification).map((side) => `${side}s must pay no hook fee`),
  );
  problems.push(...sideRateProblems(prompt, specification));

  const feeEffects = specification.rules.flatMap((rule) =>
    rule.then.filter((effect) => /fee|tax|charge|skim|toll|cut/i.test(`${effect.kind} ${effect.description}`)),
  );

  if (/\b(?:instead|replaces?|rather than)\b/i.test(prompt)) {
    const stacks = feeEffects.some((effect) => /extra|add|surcharge/i.test(effect.kind));
    if (stacks) problems.push('the description says the higher fee applies "instead", not on top');
  }

  if (/\b(?:additional|additionally|extra|on top of)\b/i.test(prompt)) {
    const adds = feeEffects.some((effect) => /extra|add|surcharge/i.test(effect.kind));
    if (!adds) problems.push("the description asks for an additional fee, but the specification replaces it");
  }

  for (const quantity of statedQuantities(prompt)) {
    if (!parameterCarries(specification, quantity)) {
      problems.push(
        `${quantity.phrase} must be a machine-readable ${quantity.kind}, not only prose`,
      );
    }
  }

  for (const destination of statedDestinations(prompt)) {
    if (!specificationText(specification).includes(destination)) {
      problems.push(`fees or value must be routed to ${destination} as described`);
    }
  }

  // `statedRates` and `statedThresholds` are intentionally called here as part of the public
  // contract: if their parsers learn another exact form, intent completeness learns it too.
  void statedRates(prompt);
  void statedThresholds(prompt);
  void statedFreeSides(prompt);

  return [...new Set(problems)];
}

function sideRateProblems(
  prompt: string,
  specification: MarketSpecification,
): readonly string[] {
  const problems: string[] = [];

  for (const clause of clauses(prompt)) {
    const thresholdPpm = new Set(
      statedThresholds(clause.quote).map((threshold) => Math.round(threshold.percent * 10_000)),
    );
    const rates = statedRates(clause.quote).filter((rate) => !thresholdPpm.has(rate.ppm));
    if (rates.length === 0) continue;
    const sides = sidesIn(clause.quote);
    if (sides.length === 0) continue;

    for (const side of sides) {
      const schedule = feeSchedule(specification, side);
      const charged =
        schedule === null
          ? []
          : [schedule.basePpm, ...(schedule.tier === null ? [] : [schedule.tier.ppm])];

      for (const rate of rates) {
        if (/\b(?:never|must not|does not|don't|do not)\b/i.test(clause.quote)) {
          if (charged.includes(rate.ppm)) {
            problems.push(`${side}s must never pay ${formatPpm(rate.ppm)}`);
          }
          continue;
        }

        if (/\b(?:additional|additionally|extra|on top of)\b/i.test(clause.quote)) {
          if (!hasSidedEffectRate(specification, side, rate.ppm, true)) {
            problems.push(
              `${side}s must add ${formatPpm(rate.ppm)} under the condition described`,
            );
          }
          continue;
        }

        if (
          !charged.includes(rate.ppm) &&
          !hasSidedEffectRate(specification, side, rate.ppm, false)
        ) {
          problems.push(`${side}s must pay ${formatPpm(rate.ppm)} where the description says`);
        }
      }
    }
  }

  return problems;
}

function sidesIn(text: string): readonly Side[] {
  const buys = /\bbuys?|buying|buyer\b/i.test(text);
  const sells = /\bsells?|selling|seller\b/i.test(text);
  if (buys && sells) return ["buy", "sell"];
  if (buys) return ["buy"];
  if (sells) return ["sell"];
  if (/\bevery trade|any trade|swap|both sides\b/i.test(text)) return ["buy", "sell"];
  return [];
}

function hasSidedEffectRate(
  specification: MarketSpecification,
  side: Side,
  ppm: number,
  additive: boolean,
): boolean {
  return specification.rules.some((rule) => {
    const applies =
      rule.when.kind === side ||
      ["swap", "trade", "buyOrSell", "buyAndSell"].includes(rule.when.kind);
    if (!applies) return false;

    return rule.then.some((effect) => {
      if (additive && !/extra|add|surcharge/i.test(effect.kind)) return false;
      if (!additive && /extra|add|surcharge/i.test(effect.kind)) return false;
      return Object.entries(effect.parameters ?? {}).some(([key, value]) => {
        if (typeof value !== "number") return false;
        const name = key.toLowerCase();
        const asPpm =
          name.includes("ppm")
            ? value
            : name.includes("bps") || name.includes("basispoint")
              ? value * 100
              : name.includes("percent") || name.includes("pct")
                ? value * 10_000
                : null;
        return asPpm === ppm;
      });
    });
  });
}

interface Clause {
  readonly quote: string;
  readonly start: number;
  readonly end: number;
}

function clauses(prompt: string): readonly Clause[] {
  const found: Clause[] = [];
  let start = 0;

  const take = (end: number): void => {
    const raw = prompt.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const quote = raw.trim();
    if (quote !== "" && !identityOnly(quote)) {
      const at = start + leading;
      found.push({ quote, start: at, end: at + quote.length });
    }
    start = end;
  };

  for (let at = 0; at < prompt.length; at += 1) {
    const character = prompt[at]!;
    if (!".!?;\n".includes(character)) continue;
    // A decimal point is part of 0.5%, not the end of a requirement.
    if (
      character === "." &&
      /\d/.test(prompt[at - 1] ?? "") &&
      /\d/.test(prompt[at + 1] ?? "")
    ) {
      continue;
    }
    take(at + 1);
  }
  take(prompt.length);
  return found;
}

function identityOnly(quote: string): boolean {
  if (!/\b(?:token|ticker|symbol|called|named)\b/i.test(quote)) return false;
  return !/\b(?:fee|tax|charge|sell|buy|trade|reward|burn|route|split|after|before|when|if|every|phase|window|liquidity|supply)\b/i.test(
    quote,
  );
}

function kindOf(quote: string): IntentKind {
  if (/\b(?:instead|replaces?|rather than)\b/i.test(quote)) return "replacement";
  if (/\b(?:additional|additionally|extra|on top of)\b/i.test(quote)) return "addition";
  if (/\b(?:at least|more than|larger than|over|above|below|under)\b[\s\S]*\b(?:supply|liquidity|pool|volume|market\s?cap)\b/i.test(quote)) {
    return "threshold";
  }
  if (/\b(?:buys?|sells?)\b[\s\S]*\b(?:nothing|no fee|zero|free)\b/i.test(quote)) return "side";
  if (/\b\d+(?:\.\d+)?\s*%\b[\s\S]*\b(?:fee|proceeds|revenue)\b[\s\S]*\b(?:goes?|split|route|to)\b/i.test(quote)) {
    return "split";
  }
  if (/\b(?:seconds?|minutes?|hours?|days?|weeks?|months?|window|cooldown)\b/i.test(quote)) return "duration";
  if (/\b(?:consecutive|every\s+\d+|after\s+\d+)\b/i.test(quote)) return "count";
  if (/\b(?:goes?|route|send|paid|vault|creator|treasury|buyback|burn|reward pool)\b/i.test(quote)) {
    return "routing";
  }
  if (/\b(?:phase|permanently|until|before|after)\b/i.test(quote)) return "phase";
  if (/\b(?:fee|fees|tax|charge|charged|toll|skim|cut)\b/i.test(quote)) return "fee";
  return "custom";
}

function ruleText(rule: Rule): string {
  return normalise(
    [
      rule.id,
      rule.title,
      rule.when.kind,
      rule.when.description,
      ...rule.conditions.flatMap((condition) => [
        condition.kind,
        condition.description,
        ...parameterText(condition.parameters),
      ]),
      ...rule.then.flatMap((effect) => [
        effect.kind,
        effect.description,
        ...parameterText(effect.parameters),
      ]),
    ].join(" "),
  );
}

function parameterText(parameters: Readonly<Record<string, Scalar>> | undefined): readonly string[] {
  return Object.entries(parameters ?? {}).flatMap(([key, value]) => [key, String(value)]);
}

const STOP = new Set([
  "a", "an", "and", "any", "as", "at", "be", "by", "called", "charge", "fee", "for", "from",
  "if", "in", "is", "it", "launch", "market", "of", "on", "or", "the", "this", "to", "token",
  "when", "with",
]);

function tokens(value: string): readonly string[] {
  return normalise(value)
    .split(" ")
    .map((word) => word.replace(/(?:es|s)$/i, ""))
    .filter((word) => word.length > 2 && !STOP.has(word));
}

function closestRules(
  quote: string,
  rules: readonly { readonly rule: Rule; readonly text: string }[],
): readonly string[] {
  const wanted = new Set(tokens(quote));
  if (wanted.size === 0) return [];
  const scored = rules
    .map(({ rule, text }) => ({
      id: rule.id,
      score: [...wanted].filter((word) => text.includes(word)).length,
    }))
    .filter(({ score }) => score >= Math.min(2, wanted.size))
    .sort((left, right) => right.score - left.score);
  const best = scored[0]?.score ?? 0;
  return scored.filter(({ score }) => score === best).map(({ id }) => id);
}

function mentioned(quote: string, candidates: readonly string[]): boolean {
  const wanted = tokens(quote);
  if (wanted.length === 0) return false;
  return candidates.some((candidate) => {
    const text = normalise(candidate);
    return wanted.filter((word) => text.includes(word)).length >= Math.min(2, wanted.length);
  });
}

function related(problem: string, quote: string): boolean {
  const words = tokens(quote);
  const text = normalise(problem);
  return words.some((word) => text.includes(word)) || /\d/.test(problem) && /\d/.test(quote);
}

interface StatedQuantity {
  readonly kind: "count" | "duration" | "split";
  readonly value: number;
  readonly unit: string;
  readonly phrase: string;
}

function statedQuantities(prompt: string): readonly StatedQuantity[] {
  const found: StatedQuantity[] = [];

  for (const match of prompt.matchAll(
    /\b(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|consecutive\s+buys?|consecutive\s+sells?|buys?|sells?|trades?)\b/gi,
  )) {
    const unit = match[2]!.toLowerCase();
    found.push({
      kind: /second|minute|hour|day|week|month/.test(unit) ? "duration" : "count",
      value: Number(match[1]),
      unit,
      phrase: match[0],
    });
  }

  for (const match of prompt.matchAll(
    /\b(?:after|every)\s+(\d+)(?:st|nd|rd|th)?\b(?=[^.!?;]{0,40}\b(?:buy|sell|trade))/gi,
  )) {
    const value = Number(match[1]);
    if (found.some((quantity) => quantity.kind === "count" && quantity.value === value)) continue;
    found.push({ kind: "count", value, unit: "trades", phrase: match[0] });
  }

  for (const match of prompt.matchAll(
    /\b(\d+(?:\.\d+)?)\s*%\s+of\s+(?:the\s+)?(?:fee|fees|proceeds|revenue)\b/gi,
  )) {
    found.push({ kind: "split", value: Number(match[1]), unit: "percent", phrase: match[0] });
  }

  return found;
}

function parameterCarries(specification: MarketSpecification, quantity: StatedQuantity): boolean {
  const entries = specification.rules.flatMap((rule) => [
    ...Object.entries(rule.when.parameters ?? {}).map(
      ([key, value]) => [`${rule.when.kind}.${key}`, value] as const,
    ),
    ...rule.conditions.flatMap((condition) =>
      Object.entries(condition.parameters ?? {}).map(
        ([key, value]) => [`${condition.kind}.${key}`, value] as const,
      ),
    ),
    ...rule.then.flatMap((effect) =>
      Object.entries(effect.parameters ?? {}).map(
        ([key, value]) => [`${effect.kind}.${key}`, value] as const,
      ),
    ),
  ]);

  return entries.some(([key, raw]) => {
    if (typeof raw !== "number") return false;
    const name = key.toLowerCase();
    if (quantity.kind === "count" && !/count|consecutive|trade|buy|sell|every|number|limit/.test(name)) {
      return false;
    }
    if (quantity.kind === "split" && !/share|split|portion|allocation|percent|pct|bps|ppm/.test(name)) {
      return false;
    }
    if (quantity.kind === "duration" && !/second|minute|hour|day|week|month|duration|window|period|cooldown/.test(name)) {
      return false;
    }

    const values =
      quantity.kind === "duration"
        ? durationValues(quantity.value, quantity.unit)
        : quantity.kind === "split"
          ? [quantity.value, quantity.value * 100, quantity.value * 10_000, quantity.value / 100]
          : [quantity.value];
    return values.some((value) => raw === value);
  });
}

function durationValues(value: number, unit: string): readonly number[] {
  const seconds =
    /minute/.test(unit)
      ? value * 60
      : /hour/.test(unit)
        ? value * 3_600
        : /day/.test(unit)
          ? value * 86_400
          : /week/.test(unit)
            ? value * 604_800
            : /month/.test(unit)
              ? value * 2_592_000
              : value;
  return [value, seconds];
}

function statedDestinations(prompt: string): readonly string[] {
  const found: string[] = [];
  for (const destination of ["creator", "vault", "treasury", "buyback", "burn", "reward pool"]) {
    if (
      new RegExp(
        String.raw`\b(?:goes?|route|send|paid|pay|into|to)\b[\s\S]{0,35}\b${destination.replace(" ", String.raw`\s+`)}\b`,
        "i",
      ).test(prompt)
    ) {
      found.push(destination);
    }
  }
  return found;
}

function specificationText(specification: MarketSpecification): string {
  return normalise(JSON.stringify(specification));
}

function normalise(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9.%]+/g, " ").trim();
}

function formatPpm(ppm: number): string {
  const percent = ppm / 10_000;
  return `${percent % 1 === 0 ? percent.toFixed(0) : String(percent)}%`;
}
