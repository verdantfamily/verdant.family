/**
 * That a delisted market is actually absent from the site.
 *
 * `isDelisted` being right about an address is the easy half; the half worth pinning is that
 * the source the pages read applies it — every shelf comes from `list`, every token page from
 * `read`, and a filter that covered one and not the other would leave the market off the
 * catalogue while its page stayed up and shareable.
 *
 * The chain half is mocked, because the claim is about the seam and not about the registry.
 */

import { describe, expect, it, vi } from "vitest";

import type { InstantMarket } from "./instant-markets";

const DELISTED = "0xebb84696c6250c46dede1c0aae964096bb4d3826";
const KEPT = "0x5f128d7c4d575bd9bb0782e4c394cce04765a636";

function market(token: string, symbol: string): InstantMarket {
  return {
    token: token as `0x${string}`,
    poolId: `0x${symbol.charCodeAt(0).toString(16).padStart(64, "0")}` as `0x${string}`,
    creator: "0x00000000000000000000000000000000000000c0" as `0x${string}`,
    createdAt: 1_786_890_183,
    vault: "0x00000000000000000000000000000000000000fa" as `0x${string}`,
    name: symbol,
    symbol,
    supplyTokens: 1_000_000_000,
    lpFee: 0,
    price: 0.000_000_01,
    liquidity: 0n,
    sqrtPriceX96: 0n,
    metadata: { description: "", image: null, links: {} },
  };
}

vi.mock("./instant-markets", () => ({
  readInstantMarkets: async () => [market(DELISTED, "AGEN"), market(KEPT, "DOG")],
  readInstantMarket: async (id: string) =>
    id.toLowerCase() === DELISTED ? market(DELISTED, "AGEN") : market(KEPT, "DOG"),
}));

// No indexer in a unit test: no day figures and no candles, which is a market that has not
// traded yet as far as these pages are concerned, and is beside the point being made.
vi.mock("./instant-feed", () => ({
  fetchInstantStats: async () => null,
  fetchInstantCandles: async () => null,
  fetchInstantTrades: async () => [],
}));

// The build store is a filesystem; an empty catalogue keeps this about the chain half.
vi.mock("./builds", () => ({
  jobStore: () => ({ list: async () => [], read: async () => null }),
  publicView: (job: unknown) => job,
}));

vi.mock("./launched", () => ({
  readLaunches: async () => [],
  readLaunch: async () => null,
}));

const { marketSource } = await import("./markets");

describe("a delisted market, from the pages' point of view", () => {
  it("is not on any shelf", async () => {
    const listed = await marketSource().list();

    expect(listed.map((entry) => entry.id)).toEqual([KEPT]);
  });

  it("has no page, even for somebody holding the link", async () => {
    await expect(marketSource().read(DELISTED)).resolves.toBeNull();
  });

  it("takes nothing else down with it", async () => {
    const kept = await marketSource().read(KEPT);

    expect(kept?.symbol).toBe("DOG");
  });

  it("serves no trades either, so the routes under its page are as empty as the page", async () => {
    await expect(marketSource().trades(DELISTED)).resolves.toEqual([]);
  });
});
