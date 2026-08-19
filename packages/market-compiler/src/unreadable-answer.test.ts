/**
 * An answer the stage could not read, and an account that cannot pay for another one.
 *
 * Both of these ended builds by reporting that Agen was broken when it was not. PULSE died at
 * architecture planning on `Cannot read properties of undefined (reading 'map')` — a
 * `TOOLCHAIN_ERROR`, three retries unspent — because Claude answered the schema in a shape the
 * reader was not written for. And five markets in the same run reported "the model provider
 * answered 400 Bad Request", which was an empty Anthropic balance saying so only in prose.
 */

import { describe, expect, it } from "vitest";

import { ArtefactError } from "./engineer.js";
import { misshapenAnswer } from "./pipeline.js";

describe("an answer in a shape the reader was not written for", () => {
  it("becomes a complaint the retry ladder can act on", () => {
    const crash = new TypeError("Cannot read properties of undefined (reading 'map')");
    const complaint = misshapenAnswer(crash);

    expect(complaint).toBeInstanceOf(ArtefactError);
    expect(complaint!.problems.join(" ")).toContain("could not be read");
    // The next attempt is told what to do about it, not just that something went wrong.
    expect(complaint!.problems.join(" ")).toContain("every field the schema");
  });

  it.each([
    "Cannot read properties of null (reading 'length')",
    "rules.map is not a function",
    "object is not iterable",
  ])("covers the other shapes a bad answer produces: %s", (message) => {
    expect(misshapenAnswer(new TypeError(message))).toBeInstanceOf(ArtefactError);
  });

  /**
   * The point of being narrow. A genuine defect in Agen must still surface as one, or every
   * bug in a stage becomes three silent retries and a generic complaint about the model.
   */
  it("leaves anything that is not an unread field alone", () => {
    expect(misshapenAnswer(new TypeError("Assignment to constant variable"))).toBeNull();
    expect(misshapenAnswer(new RangeError("Maximum call stack size exceeded"))).toBeNull();
    expect(misshapenAnswer(new Error("Cannot read properties of undefined"))).toBeNull();
    expect(misshapenAnswer("not an error at all")).toBeNull();
  });
});
