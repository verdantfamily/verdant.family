/**
 * That the card a shared link unfurls into is actually an image.
 *
 * This route shipped broken and stayed that way, because nothing it does is visible from
 * the outside. The rasteriser behind `ImageResponse` is not a browser: it accepts a small
 * subset of flexbox and rejects, among other things, a `div` holding more than one node
 * without an explicit `display`. Violating that is not a type error and not a lint error
 * — it throws at render time, on a route no page links to and no test rendered, so the
 * first report is a grey rectangle on somebody else's timeline.
 *
 * So these tests draw the card and check the bytes are a PNG. They assert almost nothing
 * about what it looks like, on purpose: the value here is exercising the rasteriser at
 * all, on each branch that builds different markup.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Market, Quote } from "../../../lib/feed";

const fetchMarket = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/feed", () => ({ fetchMarket }));

// Only the network call is replaced. The arithmetic that turns a pool price into a
// dollar figure is the real thing, so a card that renders here renders in production.
vi.mock("../../../lib/usd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/usd")>()),
  fetchUsdPerEth: vi.fn(async () => 3_800),
}));

const { default: Image } = await import("./opengraph-image");

const ETHER: Quote = {
  asset: "0x0000000000000000000000000000000000000000",
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
  isNative: true,
};

const NVDA: Quote = {
  asset: "0x1234567890123456789012345678901234567890",
  symbol: "NVDA",
  name: "NVIDIA Robinhood Token",
  decimals: 18,
  isNative: false,
};

function marketWith(overrides: Partial<Market> = {}): Market {
  return {
    poolId: `0x${"11".repeat(32)}`,
    token: `0x${"22".repeat(20)}`,
    creator: `0x${"33".repeat(20)}`,
    model: 0,
    quote: ETHER,

    name: "Test",
    symbol: "TEST",
    decimals: 18,
    totalSupply: 1_000_000_000n * 10n ** 18n,
    metadataURI: "",
    metadataMutable: false,

    splitter: `0x${"44".repeat(20)}`,
    locker: `0x${"55".repeat(20)}`,
    vesting: null,
    positionTokenId: 1n,

    creatorBps: 9_000,
    protocolBps: 1_000,
    reserveBps: 0,

    stages: [],
    initTime: 1_700_000_000,

    fee: {
      at: 1_700_000_000,
      ppm: 10_000,
      stageIndex: 0,
      stageCount: 1,
      nextTransitionAt: null,
      secondsToNextTransition: null,
    },

    initialSqrtPriceX96: 3_961_408_125_713_216_879_677_197_516_800n,
    initialTick: 0,
    sqrtPriceX96: 3_961_408_125_713_216_879_677_197_516_800n,
    tick: 0,
    liquidity: 0n,

    swapCount: 0,
    volumeQuote: 0n,
    volumeToken: 0n,
    lastSwapAt: null,

    createdAt: 1_700_000_000,
    createdAtBlock: 1n,
    createdTx: `0x${"66".repeat(32)}`,

    ...overrides,
  };
}

/** The first eight bytes of every PNG, and of nothing else. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function render(id = "0xabc"): Promise<Buffer> {
  const response = await Image({ params: Promise.resolve({ id }) });
  return Buffer.from(await response.arrayBuffer());
}

describe("the card a market link unfurls into", () => {
  beforeEach(() => {
    vi.mocked(fetchMarket).mockReset();
  });

  it("draws a PNG for an ether-quoted market", async () => {
    vi.mocked(fetchMarket).mockResolvedValue(marketWith());

    const png = await render();

    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(png.byteLength).toBeGreaterThan(1_000);
  });

  it("draws a PNG for a market quoted in an equity, which shows no dollar figure", async () => {
    vi.mocked(fetchMarket).mockResolvedValue(marketWith({ quote: NVDA, symbol: "ACME" }));

    expect((await render()).subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it("draws a PNG for a name long enough to be truncated", async () => {
    vi.mocked(fetchMarket).mockResolvedValue(
      marketWith({ name: "A Name Far Longer Than The Card Has Room For" }),
    );

    expect((await render()).subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it("falls back to a generic card, still a PNG, when the feed is unreachable", async () => {
    vi.mocked(fetchMarket).mockRejectedValue(new Error("feed unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await render()).subarray(0, 8)).toEqual(PNG_MAGIC);
  });
});
