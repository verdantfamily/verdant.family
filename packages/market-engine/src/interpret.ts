/**
 * The interpretation envelope: what a model returns, and how the engine judges it.
 *
 * A model cannot answer with a specification alone, because two of the four outcomes are
 * not specifications. "The prompt asks for a wallet cooldown" and "the prompt says
 * 'large' and never says how large" are both real, correct answers, and neither can be
 * expressed as an `AgenMarketSpec`. Without a channel for them, a model asked for a
 * cooldown could only smuggle it in as an unknown field — which `parse.ts` correctly
 * rejects as `MALFORMED`, reporting a system failure for what was actually a supported
 * question with an unsupported answer.
 *
 * So the model returns an envelope: an outcome it claims, a specification when it has
 * one, and explicit lists of what it could not express and what it needs asked.
 *
 * ## The claim is not trusted
 *
 * `resolve` re-derives the outcome rather than believing it. A model that claims
 * `SUPPORTED` and attaches a specification the compiler refuses gets the compiler's
 * answer. A model that claims `SUPPORTED` while also listing something it could not
 * express gets `UNSUPPORTED`, because the alternative is launching a market that is
 * missing a requirement the model itself noticed — which is precisely the "unsupported
 * behaviour quietly lowered into supported behaviour" failure this design is meant to
 * make impossible.
 *
 * Structured output matching a JSON schema is evidence about shape and nothing else. The
 * deterministic layer decides.
 */

import { compile } from "./compile.js";
import type { EngineProblem, Outcome } from "./errors.js";
import { worstOutcome } from "./errors.js";
import { parseSpec } from "./parse.js";
import type { AgenMarketSpec, CanonicalConfig, MarketBinding } from "./spec.js";

/** Something the prompt asked for that engine v1 cannot express. */
export interface UnsupportedRequest {
  /** The creator's own words, quoted, so the interface can show what was dropped. */
  readonly request: string;
  /** Why v1 cannot do it, in a sentence a creator can act on. */
  readonly why: string;
}

/** A number the economics depend on that the prompt did not state. */
export interface Clarification {
  /** A stable id, so an answer can be matched back to the question. */
  readonly id: string;
  /** One question about one thing. */
  readonly question: string;
  /** The creator's own words that raised it. */
  readonly because: string;
}

/** What a model returns for a prompt. */
export interface InterpretationEnvelope {
  readonly outcome: "SUPPORTED" | "NEEDS_CLARIFICATION" | "UNSUPPORTED";
  readonly spec: AgenMarketSpec | null;
  readonly unsupported: readonly UnsupportedRequest[];
  readonly clarifications: readonly Clarification[];
  /**
   * Readings the model took that the creator did not state, and should see.
   *
   * The engine never defaults an economic value, but the interpretation layer above it is
   * allowed to propose one — a market that says nothing about where fees go can be read
   * as paying the creator. The difference is that a proposal has to be disclosed here and
   * shown on the review screen, where a default applied inside the compiler would be a
   * decision nobody was told about.
   */
  readonly assumptions: readonly string[];
}

/** The engine's own verdict, which is the one that counts. */
export interface InterpretationResult {
  readonly outcome: Outcome;
  /** Present only when the outcome is `SUPPORTED`. */
  readonly config: CanonicalConfig | null;
  readonly problems: readonly EngineProblem[];
  readonly unsupported: readonly UnsupportedRequest[];
  readonly clarifications: readonly Clarification[];
  readonly assumptions: readonly string[];
}

const OUTCOMES: readonly string[] = ["SUPPORTED", "NEEDS_CLARIFICATION", "UNSUPPORTED"];

function objectAt(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringAt(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Parse the envelope's own structure. The specification inside it is `parse.ts`'s job.
 *
 * Held to the same rule as everything else: an unknown property is a fault, because a
 * model that has invented a field at this level has probably invented a mechanism to go
 * with it.
 */
export function parseEnvelope(input: unknown): InterpretationResult | { readonly envelope: InterpretationEnvelope } {
  const problems: EngineProblem[] = [];

  const object = objectAt(input);
  if (object === null) {
    return failure([{ code: "MALFORMED", path: "", detail: "the answer is not an object." }]);
  }

  const known = ["outcome", "spec", "unsupported", "clarifications", "assumptions"];
  for (const key of Object.keys(object)) {
    if (!known.includes(key)) {
      problems.push({
        code: "MALFORMED",
        path: key,
        detail: `the interpretation envelope has no field called "${key}".`,
      });
    }
  }

  const outcome = object["outcome"];
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) {
    problems.push({
      code: "UNKNOWN_VARIANT",
      path: "outcome",
      detail:
        `${JSON.stringify(outcome)} is not an outcome. An interpretation is one of ` +
        `${OUTCOMES.join(", ")} — and never INTERPRETATION_ERROR, which is a judgement about the ` +
        `answer rather than about the market, and is not the model's to make.`,
    });
  }

  const unsupported: UnsupportedRequest[] = [];
  for (const [index, entry] of (Array.isArray(object["unsupported"]) ? object["unsupported"] : []).entries()) {
    const shaped = objectAt(entry);
    const request = stringAt(shaped?.["request"]);
    const why = stringAt(shaped?.["why"]);
    if (request === null || why === null) {
      problems.push({
        code: "MALFORMED",
        path: `unsupported[${String(index)}]`,
        detail: "an unsupported request needs both the creator's words and why v1 cannot do it.",
      });
      continue;
    }
    unsupported.push({ request, why });
  }

  const clarifications: Clarification[] = [];
  for (const [index, entry] of (Array.isArray(object["clarifications"]) ? object["clarifications"] : []).entries()) {
    const shaped = objectAt(entry);
    const id = stringAt(shaped?.["id"]);
    const question = stringAt(shaped?.["question"]);
    const because = stringAt(shaped?.["because"]);
    if (id === null || question === null || because === null) {
      problems.push({
        code: "MALFORMED",
        path: `clarifications[${String(index)}]`,
        detail: "a clarification needs an id, a question and the words that raised it.",
      });
      continue;
    }
    clarifications.push({ id, question, because });
  }

  const assumptions = (Array.isArray(object["assumptions"]) ? object["assumptions"] : [])
    .map((entry) => stringAt(entry))
    .filter((entry): entry is string => entry !== null);

  if (problems.length > 0) return failure(problems);

  return {
    envelope: {
      outcome: outcome as InterpretationEnvelope["outcome"],
      spec: (object["spec"] ?? null) as AgenMarketSpec | null,
      unsupported,
      clarifications,
      assumptions,
    },
  };
}

function failure(problems: readonly EngineProblem[]): InterpretationResult {
  return {
    outcome: worstOutcome(problems) === "SUPPORTED" ? "INTERPRETATION_ERROR" : worstOutcome(problems),
    config: null,
    problems,
    unsupported: [],
    clarifications: [],
    assumptions: [],
  };
}

/**
 * The engine's verdict on a model's answer.
 *
 * The order of the checks is the policy, and it runs from "nothing here can be trusted"
 * down to "this is a market":
 *
 *  1. A malformed envelope is a system failure. Nothing else is examined.
 *  2. Anything the model could not express makes the market unsupported, whatever it
 *     claimed. A market missing a requirement is not the market that was asked for.
 *  3. Anything the model needs asked makes it a clarification.
 *  4. Only then is the specification parsed and compiled — and the compiler's answer
 *     overrides the claim, because a schema-shaped specification is not a valid one.
 */
export function resolve(input: unknown, binding: MarketBinding): InterpretationResult {
  const parsed = parseEnvelope(input);
  if (!("envelope" in parsed)) return parsed;

  const { envelope } = parsed;

  // A claim with nothing behind it is malformed rather than believed. A model that says
  // UNSUPPORTED and lists nothing has told a creator their market is impossible without
  // saying which part, which is not an answer anybody can act on.
  if (envelope.outcome === "UNSUPPORTED" && envelope.unsupported.length === 0) {
    return failure([
      {
        code: "MALFORMED",
        path: "unsupported",
        detail: "the answer claims the market is unsupported and names nothing that could not be expressed.",
      },
    ]);
  }
  if (envelope.outcome === "NEEDS_CLARIFICATION" && envelope.clarifications.length === 0) {
    return failure([
      {
        code: "MALFORMED",
        path: "clarifications",
        detail: "the answer asks for clarification and asks no question.",
      },
    ]);
  }

  const carry = {
    unsupported: envelope.unsupported,
    clarifications: envelope.clarifications,
    assumptions: envelope.assumptions,
  };

  if (envelope.unsupported.length > 0) {
    return {
      outcome: "UNSUPPORTED",
      config: null,
      problems: envelope.unsupported.map((entry) => ({
        code: "UNSUPPORTED_RULE" as const,
        path: "prompt",
        detail: `${entry.request} — ${entry.why}`,
      })),
      ...carry,
    };
  }

  if (envelope.clarifications.length > 0) {
    return {
      outcome: "NEEDS_CLARIFICATION",
      config: null,
      problems: envelope.clarifications.map((entry) => ({
        code: "MISSING_PARAMETER" as const,
        path: "prompt",
        detail: entry.question,
      })),
      ...carry,
    };
  }

  if (envelope.spec === null) {
    return failure([
      {
        code: "MALFORMED",
        path: "spec",
        detail: "the answer claims a supported market and attaches no specification.",
      },
    ]);
  }

  const shape = parseSpec(envelope.spec);
  if (!shape.ok) {
    return { outcome: worstOutcome(shape.problems), config: null, problems: shape.problems, ...carry };
  }

  const compiled = compile(shape.spec, binding);
  if (!compiled.ok) {
    return { outcome: worstOutcome(compiled.problems), config: null, problems: compiled.problems, ...carry };
  }

  return { outcome: "SUPPORTED", config: compiled.config, problems: [], ...carry };
}
