/**
 * Every way the engine can refuse, and the four things an interpretation can be.
 *
 * The point of this file is that nothing disappears quietly. The failure this whole
 * refactor exists to remove worked like this: a model emitted a trigger kind called
 * `buyOrSellSequence`, the reader that had to recognise it held an exact-match set of
 * five strings, the match failed, and the reader returned `null` — which every caller
 * read as "this market has no fee program" rather than as "this market was not
 * understood". A build went green with the prompt's most explicit requirement asserted
 * by nothing at all.
 *
 * So there is no `null` return anywhere in the parse or validate path, and no code in
 * this package may treat an unrecognised value as an absent one. Either a
 * configuration is understood completely, or a specific `EngineProblem` says which part
 * was not and why.
 */

/**
 * What an interpretation resolved to.
 *
 * The distinction between the last two is the one that matters operationally.
 * `UNSUPPORTED` is a fact about the engine: it was asked for something real that v1
 * cannot express, and saying so is a correct and final answer. `INTERPRETATION_ERROR`
 * is a fact about the model: it returned something that is not a specification at all,
 * which is a system failure to retry or surface, never something to show a creator as
 * though their market had been judged.
 */
export type Outcome =
  /** The prompt became a valid canonical configuration. */
  | "SUPPORTED"
  /** Understood, but a number the creator has to supply is missing or ambiguous. */
  | "NEEDS_CLARIFICATION"
  /** Understood, and outside what engine v1 can express. */
  | "UNSUPPORTED"
  /** The model's answer was not a specification. Not the creator's problem. */
  | "INTERPRETATION_ERROR";

/** Every refusal the engine can produce. Closed, and exhaustively switched on. */
export type ProblemCode =
  // --- structural: the answer is not a specification -----------------------
  /** A field is missing, of the wrong type, or an unknown property is present. */
  | "MALFORMED"
  /** A discriminant is not one of the variants this version knows. */
  | "UNKNOWN_VARIANT"
  /** `engineVersion` is absent or not one this build can compile. */
  | "UNSUPPORTED_ENGINE_VERSION"

  // --- semantic: a real specification the engine will not encode -----------
  /** A rate is negative, above `MAX_FEE_PPM`, or finer than one ppm. */
  | "INVALID_FEE"
  /** A threshold is zero, negative, above the reference supply, or unrepresentable. */
  | "INVALID_THRESHOLD"
  /** Two rules cannot both hold, or one makes the other unreachable. */
  | "CONFLICTING_RULES"
  /** Two thresholds on the same side are equal and charge different rates. */
  | "DUPLICATE_THRESHOLD"
  /** Shares do not total exactly one whole, or a recipient repeats. */
  | "INVALID_DISTRIBUTION"
  /** A recipient is the zero address, or a kind that needs an address has none. */
  | "INVALID_RECIPIENT"
  /** More tiers, stages or recipients than the engine will evaluate. */
  | "TOO_MANY_RULES"
  /** `referenceSupply` is absent, zero, or not the launch's own supply. */
  | "INVALID_REFERENCE_SUPPLY"
  /** A volume threshold is not denominated in this market's quote asset. */
  | "UNSUPPORTED_TRIGGER"
  /** A primitive engine v1 does not have. */
  | "UNSUPPORTED_RULE"
  /** Two primitives that are each supported and cannot be combined in v1. */
  | "UNSUPPORTED_COMBINATION"

  // --- the creator has to answer ------------------------------------------
  /** A number the economics depend on was not stated and must not be invented. */
  | "MISSING_PARAMETER"
  /** The prompt states the same thing two ways and they disagree. */
  | "AMBIGUOUS_SPECIFICATION";

/** Which outcome a code resolves to. The mapping is total and has no default. */
export function outcomeOf(code: ProblemCode): Outcome {
  switch (code) {
    case "MALFORMED":
    case "UNKNOWN_VARIANT":
    case "UNSUPPORTED_ENGINE_VERSION":
      return "INTERPRETATION_ERROR";

    case "MISSING_PARAMETER":
    case "AMBIGUOUS_SPECIFICATION":
      return "NEEDS_CLARIFICATION";

    case "INVALID_FEE":
    case "INVALID_THRESHOLD":
    case "CONFLICTING_RULES":
    case "DUPLICATE_THRESHOLD":
    case "INVALID_DISTRIBUTION":
    case "INVALID_RECIPIENT":
    case "TOO_MANY_RULES":
    case "INVALID_REFERENCE_SUPPLY":
    case "UNSUPPORTED_TRIGGER":
    case "UNSUPPORTED_RULE":
    case "UNSUPPORTED_COMBINATION":
      return "UNSUPPORTED";

    default: {
      // A new code with no outcome is a compile error rather than a silent default.
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

/**
 * One reason a specification was refused.
 *
 * `path` is a dotted route into the specification as the model sent it, so a message
 * can point at the field rather than at the market. `detail` is written for whoever has
 * to act on it: a creator for the clarification codes, an operator for the structural
 * ones.
 */
export interface EngineProblem {
  readonly code: ProblemCode;
  /** `sizeTiers[1].feePpm`, `distribution`, `stageLadder.stages[2].startOffsetSeconds`. */
  readonly path: string;
  readonly detail: string;
}

/**
 * The worst outcome among a set of problems, which is the one the caller acts on.
 *
 * Ordered by who has to do something about it. A malformed answer outranks everything
 * because nothing else in the response can be trusted; an unsupported primitive
 * outranks a missing number because asking a creator to name a threshold for a
 * mechanic the engine cannot run wastes their time.
 */
const SEVERITY: Record<Outcome, number> = {
  INTERPRETATION_ERROR: 3,
  UNSUPPORTED: 2,
  NEEDS_CLARIFICATION: 1,
  SUPPORTED: 0,
};

export function worstOutcome(problems: readonly EngineProblem[]): Outcome {
  let worst: Outcome = "SUPPORTED";
  for (const problem of problems) {
    const outcome = outcomeOf(problem.code);
    if (SEVERITY[outcome] > SEVERITY[worst]) worst = outcome;
  }
  return worst;
}

/** A refusal raised as an exception, for the few call sites that cannot return one. */
export class EngineError extends Error {
  readonly problems: readonly EngineProblem[];

  constructor(problems: readonly EngineProblem[]) {
    const first = problems[0];
    super(first === undefined ? "the engine refused a configuration" : `${first.code}: ${first.detail}`);
    this.name = "EngineError";
    this.problems = problems;
  }
}
