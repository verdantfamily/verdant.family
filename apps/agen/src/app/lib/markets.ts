/**
 * What the trader-facing pages read.
 *
 * ## The honest situation, stated once
 *
 * No Agen market has been deployed. `AgenFactory` exists and is tested, nothing has
 * sent a transaction to it, and the indexer does not watch it yet. So every figure a
 * launchpad normally leads with — price, market cap, volume, liquidity, holders — has
 * no source. There are two ways to handle that and only one of them is defensible.
 *
 * The indefensible one is placeholder numbers. A card showing "$84K MC" for a market
 * that has never traded is not a layout aid; it is the interface asserting something
 * false about money, and it stays false in a screenshot after somebody removes the
 * TODO. So the type distinguishes a market that is trading from one that is not, and
 * pages read the distinction instead of a number.
 *
 * What *is* real today: the specification, the rules derived from it, the generated
 * contracts, the test results, the gate findings, the build's age and its creator.
 * That is a genuine market card — it just leads with mechanics instead of a price,
 * which is the thing Agen has that other launchpads do not.
 *
 * When markets deploy, `TradingData` gains a source and nothing above it changes.
 */

import type {
  GateFinding,
  MarketSpecification,
  MechanicSummary,
  TestOutcome,
} from "@verdant/market-compiler";
import { mechanicSummary } from "@verdant/market-compiler";

import type { Address } from "viem";

import { jobStore, publicView } from "./builds";
import { fetchMarketStats, type MarketStats } from "./feed";
import { readLaunch, readLaunches, type LaunchRecord } from "./launched";
import { readLiveMarket, type LiveMarket } from "./onchain";

/** Where a market is in its life. Drives which figures a page can show at all. */
export type MarketPhase =
  /** Built and cleared, not deployed. Mechanics are real; there is no price. */
  | "ready"
  /** Deployed and trading. */
  | "live";

/**
 * The numbers a launchpad shows, when there are any.
 *
 * Absent rather than zeroed. Zero is a measurement — "nobody has traded this" — and
 * showing it for a market that has no pool at all would be a different lie from the
 * placeholder one, not an improvement on it. Fields inside are `null` for the same
 * reason at one level down: a market can have a price and no volume, and it says so.
 *
 * ## Everything here is in the quote asset, not dollars
 *
 * Which is ether, on this chain, for every market Agen creates. There is no oracle on
 * 4663 that this repository trusts for an ether price, and inventing a dollar figure
 * from an off-chain quote would make every number on the site depend on an unverified
 * third party — for the sole benefit of a familiar currency symbol. So a market worth
 * twelve ether says twelve ether.
 */
export interface TradingData {
  /** Quote asset per whole token, at the block this was read. */
  readonly price: number;
  /** Supply times price, in the quote asset. */
  readonly marketCap: number;
  /** The pool's own depth, in the quote asset. */
  readonly liquidity: number;
  /** Null until the indexer has a day of history for this market. */
  readonly volume24h: number | null;
  readonly trades24h: number | null;
  readonly change24hPercent: number | null;
  readonly holders: number | null;
}

export interface MarketSummary {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  /** Unix seconds. The build's creation, until a deployment supersedes it. */
  readonly createdAt: number;
  /** Null until a wallet is connected to a launch; builds have no signer today. */
  readonly creator: string | null;
  /** Null until the market is deployed and its bundle mined. */
  readonly hookAddress: string | null;
  readonly tokenAddress: string | null;
  readonly phase: MarketPhase;
  readonly mechanics: MechanicSummary;
  readonly contractCount: number;
  /**
   * Whole tokens, fixed for the life of the market — a generated token has no mint
   * function. Zero for a build that has not been launched and so has no supply yet.
   *
   * Carried because it is what turns a price into a capitalisation, and the chart needs
   * that multiplier on the client where the price per token is unreadable.
   */
  readonly supplyTokens: number;
  /** Absent for anything not trading. See the note at the top of this file. */
  readonly trading?: TradingData;
}

export interface MarketDetail extends MarketSummary {
  /** The pool, once there is one. What the trade panel quotes and swaps against. */
  readonly poolId?: string;
  /** The fee the pool was created with: the dynamic flag, or a fixed value. */
  readonly lpFee?: number;
  /** The pool's price as a string, because a `bigint` cannot cross into a client component. */
  readonly sqrtPriceX96?: string;
  readonly specification: MarketSpecification;
  readonly sources: readonly { readonly path: string; readonly content: string }[];
  readonly testOutcomes: readonly TestOutcome[];
  readonly gateFindings: readonly GateFinding[];
  readonly components: readonly {
    readonly name: string;
    readonly role: string;
    readonly purpose: string;
    readonly address: string | null;
  }[];
}

// --- enriched trades -------------------------------------------------------

/**
 * A trade, and what the market's own rules did to it.
 *
 * The reason this type exists before anything can populate it: an ordinary swap feed
 * is a solved problem and says nothing about Agen. The interesting line is not
 * "0x123 sold $1,200" but "0x123 sold $1,200 — extra fee 2%, $24 to the buyback
 * reserve", and that second half only exists if the hook's effects are captured
 * alongside the swap.
 *
 * `effects` is a list rather than fields because which effects a trade can have is a
 * property of the market, not of the schema — a market with a leaderboard produces a
 * "new leader" effect that no other market can.
 */
export interface TradeEffect {
  /** Matches the specification's effect vocabulary: `extraFee`, `routeFee`, … */
  readonly kind: string;
  /** Which rule produced it, so the page can link back to the rule that explains it. */
  readonly ruleId: string;
  /** Already rendered: "extra fee 2%", "consecutive buys 8 of 10". */
  readonly label: string;
  /** The quote-asset amount this effect moved, where it moved one. */
  readonly amountUsd?: number;
}

export interface EnrichedTrade {
  readonly id: string;
  readonly at: number;
  readonly trader: string;
  readonly side: "buy" | "sell";
  readonly amountUsd: number;
  readonly txHash: string;
  /** The fee actually charged, which a rule may have changed from the base. */
  readonly feePpm: number;
  readonly effects: readonly TradeEffect[];
}

/** A live reading of one declared state variable. */
export interface StateReading {
  readonly name: string;
  readonly value: string | number | boolean | null;
}

// --- the source ------------------------------------------------------------

/**
 * Where markets come from.
 *
 * An interface with one implementation, which is worth it here rather than premature:
 * the implementation reads finished builds off disk, and the one that replaces it will
 * read `AgenMarketRegistry` through the indexer. Naming the seam now means the pages
 * are written against the shape they will keep.
 */
export interface MarketSource {
  list(): Promise<readonly MarketSummary[]>;
  read(id: string): Promise<MarketDetail | null>;
  /** Empty until markets trade. Never fabricated. */
  trades(id: string): Promise<readonly EnrichedTrade[]>;
  /** Empty until a deployed hook can be read. Never fabricated. */
  state(id: string): Promise<readonly StateReading[]>;
}

/**
 * A build, plus whatever the chain says about it.
 *
 * The build is the source of everything a market *is* — its rules, its contracts, its
 * tests — and the chain is the source of everything it is *worth*. Neither can answer
 * the other's questions, so a market is the two joined, and `live` being absent is the
 * ordinary case rather than an error: most builds are never launched.
 */
function summaryFrom(
  job: ReturnType<typeof publicView>,
  launch: LaunchRecord | null,
  live: LiveMarket | null,
  stats: MarketStats | null = null,
): MarketSummary | null {
  // A market is a build that was cleared. Anything else is somebody's abandoned
  // attempt, and a discovery page listing those would be listing failures as products.
  if (job.stage !== "deployment_ready" || job.specification === null) return null;

  const supply = job.launch === null ? 0 : Number(job.launch.supplyTokens);

  return {
    id: job.id,
    name: job.name,
    symbol: job.symbol,
    // The launch supersedes the build's own age once there is one: a market's age is
    // how long it has been tradable, not how long ago somebody described it.
    createdAt: live?.createdAt ?? launch?.at ?? job.createdAt,
    creator: live?.creator ?? launch?.creator ?? null,
    hookAddress: live?.hook ?? launch?.hook ?? null,
    tokenAddress: live?.token ?? launch?.token ?? null,
    phase: live === null ? "ready" : "live",
    mechanics: mechanicSummary(job.specification),
    contractCount: job.plan?.components.length ?? job.sources.length,
    supplyTokens: supply,
    ...(live === null
      ? {}
      : {
          trading: {
            price: live.price,
            marketCap: supply * live.price,
            liquidity: Number(live.liquidity) / 1e18,
            // From the indexer, which is the only thing that can answer them: a pool
            // knows its price now and has no memory of yesterday. Null rather than zero
            // whenever there is no indexer to ask — see `lib/feed.ts` for why the
            // difference matters.
            volume24h: stats === null ? null : Number(stats.day.volumeQuote) / 1e18,
            trades24h: stats?.day.trades ?? null,
            change24hPercent: stats?.day.changePercent ?? null,
            // Agen's indexer does not follow token transfers, so nothing here has
            // counted holders. A dash rather than a number nobody measured.
            holders: null,
          },
        }),
  };
}

/**
 * What the chain knows about a build, if anything.
 *
 * Two reads, and the second only when the first found something. The local record is a
 * cache of the launch transaction; the registry is the authority. Asking the registry
 * for a token the server has never seen launched would be a round trip per build on
 * every discovery page, so the cache decides whether to ask.
 */
async function chainStateFor(jobId: string): Promise<{
  launch: LaunchRecord | null;
  live: LiveMarket | null;
  stats: MarketStats | null;
}> {
  const launch = await readLaunch(jobId).catch(() => null);
  if (launch === null) return { launch: null, live: null, stats: null };

  const live = await readLiveMarket(launch.token as Address);

  // Only once there is a pool to ask about, and never fatal: the day's volume is worth
  // a request on a market page and worth nothing at all if it can take the page down.
  const stats = live === null ? null : await fetchMarketStats(live.poolId);

  return { launch, live, stats };
}

/**
 * Markets from the local build store.
 *
 * Everything it returns is real. What it cannot return — prices, trades, live state —
 * it returns empty rather than inventing, and the pages render that absence as an
 * absence.
 */
export function buildStoreSource(): MarketSource {
  return {
    list: async () => {
      const jobs = await jobStore()
        .list(200)
        .catch(() => []);

      // The launched ones are read from disk in one directory listing rather than one
      // stat per build, because a discovery page holds two hundred of them and only a
      // handful will ever have been launched.
      const launches = new Map(
        (await readLaunches().catch(() => [])).map((record) => [record.jobId, record]),
      );

      const summaries = await Promise.all(
        jobs.map(async (job) => {
          const launch = launches.get(job.id) ?? null;
          const live = launch === null ? null : await readLiveMarket(launch.token as Address);
          return summaryFrom(publicView(job), launch, live);
        }),
      );

      return summaries.filter((market): market is MarketSummary => market !== null);
    },

    read: async (id) => {
      const job = await jobStore()
        .read(id)
        .catch(() => null);
      if (job === null) return null;

      const view = publicView(job);
      const { launch, live, stats } = await chainStateFor(id);
      const summary = summaryFrom(view, launch, live, stats);
      if (summary === null || view.specification === null) return null;

      return {
        ...summary,
        specification: view.specification,
        sources: view.sources,
        testOutcomes: view.testOutcomes,
        gateFindings: view.gateFindings,
        components: (view.plan?.components ?? []).map((component) => ({
          name: component.contractName,
          role: component.role,
          purpose: component.purpose,
          address: null,
        })),
        ...(live === null
          ? {}
          : { poolId: live.poolId, lpFee: live.lpFee, sqrtPriceX96: live.sqrtPriceX96.toString() }),
      };
    },

    // Both empty, and both deliberately not stubbed with samples. A sample trade is
    // indistinguishable from a real one once it is on the page.
    trades: async () => [],
    state: async () => [],
  };
}

// --- shelves ---------------------------------------------------------------

export type ShelfKey = "trending" | "new" | "volume" | "unique" | "generated";

export interface Shelf {
  readonly key: ShelfKey;
  readonly title: string;
  readonly markets: readonly MarketSummary[];
  /**
   * Why this shelf is empty, when it is.
   *
   * A shelf that cannot be populated yet says so in its own words rather than showing
   * "no results", which reads as "nothing qualified" when the truth is "this cannot be
   * computed yet".
   */
  readonly unavailable?: string;
}

const NOT_TRADING = "No Agen market is trading yet, so there is nothing to rank.";

/**
 * The discovery shelves.
 *
 * Three of the five need trading data and honestly report that they cannot be built.
 * The two that do not — the newest markets, and the ones with the most unusual
 * mechanics — are computed from real specifications and are the shelves that make Agen
 * different from a price list anyway.
 */
export function shelvesFor(markets: readonly MarketSummary[]): readonly Shelf[] {
  const byAge = [...markets].sort((left, right) => right.createdAt - left.createdAt);

  const byNovelty = [...markets].sort(
    (left, right) => right.mechanics.noveltyScore - left.mechanics.noveltyScore,
  );

  return [
    { key: "trending", title: "Trending", markets: [], unavailable: NOT_TRADING },
    { key: "new", title: "New", markets: byAge.slice(0, 12) },
    { key: "volume", title: "Top volume", markets: [], unavailable: NOT_TRADING },
    { key: "unique", title: "Most unique", markets: byNovelty.slice(0, 12) },
    { key: "generated", title: "Recently generated", markets: byAge.slice(0, 12) },
  ];
}
