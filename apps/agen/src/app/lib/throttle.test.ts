/**
 * The ceiling on what one visitor can spend by asking.
 *
 * `POST /api/markets` takes no key and identifies nobody, and every call is minutes of a
 * frontier model's attention. While Programmable was held that was theoretical, because the
 * interface would not send the request; the hold was never read by the route itself.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { BUILD_LIMIT, forgetBuildCounts, tooManyBuilds, visitorOf } from "./throttle";

beforeEach(() => {
  forgetBuildCounts();
});

const HOUR = 60 * 60 * 1000;

describe("how many builds one visitor gets", () => {
  it("allows the ones a creator refining a market actually needs", () => {
    for (let attempt = 0; attempt < BUILD_LIMIT.perHour; attempt++) {
      expect(tooManyBuilds("1.2.3.4")).toBeNull();
    }
  });

  it("stops the next one, and says why in terms of what a build costs", () => {
    for (let attempt = 0; attempt < BUILD_LIMIT.perHour; attempt++) tooManyBuilds("1.2.3.4");

    const refusal = tooManyBuilds("1.2.3.4");
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("hour");
  });

  it("counts each visitor separately", () => {
    for (let attempt = 0; attempt < BUILD_LIMIT.perHour; attempt++) tooManyBuilds("1.2.3.4");

    expect(tooManyBuilds("5.6.7.8")).toBeNull();
  });

  it("forgives the hour once it has passed", () => {
    const start = Date.now();
    for (let attempt = 0; attempt < BUILD_LIMIT.perHour; attempt++) {
      tooManyBuilds("1.2.3.4", start);
    }

    expect(tooManyBuilds("1.2.3.4", start)).not.toBeNull();
    expect(tooManyBuilds("1.2.3.4", start + HOUR + 1)).toBeNull();
  });

  /** Spread across the day so the hourly ceiling is never the thing being tested. */
  it("still holds a daily ceiling for someone pacing themselves", () => {
    const start = Date.now();

    for (let attempt = 0; attempt < BUILD_LIMIT.perDay; attempt++) {
      expect(tooManyBuilds("1.2.3.4", start + attempt * 2 * HOUR)).toBeNull();
    }

    const refusal = tooManyBuilds("1.2.3.4", start + BUILD_LIMIT.perDay * 2 * HOUR);
    expect(refusal).toContain("today");
  });

  /**
   * A refusal must not extend itself. Counting rejected attempts would mean a visitor who
   * retried twice waits longer than one who walked away, which reads as a broken form.
   */
  it("does not charge a visitor for being refused", () => {
    const start = Date.now();
    for (let attempt = 0; attempt < BUILD_LIMIT.perHour; attempt++) {
      tooManyBuilds("1.2.3.4", start);
    }

    for (let retry = 0; retry < 5; retry++) tooManyBuilds("1.2.3.4", start + retry);

    expect(tooManyBuilds("1.2.3.4", start + HOUR + 1)).toBeNull();
  });
});

describe("who is asking", () => {
  /**
   * Railway appends to `x-forwarded-for`, so the last entry is its own edge. Reading that end
   * of the list would make every visitor share one allowance.
   */
  it("is the first address in the forwarded list, not the proxy that added itself", () => {
    const request = new Request("https://agen.space/api/markets", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" },
    });

    expect(visitorOf(request)).toBe("203.0.113.7");
  });

  it("falls back to one allowance rather than none when nothing identifies the caller", () => {
    expect(visitorOf(new Request("https://agen.space/api/markets"))).toBe("unknown");
  });
});
