/**
 * What a model is allowed to ask for, and the gate everything it says passes through.
 *
 * This is the boundary between a language model and a chain. On one side is a string
 * that arrived over the network from a system that can be persuaded by its own input;
 * on the other is a transaction. Everything in this file exists to make that crossing
 * narrow, total and boring.
 *
 * Three rules hold throughout, and the tests in `intent.test.ts` exist to keep them
 * holding:
 *
 * 1. **Fail closed.** Anything not recognised is refused. Not defaulted, not coerced,
 *    not "best effort" — refused, with a reason. An unknown action is not a new
 *    feature to be tolerated; it is a model asking for something this build cannot
 *    reason about, which is exactly when to stop.
 *
 * 2. **No calldata, ever.** There is no field anywhere in an intent that reaches a
 *    transaction as bytes. An intent names an action and, at most, values that are
 *    then *checked against* what the chain already committed to. A model cannot
 *    describe a transaction here; it can only choose between transactions the runtime
 *    already knows how to build.
 *
 * 3. **Parameters are checked, not taken.** `LAUNCH_MARKET` carries the token and the
 *    symbol it believes it is launching. Those are not used to build anything. They
 *    are compared to the launch plan and to the on-chain `MarketExpectation`, and a
 *    mismatch is a refusal. A model that invents a symbol does not get a differently
 *    named market; it gets a rejected run and a record saying so.
 *
 * ## Why hand-written validation
 *
 * Because the failure mode of a schema library here is silence. Most of them coerce:
 * `"0.9"` becomes `0.9`, an extra key is stripped, a missing optional becomes
 * `undefined`. Each of those is a model's mistake being tidied away by infrastructure
 * rather than surfacing as a refusal, and the tidying happens in a dependency nobody
 * reads. Forty lines of explicit checks is a smaller thing to audit than a schema
 * language, and it lets every refusal carry a reason worth recording.
 */

import type { Address, Hex } from "viem";

// --- actions --------------------------------------------------------------

/**
 * The actions a runtime may perform on its own.
 *
 * Deliberately three. Every one of them is either bounded on chain by something the
 * runtime cannot change, or moves no value at all:
 *
 *  - `LAUNCH_MARKET` launches the market this agent's `MarketExpectation` already
 *    commits to. The parameters were fixed before the agent existed and
 *    `bindMarket` refuses anything else, so the decision here is *whether and when*,
 *    not *what*.
 *  - `CLAIM_REVENUE` is permissionless on chain and pays only where the immutable
 *    split says. Anybody may call it; the runtime doing so is a convenience.
 *  - `NO_ACTION` is the answer most evaluations should have, and it is a first-class
 *    intent rather than an absence so that "the model decided not to act" and "the
 *    model failed" are different rows in the log.
 *
 * `PAY_SERVICE` is deliberately absent from V0 even though the contracts support it
 * and the SDK can build it. It is the one action that spends the treasury, and
 * spending should not be the first thing an autonomous loop learns to do.
 */
export const RuntimeAction = {
  LaunchMarket: "LAUNCH_MARKET",
  ClaimRevenue: "CLAIM_REVENUE",
  NoAction: "NO_ACTION",
} as const;

export type RuntimeAction = (typeof RuntimeAction)[keyof typeof RuntimeAction];

/** Every action, for exhaustive iteration and for validating a config's allow-list. */
export const RUNTIME_ACTIONS: readonly RuntimeAction[] = [
  RuntimeAction.LaunchMarket,
  RuntimeAction.ClaimRevenue,
  RuntimeAction.NoAction,
];

export function isRuntimeAction(value: unknown): value is RuntimeAction {
  return (
    typeof value === "string" &&
    (RUNTIME_ACTIONS as readonly string[]).includes(value)
  );
}

// --- the intents ----------------------------------------------------------

/**
 * Fields every intent carries, whatever it asks for.
 *
 * `reasoningSummary` is a short public sentence, not a transcript. The distinction is
 * a product decision and a privacy one: a chain of thought is the model's working, it
 * is frequently wrong in ways the conclusion is not, and publishing it invites readers
 * to act on reasoning that was discarded. What is stored and shown is the sentence a
 * person would write in a commit message.
 */
interface IntentBase {
  /** 0 to 1. Compared against the config's floor before anything is built. */
  readonly confidence: number;
  /** One or two sentences, public. Never a chain of thought. */
  readonly reasoningSummary: string;
}

/**
 * Launch the market this agent was created expecting.
 *
 * The two parameters are assertions the model is making about what it thinks it is
 * doing, kept so that a confused model is *caught* rather than silently obeyed. They
 * are checked against the launch plan and the chain, and never used to build a
 * transaction. See `plan.ts`.
 */
export interface LaunchMarketIntent extends IntentBase {
  readonly action: typeof RuntimeAction.LaunchMarket;
  /** The token address the model believes it is launching. Checked, not used. */
  readonly token: Address;
  /** The symbol the model believes it is launching. Checked, not used. */
  readonly symbol: string;
}

/**
 * Move this agent's earned fees along the path the split already fixed.
 *
 * No destination, no amount, no recipient. Every one of those is decided by immutable
 * state, and a field for any of them would be a field an attacker would aim at.
 */
export interface ClaimRevenueIntent extends IntentBase {
  readonly action: typeof RuntimeAction.ClaimRevenue;
  /** Which asset's revenue to move. Checked against the market's own assets. */
  readonly asset: Address;
}

/** Do nothing, on purpose, for a reason worth recording. */
export interface NoActionIntent extends IntentBase {
  readonly action: typeof RuntimeAction.NoAction;
}

export type AgentIntent =
  | LaunchMarketIntent
  | ClaimRevenueIntent
  | NoActionIntent;

// --- refusals -------------------------------------------------------------

/**
 * Why an intent was not accepted.
 *
 * Enumerated rather than free text because these are counted, alerted on and shown in
 * an interface. A refusal reason that varies with the wording of an error message
 * cannot be any of those things.
 */
export const IntentRefusal = {
  /** The response was not an object at all: null, an array, a bare string. */
  NotAnObject: "NOT_AN_OBJECT",
  /** No `action` field, or one that is not a string. */
  MissingAction: "MISSING_ACTION",
  /** An `action` this build does not implement. The fail-closed case. */
  UnknownAction: "UNKNOWN_ACTION",
  /** `confidence` absent, not a number, NaN, or outside 0..1. */
  BadConfidence: "BAD_CONFIDENCE",
  /** `reasoningSummary` absent, not a string, empty, or implausibly long. */
  BadReasoning: "BAD_REASONING",
  /** A required parameter is missing or the wrong type. */
  BadParameter: "BAD_PARAMETER",
  /** A field that is not part of this intent. A model improvising structure. */
  UnexpectedField: "UNEXPECTED_FIELD",
} as const;

export type IntentRefusal =
  (typeof IntentRefusal)[keyof typeof IntentRefusal];

export type IntentParseResult =
  | { readonly ok: true; readonly intent: AgentIntent }
  | {
      readonly ok: false;
      readonly refusal: IntentRefusal;
      /** Which field, when the refusal is about one. For the log, not for control flow. */
      readonly field?: string;
      readonly detail: string;
    };

// --- limits ---------------------------------------------------------------
//
// Bounds on the *shape* of a response, not on its meaning. They exist because a
// response is attacker-influenced data: a model that has read a token description
// asking it to emit a megabyte of text should hit a wall in the parser rather than in
// a database column or a log shipper.

/** Long enough for two sentences. Short enough that nothing hides inside it. */
const MAX_REASONING_LENGTH = 600;

/** Symbols are short on chain; anything longer is not a symbol. */
const MAX_SYMBOL_LENGTH = 32;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * The fields each action may carry, beyond the two every intent has.
 *
 * An allow-list rather than a deny-list, and enforced: a response carrying a field
 * this table does not name is refused rather than trimmed. Trimming would let a model
 * (or a prompt injection inside a market description) attach `{"to": "0x…"}` to a
 * `NO_ACTION` and have it silently disappear — which is safe today and is exactly the
 * kind of quiet tolerance a later refactor turns into a hole.
 */
const ALLOWED_FIELDS: Readonly<Record<RuntimeAction, readonly string[]>> = {
  [RuntimeAction.LaunchMarket]: ["action", "confidence", "reasoningSummary", "token", "symbol"],
  [RuntimeAction.ClaimRevenue]: ["action", "confidence", "reasoningSummary", "asset"],
  [RuntimeAction.NoAction]: ["action", "confidence", "reasoningSummary"],
};

// --- the gate -------------------------------------------------------------

function refuse(
  refusal: IntentRefusal,
  detail: string,
  field?: string,
): IntentParseResult {
  return field === undefined
    ? { ok: false, refusal, detail }
    : { ok: false, refusal, field, detail };
}

/**
 * Turn whatever the model returned into an intent, or refuse it.
 *
 * Takes `unknown` on purpose. The caller has parsed JSON and has no more idea what is
 * in it than this function does, and a signature promising otherwise would push the
 * casting somewhere less careful.
 */
export function parseIntent(value: unknown): IntentParseResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refuse(
      IntentRefusal.NotAnObject,
      `expected a JSON object, got ${describe(value)}`,
    );
  }

  const body = value as Record<string, unknown>;
  const action = body["action"];

  if (typeof action !== "string") {
    return refuse(
      IntentRefusal.MissingAction,
      `no string \`action\`, got ${describe(action)}`,
      "action",
    );
  }

  // The fail-closed case, and the one worth being loud about. A model asking for
  // `TRANSFER` or `SWAP` is not a parse error — it is a model attempting something
  // this runtime deliberately does not implement, and the record should say which.
  if (!isRuntimeAction(action)) {
    return refuse(
      IntentRefusal.UnknownAction,
      `\`${clip(action, 64)}\` is not an action this runtime performs. ` +
        `Supported: ${RUNTIME_ACTIONS.join(", ")}`,
      "action",
    );
  }

  const unexpected = Object.keys(body).find(
    (key) => !ALLOWED_FIELDS[action].includes(key),
  );
  if (unexpected !== undefined) {
    return refuse(
      IntentRefusal.UnexpectedField,
      `\`${clip(unexpected, 64)}\` is not a field of ${action}`,
      unexpected,
    );
  }

  const confidence = body["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return refuse(
      IntentRefusal.BadConfidence,
      `confidence must be a number in 0..1, got ${describe(confidence)}`,
      "confidence",
    );
  }

  const reasoningSummary = body["reasoningSummary"];
  if (
    typeof reasoningSummary !== "string" ||
    reasoningSummary.trim().length === 0 ||
    reasoningSummary.length > MAX_REASONING_LENGTH
  ) {
    return refuse(
      IntentRefusal.BadReasoning,
      `reasoningSummary must be a non-empty string of at most ` +
        `${MAX_REASONING_LENGTH} characters, got ${describe(reasoningSummary)}`,
      "reasoningSummary",
    );
  }

  const summary = reasoningSummary.trim();

  switch (action) {
    case RuntimeAction.NoAction:
      return { ok: true, intent: { action, confidence, reasoningSummary: summary } };

    case RuntimeAction.ClaimRevenue: {
      const asset = body["asset"];
      if (typeof asset !== "string" || !ADDRESS_PATTERN.test(asset)) {
        return refuse(
          IntentRefusal.BadParameter,
          `asset must be a 20-byte hex address, got ${describe(asset)}`,
          "asset",
        );
      }
      return {
        ok: true,
        intent: {
          action,
          confidence,
          reasoningSummary: summary,
          asset: asset as Address,
        },
      };
    }

    case RuntimeAction.LaunchMarket: {
      const token = body["token"];
      if (typeof token !== "string" || !ADDRESS_PATTERN.test(token)) {
        return refuse(
          IntentRefusal.BadParameter,
          `token must be a 20-byte hex address, got ${describe(token)}`,
          "token",
        );
      }

      const symbol = body["symbol"];
      if (
        typeof symbol !== "string" ||
        symbol.length === 0 ||
        symbol.length > MAX_SYMBOL_LENGTH
      ) {
        return refuse(
          IntentRefusal.BadParameter,
          `symbol must be a string of 1..${MAX_SYMBOL_LENGTH} characters, ` +
            `got ${describe(symbol)}`,
          "symbol",
        );
      }

      return {
        ok: true,
        intent: {
          action,
          confidence,
          reasoningSummary: summary,
          token: token as Address,
          symbol,
        },
      };
    }
  }
}

/**
 * Parse a model's raw text into an intent.
 *
 * Separate from `parseIntent` because "the model did not return JSON" and "the model
 * returned JSON that means nothing here" are different failures with different fixes,
 * and a runtime that logs both as "bad response" tells its operator nothing.
 *
 * No cleverness: no fenced-code extraction, no trailing-comma repair, no grabbing the
 * first `{` and hoping. Every one of those is a heuristic that turns a malformed
 * response into a confident one, which is the opposite of what this boundary is for.
 * A provider that cannot return JSON is a provider that is misconfigured.
 */
export function parseIntentJson(text: string): IntentParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    return refuse(
      IntentRefusal.NotAnObject,
      `the response is not JSON: ${error instanceof Error ? error.message : "unparseable"}`,
    );
  }
  return parseIntent(value);
}

// --- for messages ---------------------------------------------------------

/**
 * A type name and, for short primitives, the value.
 *
 * Never the whole value. A refusal message is written to a log and shown in an
 * interface, and the thing being described is attacker-influenced: a model that has
 * read a hostile token description could otherwise put a megabyte, or a convincing
 * fake log line, into both.
 */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length}`;

  switch (typeof value) {
    case "undefined":
      return "nothing";
    case "string":
      return `the string "${clip(value, 32)}"`;
    case "number":
    case "boolean":
      return String(value);
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}

function clip(value: string, limit: number): string {
  // Newlines out as well as length down: a refusal that lands in a log must not be
  // able to forge a second log line.
  const flat = value.replace(/\s+/g, " ");
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
