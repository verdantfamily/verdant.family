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

// --- what the app works with ----------------------------------------------------

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

async function get<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${FEED_URL}${path}`, {
      next: { revalidate: REVALIDATE_SECONDS },
    });
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

/** By pool id or by token address; the indexer accepts either. */
export async function fetchMarket(id: string): Promise<Market> {
  return parseMarket(await get<RawMarket>(`/markets/${id}`));
}

export async function fetchSwaps(poolId: string, limit = 25): Promise<readonly Swap[]> {
  const raw = await get<{ swaps: readonly (Omit<Swap, "quoteAmount" | "tokenAmount" | "sqrtPriceX96"> & {
    quoteAmount: string;
    tokenAmount: string;
    sqrtPriceX96: string;
  })[] }>(`/markets/${poolId}/swaps?limit=${limit}`);

  return raw.swaps.map((swap) => ({
    ...swap,
    quoteAmount: BigInt(swap.quoteAmount),
    tokenAmount: BigInt(swap.tokenAmount),
    sqrtPriceX96: BigInt(swap.sqrtPriceX96),
  }));
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
