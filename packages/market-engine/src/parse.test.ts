import { describe, expect, it } from "vitest";

import { outcomeOf } from "./errors.js";
import { exactFlow, flat } from "./fixtures.js";
import { parseSpec } from "./parse.js";

/** Every problem code a parse produced, for asserting on the set rather than the order. */
function codes(input: unknown): readonly string[] {
  const result = parseSpec(input);
  return result.ok ? [] : result.problems.map((problem) => problem.code);
}

describe("parseSpec", () => {
  it("accepts a specification the engine can express", () => {
    const result = parseSpec(exactFlow());
    expect(result.ok).toBe(true);
  });

  /*
   * The regression this whole refactor exists for.
   *
   * A model asked to interpret Exact Flow emitted a rule whose trigger kind was
   * `buyOrSellSequence`. The old schema accepted any string there, `validateSpecification`
   * checked structure and never looked at the value, and the reader downstream held an
   * exact-match set of five recognised triggers. The match failed, the reader returned
   * `null`, and every caller read that as "this market has no fee program" rather than as
   * "this market was not understood". The build reached deployment_ready with the
   * prompt's most explicit requirement asserted by nothing.
   *
   * There is no shape in which that string can now reach a canonical configuration. It is
   * not a field the schema knows, and it is not a variant any union has — so it is caught
   * whichever way a model tries to smuggle it in, and it is caught as a fault rather than
   * as an absence.
   */
  describe("the buyOrSellSequence regression", () => {
    it("refuses an unknown trigger smuggled in as a top-level rule", () => {
      const result = parseSpec({
        ...flat("0.5"),
        rules: [{ when: { kind: "buyOrSellSequence" }, then: [{ kind: "waiveNextBuyFee" }] }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.problems.map((problem) => problem.code)).toContain("MALFORMED");
      expect(result.problems.some((problem) => problem.path === ".rules")).toBe(true);
    });

    it("refuses it as an unknown ladder axis", () => {
      const result = parseSpec({
        ...flat("0.5"),
        ladder: { axis: "buyOrSellSequence", stages: [] },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.problems.map((problem) => problem.code)).toContain("UNKNOWN_VARIANT");
    });

    it("refuses it as an unknown size measure", () => {
      const result = parseSpec({
        ...flat("0.5"),
        sizeTiers: [{ side: "SELL", measure: { kind: "buyOrSellSequence" }, rate: "4" }],
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.problems.map((problem) => problem.code)).toContain("UNKNOWN_VARIANT");
    });

    it("reports it as a system failure, never as an unsupported market", () => {
      // The distinction matters operationally. A creator whose market is UNSUPPORTED has
      // been given a real answer. A creator shown that because a model returned nonsense
      // has been told their market is impossible when nobody ever judged it.
      const result = parseSpec({ ...flat("0.5"), ladder: { axis: "buyOrSellSequence", stages: [] } });
      if (result.ok) throw new Error("unreachable");

      for (const problem of result.problems) {
        expect(outcomeOf(problem.code)).toBe("INTERPRETATION_ERROR");
      }
    });

    it("never yields an empty fee program in place of a refusal", () => {
      // The specific shape of the old failure: something unrecognised went in, and what
      // came out was a market with no rules rather than an error. `parseSpec` has no
      // return value that can express "understood nothing", so this cannot recur.
      const result = parseSpec({ ...flat("0.5"), sizeTiers: [{ side: "MAYBE", measure: {}, rate: "4" }] });
      expect(result.ok).toBe(false);
    });
  });

  describe("unknown properties", () => {
    it("refuses a field the schema does not name", () => {
      expect(codes({ ...flat("1"), customSolidity: "contract Evil {}" })).toContain("MALFORMED");
    });

    it("refuses an unknown field nested inside a tier", () => {
      const spec = flat("1");
      const result = parseSpec({
        ...spec,
        sizeTiers: [
          {
            side: "SELL",
            measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" },
            rate: "4",
            alsoBurn: true,
          },
        ],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.problems.some((problem) => problem.path.endsWith(".alsoBurn"))).toBe(true);
    });

    it("names the offending field so a retry can be specific", () => {
      const result = parseSpec({ ...flat("1"), walletCooldownSeconds: 60 });
      if (result.ok) throw new Error("unreachable");
      expect(result.problems[0]?.path).toBe(".walletCooldownSeconds");
    });
  });

  describe("nothing is defaulted", () => {
    it("refuses a market with no stated rate", () => {
      const { baseRate: _dropped, ...withoutRate } = flat("1");
      expect(codes({ ...withoutRate })).toContain("MISSING_PARAMETER");
    });

    it("refuses a tier with no stated rate", () => {
      const result = parseSpec({
        ...flat("1"),
        sizeTiers: [{ side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" } }],
      });
      if (result.ok) throw new Error("unreachable");
      expect(result.problems.map((problem) => problem.code)).toContain("MISSING_PARAMETER");
    });

    it("refuses a supply-relative threshold with no percentage", () => {
      // "charge more on large sells" arrives exactly like this, and inventing what
      // "large" means is the thing the engine must not do.
      const result = parseSpec({
        ...flat("1"),
        sizeTiers: [{ side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", operator: "GTE" }, rate: "4" }],
      });
      if (result.ok) throw new Error("unreachable");
      expect(result.problems.map((problem) => problem.code)).toContain("MISSING_PARAMETER");
    });
  });

  describe("units", () => {
    it("refuses a rate sent as a number", () => {
      // A rate that has been through a binary float is no longer exactly the rate that
      // was written, and 2.675 * 10_000 is 26749.999999999996.
      const result = parseSpec({ ...flat("1"), baseRate: { buy: 0.5, sell: 0.5 } });
      if (result.ok) throw new Error("unreachable");
      expect(result.problems.map((problem) => problem.code)).toContain("MALFORMED");
    });

    it("refuses an amount that is not a whole number of base units", () => {
      const result = parseSpec({
        ...flat("1"),
        sizeTiers: [{ side: "SELL", measure: { kind: "ABSOLUTE_TOKENS", tokens: "1.5", operator: "GTE" }, rate: "4" }],
      });
      if (result.ok) throw new Error("unreachable");
      expect(result.problems.map((problem) => problem.code)).toContain("MALFORMED");
    });
  });

  describe("engine version", () => {
    it("refuses a version this build does not compile", () => {
      expect(codes({ ...flat("1"), engineVersion: 3 })).toContain("UNSUPPORTED_ENGINE_VERSION");
    });

    it("refuses a missing version rather than assuming 1", () => {
      const { engineVersion: _dropped, ...withoutVersion } = flat("1");
      expect(codes(withoutVersion)).toContain("UNSUPPORTED_ENGINE_VERSION");
    });
  });

  it("reports every structural fault at once, not just the first", () => {
    const result = parseSpec({
      engineVersion: 1,
      baseRate: { buy: "1", sell: "1" },
      ladder: null,
      sizeTiers: [{ side: "NOPE", measure: { kind: "ALSO_NOPE" }, rate: "4" }],
      distribution: [{ recipient: { kind: "MYSTERY" }, share: "100" }],
      protections: [],
    });

    if (result.ok) throw new Error("unreachable");
    // Side, measure kind and recipient kind are three independent faults and a retry
    // prompt is only useful if it names all of them.
    expect(result.problems.length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * The shape OpenAI's structured outputs force, and the line between tolerating it and going
 * soft.
 *
 * Strict mode forbids optional fields: every property of every object must appear in
 * `required`. A ladder stage belongs to one axis and a CREATOR recipient has no address, so the
 * only expressible schema makes those fields required and nullable, and the model duly sends
 * `null`. Refusing that would mean the engine could not use OpenAI at all — which was the
 * situation, unnoticed, because Anthropic is the primary and accepts optional fields.
 *
 * The risk in accepting a null is that it becomes a general shrug: a model that omits a rate
 * and a model that sends `"rate": null` are both failing to state a rate, and the second must
 * not quietly become a default. So the tolerance is deliberately narrow, and these tests pin
 * both halves of it — what is now accepted, and what is still refused.
 */
describe("the nulls a provider's schema forces", () => {
  it("reads a time stage that carries a null volume field", () => {
    const result = parseSpec({
      ...flat("1"),
      ladder: {
        axis: "TIME",
        stages: [{ afterSeconds: 3_600, afterQuoteAmount: null, rate: { buy: "2", sell: "2" } }],
      },
    });

    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.problems)}`);
    expect(result.spec.ladder?.axis).toBe("TIME");
    expect(result.spec.ladder?.stages).toHaveLength(1);
  });

  it("reads a volume stage that carries a null time field", () => {
    const result = parseSpec({
      ...flat("1"),
      ladder: {
        axis: "QUOTE_VOLUME",
        stages: [
          { afterSeconds: null, afterQuoteAmount: "1000000000000000000", rate: { buy: "2", sell: "2" } },
        ],
      },
    });

    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.problems)}`);
    expect(result.spec.ladder?.axis).toBe("QUOTE_VOLUME");
  });

  it("reads a role recipient that carries a null address", () => {
    const result = parseSpec({
      ...flat("1"),
      distribution: [{ recipient: { kind: "CREATOR", address: null }, share: "100" }],
    });

    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.problems)}`);
    expect(result.spec.distribution[0]?.recipient.kind).toBe("CREATOR");
  });

  /*
   * The other half. A null is tolerated where the provider's schema forced a blank, and nowhere
   * else — an ADDRESS recipient with no address is a destination nobody named, and it has to
   * stay a refusal whether the field is absent or explicitly empty.
   */
  it("still refuses an ADDRESS recipient whose address is null", () => {
    expect(
      codes({
        ...flat("1"),
        distribution: [{ recipient: { kind: "ADDRESS", address: null }, share: "100" }],
      }),
    ).toContain("MALFORMED");
  });

  it("still refuses a stage whose own axis field is null", () => {
    expect(
      codes({
        ...flat("1"),
        ladder: {
          axis: "TIME",
          stages: [{ afterSeconds: null, afterQuoteAmount: null, rate: { buy: "2", sell: "2" } }],
        },
      }),
    ).toContain("MALFORMED");
  });

  /*
   * And a stage carrying the *wrong* axis's field with a real value in it is still an unknown
   * key. Dropping nulls must not turn into dropping the strictness that makes an unsupported
   * concept visible.
   */
  it("still refuses a time stage that names a volume threshold", () => {
    expect(
      codes({
        ...flat("1"),
        ladder: {
          axis: "TIME",
          stages: [{ afterSeconds: 3_600, afterQuoteAmount: "5", rate: { buy: "2", sell: "2" } }],
        },
      }),
    ).toContain("MALFORMED");
  });
});
