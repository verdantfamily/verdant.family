/**
 * What the creator asked for, written down precisely enough to build from.
 *
 * ## A plan, not a cage
 *
 * The obvious design for this file is a closed enumeration: `type Action = BUYBACK |
 * BURN | REWARD | CHANGE_FEE`, a validator that rejects anything else, and a code
 * generator that switches over the cases. It would be safe, it would be easy to
 * validate, and it would be the wrong product. The ceiling of what a creator could
 * build would be the union type, and every genuinely new idea would arrive as a pull
 * request against this file.
 *
 * So the vocabulary here is open. `kind` is a string, not a union. There is a register
 * of well-known kinds below because naming the common cases is how the generator reuses
 * a good implementation of a rolling window instead of inventing a worse one each time,
 * but an unrecognised kind is a description of something new rather than an error.
 *
 * What is *not* open is the shape. A rule has a trigger, conditions and effects; state
 * has a declared type and bounds; a fee has a ceiling. That structure is what makes the
 * specification checkable, explainable in English on a token page, and comparable
 * against the contract that eventually gets generated. The novelty lives in the values,
 * the discipline lives in the frame.
 *
 * ## Why prose and numbers are kept apart
 *
 * Every string in a specification originates, however indirectly, in something a
 * creator typed. `description` fields are prose and are treated as untrusted: they are
 * shown to humans, quoted into prompts inside fences, and never parsed for meaning.
 * Anything the generator computes with — a percentage, a duration, an address, a
 * threshold — lives in `parameters` as a scalar, where it can be bounds-checked. A
 * specification that encodes "1.5%" only inside a sentence has not been understood, it
 * has been transcribed, and the difference matters when the number reaches a fee.
 */

import type { Address } from "viem";

/** The only value types a generator may compute with. Prose is not one of them. */
export type Scalar = string | number | bigint | boolean;

/**
 * A declared piece of market state.
 *
 * `type` is open for the same reason `kind` is, but the common cases are named so the
 * generator can reach for an implementation it already knows is correct — a
 * reward-per-share accumulator rather than a loop over holders.
 */
export interface StateVariable {
  /** Identifier-shaped, because it becomes one. */
  readonly name: string;
  /** `counter`, `timer`, `accumulator`, `rollingWindow`, `address`, `phase`, … */
  readonly type: string;
  /** What it means, for the token page and for the generator's own reasoning. */
  readonly description: string;
  /** Where it starts. Absent means the type's zero value. */
  readonly initial?: Scalar;
  /**
   * Whether this is written exactly once and never again.
   *
   * Named `writeOnce` rather than `permanent`, which is what it was called until a
   * live run showed the word was ambiguous: a model reading "permanent" about a vault
   * marked the vault permanent — meaning the vault is a permanent fixture of the
   * market — and the build failed on a check about assignment counts. "Permanent" is a
   * fair description of a vault and a poor description of a variable's write pattern,
   * and the field is about the second thing.
   *
   * Load-bearing rather than decorative: a variable declared write-once that the
   * generated contract assigns twice is a specification the implementation does not
   * honour, which is exactly the class of bug a creator cannot see.
   */
  readonly writeOnce?: boolean;
}

/** What sets a rule off. */
export interface Trigger {
  /** `sell`, `buy`, `swap`, `newAllTimeHigh`, `volumeThreshold`, `inactivity`, … */
  readonly kind: string;
  readonly description: string;
  readonly parameters?: Readonly<Record<string, Scalar>>;
}

/** A test that must hold for the rule's effects to happen. */
export interface Condition {
  /** `tradeSizeVsLiquidity`, `consecutiveCount`, `holdingDuration`, `phaseIs`, … */
  readonly kind: string;
  readonly description: string;
  readonly parameters?: Readonly<Record<string, Scalar>>;
  /** `and` | `or` | `not`, for conditions that group others. */
  readonly combinator?: string;
  readonly children?: readonly Condition[];
}

/** Something the market does when a rule fires. */
export interface Effect {
  /** `extraFee`, `routeFee`, `accumulate`, `buyback`, `reward`, `transitionPhase`, … */
  readonly kind: string;
  readonly description: string;
  readonly parameters?: Readonly<Record<string, Scalar>>;
  /**
   * Declared state this effect changes.
   *
   * Advisory. It drives the coherence hints and the interface's sense of what a rule
   * touches, and it never reaches a contract — the generator works from the effect's
   * kind and parameters, not from this list.
   *
   * That matters for how strictly it is enforced. Three live runs died at
   * interpretation because the model listed `hookFeePpm` and `lpFeePpm` here, which is
   * a reasonable thing to believe about an effect that changes the fee and is not what
   * this field means: the fee is computed per swap, not stored. Failing a whole build
   * over an annotation was the wrong trade, so unknown names are dropped during
   * interpretation rather than rejected. What stays strict is everything that changes
   * what the contract does — phases, ceilings, permanence.
   */
  readonly writes?: readonly string[];
}

export interface Rule {
  /** Stable across versions, so an edit can patch a rule rather than replace the set. */
  readonly id: string;
  /** Shown on the token page as the rule's heading. */
  readonly title: string;
  readonly when: Trigger;
  readonly conditions: readonly Condition[];
  readonly then: readonly Effect[];
  /** Which market phases this rule is live in. Empty means all of them. */
  readonly activeInPhases?: readonly string[];
  /** Once true, the rule fires at most once for the life of the market. */
  readonly onceOnly?: boolean;
}

/** A named market phase, for mechanics with a state machine. */
export interface Phase {
  readonly name: string;
  readonly description: string;
  /** Cannot be left once entered. */
  readonly terminal?: boolean;
  /** Phases reachable from this one. */
  readonly transitionsTo?: readonly string[];
}

/**
 * Something that must always be true.
 *
 * These become generated invariant tests and, where they can be, gate checks. A
 * specification that says the hook's fee never exceeds three percent is a claim the
 * implementation has to earn — and a fuzzer is much better than a reviewer at finding
 * the trade where it does not.
 */
export interface Invariant {
  readonly id: string;
  readonly statement: string;
  /** A checkable form where one exists: `hookFeePpm <= 30000`. */
  readonly expression?: string;
}

/**
 * Something the market needs that the pool cannot provide.
 *
 * Disclosed rather than hidden. A market whose fee depends on the price of BTC is a
 * market with a trust assumption, and a trader who cannot see that assumption is being
 * misled by omission.
 */
export interface ExternalDependency {
  /** `priceOracle`, `attestation`, `keeper`, … */
  readonly kind: string;
  readonly description: string;
  /** Who supplies it, once chosen. */
  readonly provider?: string;
  /** What the market does when the source is unavailable or stale. */
  readonly failureBehaviour: string;
}

/**
 * How much turns on getting something right.
 *
 * The scale exists to keep a launch from becoming an interview. `low` is a detail with
 * one sensible reading — "buys have no hook fee" for a market that only mentioned sells
 * — and is recorded rather than asked about. `high` is a decision the creator would want
 * to make themselves, and Agen does not get to make it quietly: see
 * `promoteForConfirmation`.
 */
export type Importance = "low" | "medium" | "high";

/**
 * A definition the creator did not give and the interpreter had to choose.
 *
 * Surfaced in the interface so it can be corrected before deployment. "Whale" and
 * "dump" are the canonical examples: both are obvious to a human and neither has a
 * threshold until somebody picks one.
 *
 * The bar for making one at all is that the intent is clear, the reading is low-risk,
 * and asking would be friction rather than diligence. A creator who writes "charge 1% on
 * sells" has said what they want; stopping to ask whether buys should also pay is not
 * care, it is an interrogation with an obvious answer, and the honest thing is to record
 * "buys have no hook fee" where they can see and change it.
 */
export interface Assumption {
  readonly id: string;
  /** The word or phrase being pinned down. */
  readonly term: string;
  /** The interpretation chosen, in the creator's terms. */
  readonly interpretation: string;
  /**
   * What in the request led here.
   *
   * Required, because an assumption whose origin cannot be stated is a guess. It is also
   * the difference between a review screen a creator reads and one they scroll past: "you
   * only mentioned sells" tells them whether to care in a way the interpretation alone
   * does not.
   */
  readonly why: string;
  /** The machine-readable form, when the assumption is a number. */
  readonly parameters?: Readonly<Record<string, Scalar>>;
  readonly importance: Importance;
  /**
   * Whether this must be agreed to rather than merely disclosed.
   *
   * True turns the assumption into a question — the creator is asked before anything is
   * built. See `promoteForConfirmation`, which applies that rule rather than trusting
   * the interpreter to have applied it.
   */
  readonly requiresConfirmation?: boolean;
  /** Set once the creator has said yes, so they are not asked twice. */
  readonly confirmed?: boolean;
  /**
   * Set once the rules have been re-derived to honour it.
   *
   * The same marker suggestions carry, for the same reason. Without it a revision on turn
   * five is handed every reading ever settled, including the ones already built, and is
   * invited to reopen an agreement from turn two while implementing turn five.
   */
  readonly applied?: boolean;
}

/** Which part of the market a suggestion is about. */
export type SuggestionCategory =
  | "economics"
  | "ux"
  | "security"
  | "gas"
  | "scalability"
  | "execution"
  | "oracle"
  | "liquidity";

export const SUGGESTION_CATEGORIES = [
  "economics",
  "ux",
  "security",
  "gas",
  "scalability",
  "execution",
  "oracle",
  "liquidity",
] as const satisfies readonly SuggestionCategory[];

/**
 * An improvement Agen thinks is worth considering, and did not make.
 *
 * The distinction from the two neighbouring concepts is the whole value of the field.
 * An ambiguity is Agen unable to proceed correctly; an assumption is Agen proceeding on
 * a reading it can defend; a suggestion is a market that is already right, next to an
 * observation about how it might be better. Nothing here changes what gets built unless
 * the creator accepts it.
 *
 * The failure mode is not missing one, it is producing five. A screen of generic advice
 * — "consider dynamic fees", "consider adding rewards" — is worse than silence, because
 * it buries the one observation that came from actually reading the market and teaches
 * the creator to skip the section. Zero suggestions is the common, correct answer for a
 * market whose mechanic is sound.
 */
export interface Suggestion {
  readonly id: string;
  /** An imperative line: "Roll part of the jackpot forward". */
  readonly title: string;
  /** Why it might help, grounded in this market rather than in general advice. */
  readonly reason: string;
  /** What would change, concretely enough to be acted on. */
  readonly proposedChange: string;
  readonly category: SuggestionCategory;
  /** Absent until the creator has decided. */
  readonly decision?: "accepted" | "declined";
  /** The creator's own wording, when they accepted a modified version of it. */
  readonly amended?: string;
  /** Set once the rules have been re-derived to include it. See `derivedNow`. */
  readonly applied?: boolean;
}

/**
 * Something the request implies that could not be resolved at all.
 *
 * Four fields rather than two, because a question on its own is an interrogation. A
 * creator being asked "how should the buyback execute?" needs to know why they are being
 * asked, what happens if they say nothing, and what the plausible answers are — and
 * without those three a clarifying question is slower than no question, since the
 * creator has to reconstruct the engineering context that prompted it.
 *
 * `blocking` is what separates a question from an interview. Most ambiguity has a
 * defensible default and should be resolved into an assumption the creator can see and
 * override; only ambiguity that materially changes economics, custody, security or
 * feasibility earns the right to stop a build. See `assess`.
 */
export interface Ambiguity {
  readonly id: string;
  readonly question: string;
  /** Why this changes the market, in the creator's terms. */
  readonly why: string;
  /**
   * What Agen would do if nobody answered.
   *
   * Always present, including for blocking questions. A question with no default is a
   * question the interpreter has not finished thinking about, and it is also the thing
   * that makes an answer optional later: a creator who does not care can accept this.
   */
  readonly otherwise: string;
  readonly options?: readonly string[];
  /**
   * Whether building without an answer would produce a market the creator did not ask
   * for, rather than merely one of several reasonable readings.
   */
  readonly blocking: boolean;
}

/**
 * A change the creator asked for in their own words, after reading the market.
 *
 * "Make the sell fee 1% instead", "change the timer to 30 minutes". The third thing a
 * creator can do to a specification, alongside answering a question and taking a
 * suggestion, and the one that arrives as free text rather than as a decision about
 * something Agen raised.
 *
 * Kept on the specification rather than in a chat log for the same reason every other
 * decision is: it is the record of what the creator actually agreed to, it is what the
 * next revision reads, and it is what the review screen shows when they ask what they
 * changed. The instruction is prose and is treated as untrusted — quoted into a prompt
 * inside a fence, never parsed for meaning here.
 */
export interface Edit {
  readonly id: string;
  /** What they typed. */
  readonly instruction: string;
  /** Set once the rules have been re-derived to include it. */
  readonly applied?: boolean;
}

/** Something the request asked for that this market will not do, and why. */
export interface Unsupported {
  readonly request: string;
  readonly reason: string;
  /** A different mechanic that preserves the intent, where one exists. */
  readonly suggestion?: string;
}

export interface MarketSpecification {
  /** Bumped on every edit. The deployed market pins exactly one. */
  readonly version: number;

  /**
   * The version whose decisions the rules below actually implement.
   *
   * Equal to `version` for a specification whose mechanic is up to date, and behind it
   * for one carrying decisions that have been recorded but not yet built into the rules —
   * an accepted suggestion, an answered question, a reading the creator replaced.
   *
   * It exists because those two things move at different speeds. Recording a decision is
   * bookkeeping and happens instantly; turning "roll 20% of the pot forward" into a
   * changed effect is interpretation and costs a model call. Without a number saying
   * which of the two a specification is between, the only options are to re-interpret on
   * every click or to quietly build a market that ignores what the creator just said.
   *
   * Absent on specifications written before this existed, which are read as current.
   */
  readonly rulesDerivedAtVersion?: number;
  readonly name: string;
  readonly symbol: string;
  /** One line for a token card: "Largest hourly buyer earns 20% of fees". */
  readonly summary: string;
  /** The base LP fee before any rule adjusts it, in hundredths of a basis point. */
  readonly baseFeePpm: number;

  /**
   * The most this market can ever charge, in hundredths of a basis point.
   *
   * Declared per market rather than imposed by Agen. An early version of this file
   * capped every market at 3% on the reasoning that more looked like theft, and that
   * was Agen deciding what economics are allowed — which is the opposite of the
   * product. A market that charges 20% on sells in its first hour is a strange market,
   * not an illegitimate one, and the honest response is to make the number impossible
   * to miss rather than impossible to choose.
   *
   * So the ceiling is the market's own, and it is load-bearing in three places: the
   * validator refuses any rule that could exceed it, the generated invariant tests have
   * to prove the contract respects it, and the interface shows it to a trader before
   * they buy. The only limit Agen imposes is the protocol's own.
   */
  readonly maxFeePpm: number;
  readonly quoteAsset?: Address;

  readonly phases: readonly Phase[];
  readonly state: readonly StateVariable[];
  readonly rules: readonly Rule[];
  readonly invariants: readonly Invariant[];

  readonly externalDependencies: readonly ExternalDependency[];
  readonly assumptions: readonly Assumption[];
  readonly ambiguities: readonly Ambiguity[];
  /** Optional improvements, none of which have been applied. See `Suggestion`. */
  readonly suggestions: readonly Suggestion[];
  /** Changes the creator asked for in their own words, newest last. See `Edit`. */
  readonly edits?: readonly Edit[];
  readonly unsupported: readonly Unsupported[];
}

// --- the register of well-known kinds --------------------------------------
//
// Not a whitelist. Nothing rejects a kind that is missing here. This exists so the
// generator can recognise a mechanic it already knows how to implement well, and so
// two specifications that mean the same thing tend to say it the same way. Anything
// absent is a mechanic that has to be designed rather than recalled, which is the
// normal case for a product whose promise is that novel ideas work.

export const KNOWN_TRIGGERS = [
  "buy",
  "sell",
  "swap",
  "addLiquidity",
  "removeLiquidity",
  "timeElapsed",
  "blockReached",
  "volumeThreshold",
  "marketCapThreshold",
  "priceThreshold",
  "newAllTimeHigh",
  "consecutiveTrades",
  "inactivity",
  "phaseEntered",
  "externalEvent",
] as const;

export const KNOWN_CONDITIONS = [
  "tradeSizeAbsolute",
  "tradeSizeVsLiquidity",
  "tradeSizeVsSupply",
  "walletBalance",
  "walletHoldingDuration",
  "walletAge",
  "consecutiveCount",
  "rollingCount",
  "rollingAverage",
  "withinDuration",
  "sinceEvent",
  "percentageChange",
  "volatility",
  "phaseIs",
  "flagIs",
] as const;

export const KNOWN_EFFECTS = [
  "setFee",
  "extraFee",
  "waiveFee",
  "routeFee",
  "accumulate",
  "burn",
  "buyback",
  "rewardWallet",
  "rewardGroup",
  "transitionPhase",
  "startTimer",
  "resetCounter",
  "setFlag",
  "lockFunctionality",
  "unlockFunctionality",
  "disableRulePermanently",
  "callAdapter",
] as const;

export const KNOWN_STATE_TYPES = [
  "counter",
  "timer",
  "boolean",
  "address",
  "amount",
  "percentage",
  "rollingWindow",
  "accumulator",
  "snapshot",
  "phase",
] as const;

// --- bounds ----------------------------------------------------------------

/**
 * The only fee limit Agen imposes, and it is not Agen's.
 *
 * `LPFeeLibrary.MAX_LP_FEE` in Uniswap v4: one hundred percent, in hundredths of a
 * basis point. A pool cannot express more, so a market asking for more is not being
 * refused on taste — it is being told the chain will not carry it.
 */
export const PROTOCOL_MAX_FEE_PPM = 1_000_000;

/**
 * What a market charges when the creator did not say.
 *
 * 0.3%, which is the fee most Uniswap pools have charged for years and therefore the one
 * a trader is least surprised by. It exists so that "you did not tell me your base fee"
 * is never a question: almost every prompt describes an unusual mechanic and says nothing
 * about the ordinary fee underneath it, and stopping the build to ask about the one
 * number with an obvious industry default is the interview this loop exists to avoid.
 *
 * Recorded as an assumption when it is used, so a creator who does care can see it and
 * change it.
 */
export const DEFAULT_BASE_FEE_PPM = 3_000;

/**
 * Bounds that exist so a misunderstanding cannot become a market.
 *
 * Note what is absent. There is no Agen-wide fee ceiling: each specification declares
 * its own `maxFeePpm` and is held to it. The product's promise is that a creator can
 * describe unusual economics, and a global cap is exactly the kind of well-meant
 * restriction that turns "describe anything" into "describe anything from this list".
 */
export const SPEC_BOUNDS = {
  maxRules: 32,
  maxStateVariables: 32,
  maxPhases: 8,
  maxConditionDepth: 4,
  minBaseFeePpm: 0,
  maxDescriptionLength: 400,
  maxSummaryLength: 120,
  identifierPattern: /^[a-z][a-zA-Z0-9]{0,39}$/,
  ruleIdPattern: /^[a-z0-9][a-z0-9-]{0,39}$/,
} as const;

export interface SpecProblem {
  /** A dotted path into the specification: `rules[2].then[0].writes[1]`. */
  readonly path: string;
  readonly detail: string;
}

function depthOf(condition: Condition, depth = 1): number {
  const children = condition.children ?? [];
  if (children.length === 0) return depth;
  return Math.max(...children.map((child) => depthOf(child, depth + 1)));
}

/**
 * Everything wrong with a specification, rather than the first thing.
 *
 * The caller is either a form or a repair loop, and both do better with the whole list:
 * a model handed one error at a time will fix it, introduce the next, and burn an
 * iteration per problem.
 *
 * Note what is *not* checked. No kind is rejected for being unrecognised, and no rule
 * is rejected for describing something unusual. What is enforced is internal coherence
 * — a rule writing state that was never declared, a phase transition to a phase that
 * does not exist, a fee above the ceiling — because those are the errors that produce a
 * contract nobody can explain, whatever the mechanic was supposed to be.
 */
export function validateSpecification(
  spec: MarketSpecification,
): readonly SpecProblem[] {
  const problems: SpecProblem[] = [];
  const add = (path: string, detail: string): void => {
    problems.push({ path, detail });
  };

  if (spec.version < 1 || !Number.isInteger(spec.version)) {
    add("version", "a whole number from 1");
  }
  if (spec.summary.trim().length === 0) {
    add("summary", "a one-line summary is required; it is what a token card shows");
  }
  if (spec.summary.length > SPEC_BOUNDS.maxSummaryLength) {
    add("summary", `at most ${String(SPEC_BOUNDS.maxSummaryLength)} characters`);
  }

  if (
    !Number.isInteger(spec.maxFeePpm) ||
    spec.maxFeePpm < 0 ||
    spec.maxFeePpm > PROTOCOL_MAX_FEE_PPM
  ) {
    add(
      "maxFeePpm",
      `whole hundredths of a basis point up to ${String(PROTOCOL_MAX_FEE_PPM)}, which is ` +
        `100% and the most a Uniswap v4 pool can express`,
    );
  }

  if (
    !Number.isInteger(spec.baseFeePpm) ||
    spec.baseFeePpm < SPEC_BOUNDS.minBaseFeePpm ||
    spec.baseFeePpm > PROTOCOL_MAX_FEE_PPM
  ) {
    add("baseFeePpm", `whole hundredths of a basis point up to ${String(PROTOCOL_MAX_FEE_PPM)}`);
  }

  // The base fee is a fee like any other, and a market whose resting state already
  // exceeds its own declared maximum has not understood its own disclosure.
  if (spec.baseFeePpm > spec.maxFeePpm) {
    add(
      "baseFeePpm",
      `the base fee of ${String(spec.baseFeePpm)} is above this market's declared ceiling ` +
        `of ${String(spec.maxFeePpm)}`,
    );
  }

  if (spec.rules.length > SPEC_BOUNDS.maxRules) {
    add("rules", `at most ${String(SPEC_BOUNDS.maxRules)} rules`);
  }
  if (spec.state.length > SPEC_BOUNDS.maxStateVariables) {
    add("state", `at most ${String(SPEC_BOUNDS.maxStateVariables)} state variables`);
  }
  if (spec.phases.length > SPEC_BOUNDS.maxPhases) {
    add("phases", `at most ${String(SPEC_BOUNDS.maxPhases)} phases`);
  }

  const stateNames = new Set<string>();
  spec.state.forEach((variable, index) => {
    const path = `state[${String(index)}]`;

    if (!SPEC_BOUNDS.identifierPattern.test(variable.name)) {
      add(`${path}.name`, "must be a camelCase identifier: it becomes one in Solidity");
    }
    if (stateNames.has(variable.name)) {
      add(`${path}.name`, `duplicate state variable "${variable.name}"`);
    }
    stateNames.add(variable.name);

    if (variable.description.length > SPEC_BOUNDS.maxDescriptionLength) {
      add(`${path}.description`, `at most ${String(SPEC_BOUNDS.maxDescriptionLength)} characters`);
    }
  });

  const phaseNames = new Set(spec.phases.map((phase) => phase.name));
  spec.phases.forEach((phase, index) => {
    for (const target of phase.transitionsTo ?? []) {
      if (!phaseNames.has(target)) {
        add(`phases[${String(index)}].transitionsTo`, `no such phase: "${target}"`);
      }
    }
    if (phase.terminal === true && (phase.transitionsTo ?? []).length > 0) {
      add(
        `phases[${String(index)}]`,
        "a terminal phase cannot transition anywhere; one of the two is wrong",
      );
    }
  });

  const ruleIds = new Set<string>();
  spec.rules.forEach((rule, index) => {
    const path = `rules[${String(index)}]`;

    if (!SPEC_BOUNDS.ruleIdPattern.test(rule.id)) {
      add(`${path}.id`, "must be a lowercase kebab-case identifier");
    }
    if (ruleIds.has(rule.id)) {
      add(`${path}.id`, `duplicate rule id "${rule.id}"`);
    }
    ruleIds.add(rule.id);

    if (rule.title.trim().length === 0) {
      add(`${path}.title`, "every rule needs a title; it is a heading on the token page");
    }

    for (const phase of rule.activeInPhases ?? []) {
      if (!phaseNames.has(phase)) {
        add(`${path}.activeInPhases`, `no such phase: "${phase}"`);
      }
    }

    rule.conditions.forEach((condition, conditionIndex) => {
      if (depthOf(condition) > SPEC_BOUNDS.maxConditionDepth) {
        add(
          `${path}.conditions[${String(conditionIndex)}]`,
          `nested more than ${String(SPEC_BOUNDS.maxConditionDepth)} deep`,
        );
      }
    });

    if (rule.then.length === 0) {
      add(`${path}.then`, "a rule that does nothing is not a rule");
    }

    rule.then.forEach((effect, effectIndex) => {
      const effectPath = `${path}.then[${String(effectIndex)}]`;

      // `writes` is deliberately not checked here. See the field's own documentation:
      // it is advisory, it never reaches a contract, and three live builds died at
      // interpretation over a model describing a fee change in it. `normaliseWrites`
      // drops names that are not declared state before this runs.

      // Checked against the market's own ceiling rather than a global one. A rule that
      // can charge more than the market disclosed is a disclosure that is wrong, which
      // matters more than the size of the number.
      const extra = effect.parameters?.["feePpm"];
      if (typeof extra === "number" && extra > spec.maxFeePpm) {
        add(
          `${effectPath}.parameters.feePpm`,
          `${String(extra)} is above this market's declared maximum fee of ` +
            `${String(spec.maxFeePpm)}. Either lower the rule or raise maxFeePpm, which ` +
            `traders are shown.`,
        );
      }

      const target = effect.parameters?.["phase"];
      if (effect.kind === "transitionPhase" && typeof target === "string" && !phaseNames.has(target)) {
        add(`${effectPath}.parameters.phase`, `no such phase: "${target}"`);
      }
    });
  });

  // There was a check here comparing `writeOnce` state against rules that can fire more
  // than once, and it was removed after blocking three live builds without once being
  // right.
  //
  // It was built on `writes`, which is advisory — the field is documented as annotation
  // that never reaches a contract, and unknown names in it are dropped rather than
  // rejected. A check that treats an advisory field as authoritative is incoherent, and
  // this one was also wrong on the merits: the case that failed was a model marking a
  // vault's address write-once, which it is, while a rule that routes fees to that vault
  // listed it in `writes`, which is a reasonable thing to annotate.
  //
  // The property worth enforcing — that the contract assigns a write-once variable
  // exactly once — is a statement about the generated Solidity, not about the
  // specification, and belongs in the gates or in a generated invariant test.

  // Suggestions change nothing until they are accepted, so what is checked here is only
  // what an interface needs to act on one: a stable id to send back, and a change
  // concrete enough that accepting it means something. Their prose is not policed.
  const suggestionIds = new Set<string>();
  (spec.suggestions ?? []).forEach((suggestion, index) => {
    const path = `suggestions[${String(index)}]`;

    if (suggestionIds.has(suggestion.id)) {
      add(`${path}.id`, `duplicate suggestion id "${suggestion.id}"`);
    }
    suggestionIds.add(suggestion.id);

    if (suggestion.proposedChange.trim().length === 0) {
      add(`${path}.proposedChange`, "a suggestion the creator cannot act on is not a suggestion");
    }
    if (!SUGGESTION_CATEGORIES.includes(suggestion.category)) {
      add(
        `${path}.category`,
        `"${suggestion.category}" is not one of: ${SUGGESTION_CATEGORIES.join(", ")}`,
      );
    }
  });

  for (const dependency of spec.externalDependencies) {
    if (dependency.failureBehaviour.trim().length === 0) {
      add(
        "externalDependencies",
        `"${dependency.kind}" must say what the market does when the source fails`,
      );
    }
  }

  return problems;
}

/**
 * Whether this specification can be built without anything outside the pool.
 *
 * Not a judgement about quality. A market with an oracle dependency is a legitimate
 * market; it is a market with a disclosure obligation and a different deployment path,
 * and the pipeline needs to know which one it is holding well before it starts
 * generating contracts.
 */
export function isSelfContained(spec: MarketSpecification): boolean {
  return spec.externalDependencies.length === 0;
}

/**
 * The assumptions a creator should actually be shown.
 *
 * Everything that is not `low`. A creator shown eight readings reads none of them, and
 * the two that mattered are lost among the six that did not.
 *
 * Tolerant of a specification stored before importance existed, where the field is
 * absent: such an assumption is shown rather than hidden, which is the safe direction to
 * be wrong in.
 */
export function materialAssumptions(spec: MarketSpecification): readonly Assumption[] {
  return (spec.assumptions ?? []).filter((assumption) => assumption.importance !== "low");
}

/** Suggestions the creator has not decided on yet. */
export function openSuggestions(spec: MarketSpecification): readonly Suggestion[] {
  return (spec.suggestions ?? []).filter((suggestion) => suggestion.decision === undefined);
}

/**
 * The improvements the creator agreed to, in the words they agreed to.
 *
 * This is what a later interpretation reads to change the market. Accepting a suggestion
 * records the decision; it is re-reading the specification with these in hand that turns
 * the decision into rules.
 */
export function acceptedSuggestions(spec: MarketSpecification): readonly string[] {
  return (spec.suggestions ?? [])
    .filter((suggestion) => suggestion.decision === "accepted")
    .map((suggestion) => suggestion.amended ?? suggestion.proposedChange);
}

// --- the clarification loop -------------------------------------------------

/**
 * Whether this specification can be built yet.
 *
 * Deterministic, and deliberately not something the model decides. The interpreter's job
 * is to notice ambiguity and describe it; whether that ambiguity stops a build is a
 * product rule, and a product rule that lives inside a prompt is a product rule that
 * changes when the weather does.
 */
export type SpecStatus =
  | "ready"
  /** At least one blocking question. Nothing is generated until it is answered. */
  | "needs_clarification"
  /** Part of the request cannot be built at all, and no substitute was offered. */
  | "impossible"
  /** Buildable, but it would do something the creator should confirm on purpose. */
  | "unsafe_without_change";

export interface Assessment {
  readonly status: SpecStatus;
  /** The questions that must be answered, in the order to ask them. */
  readonly blocking: readonly Ambiguity[];
  /** Chosen without asking, and shown so they can be overridden. */
  readonly assumed: readonly Assumption[];
  /** Requests that will not be built, each with a reason. */
  readonly refused: readonly Unsupported[];
  /** Things that will be built and that the creator should agree to knowingly. */
  readonly concerns: readonly string[];
}

/**
 * How much of a trade this market could ever take, as a percentage.
 *
 * A market may charge what it likes — Agen does not impose a ceiling, see `maxFeePpm` —
 * but a fee this size makes a market that is difficult to exit, and a creator should
 * arrive at it deliberately rather than discover it after launch.
 */
const CONCERNING_FEE_PPM = 100_000; // 10%

/**
 * Whether this reading has to be agreed to rather than merely disclosed.
 *
 * `high` implies it whatever the interpreter said. The two fields are not redundant: a
 * model that has correctly judged something as high-impact should not also have to
 * remember to tick a second box for the consequence to follow, and a medium reading can
 * still be flagged when the interpreter has a specific reason to want it confirmed.
 */
export function needsConfirmation(assumption: Assumption): boolean {
  if (assumption.confirmed === true) return false;
  return assumption.requiresConfirmation === true || assumption.importance === "high";
}

/**
 * Turn the readings that need agreeing to into questions.
 *
 * The product rule is that Agen may decide what is low-risk and must not decide what is
 * not. An assumption is Agen proceeding on its own judgement, so a high-impact one is a
 * contradiction — it is the interpreter having noticed a decision worth making and then
 * making it anyway, which is the failure the whole clarification loop exists to prevent.
 *
 * Applied as a transform rather than left to the prompt, because it is a product rule
 * and a product rule that lives in a prompt changes when the weather does. The
 * interpreter is asked to raise these as questions in the first place; this is what
 * happens when it does not, and it runs over hand-written specifications too.
 *
 * The assumption's own reading becomes the question's default, so a creator who does not
 * care still gets the market the interpreter would have built.
 */
export function promoteForConfirmation(spec: MarketSpecification): MarketSpecification {
  const promoting = (spec.assumptions ?? []).filter(needsConfirmation);
  if (promoting.length === 0) return spec;

  const asked = promoting.map<Ambiguity>((assumption) => ({
    id: `confirm-${assumption.id}`,
    question: `You did not say what "${assumption.term}" means. Agen read it as ${assumption.interpretation}. Is that right?`,
    why: assumption.why,
    otherwise: assumption.interpretation,
    blocking: true,
  }));

  return {
    ...spec,
    assumptions: spec.assumptions.filter((assumption) => !needsConfirmation(assumption)),
    // Behind anything the interpreter raised as a question itself, which it phrased for
    // the creator rather than having phrased for it here.
    ambiguities: [...spec.ambiguities, ...asked],
  };
}

export function assess(spec: MarketSpecification): Assessment {
  const blocking = spec.ambiguities.filter((ambiguity) => ambiguity.blocking);
  const assumed = materialAssumptions(spec);

  // A request that cannot be built and has no alternative is the one case where the
  // honest answer is "not like that". One that has a suggestion is a conversation.
  const impossible = spec.unsupported.filter(
    (entry) => entry.suggestion === undefined || entry.suggestion.trim() === "",
  );

  const concerns: string[] = [];

  if (spec.maxFeePpm >= CONCERNING_FEE_PPM) {
    concerns.push(
      `This market can take up to ${(spec.maxFeePpm / 10_000).toFixed(2)}% of a single ` +
        `trade. That is high enough to make it hard to exit, which may be the intent — ` +
        `but it should be the intent.`,
    );
  }

  for (const dependency of spec.externalDependencies) {
    concerns.push(
      `Depends on ${dependency.kind} (${dependency.description}). If it is unavailable: ` +
        dependency.failureBehaviour,
    );
  }

  const status: SpecStatus =
    impossible.length > 0
      ? "impossible"
      : blocking.length > 0
        ? "needs_clarification"
        : concerns.length > 0
          ? "unsafe_without_change"
          : "ready";

  return { status, blocking, assumed, refused: spec.unsupported, concerns };
}

/**
 * Fold an answer back into the specification.
 *
 * The conversation is not the source of truth; this is what makes that true. An answer
 * does not live in a chat log — it removes the question and leaves an assumption in its
 * place, which is the same shape every other resolved decision has and is therefore
 * visible on the review screen, editable, and carried into the generated tests.
 *
 * The version bumps because a deployed market pins exactly one specification, and two
 * specifications that differ by an answered question are not the same market.
 *
 * What this deliberately does not do is rewrite the rules. Applying "1% of pool
 * liquidity" to the rule that needed a threshold is interpretation, not bookkeeping, and
 * it belongs to the model — which re-reads the specification, sees the recorded answer,
 * and produces rules that honour it. Doing it here with string substitution is how a
 * clarification loop quietly becomes a template engine.
 */
export function resolveAmbiguity(
  spec: MarketSpecification,
  id: string,
  answer: string,
): MarketSpecification {
  const question = spec.ambiguities.find((ambiguity) => ambiguity.id === id);
  if (question === undefined) return spec;

  const resolution: Assumption = {
    id: `answered-${id}`,
    term: question.question,
    interpretation: answer,
    why: question.why,
    importance: question.blocking ? "high" : "medium",
    // The creator has just settled this, and a settled decision must never come back as
    // a question: `promoteForConfirmation` re-reads high-importance assumptions on every
    // pass, so without this an answered question would be asked again on the next turn,
    // for ever.
    confirmed: true,
  };

  return {
    ...spec,
    version: spec.version + 1,
    ambiguities: spec.ambiguities.filter((ambiguity) => ambiguity.id !== id),
    assumptions: [...spec.assumptions, resolution],
  };
}

/**
 * Accept the default for a question nobody wants to answer.
 *
 * The same merge, using the interpreter's own fallback. Without this a creator who does
 * not care about a detail cannot proceed, which turns every launch into the interview
 * this loop exists to avoid.
 */
export function acceptDefault(spec: MarketSpecification, id: string): MarketSpecification {
  const question = spec.ambiguities.find((ambiguity) => ambiguity.id === id);
  if (question === undefined) return spec;
  return resolveAmbiguity(spec, id, question.otherwise);
}

// --- the suggestion and assumption loop -------------------------------------
//
// Six operations, one specification. What makes them a loop rather than a form is that
// each one produces a specification of the same shape as the one it consumed, so a
// second round of questions can be asked about the result of the first.
//
// Note which of them bump the version and which do not. The version is what a deployed
// market pins, so it tracks changes to the market and not to the conversation about it:
// agreeing with a reading Agen already had, or declining an improvement it was never
// going to make, leaves the market it was going to build exactly as it was.

/**
 * Agree with a reading Agen took.
 *
 * Nothing about the market changes — this is the creator saying yes to what was already
 * going to happen — so the version does not move. What changes is that they will not be
 * asked again, which is the whole point of recording it.
 */
export function confirmAssumption(spec: MarketSpecification, id: string): MarketSpecification {
  if (!spec.assumptions.some((assumption) => assumption.id === id)) return spec;

  return {
    ...spec,
    assumptions: spec.assumptions.map((assumption) =>
      assumption.id === id ? { ...assumption, confirmed: true } : assumption,
    ),
  };
}

/**
 * Replace a reading with the creator's own.
 *
 * This one does change the market: the interpretation is what the rules are generated
 * against, and a threshold moved from one percent to five is a different market with the
 * same prose.
 */
export function overrideAssumption(
  spec: MarketSpecification,
  id: string,
  interpretation: string,
): MarketSpecification {
  const existing = spec.assumptions.find((assumption) => assumption.id === id);
  if (existing === undefined) return spec;
  if (interpretation.trim() === "") return spec;

  // The parameters were derived from the reading being replaced, and a number left over
  // from a superseded interpretation is worse than none, because it is the one part of
  // an assumption that downstream computes with. Re-deriving them belongs to the
  // interpreter, which reads the new wording.
  const { parameters: superseded, ...kept } = existing;
  void superseded;

  const replaced: Assumption = {
    ...kept,
    interpretation,
    why: "The creator set this themselves.",
    confirmed: true,
  };

  return {
    ...spec,
    version: spec.version + 1,
    assumptions: spec.assumptions.map((assumption) =>
      assumption.id === id ? replaced : assumption,
    ),
  };
}

/**
 * Take an improvement Agen offered.
 *
 * The decision is recorded; the rules are not rewritten here. Turning "roll 20% of the
 * pool forward" into a changed effect is interpretation, and doing it with string
 * substitution is how a conversation quietly becomes a template engine — the same
 * reasoning as `resolveAmbiguity`. What this guarantees is that the decision is on the
 * specification, in the creator's wording if they edited it, where the next
 * interpretation reads it from.
 */
export function acceptSuggestion(
  spec: MarketSpecification,
  id: string,
  amended?: string,
): MarketSpecification {
  const suggestion = (spec.suggestions ?? []).find((entry) => entry.id === id);
  if (suggestion === undefined) return spec;
  if (suggestion.decision === "accepted" && amended === undefined) return spec;

  return {
    ...spec,
    version: spec.version + 1,
    suggestions: spec.suggestions.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            decision: "accepted",
            ...(amended === undefined || amended.trim() === "" ? {} : { amended }),
          }
        : entry,
    ),
  };
}

/**
 * Turn one down.
 *
 * The market is untouched, including its version: a suggestion that was never applied
 * cannot be unapplied. The record is kept rather than deleted so the next turn does not
 * offer it again, which is how a helpful observation becomes nagging.
 */
export function declineSuggestion(spec: MarketSpecification, id: string): MarketSpecification {
  if (!(spec.suggestions ?? []).some((entry) => entry.id === id)) return spec;

  return {
    ...spec,
    suggestions: spec.suggestions.map((entry) =>
      entry.id === id ? { ...entry, decision: "declined" } : entry,
    ),
  };
}

/**
 * Everything a creator can decide, in one shape.
 *
 * A single union rather than six endpoints because every one of these has to land on the
 * same specification, and the way that stops being true is two call sites that each
 * update it slightly differently.
 */
export type Decision =
  | { readonly kind: "answer"; readonly id: string; readonly answer?: string }
  | { readonly kind: "confirm"; readonly id: string }
  | { readonly kind: "override"; readonly id: string; readonly interpretation: string }
  | { readonly kind: "accept"; readonly id: string; readonly amended?: string }
  | { readonly kind: "decline"; readonly id: string }
  /** A change in the creator's own words, after reading what was built. See `Edit`. */
  | { readonly kind: "edit"; readonly instruction: string };

/**
 * Ask for a change in your own words.
 *
 * The one decision that is not about something Agen raised, and the one a creator reaches
 * for most after reading their market: make the sell fee 1% instead, change the timer to
 * thirty minutes. It changes what gets built, so the version moves and the rules go stale
 * until a revision folds it in.
 *
 * The id is derived from how many edits came before it, so it is stable for an interface
 * to reference and legible in a record that a person may read: `edit-1`, `edit-2`.
 */
export function requestEdit(spec: MarketSpecification, instruction: string): MarketSpecification {
  if (instruction.trim() === "") return spec;

  const edits = spec.edits ?? [];

  return {
    ...spec,
    version: spec.version + 1,
    edits: [...edits, { id: `edit-${String(edits.length + 1)}`, instruction: instruction.trim() }],
  };
}

/**
 * Apply one decision.
 *
 * Total and deterministic: a decision naming something that is not there returns the
 * specification unchanged rather than throwing, because the interface can always be one
 * turn behind — two tabs open, a question answered twice — and that is not an error
 * worth failing a build over.
 */
export function decide(spec: MarketSpecification, decision: Decision): MarketSpecification {
  switch (decision.kind) {
    case "answer":
      return decision.answer === undefined || decision.answer.trim() === ""
        ? acceptDefault(spec, decision.id)
        : resolveAmbiguity(spec, decision.id, decision.answer);
    case "confirm":
      return confirmAssumption(spec, decision.id);
    case "override":
      return overrideAssumption(spec, decision.id, decision.interpretation);
    case "accept":
      return acceptSuggestion(spec, decision.id, decision.amended);
    case "decline":
      return declineSuggestion(spec, decision.id);
    case "edit":
      return requestEdit(spec, decision.instruction);
  }
}

export function decideAll(
  spec: MarketSpecification,
  decisions: readonly Decision[],
): MarketSpecification {
  return decisions.reduce(decide, spec);
}

/**
 * Whether the rules are behind the decisions.
 *
 * The question every turn of a conversation has to answer before anything is built: does
 * this specification describe the market the creator has now agreed to, or the one they
 * agreed to before the last thing they said?
 */
export function rulesAreStale(spec: MarketSpecification): boolean {
  return (spec.rulesDerivedAtVersion ?? spec.version) < spec.version;
}

/** What a revision has to account for: the decisions the rules do not yet reflect. */
export interface OutstandingDecisions {
  /** Improvements the creator took, in their wording where they edited it. */
  readonly accepted: readonly string[];
  /** Questions answered and readings replaced, as term-and-meaning pairs. */
  readonly settled: readonly Assumption[];
  /** Changes the creator asked for directly, in their own words. */
  readonly edits: readonly string[];
}

/**
 * Everything decided since the rules were last derived.
 *
 * Deliberately not "everything decided". A market five turns in has a long record, and
 * handing all of it to a revision invites the model to re-litigate decisions that are
 * already built — which is how turn five quietly undoes turn two.
 */
export function outstanding(spec: MarketSpecification): OutstandingDecisions {
  if (!rulesAreStale(spec)) return { accepted: [], settled: [], edits: [] };

  return {
    accepted: (spec.suggestions ?? [])
      .filter((suggestion) => suggestion.decision === "accepted" && suggestion.applied !== true)
      .map((suggestion) => suggestion.amended ?? suggestion.proposedChange),
    settled: (spec.assumptions ?? []).filter(
      (assumption) => assumption.confirmed === true && assumption.applied !== true,
    ),
    edits: (spec.edits ?? [])
      .filter((edit) => edit.applied !== true)
      .map((edit) => edit.instruction),
  };
}

/**
 * Mark the rules as current again.
 *
 * Called by whatever re-derived them. Accepted suggestions are marked applied at the same
 * moment and for the same reason: the next revision must not be handed a change that has
 * already been made, or it will make it twice.
 */
export function derivedNow(spec: MarketSpecification): MarketSpecification {
  return {
    ...spec,
    rulesDerivedAtVersion: spec.version,
    suggestions: (spec.suggestions ?? []).map((suggestion) =>
      suggestion.decision === "accepted" ? { ...suggestion, applied: true } : suggestion,
    ),
    assumptions: (spec.assumptions ?? []).map((assumption) =>
      assumption.confirmed === true ? { ...assumption, applied: true } : assumption,
    ),
    edits: (spec.edits ?? []).map((edit) => ({ ...edit, applied: true })),
  };
}

/**
 * Whether a decision changes what would be built.
 *
 * The pipeline needs this to know whether the architecture and contracts it is holding
 * are still answers to the current question. Confirming a reading or declining an
 * improvement leaves them valid; overriding a reading or accepting an improvement does
 * not, and reusing them would produce a market that quietly ignores what the creator
 * just said.
 */
export function changesTheMarket(decision: Decision): boolean {
  return (
    decision.kind === "answer" ||
    decision.kind === "override" ||
    decision.kind === "accept" ||
    decision.kind === "edit"
  );
}
