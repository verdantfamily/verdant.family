/**
 * The rule behind the wash on a live figure.
 *
 * Worth testing rather than eyeballing, because the thing it produces is a 640ms
 * animation that only fires when the chain does something: on a quiet market there is
 * nothing to look at, and on a busy one it is gone before it can be read. The cases below
 * are the ones where the obvious implementation is wrong.
 */

import { describe, expect, it } from "vitest";

import { flashFor } from "./flash";

describe("deciding whether a figure should announce itself", () => {
  it("says nothing when the figure has not arrived yet", () => {
    expect(flashFor({ text: "$3.9K", amount: 3_900 }, { text: "$3.9K", amount: 3_900 })).toBe(
      null,
    );
  });

  it("flashes green when the number went up", () => {
    expect(flashFor({ text: "$3.9K", amount: 3_900 }, { text: "$4.1K", amount: 4_100 })).toBe(
      "rise",
    );
  });

  it("flashes red when the number went down", () => {
    expect(flashFor({ text: "$4.1K", amount: 4_100 }, { text: "$3.9K", amount: 3_900 })).toBe(
      "fall",
    );
  });

  /*
   * The case that makes the two arguments necessary. A market cap moving by two cents is
   * a real change to the amount and no change at all to what is on screen, and a page of
   * figures winking at a reader over movement they cannot see is worse than one that
   * stays still.
   */
  it("stays quiet when the amount moved but the rounded text did not", () => {
    expect(
      flashFor({ text: "$3.9K", amount: 3_861.02 }, { text: "$3.9K", amount: 3_861.04 }),
    ).toBe(null);
  });

  /*
   * And its mirror. Direction has to come from the amount, because two visibly different
   * figures can be equal as text is compared — and because "$4.1K" < "$3.9K" is a string
   * comparison that answers a question nobody asked.
   */
  it("takes direction from the amount rather than from the text", () => {
    expect(flashFor({ text: "$900", amount: 900 }, { text: "$1.1K", amount: 1_100 })).toBe(
      "rise",
    );
    expect(flashFor({ text: "$1.1K", amount: 1_100 }, { text: "$900", amount: 900 })).toBe(
      "fall",
    );
  });

  it("treats an unmeasurable change as a rise rather than as bad news", () => {
    expect(flashFor({ text: "—", amount: null }, { text: "2", amount: 2 })).toBe("rise");
    expect(flashFor({ text: "2", amount: 2 }, { text: "—", amount: null })).toBe("rise");
    expect(
      flashFor({ text: "1B TEST", amount: null }, { text: "2B TEST", amount: null }),
    ).toBe("rise");
  });

  it("counts an unchanged amount as a rise, not a fall", () => {
    expect(flashFor({ text: "1%", amount: 10_000 }, { text: "1.0%", amount: 10_000 })).toBe(
      "rise",
    );
  });

  /*
   * The headline follows the chart's crosshair, so during a drag its text changes on
   * every pixel. Flashing there would be constant motion carrying no information about
   * the market.
   */
  it("says nothing at all while the reader is driving the figure", () => {
    expect(
      flashFor({ text: "$3.9K", amount: 3_900 }, { text: "$4.1K", amount: 4_100 }, true),
    ).toBe(null);
  });
});
