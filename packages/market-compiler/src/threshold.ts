/**
 * A size threshold as a number and a comparison, rather than as a sentence.
 *
 * "Charge 5% on every sell over 2% of the total supply" contains three facts and a
 * pipeline that keeps only two of them will ship the wrong market. The percentage is
 * obvious. What it is a percentage *of* is not — a threshold against the pool's
 * liquidity and one against the token's immutable supply move in opposite directions
 * over a market's life, and they are written with the same words. And whether the
 * boundary itself is included decides what a sale of exactly two percent pays, which is
 * the one trade a creator will check by hand.
 *
 * ## Why this is a module rather than a helper
 *
 * PUSH is why. Its prompt said "over 2% of the immutable total supply", the
 * interpretation came back with one percent, and every artefact downstream agreed with
 * the interpretation: the Solidity, the generated tests, the decision note, and the card
 * on the token page all said one percent, consistently and wrongly. Nothing disagreed,
 * because nothing else held a copy of what had been asked for.
 *
 * So the threshold is read once, from the creator's words, into a value with a basis and
 * a comparison — and everything that needs to say what the market does says it from
 * here. `requirements.ts` compares this against what interpretation locked and refuses
 * the build when they differ; `describe.ts` renders the English from it; `feeAt` is the
 * arithmetic a generated hook has to agree with, and the boundary cases nobody thinks to
 * try by hand are tested against it directly.
 *
 * ## The comparison is carried, never assumed
 *
 * `inclusive` is `null` when nothing said. That is deliberately not the same as `false`:
 * a threshold whose boundary nobody stated is a threshold with a gap in it, and
 * recording the gap is what lets a guard say "the creator wrote *over*, this market
 * implements *at least*" instead of silently agreeing with whichever the model chose.
 * Where a comparison has to be made anyway — the arithmetic below — `null` reads as
 * exclusive, because "over", "more than" and "above" are how creators overwhelmingly
 * write this and all three exclude the boundary.
 */

import type { Condition, MarketSpecification, Rule, Scalar } from "./spec.js";

/** What a size threshold is measured against. */
export type ThresholdBasis =
  /** The token's own total supply, which for an Agen launch never changes. */
  | "supply"
  /** What is in the pool right now, which every trade moves. */
  | "liquidity"
  | "marketCap"
  | "volume";

/** A trade size expressed as a share of something, with the comparison it is made under. */
export interface SizeThreshold {
  readonly basis: ThresholdBasis;
  /** `2` means two percent. Kept as percent because that is the unit creators write. */
  readonly percent: number;
  /**
   * Whether a trade landing exactly on the boundary is over it.
   *
   * `null` where nothing stated a comparison. See the note above on why that is not
   * `false`.
   */
  readonly inclusive: boolean | null;
  /** The words this was read from, so a message about it can be checked against them. */
  readonly phrase: string;
}

/** How the words name what a percentage is measured against. */
const BASIS_WORDS: readonly (readonly [ThresholdBasis, RegExp])[] = [
  // Supply first, and specifically: "total supply" and "circulating supply" are the same
  // basis, and a market cap is a supply times a price rather than a supply.
  ["supply", /\b(?:total|circulating|max|token'?s?)?\s*supply\b|\bsupply\b/i],
  ["marketCap", /\bmarket\s?cap(?:italisation|italization)?\b|\bvaluation\b|\bfdv\b/i],
  ["liquidity", /\bliquidity\b|\bpool\b|\breserves?\b|\btvl\b/i],
  ["volume", /\bvolume\b|\bturnover\b/i],
];

/**
 * Words that put a trade exactly on the boundary inside the rule, and words that leave
 * it out.
 *
 * Read from the phrasing rather than from the size of the number, for the same reason
 * every unit in this package is: "2% or more" and "more than 2%" differ by one trade,
 * and that trade is the one somebody tests.
 */
const INCLUSIVE_WORDS = /\bat least\b|\bor more\b|\bor above\b|\bor greater\b|\bno less than\b|\bminimum of\b|\bof at least\b|>=|≥/i;
const EXCLUSIVE_WORDS = /\bmore than\b|\bover\b|\babove\b|\bgreater than\b|\bexceed(?:s|ing)?\b|\bbeyond\b|\blarger than\b|\bbigger than\b|>(?!=)/i;

/** `tradeSizeVsSupply` as `trade Size Vs Supply`, so a word boundary exists to match on. */
function words(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
}

/**
 * The comparison a parameter bag states, or `null`.
 *
 * Interpretation commonly records it as an operator beside the number — `{ operator: ">",
 * percent: 1 }` is the shape the fixtures use — and an operator stated that plainly should not
 * have to be recovered from the prose next to it.
 */
export function inclusivityOf(parameters: Readonly<Record<string, Scalar>> | undefined): boolean | null {
  for (const [key, value] of Object.entries(parameters ?? {})) {
    const name = key.toLowerCase();

    if (typeof value === "boolean" && /inclusive|orequal|includesboundary/.test(name)) return value;
    if (typeof value !== "string") continue;
    if (!/operator|comparison|compare|relation/.test(name)) continue;

    const said = value.trim().toLowerCase();
    if (said === ">=" || said === "≥" || said === "gte" || said === "atleast") return true;
    if (said === ">" || said === "gt" || said === "morethan" || said === "above") return false;
  }

  return null;
}

/** The comparison a phrase states, or `null` where it states none. */
export function inclusivityIn(text: string): boolean | null {
  // Exclusive read first where both appear. "at least 2% more than the base" mentions
  // both and is about the fee rather than the boundary; a phrase that says "over" at all
  // has named the comparison this cares about.
  if (EXCLUSIVE_WORDS.test(text)) return false;
  if (INCLUSIVE_WORDS.test(text)) return true;
  return null;
}

/** What the words say the percentage is measured against, or `null`. */
export function basisIn(text: string): ThresholdBasis | null {
  for (const [basis, pattern] of BASIS_WORDS) {
    if (pattern.test(text)) return basis;
  }
  return null;
}

/**
 * A percentage read out of a parameter bag, whatever unit the key names.
 *
 * The unit comes from the key and never from the size of the value, which is the same
 * discipline `requirements.ts` and `core-tests.ts` apply to rates: a bare `2` is two
 * percent or two ppm depending entirely on what it was called, and guessing between them
 * moves a threshold by four orders of magnitude. A key that names no unit is read as
 * percent only when it says so.
 */
export function percentIn(parameters: Readonly<Record<string, Scalar>> | undefined): number | null {
  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;

    const name = key.toLowerCase();
    if (/share|split|portion|allocation|payout/.test(name)) continue;

    const percent = /percent|pct/.test(name)
      ? value
      : /ppm/.test(name)
        ? value / 10_000
        : /bps|basispoint/.test(name)
          ? value / 100
          : /fraction|ratio/.test(name)
            ? value * 100
            : null;

    if (percent !== null && percent > 0 && percent <= 100) return percent;
  }

  return null;
}

/**
 * The threshold a condition states, or `null` where it states none this can read.
 *
 * Wide about where the words come from — the kind, the description and the parameter
 * names all get a say — because `kind` is a free string and models spell this half a
 * dozen ways: `tradeSizeVsSupply`, `sellSizeOverSupplyPercent`, `isLargeSell`. Narrow
 * about the number, which only ever comes from `parameters`.
 */
export function thresholdIn(condition: Condition): SizeThreshold | null {
  const percent = percentIn(condition.parameters);
  if (percent === null) return null;

  const said = `${condition.kind} ${condition.description}`;

  /*
   * A parameter that names the basis outranks the kind and the prose, for the same reason a
   * recorded operator does: it is the field made for saying this. The precedence is
   * load-bearing rather than tidy — a rule can perfectly well arrive as
   * `tradeSizeVsSupply` gated on `{ basis: "poolLiquidity" }`, and reading the identifier
   * over the value would call that market a supply threshold on the strength of its name.
   *
   * Both readings split camelCase first. Neither `tradeSizeVsSupply` nor `totalSupply`
   * matches `\bsupply\b` until the case boundary is treated as a word boundary, which is why
   * the first version of this found nothing at all outside the fixtures.
   */
  const stated = Object.entries(condition.parameters ?? {})
    .filter(([key, value]) => typeof value === "string" && /basis|measured|against|relative|versus|vs\b|of\b/i.test(key))
    .map(([, value]) => basisIn(words(String(value))))
    .find((found): found is ThresholdBasis => found !== null);

  const basis =
    stated ??
    basisIn(words(`${said} ${Object.keys(condition.parameters ?? {}).join(" ")}`));

  if (basis === null) return null;

  return {
    basis,
    percent,
    // A recorded operator outranks the prose beside it: it is the same statement, made in the
    // field that exists for making it.
    inclusive: inclusivityOf(condition.parameters) ?? inclusivityIn(said),
    phrase: condition.description.trim().length > 0 ? condition.description.trim() : condition.kind,
  };
}

/** Whether two thresholds are the same requirement, ignoring the words around them. */
export function sameThreshold(left: SizeThreshold, right: SizeThreshold): boolean {
  return left.basis === right.basis && left.percent === right.percent;
}

// --- what a trade pays -----------------------------------------------------

/** The trade sides a fee can be stated for, as the interpretation names them. */
export type Side = "buy" | "sell";

/**
 * What one side of a market charges: a rate below the threshold and a rate above it.
 *
 * `tier` is null for the ordinary market with one flat rate. Where it is set, `basePpm`
 * is what a trade under the threshold pays and `tier.ppm` is what one over it pays —
 * already resolved, so a reader never has to know whether the specification wrote the
 * surcharge as an absolute rate or as an addition to the base.
 */
export interface FeeSchedule {
  readonly side: Side;
  readonly basePpm: number;
  readonly tier: {
    readonly threshold: SizeThreshold;
    readonly ppm: number;
  } | null;
}

/**
 * One rate in a side's ladder, and what has to hold for a trade to pay it.
 *
 * The distinction `kind` draws is about who writes the comparison, not about how
 * complicated the rule is. A size branch is arithmetic over numbers this package already
 * holds, so Agen writes it and nothing can move the boundary. A state branch turns on a
 * streak, a window, a phase or a wallet — something the hook has to keep — so the hook
 * answers whether it holds, and Agen still owns the rate that follows from the answer.
 */
export interface FeeBranch {
  readonly kind: "size" | "state";
  readonly ruleId: string;
  /** What a trade pays when this branch applies, in ppm, already resolved. */
  readonly ppm: number;
  /** The comparison Agen writes itself. Set on a size branch. */
  readonly threshold: SizeThreshold | null;
  /** The identifier the policy takes the hook's answer under. Set on a state branch. */
  readonly name: string | null;
  /** The gate in the creator's words, for the doc comment and the generator's brief. */
  readonly phrase: string;
}

/**
 * A side's whole fee ladder: what a plain trade pays, and every branch off it.
 *
 * This is the reading `feeSchedule` refuses. A market with a streak beside its size tier
 * does not have unknowable rates — it has one gate this package cannot compute and
 * several facts it can, and answering `null` to the whole thing handed the rates back to
 * a model with no better information than the specification it was copying from. EXCT is
 * the case: a consecutive-buy waiver on one side meant the 0.5%/4% ladder on the other
 * stopped being written here, for no reason connected to the ladder.
 *
 * Branches come out in specification order, because the order a creator wrote their
 * rules in is the only statement of precedence a prompt makes.
 */
export interface FeeProgram {
  readonly side: Side;
  readonly basePpm: number;
  readonly branches: readonly FeeBranch[];
}

/** Effect kinds that change what a trade pays. */
const FEE_EFFECTS = new Set(["extraFee", "setFee", "waiveFee", "routeFee", "chargeFee"]);

function chargesFee(effect: Rule["then"][number]): boolean {
  return FEE_EFFECTS.has(effect.kind) || /fee|tax|charge|skim|toll|cut/i.test(effect.kind);
}

/** Triggers that fire on both sides of a trade, however interpretation named them. */
const BOTH_SIDES = new Set(["swap", "trade", "buyOrSell", "buyAndSell", "any"]);

function appliesTo(rule: Rule, side: Side): boolean {
  return rule.when.kind === side || BOTH_SIDES.has(rule.when.kind);
}

/** Triggers that name a trade side, so a rule on the other side cannot affect this one. */
const SIDED = new Set(["buy", "sell"]);

/**
 * Whether a rule fires on a fee that has already been taken, rather than on a trade.
 *
 * Where a fee *goes* is a separate rule from what a trade *pays*, and interpretations write
 * it that way: EMBR asked for 3% on sells and 1% on buys, both stated plainly, and a third
 * rule sent the proceeds to the creator — `transferFee` on `feeCollected`. Read as one more
 * rule that might touch a fee, it made both sides unreadable.
 *
 * Exact Flow lost the same way and worse. Its "send 80% to the creator and 20% to the fee
 * vault" arrived as `splitCollectedFee` on `feeCollected`, the effect kind contains "Fee",
 * and so the whole ladder — 0.5%, 4% above 1% of supply, the inclusive boundary — went back
 * to being a model's copy of a number, because this module refused to read a market with a
 * payout rule in it. The fee policy was silently not generated at all.
 *
 * Narrow on purpose, in the direction that costs nothing. Mistaking a real trade fee for a
 * routing rule would mean claiming a rate another rule changes, so both halves are
 * required: the trigger has to name a fee *and* say it already happened.
 */
export function downstreamOfTheCharge(rule: Rule): boolean {
  const kind = rule.when.kind.toLowerCase();
  if (/fee/.test(kind) && /collect|charged|taken|received|accru|earned/.test(kind)) return true;

  /*
   * And anything a trade cannot trigger at all.
   *
   * HOLD charges 0.3% on every swap and pays it out to holders when they claim. The payout
   * rule fires on `claim`, mentions fees because that is what it distributes, and made the
   * flat 0.3% unreadable — so the one number the market is built on was asserted by nothing.
   * A claim, a withdrawal or a settlement happens because somebody asked for it, never
   * because somebody traded, so no such rule can change what a trade pays.
   */
  return /^(?:claim|withdraw|harvest|redeem|distribut|settle|payout)/.test(kind);
}

/**
 * The rate an effect states for one side, in ppm.
 *
 * A parameter naming the other side belongs to the other side; one naming neither is
 * read as this side's. The reasoning is `core-tests.ts`'s, at length, and the failure it
 * prevents is a single effect carrying `{ sellFeePpm: 50000, buyFeePpm: 0 }` being read
 * as a five percent fee on buys.
 */
function rateOf(parameters: Readonly<Record<string, Scalar>> | undefined, side: Side): number | null {
  const other: Side = side === "sell" ? "buy" : "sell";

  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (typeof value !== "number") continue;

    const name = key.toLowerCase();
    if (name.includes(other) && !name.includes(side)) continue;
    if (/share|split|portion|allocation|payout/.test(name)) continue;

    const ppm = name.includes("ppm")
      ? value
      : name.includes("bps") || name.includes("basispoint")
        ? value * 100
        : name.includes("percent") || name.includes("pct")
          ? value * 10_000
          : null;

    if (ppm !== null && Number.isInteger(ppm)) return ppm;
  }

  return null;
}

/** One rule's effects applied to a rate, or `null` where the rule says something this cannot read. */
function applyEffects(rule: Rule, side: Side, from: number): number | null {
  let ppm = from;

  for (const effect of rule.then) {
    if (!chargesFee(effect)) continue;

    // Where the fee goes is not what it costs. A routing effect that carries no rate
    // leaves the number alone rather than reading as a change to it.
    if (effect.kind === "routeFee" && rateOf(effect.parameters, side) === null) continue;

    if (effect.kind === "waiveFee") {
      ppm = 0;
      continue;
    }

    const stated = rateOf(effect.parameters, side) ?? rateInProse(effect.description);
    if (stated === null) return null;

    ppm = effect.kind === "extraFee" ? ppm + stated : stated;
  }

  return ppm;
}

/** `charge a 4% fee` is a rate even when the parameter bag is empty. */
function rateInProse(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  if (match === null) return null;
  const ppm = Math.round(Number(match[1]!) * 10_000);
  return Number.isInteger(ppm) && ppm >= 0 && ppm <= 1_000_000 ? ppm : null;
}

/**
 * Whether a condition only says which side of the trade this is.
 *
 * Such a condition is the effect's own sidedness written twice rather than a gate, and
 * treating it as a gate would make a plainly flat market unreadable. Held to the same
 * narrow test `core-tests.ts` uses: it must name the side or the direction and compare
 * against nothing numeric.
 */
function sideOnly(condition: Condition): boolean {
  const numeric = Object.values(condition.parameters ?? {}).some((value) => typeof value === "number");
  if (numeric) return false;

  return /^(?:trade)?side$|direction|isbuy|issell|buyorsell|zeroforone|swapkind/i.test(condition.kind);
}

/**
 * A size test that names the trades *under* the threshold.
 *
 * FLOR writes the 0.5% as "not a large sell" and the 4% as "at least 1%". Both
 * are size conditions; only the second is a tier. Counting the inverse as a
 * second gate makes the schedule unreadable, and then the hook is free to invent
 * one.
 */
function inverseSizeGate(condition: Condition): boolean {
  const sized =
    thresholdIn(condition) !== null ||
    (condition.children ?? []).some((child) => thresholdIn(child) !== null);
  if (!sized) return false;
  if (condition.combinator === "not") return true;
  const operator = String(condition.parameters?.operator ?? "");
  return operator === "<" || operator === "<=";
}

/**
 * What one side of this market charges, branch by branch.
 *
 * Still `null` for a market whose *rates* cannot be read — a rule whose effect states no
 * rate this can recover, or a phase that changes which rules are live at all. Those are
 * judgements, and inventing a number for one would be the crime this module exists to
 * stop. What no longer returns `null` is a rate that is perfectly readable sitting next
 * to a gate that is not: the gate becomes a named question for the hook, and the rate
 * stays here.
 */
export function feeProgram(specification: MarketSpecification, side: Side): FeeProgram | null {
  const charging = specification.rules.filter((rule) => rule.then.some(chargesFee));

  /*
   * A fee rule on some other trigger — a milestone, a claim, a payout — can change what this
   * side pays in ways this does not model, so the reading is abandoned rather than guessed at.
   *
   * A rule triggered on the *other* side is different, and the distinction is the one
   * `core-tests.ts` draws for the same reason: a rule that fires on a sell cannot change what
   * a buy costs, so a market stating both sides longhand is perfectly readable one side at a
   * time. Without that, every two-sided market answered `null` here and the cards fell back to
   * a figure with no threshold in it.
   */
  if (
    charging.some(
      (rule) =>
        !appliesTo(rule, side) && !SIDED.has(rule.when.kind) && !downstreamOfTheCharge(rule),
    )
  ) {
    return null;
  }

  const relevant = charging.filter((rule) => appliesTo(rule, side));

  const gates = (rule: Rule): readonly Condition[] =>
    rule.conditions.filter((clause) => !sideOnly(clause) && !inverseSizeGate(clause));

  const phased = (rule: Rule): boolean =>
    rule.onceOnly === true || (rule.activeInPhases ?? []).length > 0;

  // A rule that is only live in some phases, or only once ever, changes which ladder
  // applies rather than adding a rung to this one.
  if (relevant.some(phased)) return null;

  let basePpm: number | null = specification.baseFeePpm;
  for (const rule of relevant.filter((rule) => gates(rule).length === 0)) {
    basePpm = basePpm === null ? null : applyEffects(rule, side, basePpm);
  }
  if (basePpm === null) return null;

  const branches: FeeBranch[] = [];

  for (const rule of relevant) {
    const clauses = gates(rule);
    if (clauses.length === 0) continue;

    const ppm = applyEffects(rule, side, basePpm) ?? rateInProse(rule.title);
    if (ppm === null) return null;

    // One clause naming a size is the only gate this package can compute. Everything
    // else — two clauses, a streak, a duration — is the hook's to answer.
    const threshold = clauses.length === 1 ? thresholdIn(clauses[0]!) : null;

    branches.push(
      threshold === null
        ? {
            kind: "state",
            ruleId: rule.id,
            ppm,
            threshold: null,
            name: predicateName(rule.id),
            phrase: gatePhrase(rule, clauses),
          }
        : {
            kind: "size",
            ruleId: rule.id,
            ppm,
            threshold,
            name: null,
            phrase: thresholdEnglish(threshold),
          },
    );
  }

  return { side, basePpm, branches };
}

/**
 * What one side of this market charges, as a base and at most one size-gated tier.
 *
 * The narrow reading, kept narrow. Cards, `core-tests.ts` and `requirements.ts` all say
 * "this market charges X, and Y above a size" in the creator's language, and a ladder
 * with a streak in it cannot be said that way without leaving the streak out. So this
 * still answers `null` there, and `feeProgram` is what the generated Solidity is built
 * from.
 */
export function feeSchedule(specification: MarketSpecification, side: Side): FeeSchedule | null {
  const program = feeProgram(specification, side);
  if (program === null) return null;

  const { basePpm, branches } = program;
  if (branches.length === 0) return { side, basePpm, tier: null };
  if (branches.length > 1) return null;

  const only = branches[0]!;
  if (only.kind !== "size" || only.threshold === null) return null;

  return { side, basePpm, tier: { threshold: only.threshold, ppm: only.ppm } };
}

/**
 * The identifier a state gate is answered under, from the rule's own id.
 *
 * Derived rather than invented so the parameter in the generated library, the entry in
 * the generator's brief and the rule on the token page are all traceable to one another
 * by name. Rule ids are already `[a-z0-9-]`, so camel-casing produces an identifier.
 */
function predicateName(ruleId: string): string {
  const parts = ruleId.split(/[^a-zA-Z0-9]+/).filter((part) => part.length > 0);
  const camel = parts
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : part[0]!.toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join("");

  return /^[a-z]/.test(camel) ? camel : `gate${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

/** A rule's gate in the creator's words, for a reader who has to check it. */
function gatePhrase(rule: Rule, clauses: readonly Condition[]): string {
  const said = clauses
    .map((clause) =>
      clause.description.trim().length > 0 ? clause.description.trim() : words(clause.kind),
    )
    .filter((text) => text.length > 0);

  return said.length > 0 ? said.join(", and ") : rule.title;
}

/**
 * What a trade of this size pays under this schedule, in ppm.
 *
 * Integer arithmetic throughout, and in the same shape a hook has to use: the amount is
 * scaled up rather than the basis divided down, so nothing turns on a rounding decision
 * that Solidity would make differently. `basisAmount` is whatever the threshold is
 * measured against — the total supply for a supply threshold, the pool's holding for a
 * liquidity one — and a basis of zero means no trade can be over the threshold.
 */
export function feeAt(
  schedule: FeeSchedule,
  { amount, basisAmount }: { readonly amount: bigint; readonly basisAmount: bigint },
): number {
  const { tier } = schedule;
  if (tier === null) return schedule.basePpm;

  return overThreshold(tier.threshold, { amount, basisAmount }) ? tier.ppm : schedule.basePpm;
}

/**
 * Whether a trade of this size is over the threshold.
 *
 * `amount * 1e6 > basis * thresholdPpm` rather than `amount > basis * percent / 100`,
 * because the second truncates the boundary and a truncated boundary is exactly the
 * trade this comparison exists to classify.
 */
export function overThreshold(
  threshold: SizeThreshold,
  { amount, basisAmount }: { readonly amount: bigint; readonly basisAmount: bigint },
): boolean {
  if (basisAmount <= 0n) return false;

  const scaled = amount * 1_000_000n;
  const boundary = basisAmount * BigInt(Math.round(threshold.percent * 10_000));

  return threshold.inclusive === true ? scaled >= boundary : scaled > boundary;
}

// --- saying it in the two languages that have to agree ---------------------

/** What a basis is called in a sentence a creator reads. */
const BASIS_ENGLISH: Readonly<Record<ThresholdBasis, string>> = {
  supply: "the total supply",
  liquidity: "the pool's liquidity",
  marketCap: "the market's implied value",
  volume: "traded volume",
};

/** The name a generated contract holds the basis under. */
const BASIS_SOLIDITY: Readonly<Record<ThresholdBasis, string>> = {
  supply: "totalSupply",
  liquidity: "poolLiquidity",
  marketCap: "impliedValue",
  volume: "cumulativeVolume",
};

/** `2% of the total supply`, with the comparison the creator wrote in front of it. */
export function thresholdEnglish(threshold: SizeThreshold): string {
  const comparison = threshold.inclusive === true ? "at least" : "more than";
  return `${comparison} ${formatPercent(threshold.percent)} of ${BASIS_ENGLISH[threshold.basis]}`;
}

/**
 * The comparison a generated hook has to make, as Solidity.
 *
 * Written out so the contract, the card and the tests are three renderings of one value
 * rather than three chances to disagree — and in the same arithmetic as `overThreshold`,
 * which is the point of writing it here at all.
 *
 * That last part used to be untrue, twice.
 *
 * A whole percentage got `basis * 2 / 100`, the form somebody would write by hand, and
 * integer division truncates it: against a basis of 101 the boundary lands at 2 rather
 * than 2.02, so a trade of exactly 2 is over the line in the contract and under it
 * everywhere else. It never showed against a supply, which is round by construction, and
 * it was always wrong against the pool's liquidity, which is whatever the last trade left
 * behind. Scaling the amount up instead cannot truncate, so both percentages get that form.
 *
 * And a zero basis read as every trade being enormous. `overThreshold` has always said a
 * threshold against nothing is not exceeded; the Solidity said `1 * 1_000_000 > 0`, which
 * is true, so a market with a liquidity gate charged its surcharge on every trade the
 * moment a hook passed a basis it did not have — which the hooks do, because the ones with
 * a supply gate pass zero for liquidity and the reverse. Found by the vector table on the
 * first market it ran against, which is the entire argument for having one.
 */
export function thresholdSolidity(
  threshold: SizeThreshold,
  amountExpression = "amountIn",
): string {
  const operator = threshold.inclusive === true ? ">=" : ">";
  const basis = BASIS_SOLIDITY[threshold.basis];
  const ppm = Math.round(threshold.percent * 10_000);

  return `${basis} != 0 && ${amountExpression} * 1_000_000 ${operator} ${basis} * ${grouped(ppm)}`;
}

/** `25000` as `25_000`, which is how the rest of this package writes a constant. */
function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}

/** `2` reads as `2%`, `1.5` as `1.5%`. */
export function formatPercent(percent: number): string {
  return `${percent % 1 === 0 ? percent.toFixed(0) : String(percent)}%`;
}
