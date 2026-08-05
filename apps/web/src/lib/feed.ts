/**
 * The interface's one door to the indexer.
 *
 * Two things happen here and nowhere else. The API's JSON shapes are declared once, so
 * a change to the indexer's response breaks in a single file rather than in eight
 * components. And every amount is turned into `bigint` on the way in, so no page can
 * accidentally do arithmetic on a decimal string or route money through a float. What
 * leaves this module is already in the units `@verdant/ui` formats.
 *
 * ## Why the indexer rather than the chain
 *
 * A listing of markets sorted by age, with volume and trade counts, is a query — it is
 * what an indexer is for, and doing it from the chain would mean a call per market per
 * page load. The SDK's read layer exists for the other case: a wallet that must not
 * trust a server, and the fallback when the indexer is behind. The fee shown here is
 * derived by the indexer from the stored ladder using the same code the SDK would use,
 * and the feed proof checks that answer against the hook itself on every commit.
 */

import { candles } from "@verdant/sdk";

/** Where the feed lives. The dev stack prints this; production sets it. */
const FEED_URL = process.env.VERDANT_FEED_URL ?? "http://127.0.0.1:42069";

/**
 * How long a listing may be reused.
 *
 * Five seconds, which is a few blocks. Everything that moves faster than that — the
 * countdown to a fee transition — advances client-side from the chain timestamp the
 * response carries, so a slightly stale response still shows a correct clock.
 */
const REVALIDATE_SECONDS = 5;

// --- the shapes the API returns -------------------------------------------------

interface RawStage {
  readonly startOffset: number;
  readonly feePpm: number;
}

interface RawQuote {
  readonly asset: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly isNative: boolean;
}

interface RawMarket {
  readonly poolId: string;
  readonly token: string;
  readonly creator: string;
  readonly model: number;
  readonly quote: RawQuote;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly totalSupply: string;
  readonly metadataURI: string;
  readonly metadataMutable: boolean;
  readonly splitter: string;
  readonly locker: string;
  readonly vesting: string | null;
  readonly positionTokenId: string;
  readonly splits: {
    readonly creatorBps: number;
    readonly protocolBps: number;
    readonly reserveBps: number;
  };
  readonly schedule: {
    readonly initTime: number;
    readonly stages: readonly RawStage[];
  };
  readonly fee: {
    readonly at: number;
    readonly ppm: number;
    readonly stageIndex: number;
    readonly stageCount: number;
    readonly nextTransitionAt: number | null;
    readonly secondsToNextTransition: number | null;
  };
  readonly pool: {
    readonly initialSqrtPriceX96: string;
    readonly initialTick: number;
    readonly sqrtPriceX96: string;
    readonly tick: number;
    readonly liquidity: string;
  };
  readonly activity: {
    readonly swapCount: number;
    readonly volumeQuote: string;
    readonly volumeToken: string;
    readonly lastSwapAt: number | null;
  };
  readonly createdAt: number;
  readonly createdAtBlock: string;
  readonly createdTx: string;
}

interface RawCandles {
  readonly interval: candles.CandleInterval;
  readonly seconds: number;
  readonly at: number;
  readonly since: number;
  readonly anchor: { readonly at: number; readonly price: string };
  readonly candles: readonly {
    readonly start: number;
    readonly open: string;
    readonly high: string;
    readonly low: string;
    readonly close: string;
    readonly volumeQuote: string;
    readonly volumeToken: string;
    readonly trades: number;
  }[];
}

// --- what the app works with ----------------------------------------------------

export interface CandleSeries {
  readonly interval: candles.CandleInterval;
  readonly seconds: number;
  /** Chain time the series was computed at, and the right-hand edge of the chart. */
  readonly at: number;
  readonly candles: readonly candles.Candle[];
}

export interface Stage {
  readonly startOffset: number;
  readonly feePpm: number;
}

/**
 * What a market is priced and traded in: the pool's `currency0`.
 *
 * Carried on every market because nothing about a launch token discloses it, and a
 * reader who cannot see the pair cannot read the price. `asset` is the zero address
 * for a market quoted in native ether, which is how v4 itself addresses ether — there
 * is no wrapping — and `isNative` says the same thing without an address comparison at
 * each call site.
 *
 * The symbol and name are the indexer's reading of the asset, not our allowlist's.
 * `@verdant/config`'s `QUOTE_ASSETS` carries a human label for the equities that have
 * been reviewed, and a market quoted in something absent from it is still a market:
 * the interface shows what the chain says and, where it has no label, the address.
 */
export interface Quote {
  readonly asset: `0x${string}`;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly isNative: boolean;
}

export interface Market {
  readonly poolId: `0x${string}`;
  readonly token: `0x${string}`;
  readonly creator: `0x${string}`;
  readonly model: number;
  readonly quote: Quote;

  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly totalSupply: bigint;
  readonly metadataURI: string;
  readonly metadataMutable: boolean;

  readonly splitter: `0x${string}`;
  readonly locker: `0x${string}`;
  readonly vesting: `0x${string}` | null;
  readonly positionTokenId: bigint;

  readonly creatorBps: number;
  readonly protocolBps: number;
  readonly reserveBps: number;

  /** The ladder, as stored. Immutable for the life of the market. */
  readonly stages: readonly Stage[];
  readonly initTime: number;

  /**
   * The fee in force, and when it next changes.
   *
   * Derived by the indexer at `at`, which is a chain timestamp. Anything that needs
   * to tick — a countdown — advances from `at` rather than from the reader's clock.
   */
  readonly fee: {
    readonly at: number;
    readonly ppm: number;
    readonly stageIndex: number;
    readonly stageCount: number;
    readonly nextTransitionAt: number | null;
    readonly secondsToNextTransition: number | null;
  };

  readonly initialSqrtPriceX96: bigint;
  readonly initialTick: number;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;

  readonly swapCount: number;
  /** Base units of `quote.asset`, so it is formatted with that asset's decimals. */
  readonly volumeQuote: bigint;
  readonly volumeToken: bigint;
  readonly lastSwapAt: number | null;

  readonly createdAt: number;
  readonly createdAtBlock: bigint;
  readonly createdTx: `0x${string}`;
}

export interface Swap {
  readonly id: string;
  readonly buy: boolean;
  /** Base units of the market's quote asset, whichever it is. */
  readonly quoteAmount: bigint;
  readonly tokenAmount: bigint;
  readonly feePpm: number;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly sender: `0x${string}`;
  readonly timestamp: number;
  readonly transactionHash: `0x${string}`;
}

/** Trades, with the chain time they were read at. */
export interface TradeHistory {
  readonly at: number;
  readonly swaps: readonly Swap[];
  /** Every trade the market has, not the number in `swaps`. What a pager counts with. */
  readonly total: number;
  readonly offset: number;
}

/**
 * One address holding the token, and how much of it.
 *
 * "Holder" is what the transfer log says rather than a judgement about who is a person:
 * a router caught mid-trade, the splitter sitting on uncollected fees and a vesting
 * contract all appear here. The address is shown so a reader can make that call
 * themselves, which is the only place it can honestly be made.
 */
export interface Holder {
  readonly address: `0x${string}`;
  readonly balance: bigint;
}

export interface HolderPage {
  readonly token: `0x${string}`;
  readonly totalSupply: bigint;
  readonly decimals: number;
  /** How many addresses hold any of it, across all pages. */
  readonly total: number;
  readonly offset: number;
  readonly holders: readonly Holder[];
}

/**
 * The figures that are aggregates over the trade table rather than columns on the market.
 *
 * Separate from `Market` because they cost a scan each and a listing of twenty-five
 * markets does not want twenty-five of them. A market page asks for these once.
 */
export interface MarketStats {
  /** Chain time the window below was measured back from. */
  readonly at: number;
  readonly window: number;
  readonly day: {
    readonly since: number;
    /** Base units of the market's quote asset, like every other volume here. */
    readonly volumeQuote: bigint;
    readonly volumeToken: bigint;
    readonly trades: number;
  };
  /**
   * The extremes over the market's whole life, as quote-per-token at 36 decimals — the
   * same fixed point `quotePerToken` produces, so `formatPrice` renders them directly.
   * The launch price counts, so these are never empty.
   */
  readonly allTime: {
    readonly high: bigint;
    readonly low: bigint;
  };
  readonly holders: number;
}

export interface FeeActivity {
  readonly collections: readonly {
    readonly id: string;
    readonly caller: `0x${string}`;
    readonly timestamp: number;
    readonly transactionHash: `0x${string}`;
  }[];
  readonly claims: readonly {
    readonly id: string;
    readonly recipient: `0x${string}`;
    /** The quote side of a claim: ether for an ether-quoted market, the equity otherwise. */
    readonly quoteAmount: bigint;
    readonly tokenAmount: bigint;
    readonly timestamp: number;
    readonly transactionHash: `0x${string}`;
  }[];
}

/** A listing, with the chain time it was taken at. */
export interface Listing {
  readonly at: number;
  readonly markets: readonly Market[];
}

// --- parsing --------------------------------------------------------------------

function parseMarket(raw: RawMarket): Market {
  return {
    poolId: raw.poolId as `0x${string}`,
    token: raw.token as `0x${string}`,
    creator: raw.creator as `0x${string}`,
    model: raw.model,
    quote: {
      asset: raw.quote.asset as `0x${string}`,
      symbol: raw.quote.symbol,
      name: raw.quote.name,
      decimals: raw.quote.decimals,
      isNative: raw.quote.isNative,
    },

    name: raw.name,
    symbol: raw.symbol,
    decimals: raw.decimals,
    totalSupply: BigInt(raw.totalSupply),
    metadataURI: raw.metadataURI,
    metadataMutable: raw.metadataMutable,

    splitter: raw.splitter as `0x${string}`,
    locker: raw.locker as `0x${string}`,
    vesting: raw.vesting === null ? null : (raw.vesting as `0x${string}`),
    positionTokenId: BigInt(raw.positionTokenId),

    creatorBps: raw.splits.creatorBps,
    protocolBps: raw.splits.protocolBps,
    reserveBps: raw.splits.reserveBps,

    stages: raw.schedule.stages,
    initTime: raw.schedule.initTime,
    fee: raw.fee,

    initialSqrtPriceX96: BigInt(raw.pool.initialSqrtPriceX96),
    initialTick: raw.pool.initialTick,
    sqrtPriceX96: BigInt(raw.pool.sqrtPriceX96),
    tick: raw.pool.tick,
    liquidity: BigInt(raw.pool.liquidity),

    swapCount: raw.activity.swapCount,
    volumeQuote: BigInt(raw.activity.volumeQuote),
    volumeToken: BigInt(raw.activity.volumeToken),
    lastSwapAt: raw.activity.lastSwapAt,

    createdAt: raw.createdAt,
    createdAtBlock: BigInt(raw.createdAtBlock),
    createdTx: raw.createdTx as `0x${string}`,
  };
}

/**
 * Thrown when the feed cannot answer.
 *
 * A distinct type so a page can tell "the indexer is down" from "there are no markets
 * yet" and say the true thing. Those look identical in an empty array, and telling a
 * visitor that nothing has launched when in fact the server is broken is the worse of
 * the two mistakes: it is a claim about the protocol rather than about us.
 */
export class FeedUnavailableError extends Error {
  constructor(
    readonly path: string,
    cause?: unknown,
  ) {
    // Through `cause` rather than as a field of our own: `Error` already has one, and
    // shadowing it would hide the original failure from every logger that knows to
    // look there.
    super(`the market feed did not answer ${path}`, { cause });
    this.name = "FeedUnavailableError";
  }
}

/**
 * Ask the indexer, with or without the window in front of it.
 *
 * The cache is right for a page render: several components ask for the same market while
 * one page is built, a listing is read by everybody who arrives in the same few seconds,
 * and none of them needs a figure fresher than the last block or two.
 *
 * It is wrong for the routes a component polls. Those exist precisely because a number
 * moved, and a poll every second against a response held for five gets the same answer
 * four times — the interface looked frozen while the chain was busy, which is the whole
 * of the "not updating in real time" complaint. Freshness is therefore the caller's
 * decision, because only the caller knows whether it is rendering a page once or asking
 * again on a timer.
 */
async function get<T>(path: string, fresh = false): Promise<T> {
  let response: Response;
  try {
    response = await fetch(
      `${FEED_URL}${path}`,
      fresh ? { cache: "no-store" } : { next: { revalidate: REVALIDATE_SECONDS } },
    );
  } catch (cause) {
    throw new FeedUnavailableError(path, cause);
  }

  // A 404 is an answer — the market does not exist — and callers handle it. Anything
  // else in the failure range means the feed is unwell.
  if (response.status === 404) throw new MarketNotFoundError(path);
  if (!response.ok) throw new FeedUnavailableError(path, response.status);

  return (await response.json()) as T;
}

/** Thrown when a pool id or token address matches no market. */
export class MarketNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`no market at ${path}`);
    this.name = "MarketNotFoundError";
  }
}

// --- the queries ----------------------------------------------------------------

export async function fetchMarkets(limit = 24): Promise<Listing> {
  const raw = await get<{ at: number; markets: RawMarket[] }>(`/markets?limit=${limit}`);
  return { at: raw.at, markets: raw.markets.map(parseMarket) };
}

/**
 * The markets one address launched, newest first.
 *
 * `creator` here is whoever sent the launch transaction. It is not necessarily who the
 * fees belong to — a launch may name a different `feeRecipient`, and only the market's
 * own splitter knows that address — so a page about earnings reads this for the list and
 * then asks each splitter who it pays.
 */
export async function fetchMarketsBy(creator: string, limit = 50): Promise<Listing> {
  const raw = await get<{ at: number; markets: RawMarket[] }>(
    `/markets?creator=${creator.toLowerCase()}&limit=${limit}`,
  );
  return { at: raw.at, markets: raw.markets.map(parseMarket) };
}

/** By pool id or by token address; the indexer accepts either. */
export async function fetchMarket(id: string, fresh = false): Promise<Market> {
  return parseMarket(await get<RawMarket>(`/markets/${id}`, fresh));
}

/**
 * A market's trades, newest first, with the chain time they were read at.
 *
 * `at` travels with them because every row is rendered as an age, and an age measured
 * against the reader's own clock is wrong by whatever their machine is off by — on a
 * chain with sub-second blocks that is easily "in 4 seconds".
 */
export async function fetchSwaps(
  poolId: string,
  limit = 25,
  offset = 0,
  fresh = false,
): Promise<TradeHistory> {
  const raw = await get<{
    at: number;
    total: number;
    offset: number;
    swaps: readonly (Omit<Swap, "quoteAmount" | "tokenAmount" | "sqrtPriceX96"> & {
      quoteAmount: string;
      tokenAmount: string;
      sqrtPriceX96: string;
    })[];
  }>(`/markets/${poolId}/swaps?limit=${limit}&offset=${offset}`, fresh);

  return {
    at: raw.at,
    total: raw.total,
    offset: raw.offset,
    swaps: raw.swaps.map((swap) => ({
      ...swap,
      quoteAmount: BigInt(swap.quoteAmount),
      tokenAmount: BigInt(swap.tokenAmount),
      sqrtPriceX96: BigInt(swap.sqrtPriceX96),
    })),
  };
}

/**
 * Who holds the token, largest first.
 *
 * `totalSupply` rides along so a share can be worked out without also fetching the
 * market — the page usually has one, but the polling route behind the holders tab does
 * not, and a percentage computed against a supply from a different request is a
 * percentage that can exceed a hundred.
 */
export async function fetchHolders(
  id: string,
  limit = 25,
  offset = 0,
  fresh = false,
): Promise<HolderPage> {
  const raw = await get<{
    token: string;
    totalSupply: string;
    decimals: number;
    total: number;
    offset: number;
    holders: readonly { address: string; balance: string }[];
  }>(`/markets/${id}/holders?limit=${limit}&offset=${offset}`, fresh);

  return {
    token: raw.token as `0x${string}`,
    totalSupply: BigInt(raw.totalSupply),
    decimals: raw.decimals,
    total: raw.total,
    offset: raw.offset,
    holders: raw.holders.map((holder) => ({
      address: holder.address as `0x${string}`,
      balance: BigInt(holder.balance),
    })),
  };
}

/** The rolling window and all-time extremes a market page leads with. */
export async function fetchMarketStats(id: string, fresh = false): Promise<MarketStats> {
  const raw = await get<{
    at: number;
    window: number;
    day: {
      since: number;
      volumeQuote: string;
      volumeToken: string;
      trades: number;
    };
    allTime: { high: string; low: string };
    holders: number;
  }>(`/markets/${id}/stats`, fresh);

  return {
    at: raw.at,
    window: raw.window,
    day: {
      since: raw.day.since,
      volumeQuote: BigInt(raw.day.volumeQuote),
      volumeToken: BigInt(raw.day.volumeToken),
      trades: raw.day.trades,
    },
    allTime: {
      high: BigInt(raw.allTime.high),
      low: BigInt(raw.allTime.low),
    },
    holders: raw.holders,
  };
}

/**
 * A market's price history, already gapless.
 *
 * The indexer returns the buckets it observed and the price entering the window; the
 * filling happens here, through `candles.fill`, so the series a chart receives has one
 * point per interval and no holes. See that function for why a flat filled candle is
 * the truth about a pool rather than an interpolation of it.
 *
 * `at` is the indexer's chain timestamp and the series is filled up to it, so the line
 * reaches the right-hand edge of the chart even when the last trade was hours ago.
 */
export async function fetchCandles(
  poolId: string,
  interval: candles.CandleInterval,
  limit = 240,
  fresh = false,
): Promise<CandleSeries> {
  const raw = await get<RawCandles>(
    `/markets/${poolId}/candles?interval=${interval}&limit=${limit}`,
    fresh,
  );

  const observed = raw.candles.map((candle) => ({
    start: candle.start,
    open: BigInt(candle.open),
    high: BigInt(candle.high),
    low: BigInt(candle.low),
    close: BigInt(candle.close),
    volumeQuote: BigInt(candle.volumeQuote),
    volumeToken: BigInt(candle.volumeToken),
    trades: candle.trades,
    traded: true,
  }));

  return {
    interval: raw.interval,
    seconds: raw.seconds,
    at: raw.at,
    candles: candles.fill(observed, {
      seconds: raw.seconds,
      since: raw.since,
      until: raw.at,
      anchor: { at: raw.anchor.at, price: BigInt(raw.anchor.price) },
    }),
  };
}

export async function fetchFeeActivity(poolId: string): Promise<FeeActivity> {
  const raw = await get<{
    collections: FeeActivity["collections"];
    claims: readonly (Omit<FeeActivity["claims"][number], "quoteAmount" | "tokenAmount"> & {
      quoteAmount: string;
      tokenAmount: string;
    })[];
  }>(`/markets/${poolId}/fees`);

  return {
    collections: raw.collections,
    claims: raw.claims.map((claim) => ({
      ...claim,
      quoteAmount: BigInt(claim.quoteAmount),
      tokenAmount: BigInt(claim.tokenAmount),
    })),
  };
}
