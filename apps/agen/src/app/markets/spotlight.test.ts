import { describe, expect, it } from "vitest";

import type { InstantSummary } from "../lib/markets";
import { spotlightOf } from "./spotlight";

function instant(
  id: string,
  marketCap?: number,
): InstantSummary {
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
    ...(marketCap === undefined ? {} : { trading: {
      price: 0,
      marketCap,
      liquidity: 0,
      volume24h: null,
      boostVolume24h: null,
      trades24h: null,
      change24hPercent: null,
      holders: null,
    } }),
  };
}

/** The token named in `spotlight.tsx`, which is the whole point of the pick being a pick. */
const CHOSEN = "0x11e1553f59bb42834dc23b1b9d23c885273d3d97";

describe("the house's own pick", () => {
  it("takes the frame from a token worth ten times as much", () => {
    const chosen = spotlightOf([instant("0xbigger", 1_000), instant(CHOSEN, 100)]);

    expect(chosen?.id).toBe(CHOSEN);
  });

  it("is recognised whatever case the address arrives in", () => {
    const chosen = spotlightOf([instant("0xbigger", 1_000), instant(CHOSEN.toUpperCase(), 100)]);

    expect(chosen?.id.toLowerCase()).toBe(CHOSEN);
  });

  it("gives way to the largest market cap when the chosen token is not on the shelf", () => {
    const chosen = spotlightOf([instant("0xsmall", 2), instant("0xlarge", 10)]);

    expect(chosen?.id).toBe("0xlarge");
  });

  it("gives way rather than showing an empty frame when the chosen token has no figures", () => {
    const chosen = spotlightOf([instant(CHOSEN), instant("0xlarge", 10)]);

    expect(chosen?.id).toBe("0xlarge");
  });
});

describe("which token the Spotlight shows", () => {
  it("picks the Instant market with the highest capitalisation", () => {
    const chosen = spotlightOf([
      instant("small", 2),
      instant("large", 10),
      instant("mid", 5),
    ]);

    expect(chosen?.id).toBe("large");
  });

  it("ignores a market that is not trading yet", () => {
    const chosen = spotlightOf([instant("ready"), instant("live", 3)]);
    expect(chosen?.id).toBe("live");
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

    const chosen = spotlightOf([programmable, instant("instant", 4)]);
    expect(chosen?.id).toBe("instant");
  });

  it("is absent when nothing Instant is trading", () => {
    expect(spotlightOf([instant("a"), instant("b")])).toBeNull();
    expect(spotlightOf([])).toBeNull();
  });
});
