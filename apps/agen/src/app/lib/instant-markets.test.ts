/**
 * That the catalogue cannot go missing.
 *
 * The shelf disappeared from production once: the chain route asked for sixty `eth_call`s in
 * one batch, the public RPC refused the batch as a whole, the refusal was caught, and the
 * page said "no token has been built yet" about thirty live markets. Every claim below is
 * about that failure being structurally impossible rather than currently absent.
 *
 * The feed is mocked and the chain is a stub that refuses everything, which is the shape of
 * the outage: the interesting question is what the reader does when its sources will not
 * answer, not what the sources say when they will.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "@verdant/sdk";

const HOOK = "0xa3a48A91B52e8553a9422f7eD71497d76405B8Cc" as const;
const REGISTRY = "0xAE8E1f39680A0fc7a164de25c1533179E853a807" as const;

const TOKENS = [
  "0x11e1553f59bb42834dc23b1b9d23c885273d3d97",
  "0xee101bcff5c75c8b092fa57c010a314d672559c8",
  "0x5f128d7c4d575bd9bb0782e4c394cce04765a636",
] as const;

/** A feed row for a token, with the pool id the reader will insist on deriving for itself. */
function row(token: string, symbol: string) {
  return {
    poolId: pool.poolIdFor(pool.NATIVE_CURRENCY, token as `0x${string}`, HOOK),
    token,
    hook: HOOK,
    creator: "0x00000000000000000000000000000000000000c0",
    vault: "0x00000000000000000000000000000000000000fa",
    fee: 8_388_608,
    name: symbol,
    symbol,
    decimals: 18,
    totalSupply: 1_000_000_000n * 10n ** 18n,
    // Empty, so that no metadata document is fetched: a URI is a network call and the
    // absence of one is a market with no document, which is the same code path.
    metadataURI: "",
    createdAt: 1_786_989_503,
    sqrtPriceX96: 2_046_873_073_838_085_973_375_944_779_044_050n,
    liquidity: 0n,
  };
}

const feed = vi.hoisted(() => ({ list: vi.fn() }));
const files = vi.hoisted(() => ({
  read: vi.fn<(name: string) => Promise<string | null>>(async () => null),
}));

vi.mock("./instant-feed", () => ({
  fetchInstantMarketList: feed.list,
}));

vi.mock("./metadata", () => ({
  readMetadata: (name: string) => files.read(name),
}));

vi.mock("./chain", () => ({
  INSTANT_ADDRESSES: { hook: HOOK, registry: REGISTRY },
  EXTERNAL: { stateView: "0x000000000000000000000000000000000000513e" },
}));

/**
 * A chain that refuses every call, which is the outage this file is about: the registry is
 * reachable in principle and answers nothing usable in practice.
 */
vi.mock("./onchain", () => ({
  publicClient: () =>
    new Proxy(
      {},
      {
        get:
          () =>
          () => {
            throw new Error("the public RPC refused the batch");
          },
      },
    ),
}));

async function reader() {
  vi.resetModules();
  return await import("./instant-markets");
}

beforeEach(() => {
  feed.list.mockReset();
  files.read.mockReset();
  files.read.mockResolvedValue(null);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("reading every Instant market", () => {
  it("puts the picture from the volume on the card, without asking this process for it", async () => {
    files.read.mockImplementation(async (name: string) =>
      name === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"
        ? JSON.stringify({
            image: "https://agen.space/api/images/logo.png",
            description: "the house token",
            name: "Agen",
            symbol: "AGEN",
          })
        : null,
    );

    const { readInstantMarkets } = await reader();
    feed.list.mockResolvedValue([
      {
        ...row(TOKENS[0], "AGEN"),
        metadataURI: "https://agen.space/api/metadata/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
      },
    ]);

    const shelf = await readInstantMarkets();

    expect(shelf[0]?.metadata.image).toBe("https://agen.space/api/images/logo.png");
    expect(files.read).toHaveBeenCalledWith("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json");
  });

  it("builds the shelf from the feed's rows", async () => {
    const { readInstantMarkets } = await reader();
    feed.list.mockResolvedValue([row(TOKENS[0], "AGEN"), row(TOKENS[1], "ROBIN")]);

    const shelf = await readInstantMarkets();

    expect(shelf.map((market) => market.symbol)).toEqual(["AGEN", "ROBIN"]);
  });

  it("serves the shelf it last saw when neither the feed nor the chain will answer", async () => {
    const { readInstantMarkets } = await reader();

    feed.list.mockResolvedValue([row(TOKENS[0], "AGEN"), row(TOKENS[1], "ROBIN")]);
    expect(await readInstantMarkets()).toHaveLength(2);

    // The outage: the feed goes quiet, and the chain behind it is the stub that refuses.
    feed.list.mockResolvedValue(null);

    const during = await readInstantMarkets();

    expect(during.map((market) => market.symbol)).toEqual(["AGEN", "ROBIN"]);
  });

  it("shows a market launched since, rather than the shelf it remembered", async () => {
    const { readInstantMarkets } = await reader();

    feed.list.mockResolvedValue([row(TOKENS[0], "AGEN")]);
    expect(await readInstantMarkets()).toHaveLength(1);

    feed.list.mockResolvedValue([row(TOKENS[0], "AGEN"), row(TOKENS[2], "DOG")]);

    const after = await readInstantMarkets();

    expect(after.map((market) => market.symbol)).toEqual(["AGEN", "DOG"]);
  });

  it("invents nothing when it has never managed to read a shelf", async () => {
    const { readInstantMarkets } = await reader();
    feed.list.mockResolvedValue(null);

    expect(await readInstantMarkets()).toEqual([]);
  });

  it("keeps the readable rows when one row cannot be turned into a market", async () => {
    const { readInstantMarkets } = await reader();
    const broken = { ...row(TOKENS[2], "BAD"), creator: "not-an-address" };
    feed.list.mockResolvedValue([row(TOKENS[0], "AGEN"), broken]);

    const shelf = await readInstantMarkets();

    expect(shelf.map((market) => market.symbol)).toEqual(["AGEN"]);
  });

  it("keeps the markets it could read when the feed offers rows from another deployment", async () => {
    const { readInstantMarkets } = await reader();

    const foreign = { ...row(TOKENS[2], "FORK"), hook: "0x00000000000000000000000000000000000f0000" };
    feed.list.mockResolvedValue([row(TOKENS[0], "AGEN"), foreign]);

    const shelf = await readInstantMarkets();

    expect(shelf.map((market) => market.symbol)).toEqual(["AGEN"]);
  });

  it("says so in the log rather than failing quietly, when it falls back to memory", async () => {
    const { readInstantMarkets } = await reader();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    feed.list.mockResolvedValue([row(TOKENS[0], "AGEN")]);
    await readInstantMarkets();

    feed.list.mockResolvedValue(null);
    await readInstantMarkets();

    expect(warn.mock.calls.flat().join(" ")).toMatch(/remembered/);
  });
});
