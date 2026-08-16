/**
 * An answer that left a list out, from a provider that is allowed to.
 *
 * OpenAI's structured outputs return every required field or fail, and every stage in this
 * pipeline was written against that. Anthropic's tool use treats the schema as a strong
 * suggestion, so a model with nothing to say for a list omits it — and the stage that had
 * otherwise answered correctly died on `Cannot read properties of undefined`, reported to the
 * creator as an internal error. FRAG, a six-word prompt, was lost that way in one second.
 *
 * These prove the reading rather than the provider: absent and empty mean the same thing for
 * every list in these schemas, and each already has a validator behind it that complains in
 * the stage's own words.
 */

import { describe, expect, it } from "vitest";

import { fillMissingArrays, readAnswer, rulesSchema } from "./engineer.js";

const RULES = {
  type: "object",
  properties: {
    summary: { type: "string" },
    rules: {
      type: "object",
      properties: {
        id: { type: "string" },
        then: { type: "array", items: { type: "object", properties: { kind: { type: "string" } } } },
        conditions: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

const LIST = {
  type: "object",
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          then: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

describe("a model answer with a list left out", () => {
  it("gets the empty list the stage was written to expect", () => {
    expect(fillMissingArrays({ summary: "Sells pay" }, RULES)).toEqual({ summary: "Sells pay" });

    expect(fillMissingArrays({ rules: { id: "sell-fee" } }, RULES)).toEqual({
      rules: { id: "sell-fee", then: [], conditions: [] },
    });
  });

  it("fills the lists inside a list, which is where it actually happened", () => {
    expect(fillMissingArrays({ rules: [{ id: "sell-fee" }, { id: "buy-fee", then: ["x"] }] }, LIST)).toEqual(
      { rules: [{ id: "sell-fee", then: [] }, { id: "buy-fee", then: ["x"] }] },
    );
  });

  it("leaves everything the model did answer exactly as it was", () => {
    const answered = { summary: "Sells pay", rules: { id: "sell-fee", then: [{ kind: "chargeFee" }], conditions: [] } };

    expect(fillMissingArrays(answered, RULES)).toEqual(answered);
  });

  /**
   * A missing string is a stage that did not answer. Inventing an empty one would ship a
   * market with a blank where a rule's description goes, which is worse than a complaint.
   */
  it("invents nothing for a missing string", () => {
    expect(fillMissingArrays({ rules: { then: [] } }, RULES)).toEqual({
      rules: { then: [], conditions: [] },
    });
  });

  it("passes through what it cannot read rather than reshaping it", () => {
    expect(fillMissingArrays(null, RULES)).toBeNull();
    expect(fillMissingArrays("not an object", RULES)).toBe("not an object");
    expect(fillMissingArrays({ rules: "not an object" }, LIST)).toEqual({ rules: "not an object" });
  });
});

/**
 * The answer FRAG actually got, twice, in six seconds: everything correct, wrapped in the
 * wrong envelope. Claude answered the rules schema by putting the entire document — summary,
 * rules, effects, all of it — into the `rules` field as JSON text.
 */
describe("an answer sent as text inside one of its own fields", () => {
  const ANSWER = {
    summary: "0.5% fee on sells, buys free",
    rules: [
      {
        id: "sell-tax",
        title: "SELL TAX",
        then: [
          {
            kind: "extraFee",
            description: "charge 0.5% fee on the trade",
            parameters: [{ key: "feePpm", value: 5_000 }],
            writes: [],
          },
        ],
        when: { kind: "sell", description: "a sell trade occurs", parameters: [] },
        conditions: [],
        activeInPhases: [],
        onceOnly: false,
      },
    ],
  };

  it("is read as the answer it is", () => {
    expect(readAnswer({ rules: JSON.stringify(ANSWER) }, rulesSchema)).toEqual(ANSWER);
  });

  it("is read the same way when the provider sent it properly", () => {
    expect(readAnswer(ANSWER, rulesSchema)).toEqual(ANSWER);
  });

  it("parses a single list sent as text without lifting anything", () => {
    expect(readAnswer({ rules: JSON.stringify(ANSWER.rules), summary: "x" }, rulesSchema)).toEqual({
      summary: "x",
      rules: ANSWER.rules,
    });
  });

  /** A field that merely looks like the document is not the document. */
  it("leaves an object that does not answer the schema where it was", () => {
    const partial = { summary: "x", rules: [{ id: "a", then: [], when: { kind: "sell" } }] };

    expect(readAnswer(partial, rulesSchema)).toEqual({
      summary: "x",
      rules: [
        {
          id: "a",
          then: [],
          // `when.parameters` is nullable in the schema rather than a plain list, and a
          // nullable field left out is a field the model chose not to answer.
          when: { kind: "sell" },
          conditions: [],
          activeInPhases: [],
        },
      ],
    });
  });
});
