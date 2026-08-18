import { describe, expect, it } from "vitest";

import type { InstantSummary } from "../lib/markets";
import { spotlightOf } from "./spotlight";

function instant(id: string, marketCap?: number): InstantSummary {
  return {
    id,
    kind: "instant",
    name: id,
    symbol: id.slice(0, 4).toUpperCase(),
    createdAt: 1,
    creator: null,
    hookAddress: null,
    tokenAddress: id,
    phase: "live",
    headline: "",
    image: null,
    supplyTokens: 1_000_000_000,
    ...(marketCap === undefined
      ? {}
      : {
          trading: {
            price: 0,
            marketCap,
            liquidity: 0,
            volume24h: null,
            boostVolume24h: null,
            trades24h: null,
            change24hPercent: null,
            holders: null,
          },
        }),
  };
}

/** The two tokens named in `spotlight.tsx`, in the order the section is meant to show them. */
const FIRST = "0x6c58d6f67f728a74158e31fa1b6b497967e4786f";
const SECOND = "0x11e1553f59bb42834dc23b1b9d23c885273d3d97";

const ids = (markets: readonly InstantSummary[]): readonly string[] =>
  spotlightOf(markets).map((market) => market.id.toLowerCase());

describe("the house's own picks", () => {
  it("shows both, in the order they are named rather than by size", () => {
    // The second pick is worth ten times the first, and still goes second.
    expect(ids([instant(SECOND, 1_000), instant(FIRST, 100)])).toEqual([FIRST, SECOND]);
  });

  it("takes the frames from tokens worth more than either", () => {
    expect(ids([instant("0xhuge", 9_000), instant(FIRST, 5), instant(SECOND, 4)])).toEqual([
      FIRST,
      SECOND,
    ]);
  });

  it("recognises an address whatever case it arrives in", () => {
    expect(ids([instant(FIRST.toUpperCase(), 5), instant(SECOND.toUpperCase(), 4)])).toEqual([
      FIRST,
      SECOND,
    ]);
  });

  it("gives a frame to the largest market when a named token is not on the shelf", () => {
    expect(ids([instant(FIRST, 5), instant("0xlarge", 10), instant("0xsmall", 1)])).toEqual([
      FIRST,
      "0xlarge",
    ]);
  });

  it("gives the frame away rather than showing a token with no figures", () => {
    expect(ids([instant(FIRST), instant(SECOND, 4), instant("0xlarge", 10)])).toEqual([
      SECOND,
      "0xlarge",
    ]);
  });
});

describe("which tokens the Spotlight shows", () => {
  it("fills both frames with the largest capitalisations when nothing is named", () => {
    expect(ids([instant("0xsmall", 2), instant("0xlarge", 10), instant("0xmid", 5)])).toEqual([
      "0xlarge",
      "0xmid",
    ]);
  });

  it("never shows the same token in both frames", () => {
    const shown = ids([instant(FIRST, 10), instant("0xother", 1)]);

    expect(new Set(shown).size).toBe(shown.length);
  });

  it("shows two and no more, however many have traded", () => {
    const many = Array.from({ length: 8 }, (_, index) => instant(`0x${String(index)}`, index + 1));

    expect(spotlightOf(many)).toHaveLength(2);
  });

  it("shows the one market that is trading rather than nothing", () => {
    expect(ids([instant("0xready"), instant("0xlive", 3)])).toEqual(["0xlive"]);
  });

  it("ignores Programmable markets, even a larger one", () => {
    const programmable = {
      ...instant("prog", 100),
      kind: "programmable" as const,
      mechanics: {
        headline: "",
        ruleCount: 0,
        stateCount: 0,
        hasPhases: false,
        hasExternalDependencies: false,
        noveltyScore: 0,
      },
      contractCount: 0,
    };

    expect(spotlightOf([programmable, instant("0xinstant", 4)]).map((m) => m.id)).toEqual([
      "0xinstant",
    ]);
  });

  it("is empty when nothing Instant is trading", () => {
    expect(spotlightOf([instant("0xa"), instant("0xb")])).toEqual([]);
    expect(spotlightOf([])).toEqual([]);
  });
});
