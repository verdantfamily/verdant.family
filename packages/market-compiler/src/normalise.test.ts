/**
 * Normalisation runs on every interpretation and nothing downstream reviews it, so the
 * one property that matters is that it changes spelling and never meaning.
 */

import { describe, expect, it } from "vitest";

import { camel, clamp, kebab, uniqueNames } from "./normalise.js";

describe("turning a model's names into identifiers", () => {
  it("handles the shapes a live build actually produced", () => {
    expect(camel("Buyer Fees Paid This Window")).toBe("buyerFeesPaidThisWindow");
    expect(camel("drift_pool_balance")).toBe("driftPoolBalance");
    expect(camel("current window direction")).toBe("currentWindowDirection");
  });

  it("leaves a name that was already right exactly as it was", () => {
    // The common case, and a normaliser that churns correct input is one that shows up
    // as spurious diffs between two builds of the same market.
    for (const name of ["driftPool", "consecutiveBuys", "epochStartedAt", "x"]) {
      expect(camel(name)).toBe(name);
    }
  });

  it("splits camel and Pascal runs rather than lowercasing them into one word", () => {
    expect(camel("DriftPool")).toBe("driftPool");
    expect(camel("driftPool Total")).toBe("driftPoolTotal");
  });

  it("produces something Solidity will accept from something it would not", () => {
    expect(camel("2ndWindow")).toBe("v2ndWindow");
    expect(camel("fees (this window)")).toBe("feesThisWindow");
  });

  it("makes rule ids kebab-case", () => {
    expect(kebab("Toggle Direction")).toBe("toggle-direction");
    expect(kebab("emptyWindowRollover")).toBe("empty-window-rollover");
    expect(kebab("large-sell-surcharge")).toBe("large-sell-surcharge");
  });

  it("keeps a name it cannot improve rather than returning nothing", () => {
    // An empty identifier fails validation with a far more confusing message than the
    // original would have.
    expect(camel("!!!")).toBe("!!!");
    expect(kebab("???")).toBe("???");
  });
});

describe("shortening a summary", () => {
  it("leaves one that fits", () => {
    expect(clamp("Every tenth buy trades free", 120)).toBe("Every tenth buy trades free");
  });

  it("cuts at a word boundary and says it was cut", () => {
    const long =
      "Six-hour alternating windows. Fees differ by side, all fees accumulate in a drift " +
      "pool, and the side that paid less receives the whole pool at the end of the window.";

    const short = clamp(long, 120);

    expect(short.length).toBeLessThanOrEqual(120);
    expect(short.endsWith("…")).toBe(true);
    expect(short).not.toMatch(/[ ,;:]…$/);
    expect(long.startsWith(short.slice(0, -1))).toBe(true);
  });
});

describe("renaming a whole specification at once", () => {
  it("gives two names that would collide separate identifiers", () => {
    // Silently merging them would merge two state variables, which is a change to the
    // market rather than to its spelling.
    const mapping = uniqueNames(["drift pool", "Drift Pool", "driftPool"], camel);

    expect([...new Set(mapping.values())]).toHaveLength(3);
    expect(mapping.get("drift pool")).toBe("driftPool");
  });

  it("maps every name it was given, so no reference is left dangling", () => {
    const names = ["Buyer Fees", "seller fees", "windowIndex"];
    const mapping = uniqueNames(names, camel);

    expect([...mapping.keys()]).toEqual(names);
  });
});
