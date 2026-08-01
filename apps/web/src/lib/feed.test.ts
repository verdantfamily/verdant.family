/**
 * The feed boundary's tests.
 *
 * This module is the only place the indexer's JSON becomes the app's types, so it is the
 * only place a change to the indexer can silently produce wrong numbers rather than a
 * type error. Two things are worth pinning: that every amount arrives as `bigint` — a
 * decimal string that stayed a string would concatenate where it should add — and that
 * the two failure modes stay distinguishable, because the pages say different and
 * mutually exclusive things about the protocol depending on which one happened.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeedUnavailableError,
  MarketNotFoundError,
  fetchFeeActivity,
  fetchMarket,
  fetchMarkets,
  fetchSwaps,
} from "./feed";

/** One market, in exactly the shape the indexer serves. Taken from a live rig run. */
const RAW_MARKET = {
  poolId: "0x18f8f59bee20b2c302f6d8f082cb37b1aaed6f4d1ff7a7b100017685a2c781a0",
  token: "0xde32d9a62a24c385c844bdf2b7ee3c50924933d0",
  creator: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  model: 1,
  quote: {
    asset: "0x0000000000000000000000000000000000000000",
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    isNative: true,
  },
  name: "Progressive Market",
  symbol: "PROG",
  decimals: 18,
  totalSupply: "1000000000000000000000000000",
  metadataURI: "ipfs://seed",
  metadataMutable: false,
  splitter: "0x8272e0336e46b147437f06a7b6b85812571f89a1",
  locker: "0x9d0d542d9b6a1510cbb43661660609070461156a",
  vesting: null,
  positionTokenId: "2",
  splits: { creatorBps: 9000, protocolBps: 1000, reserveBps: 0 },
  schedule: {
    initTime: 1785583620,
    stages: [
      { startOffset: 0, feePpm: 10000 },
      { startOffset: 3600, feePpm: 3000 },
      { startOffset: 2592000, feePpm: 1000 },
    ],
  },
  fee: {
    at: 1785587280,
    ppm: 3000,
    stageIndex: 1,
    stageCount: 3,
    nextTransitionAt: 1788175620,
    secondsToNextTransition: 2588340,
  },
  pool: {
    initialSqrtPriceX96: "1744244129640337381386292603617838",
    initialTick: 200000,
    sqrtPriceX96: "1655957054888330327264577349061194",
    tick: 198961,
    liquidity: "40880370500396091307620",
  },
  activity: {
    swapCount: 2,
    volumeQuote: "100000000000000000",
    volumeToken: "45554613558132278370801614",
    lastSwapAt: 1785587280,
  },
  createdAt: 1785583620,
  createdAtBlock: "11",
  createdTx: "0x60c1028e28d716f2b086f0c2b547b2d09f7b3b291431faf39bbbd9430b0bdca4",
};

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parsing", () => {
  it("turns every amount into a bigint", async () => {
    respondWith({ at: 1785587280, markets: [RAW_MARKET] });
    const listing = await fetchMarkets();
    const market = listing.markets[0]!;

    expect(market.totalSupply).toBe(10n ** 27n);
    expect(market.volumeQuote).toBe(100_000_000_000_000_000n);
    expect(market.sqrtPriceX96).toBe(1_655_957_054_888_330_327_264_577_349_061_194n);
    expect(market.positionTokenId).toBe(2n);
    expect(market.createdAtBlock).toBe(11n);

    // The failure this guards against is addition that silently concatenates. If
    // volumeQuote were still a string, this would be "100000000000000000100..." and no
    // type error would have been raised at the call site.
    expect(market.volumeQuote + market.volumeQuote).toBe(200_000_000_000_000_000n);
  });

  it("carries the quote asset, so a page never assumes ether", async () => {
    respondWith(RAW_MARKET);
    const market = await fetchMarket(RAW_MARKET.poolId);

    expect(market.quote.isNative).toBe(true);
    expect(market.quote.asset).toBe("0x0000000000000000000000000000000000000000");
    expect(market.quote.symbol).toBe("ETH");
    expect(market.quote.decimals).toBe(18);
  });

  it("keeps an equity-quoted market's own symbol and decimals", async () => {
    // The pairing is the creator's choice and nothing about the launch token discloses
    // it, so a market that arrives quoted in NVDA has to read as NVDA all the way
    // through. Labelling this market's volume "ETH" would be a claim about which asset
    // a trader is spending.
    respondWith({
      ...RAW_MARKET,
      quote: {
        asset: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
        symbol: "NVDA",
        name: "NVIDIA Robinhood Token",
        decimals: 18,
        isNative: false,
      },
    });

    const market = await fetchMarket(RAW_MARKET.poolId);
    expect(market.quote.isNative).toBe(false);
    expect(market.quote.symbol).toBe("NVDA");
    expect(market.quote.asset).toBe("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec");
  });

  it("keeps the schedule and the derived fee as the indexer sent them", async () => {
    respondWith(RAW_MARKET);
    const market = await fetchMarket(RAW_MARKET.poolId);

    expect(market.stages).toHaveLength(3);
    expect(market.stages.map((stage) => stage.feePpm)).toEqual([10000, 3000, 1000]);
    expect(market.fee.ppm).toBe(3000);
    expect(market.fee.stageIndex).toBe(1);
    // A market mid-ladder must carry a transition, or the countdown has nothing to
    // count to and the page claims the fee is final.
    expect(market.fee.nextTransitionAt).not.toBeNull();
  });

  it("flattens the nested response so pages do not reach through it", async () => {
    respondWith(RAW_MARKET);
    const market = await fetchMarket(RAW_MARKET.poolId);

    expect(market.creatorBps).toBe(9000);
    expect(market.protocolBps).toBe(1000);
    expect(market.swapCount).toBe(2);
    expect(market.initialTick).toBe(200000);
  });

  it("preserves a null vesting contract rather than inventing an address", async () => {
    respondWith(RAW_MARKET);
    const market = await fetchMarket(RAW_MARKET.poolId);
    expect(market.vesting).toBeNull();
  });

  it("parses swap amounts, including the signed deltas", async () => {
    respondWith({
      swaps: [
        {
          id: "0xabc-3",
          buy: true,
          quoteAmount: "50000000000000000",
          tokenAmount: "22500000000000000000000000",
          feePpm: 3000,
          sqrtPriceX96: "1655957054888330327264577349061194",
          tick: 198961,
          sender: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
          timestamp: 1785587280,
          transactionHash: "0x0ba4651a",
        },
      ],
    });

    const swaps = await fetchSwaps(RAW_MARKET.poolId);
    expect(swaps[0]!.quoteAmount).toBe(50_000_000_000_000_000n);
    expect(swaps[0]!.tokenAmount).toBe(22_500_000_000_000_000_000_000_000n);
    expect(swaps[0]!.buy).toBe(true);
  });

  it("parses a claim's two sides, neither of which is necessarily ether", async () => {
    respondWith({
      collections: [
        {
          id: "0xabc-4",
          caller: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
          timestamp: 1785587280,
          transactionHash: "0x0ba4651a",
        },
      ],
      claims: [
        {
          id: "0xabc-5",
          recipient: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
          quoteAmount: "1200000000000000",
          tokenAmount: "3400000000000000000000",
          timestamp: 1785587280,
          transactionHash: "0x0ba4651b",
        },
      ],
    });

    const fees = await fetchFeeActivity(RAW_MARKET.poolId);
    expect(fees.collections).toHaveLength(1);
    expect(fees.claims[0]!.quoteAmount).toBe(1_200_000_000_000_000n);
    expect(fees.claims[0]!.tokenAmount).toBe(3_400n * 10n ** 18n);
  });
});

describe("failure modes", () => {
  it("distinguishes a missing market from a broken feed", async () => {
    respondWith({}, 404);
    await expect(fetchMarket("0xdead")).rejects.toBeInstanceOf(MarketNotFoundError);

    respondWith({}, 500);
    await expect(fetchMarket("0xdead")).rejects.toBeInstanceOf(FeedUnavailableError);
  });

  it("treats an unreachable feed as unavailable, not as an empty listing", async () => {
    // The distinction the pages depend on: an empty array would have the interface
    // announce that nothing has launched, which is a claim about the chain rather than
    // about our server.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(fetchMarkets()).rejects.toBeInstanceOf(FeedUnavailableError);
  });

  it("keeps the original failure reachable through cause", async () => {
    const underlying = new TypeError("ECONNREFUSED");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw underlying;
      }),
    );

    await expect(fetchMarkets()).rejects.toMatchObject({ cause: underlying });
  });
});
