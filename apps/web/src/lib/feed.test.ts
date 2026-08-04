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
  fetchCandles,
  fetchFeeActivity,
  fetchHolders,
  fetchMarket,
  fetchMarketStats,
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
      at: 1785587290,
      total: 412,
      offset: 30,
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

    const history = await fetchSwaps(RAW_MARKET.poolId);
    expect(history.swaps[0]!.quoteAmount).toBe(50_000_000_000_000_000n);
    expect(history.swaps[0]!.tokenAmount).toBe(22_500_000_000_000_000_000_000_000n);
    expect(history.swaps[0]!.buy).toBe(true);
    // The chain's clock travels with the rows, because every one is rendered as an age.
    expect(history.at).toBe(1785587290);
    // And the count of every trade, which is what a pager draws itself from — one page
    // of rows says nothing about how many pages there are.
    expect(history.total).toBe(412);
    expect(history.offset).toBe(30);
  });

  it("parses holder balances and the supply they are a share of", async () => {
    respondWith({
      token: RAW_MARKET.token,
      totalSupply: "1000000000000000000000000000",
      decimals: 18,
      total: 3,
      offset: 0,
      holders: [
        { address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", balance: "250000000000000000000000000" },
        { address: "0x8272e0336e46b147437f06a7b6b85812571f89a1", balance: "1" },
      ],
    });

    const page = await fetchHolders(RAW_MARKET.poolId);
    expect(page.holders[0]!.balance).toBe(250_000_000_000_000_000_000_000_000n);
    // A single wei is a real balance and has to survive the crossing: rounded to a
    // number it would be indistinguishable from a quarter of the supply's last digit.
    expect(page.holders[1]!.balance).toBe(1n);
    expect(page.totalSupply).toBe(10n ** 27n);
    expect(page.total).toBe(3);
  });

  it("parses the rolling window and the all-time extremes", async () => {
    respondWith({
      at: 1785587290,
      window: 86_400,
      day: {
        since: 1785500890,
        volumeQuote: "50000000000000000",
        volumeToken: "22500000000000000000000000",
        trades: 7,
      },
      // Quote per token at 36 decimals, the fixed point `quotePerToken` produces.
      allTime: { high: "2100000000000000000000000000", low: "1900000000000000000000000000" },
      holders: 12,
    });

    const stats = await fetchMarketStats(RAW_MARKET.poolId);
    expect(stats.day.volumeQuote).toBe(50_000_000_000_000_000n);
    expect(stats.day.trades).toBe(7);
    // The high is the larger price, whatever the square root it came from was doing.
    expect(stats.allTime.high).toBeGreaterThan(stats.allTime.low);
    expect(stats.holders).toBe(12);
  });

  it("fills the quiet buckets of a candle series, flat and unmarked as traded", async () => {
    // Two trades twenty minutes apart, at one-minute resolution. The indexer reports the
    // two buckets it saw; what reaches a chart has to be every minute between them, at
    // the price the pool actually held — which is the previous close, because nothing
    // moved it. The alternative, a line sloping between two trades, is a price nobody
    // could have traded at.
    respondWith({
      interval: "1m",
      seconds: 60,
      at: 1_785_587_400,
      since: 1_785_586_200,
      anchor: { at: 1_785_583_620, price: "1000000000000000000000000000" },
      candles: [
        {
          start: 1_785_586_200,
          open: "1000000000000000000000000000",
          high: "1100000000000000000000000000",
          low: "1000000000000000000000000000",
          close: "1100000000000000000000000000",
          volumeQuote: "50000000000000000",
          volumeToken: "22500000000000000000000000",
          trades: 1,
        },
      ],
    });

    const series = await fetchCandles(RAW_MARKET.poolId, "1m");

    // 1 785 586 200 through 1 785 587 400 inclusive, every minute.
    expect(series.candles).toHaveLength(21);
    expect(series.candles[0]!.traded).toBe(true);
    expect(series.candles[0]!.close).toBe(1_100_000_000_000_000_000_000_000_000n);

    const quiet = series.candles[1]!;
    expect(quiet.traded).toBe(false);
    expect(quiet.open).toBe(quiet.close);
    expect(quiet.close).toBe(1_100_000_000_000_000_000_000_000_000n);
    expect(quiet.volumeQuote).toBe(0n);

    // And it reaches the right-hand edge, which is chain time rather than this machine's.
    expect(series.candles[series.candles.length - 1]!.start).toBe(1_785_587_400);
    expect(series.at).toBe(1_785_587_400);
  });

  it("draws a market that has never traded at the price it launched at", async () => {
    respondWith({
      interval: "5m",
      seconds: 300,
      at: 1_785_584_520,
      since: 1_785_583_500,
      anchor: { at: 1_785_583_620, price: "2000000000000000000000000000" },
      candles: [],
    });

    const series = await fetchCandles(RAW_MARKET.poolId, "5m");

    expect(series.candles.length).toBeGreaterThan(0);
    expect(series.candles.every((candle) => !candle.traded)).toBe(true);
    expect(series.candles.every((candle) => candle.close === 2n * 10n ** 27n)).toBe(true);
    // The series starts at the bucket the pool was initialised *in* — 1 785 583 620 falls
    // inside the five minutes from 1 785 583 500 — and not at any bucket that had already
    // ended by then, where a flat line would be a price that did not exist yet.
    expect(series.candles[0]!.start).toBe(1_785_583_500);
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
