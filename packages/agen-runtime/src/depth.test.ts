import { describe, expect, it } from "vitest";

import { depthFor, planFor } from "./depth";

describe("depthFor", () => {
  it("treats an ordinary question as quick", () => {
    for (const question of [
      "thoughts?",
      "",
      "what is this",
      "explain quantum computing",
      "is this token doing well",
      "roast this chart",
    ]) {
      expect(depthFor(question), question).toBe("quick");
    }
  });

  it("hears a request for sources as research", () => {
    for (const question of [
      "research this",
      "look into this project",
      "what are people saying about this",
      "summarize this thread",
      "compare these two",
      "brief me on the team",
      "explain in detail",
      "give me sources",
    ]) {
      expect(depthFor(question), question).toBe("research");
    }
  });

  it("hears a claim to be checked as an investigation", () => {
    for (const question of [
      "investigate this",
      "deep dive on this",
      "dig into who is behind this",
      "fact check this",
      "is this true",
      "is this screenshot real",
      "is this a scam",
      "debunk this",
      "do the due diligence",
    ]) {
      expect(depthFor(question), question).toBe("investigate");
    }
  });

  it("takes the strongest cue when a question carries two", () => {
    // Otherwise the answer depends on which list happened to be tested first, which is exactly the
    // kind of ordering bug that only shows up as "sometimes it does less work than it was asked to".
    expect(depthFor("research this and fact check the numbers")).toBe("investigate");
  });

  it("does not mistake a substring for a cue", () => {
    // `researcher` and `investment` contain the cue words. Reading them as depth requests would
    // make an ordinary question about a person cost twelve model calls.
    expect(depthFor("who is this researcher")).toBe("quick");
    expect(depthFor("is this a good investment")).toBe("quick");
  });

  it("does not look at the topic at all", () => {
    // The moment depth depends on subject matter it has become the hardcoded classifier this design
    // rejects. A token question and a physics question are the same amount of work by default.
    expect(depthFor("how is $IDOG doing")).toBe(depthFor("how do black holes evaporate"));
  });
});

describe("planFor", () => {
  it("gives each depth more room than the one before", () => {
    const quick = planFor("quick");
    const research = planFor("research");
    const investigate = planFor("investigate");

    expect(quick.maxTurns).toBeLessThan(research.maxTurns);
    expect(research.maxTurns).toBeLessThan(investigate.maxTurns);
    expect(quick.maxParts).toBe(1);
    expect(investigate.maxParts).toBeGreaterThan(1);
  });

  it("never exceeds what the surface said it could afford", () => {
    // The surface's ceiling is a real constraint — a poll cannot sit open for twelve model calls,
    // and X will not take a nine-post thread. Handing back a plan the caller already refused would
    // make the limit advisory.
    const plan = planFor("investigate", { maxTurns: 5, maxParts: 1 });
    expect(plan.maxTurns).toBe(5);
    expect(plan.maxParts).toBe(1);
    expect(plan.depth).toBe("investigate");
  });

  it("does not let a surface ask for less than one turn", () => {
    expect(planFor("quick", { maxTurns: 0, maxParts: 0 })).toMatchObject({ maxTurns: 1, maxParts: 1 });
  });

  it("says out loud that depth is a ceiling and not a quota", () => {
    // A model told it has eight turns will find eight turns of work unless told otherwise, and the
    // result is a four-source answer to a question one lookup settled.
    expect(planFor("research").guidance).toContain("not a quota");
    expect(planFor("quick").guidance).toContain("one turn");
  });

  it("sets a floor as well as a ceiling once the person asked for work", () => {
    /*
     * The loophole this closes. Asked to `investigate this, is it true?` about a statistic, Agen
     * called no tool at all and replied that the claim was undefined and uncited — a fair critique,
     * and a way of not doing the thing it was asked to do. The old guidance invited it: it offered
     * "if you could not check the load-bearing part, lead with that" without saying that not checking
     * is different from being unable to.
     */
    expect(planFor("research").guidance).toContain("one source is the floor");
    expect(planFor("investigate").guidance).toContain("Never answer at this depth without retrieving");
    expect(planFor("investigate").guidance).toContain("never a reason to skip searching");
    // A loosely worded claim is a reason to go and find the real figure, not a reason to dismiss it.
    expect(planFor("investigate").guidance).toContain("check the nearest thing that is measurable");
    // Quick keeps no floor: `thoughts?` under a chart should still answer from what is on screen.
    expect(planFor("quick").guidance).not.toContain("floor");
  });
});
