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
import { INSTANT_ADDRESSES } from "./chain";
import { fetchMarketStats, type MarketStats } from "./feed";
import { fetchInstantStats, fetchInstantTrades } from "./instant-feed";
import { readInstantMarket, readInstantMarkets, type InstantMarket } from "./instant-markets";
import { readLaunch, readLaunches, type LaunchRecord } from "./launched";
import { readLiveMarket, type LiveMarket } from "./onchain";

/** Where a market is in its life. Drives which figures a page can show at all. */
export type MarketPhase =
  /** Built and cleared, not deployed. Mechanics are real; there is no price. */
  | "ready"
  /** Deployed and trading. */
  | "live";

/**
 * Which of Agen's two products made this market.
 *
 * They are genuinely different objects rather than one object with a flag, and the
 * difference is what a page is allowed to say about them:
 *
 *  - **`programmable`** — described in language, compiled into a hook, and carrying a
 *    specification. It has rules, declared state a page can read back, generated
 *    contracts and test results. "How this token works" is the whole point of it.
 *  - **`instant`** — a fixed supply into one locked position at a fixed opening
 *    valuation, under a shared hook at a fixed 1.50%. It has no specification, no
 *    declared state and no rules beyond the fee, so a page that offered to explain its
 *    mechanics would be padding an empty section to keep two layouts symmetrical.
 *
 * This is the discriminator ADR-014 asks consumers to branch on. In particular it is what
 * they should read instead of a registry's `creatorBps` and `protocolBps`, which are zero
 * on an Instant row on purpose: 1.00% and 0.50% of a 1.50% fee are two thirds and one
 * third, and one third is not a whole number of basis points. `InstantFees` is the
 * authority for an Instant market's fee and this field is how a page knows to ask it.
 */
export type MarketKind = "programmable" | "instant";

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

/** Everything true of a market whichever product made it. Not used directly; see below. */
export interface MarketCommon {
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
  /**
   * One line saying what this token is, whatever produced it.
   *
   * On the common shape rather than on each branch because every consumer that reads it —
   * the search on two pages, the row, the card, the page's meta description — wants the
   * sentence and does not care which product wrote it. For a programmable market it is
   * derived from the compiled specification; for an Instant one it is what the creator
   * typed into the form.
   */
  readonly headline: string;
  /**
   * The creator's picture, absolute, or null.
   *
   * Instant asks for one and will not launch without it. The programmable flow does not
   * ask, and draws the token's machine instead — so this is null for every build and the
   * card branches on `kind` rather than on this being absent.
   */
  readonly image: string | null;
  /**
   * Whole tokens, fixed for the life of the market — neither product's token has a mint
   * function. Zero for a build that has not been launched and so has no supply yet.
   *
   * Carried because it is what turns a price into a capitalisation, and the chart needs
   * that multiplier on the client where the price per token is unreadable.
   */
  readonly supplyTokens: number;
  /** Absent for anything not trading. See the note at the top of this file. */
  readonly trading?: TradingData;
}

/** A market that was described in language and compiled into a hook. */
export interface ProgrammableSummary extends MarketCommon {
  readonly kind: "programmable";
  readonly mechanics: MechanicSummary;
  readonly contractCount: number;
}

/** A market that took the standard shape: fixed supply, fixed opening, fixed fee. */
export interface InstantSummary extends MarketCommon {
  readonly kind: "instant";
}

export type MarketSummary = ProgrammableSummary | InstantSummary;

/** What both kinds gain once they have a pool. */
interface Tradable {
  /** The pool, once there is one. What the trade panel quotes and swaps against. */
  readonly poolId?: string;
  /** The fee the pool was created with: the dynamic flag, or a fixed value. */
  readonly lpFee?: number;
  /** The pool's price as a string, because a `bigint` cannot cross into a client component. */
  readonly sqrtPriceX96?: string;
}

export interface ProgrammableDetail extends ProgrammableSummary, Tradable {
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

export interface InstantDetail extends InstantSummary, Tradable {
  /** The creator's own accounts, from the token's metadata document. */
  readonly links: {
    readonly x?: string;
    readonly website?: string;
    readonly telegram?: string;
  };
  /** The `InstantFeeVault` the creator's ether fees accrue in. */
  readonly vault: string | null;
}

/**
 * A market, of either kind.
 *
 * A union rather than one interface with optional halves, and the difference is not
 * stylistic: a programmable market's specification, sources, tests and findings are not
 * "missing" on an Instant market, they are meaningless on one. With a union, a page that
 * reads `market.specification` without checking `kind` does not compile — which is what
 * stops "How this token works" reappearing on Instant the next time somebody edits this.
 */
export type MarketDetail = ProgrammableDetail | InstantDetail;

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
  /**
   * The ether the trade moved, for markets quoted in it.
   *
   * Added for Instant and optional so that nothing about a programmable trade changes:
   * `amountUsd` above is what that path has always carried and still carries. An Instant
   * trade sets this instead, because it is denominated in ether and rendering it through
   * a dollar formatter would put a `$` in front of a quantity of ETH.
   */
  readonly amountEth?: number;
  /**
   * Whole tokens the trade moved. Present alongside `amountEth`.
   */
  readonly tokens?: number;
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
 * Two implementations now — builds off disk, and the Instant registry on chain — and
 * `marketSource()` below is the one the pages use, which is the two joined. The seam
 * exists so that when the indexer answers these questions instead, the pages do not
 * change.
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
): ProgrammableSummary | null {
  // A market is a build that was cleared. Anything else is somebody's abandoned
  // attempt, and a discovery page listing those would be listing failures as products.
  if (job.stage !== "deployment_ready" || job.specification === null) return null;

  const supply = job.launch === null ? 0 : Number(job.launch.supplyTokens);
  const mechanics = mechanicSummary(job.specification);

  return {
    id: job.id,
    // Everything this module can see came out of the compiler. An Instant market is not
    // built, so it has no job, and no read here will ever produce one.
    kind: "programmable",
    name: job.name,
    symbol: job.symbol,
    // The launch supersedes the build's own age once there is one: a market's age is
    // how long it has been tradable, not how long ago somebody described it.
    createdAt: live?.createdAt ?? launch?.at ?? job.createdAt,
    creator: live?.creator ?? launch?.creator ?? null,
    hookAddress: live?.hook ?? launch?.hook ?? null,
    tokenAddress: live?.token ?? launch?.token ?? null,
    phase: live === null ? "ready" : "live",
    mechanics,
    headline: mechanics.headline,
    // The programmable flow never asks for one; the card draws the token's machine.
    image: null,
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

      return summaries.filter((market): market is ProgrammableSummary => market !== null);
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

// --- instant ---------------------------------------------------------------

/**
 * An Instant market, in the shape the pages read.
 *
 * Every field comes from the chain or from the document the token points at. There is no
 * `phase`: an Instant market is created and its pool is opened in the same transaction,
 * so unlike a build it cannot exist and not be trading.
 */
function instantSummaryFrom(market: InstantMarket, stats: MarketStats | null): InstantSummary {
  return {
    id: market.token.toLowerCase(),
    kind: "instant",
    name: market.name,
    symbol: market.symbol,
    createdAt: market.createdAt,
    creator: market.creator,
    hookAddress: INSTANT_ADDRESSES?.hook ?? null,
    tokenAddress: market.token,
    phase: "live",
    headline: market.metadata.description,
    image: market.metadata.image,
    supplyTokens: market.supplyTokens,
    trading: {
      price: market.price,
      marketCap: market.supplyTokens * market.price,
      liquidity: Number(market.liquidity) / 1e18,
      volume24h: stats === null ? null : Number(stats.day.volumeQuote) / 1e18,
      trades24h: stats?.day.trades ?? null,
      change24hPercent: stats?.day.changePercent ?? null,
      holders: null,
    },
  };
}

function instantDetailFrom(market: InstantMarket, stats: MarketStats | null): InstantDetail {
  return {
    ...instantSummaryFrom(market, stats),
    poolId: market.poolId,
    lpFee: market.lpFee,
    sqrtPriceX96: market.sqrtPriceX96.toString(),
    links: market.metadata.links,
    vault: market.vault,
  };
}

/**
 * Which kind of market an id names.
 *
 * A build id is the uuid the server generated for a job. An Instant market has no build
 * and so no uuid; it is addressed by its token, which is the identifier a buyer already
 * has and the one that appears in a wallet, an explorer and a link somebody was sent.
 *
 * Distinguishing them by shape rather than by a prefix or a second route: the two
 * alphabets do not overlap — a uuid is 36 characters with dashes, an address is `0x` and
 * forty hex digits — so one route serves both and no existing link changes.
 */
function looksLikeAddress(id: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(id);
}

/** Markets created through `InstantFactory`, read from its registry. */
export function instantSource(): MarketSource {
  return {
    list: async () => {
      const found = await readInstantMarkets();

      return Promise.all(
        found.map(async (market) =>
          instantSummaryFrom(market, await fetchInstantStats(market.poolId)),
        ),
      );
    },

    read: async (id) => {
      if (!looksLikeAddress(id)) return null;

      const market = await readInstantMarket(id);
      if (market === null) return null;

      return instantDetailFrom(market, await fetchInstantStats(market.poolId));
    },

    /**
     * Real trades, from Instant's own feed.
     *
     * Addressed by token, which the indexer's route accepts as readily as a pool id — so
     * this needs no second read to turn the id in the URL into the id the feed keys on.
     *
     * `effects` is empty and will stay empty. It exists for a programmable market's rules
     * firing, and an Instant market has one rule: 1.50% of the ether leg, every trade,
     * forever. There is nothing per-trade to report.
     */
    trades: async (id) => {
      if (!looksLikeAddress(id)) return [];

      const found = await fetchInstantTrades(id);

      return found.map((trade) => ({
        id: trade.id,
        at: trade.at,
        trader: trade.sender,
        side: trade.side,
        // Zero rather than a converted figure: nothing here knows an ether price, and
        // `amountEth` below is the amount this trade actually moved.
        amountUsd: 0,
        amountEth: trade.ether,
        tokens: trade.tokens,
        txHash: trade.txHash,
        // What v4 reported, which the hook overrode to zero. The page states the real
        // 1.50% from `InstantFees` rather than pretending to read it per trade.
        feePpm: 0,
        effects: [],
      }));
    },

    state: async () => [],
  };
}

/**
 * Both products, behind one interface.
 *
 * The pages read this rather than either half, so a token page, a card and a search all
 * work the same whichever product made the market. `read` dispatches on the shape of the
 * id and asks exactly one source; `list` asks both and merges, newest first.
 *
 * Neither half can take the other down. A build store that cannot be read and a chain
 * that will not answer both degrade to an empty list, because a catalogue missing half of
 * itself is better than a catalogue that 500s — and on a deployment with no Instant
 * contracts configured, the Instant half is *always* empty and that is not an error.
 */
export function marketSource(): MarketSource {
  const builds = buildStoreSource();
  const instant = instantSource();

  return {
    list: async () => {
      const [fromBuilds, fromChain] = await Promise.all([
        builds.list().catch(() => [] as readonly MarketSummary[]),
        instant.list().catch(() => [] as readonly MarketSummary[]),
      ]);

      return [...fromChain, ...fromBuilds].sort((left, right) => right.createdAt - left.createdAt);
    },

    read: async (id) =>
      looksLikeAddress(id)
        ? await instant.read(id).catch(() => null)
        : await builds.read(id).catch(() => null),

    trades: async (id) => (looksLikeAddress(id) ? instant.trades(id) : builds.trades(id)),
    state: async (id) => (looksLikeAddress(id) ? instant.state(id) : builds.state(id)),
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

/** How unusual a market's rules are, and zero for a market whose rules are the standard. */
export function noveltyOf(market: MarketSummary): number {
  return market.kind === "programmable" ? market.mechanics.noveltyScore : 0;
}

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

  // Instant markets have no novelty to score: every one is the same shape by design, and
  // the ranking is of compiled mechanics. They sort to the bottom rather than being
  // filtered, so the shelf is never shorter than it looks.
  const byNovelty = [...markets].sort((left, right) => noveltyOf(right) - noveltyOf(left));

  return [
    { key: "trending", title: "Trending", markets: [], unavailable: NOT_TRADING },
    { key: "new", title: "New", markets: byAge.slice(0, 12) },
    { key: "volume", title: "Top volume", markets: [], unavailable: NOT_TRADING },
    { key: "unique", title: "Most unique", markets: byNovelty.slice(0, 12) },
    { key: "generated", title: "Recently generated", markets: byAge.slice(0, 12) },
  ];
}
