import { describe, expect, it } from "vitest";

import {
  IntentRefusal,
  RUNTIME_ACTIONS,
  RuntimeAction,
  parseIntent,
  parseIntentJson,
} from "./intent.js";

/**
 * The parser is the boundary between a language model and a chain, so these tests are
 * written adversarially: most of them are things a model should never send, and the
 * assertion is that each is refused for the *right* reason. A test suite that only
 * checked the happy path would pass against a parser that accepted everything.
 */

const VALID_LAUNCH = {
  action: "LAUNCH_MARKET",
  token: "0x1111111111111111111111111111111111111111",
  symbol: "SCOUT",
  confidence: 0.9,
  reasoningSummary: "The committed market is funded and unlaunched.",
};

describe("what the parser accepts", () => {
  it("takes a well-formed launch", () => {
    const result = parseIntent(VALID_LAUNCH);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.intent.action).toBe(RuntimeAction.LaunchMarket);
    expect(result.intent).toMatchObject({ symbol: "SCOUT", confidence: 0.9 });
  });

  it("takes a claim and a no-action", () => {
    const claim = parseIntent({
      action: "CLAIM_REVENUE",
      asset: "0x0000000000000000000000000000000000000000",
      confidence: 1,
      reasoningSummary: "There are fees to collect.",
    });
    const nothing = parseIntent({
      action: "NO_ACTION",
      confidence: 0.4,
      reasoningSummary: "Not enough evidence to justify a launch.",
    });

    expect(claim.ok).toBe(true);
    expect(nothing.ok).toBe(true);
  });

  it("trims the summary but keeps the rest verbatim", () => {
    const result = parseIntent({ ...VALID_LAUNCH, reasoningSummary: "  spaced out  " });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent.reasoningSummary).toBe("spaced out");
  });

  it("accepts the confidence boundaries exactly", () => {
    for (const confidence of [0, 1]) {
      expect(parseIntent({ ...VALID_LAUNCH, confidence }).ok, `${confidence}`).toBe(true);
    }
  });
});

describe("failing closed", () => {
  it("refuses an action this runtime does not implement", () => {
    // The headline case. A model asking to move money in a way the runtime has no
    // concept of must not be a parse error that some caller recovers from — it must be
    // a named refusal that lands in the record.
    for (const action of ["TRANSFER", "SWAP", "APPROVE", "launch_market", ""]) {
      const result = parseIntent({ ...VALID_LAUNCH, action });

      expect(result.ok, action).toBe(false);
      if (result.ok) continue;
      expect(result.refusal).toBe(IntentRefusal.UnknownAction);
    }
  });

  it("refuses a field that is not part of the intent", () => {
    // A model improvising structure, or a prompt injection persuading it to attach a
    // destination. Refused rather than stripped: stripping is safe today and is how a
    // later refactor that starts reading `body.to` becomes a hole.
    const result = parseIntent({
      ...VALID_LAUNCH,
      to: "0x2222222222222222222222222222222222222222",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe(IntentRefusal.UnexpectedField);
    expect(result.field).toBe("to");
  });

  it("refuses calldata under any name", () => {
    for (const field of ["data", "calldata", "value", "target", "params"]) {
      const result = parseIntent({ ...VALID_LAUNCH, [field]: "0xdeadbeef" });

      expect(result.ok, field).toBe(false);
      if (result.ok) continue;
      expect(result.refusal).toBe(IntentRefusal.UnexpectedField);
    }
  });

  it("refuses a field that belongs to a different action", () => {
    // `asset` is real, but not on a launch. Allowing it would mean the union's arms
    // leak into each other, which is how an intent ends up half-validated.
    const result = parseIntent({
      ...VALID_LAUNCH,
      asset: "0x0000000000000000000000000000000000000000",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe(IntentRefusal.UnexpectedField);
  });

  it("refuses anything that is not an object", () => {
    for (const value of [null, undefined, 42, "LAUNCH_MARKET", [VALID_LAUNCH], true]) {
      const result = parseIntent(value);

      expect(result.ok, String(value)).toBe(false);
      if (result.ok) continue;
      expect(result.refusal).toBe(IntentRefusal.NotAnObject);
    }
  });

  it("refuses a missing or non-string action", () => {
    for (const action of [undefined, 1, null, {}]) {
      const result = parseIntent({ ...VALID_LAUNCH, action });

      expect(result.ok, String(action)).toBe(false);
      if (result.ok) continue;
      expect(result.refusal).toBe(IntentRefusal.MissingAction);
    }
  });

  it("refuses a confidence that is not a number in 0..1", () => {
    // `"0.9"` is the one that matters: a coercing parser turns it into 0.9 and a
    // threshold check then passes on a value the model never expressed numerically.
    for (const confidence of ["0.9", -0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      const result = parseIntent({ ...VALID_LAUNCH, confidence });

      expect(result.ok, String(confidence)).toBe(false);
      if (result.ok) continue;
      expect(result.refusal).toBe(IntentRefusal.BadConfidence);
    }
  });

  it("refuses a missing, empty or oversized reasoning summary", () => {
    for (const reasoningSummary of [undefined, "", "   ", 7, "x".repeat(601)]) {
      const result = parseIntent({ ...VALID_LAUNCH, reasoningSummary });

      expect(result.ok, String(reasoningSummary).slice(0, 20)).toBe(false);
      if (result.ok) continue;
      expect(result.refusal).toBe(IntentRefusal.BadReasoning);
    }
  });

  it("refuses a token or asset that is not an address", () => {
    for (const token of ["0x123", "not an address", "", "0xZZZZ", 1]) {
      const result = parseIntent({ ...VALID_LAUNCH, token });

      expect(result.ok, String(token)).toBe(false);
      if (result.ok) continue;
      expect(result.refusal).toBe(IntentRefusal.BadParameter);
      expect(result.field).toBe("token");
    }
  });

  it("refuses a missing parameter the action requires", () => {
    const { token: _dropped, ...withoutToken } = VALID_LAUNCH;
    const result = parseIntent(withoutToken);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe(IntentRefusal.BadParameter);
  });
});

describe("parsing the raw response", () => {
  it("reads well-formed JSON", () => {
    expect(parseIntentJson(JSON.stringify(VALID_LAUNCH)).ok).toBe(true);
  });

  it("refuses prose, fenced code and truncation rather than repairing them", () => {
    // Every one of these is something a heuristic parser would happily rescue, and
    // rescuing them is how a malformed response becomes a confident one. A provider
    // that cannot return JSON is misconfigured, and that should be visible.
    const malformed = [
      "I think we should launch!",
      "```json\n{}\n```",
      '{"action": "NO_ACTION", "confidence": 1,',
      "",
      `Sure. ${JSON.stringify(VALID_LAUNCH)}`,
    ];

    for (const text of malformed) {
      expect(parseIntentJson(text).ok, text.slice(0, 20)).toBe(false);
    }
  });

  it("does not let a refusal message carry a payload into the log", () => {
    // The value being described is attacker-influenced. A refusal that echoed it whole
    // would let a token description forge log lines, or ship a megabyte to a log
    // aggregator on every evaluation.
    const hostile = `${"A".repeat(5_000)}\nERROR: system compromised`;
    const result = parseIntent({ ...VALID_LAUNCH, action: hostile });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail.length).toBeLessThan(200);
    expect(result.detail).not.toContain("\n");
  });
});

describe("the action set", () => {
  it("is the three V0 supports, and PAY_SERVICE is not among them", () => {
    // Spending the treasury is the one thing the contracts support and the runtime
    // deliberately does not. If this list grows, that was a decision, and it should
    // fail here first.
    expect([...RUNTIME_ACTIONS].sort()).toEqual([
      "CLAIM_REVENUE",
      "LAUNCH_MARKET",
      "NO_ACTION",
    ]);
    expect(RUNTIME_ACTIONS).not.toContain("PAY_SERVICE");
  });
});
