/**
 * Reading a market.
 *
 * Everything an interface shows about a Verdant market comes from here, and the
 * shape of this file follows three rules that are worth stating before the code.
 *
 * ## Chain time, never wall-clock time
 *
 * Every fee, stage and countdown is a function of `block.timestamp`, and on an
 * Arbitrum Orbit chain that is not the reader's clock — the sequencer's notion of
 * time can sit a little behind or ahead of it, and `block.number` on this chain is
 * the *L1* block number, so it is not a clock at all (V6, V7 in
 * docs/verification.md). A countdown anchored to `Date.now()` would be wrong by
 * that drift and would be wrong at the moment it matters most, which is the second
 * a fee changes. So a snapshot carries the timestamp of the block it was read at,
 * and the interface advances its own clock from that anchor.
 *
 * ## Derived values are computed here, from the same code the contracts run
 *
 * The active fee, the stage index and the time to the next transition are not read
 * from the chain one by one; they are computed by `../models/schedule.js`, which is
 * the twin of `ScheduleLib.sol` and is held to it by shared vectors. That is what
 * makes the fee a user is shown and the fee a swap charges the same number by
 * construction rather than by coincidence — and `readHookFee` exists so a test can
 * demand the chain confirm it.
 *
 * ## A pool is not derivable from a token
 *
 * It used to be: every market was quoted in ether, so `poolIdFor(token, hook)` was
 * a complete answer and a token address was as good as a pool id. Markets quoted in
 * an equity ended that — the quote asset is the pool key's other currency, it is
 * the creator's choice, and nothing about the token discloses it. `MarketRegistry`
 * records it for exactly this reason, so every key and id below is built from
 * `MarketRecord.quoteAsset` and never from a default. A default would be the worst
 * available failure: it produces a valid pool id for a pool that does not exist, so
 * an equity-quoted market would render as a market with no price and no trades
 * rather than as an error.
 */

import type { Address, Hex, PublicClient } from "viem";

import {
  marketRegistryAbi,
  verdantHookAbi,
  verdantTokenAbi,
} from "../abi/index.js";
import type { ScheduleConfig, Stage } from "../models/schedule.js";
import {
  feeAt,
  nextTransition,
  secondsUntilNextTransition,
  stageAt,
} from "../models/schedule.js";
import type { PoolKey } from "./pool.js";
import { poolKeyFor } from "./pool.js";

/**
 * The deployed contracts a read needs.
 *
 * A parameter rather than an import from `@verdant/config`'s `DEPLOYMENTS`, so the
 * same functions work against a fork or a fresh anvil deployment. The interface
 * passes the configured deployment; the integration tests pass whatever they just
 * deployed.
 */
export interface VerdantAddresses {
  readonly hook: Address;
  readonly marketRegistry: Address;
}

/** A market as the registry recorded it at creation. Every field is a snapshot. */
export interface MarketRecord {
  readonly poolId: Hex;
  readonly token: Address;
  /**
   * The pool's `currency0`: what this market is priced and traded in. The zero
   * address is native ether, and it is left as the zero address rather than mapped
   * to `undefined` — unlike `vesting` below — because that is the value the pool
   * key carries and a caller building one needs it verbatim.
   */
  readonly quoteAsset: Address;
  readonly creator: Address;
  readonly model: number;
  readonly createdAt: number;
  /** The fee shares in force when this market was created, not current settings. */
  readonly creatorBps: number;
  readonly protocolBps: number;
  readonly reserveBps: number;
  readonly positionTokenId: bigint;
  readonly locker: Address;
  readonly splitter: Address;
  /** `undefined` where the creator configured no vesting. */
  readonly vesting: Address | undefined;
}

export interface TokenInfo {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly totalSupply: bigint;
  readonly metadataURI: string;
  readonly metadataMutable: boolean;
}

/**
 * A market at one instant, with everything derived from that instant stated
 * explicitly rather than left to the caller to recompute.
 */
export interface MarketSnapshot {
  readonly market: MarketRecord;
  readonly token: TokenInfo;
  /** Model, pool init time and the whole fee ladder, from the hook. */
  readonly schedule: ScheduleConfig;
  /** The chain's timestamp at the block this was read at. Seconds. */
  readonly at: number;
  /** The fee in force at `at`, in ppm. 10 000 is 1%. */
  readonly feePpm: number;
  readonly stageIndex: number;
  readonly stageCount: number;
  /** Absolute timestamp of the next fee change, or `undefined` if this is the last stage. */
  readonly nextTransitionAt: number | undefined;
  /** Seconds from `at` to that change. Never negative, `undefined` on the last stage. */
  readonly secondsToNextTransition: number | undefined;
}

/** Either way of naming a market. A pool id is exact; a token needs a lookup. */
export type MarketIdentifier =
  | { readonly poolId: Hex }
  | { readonly token: Address };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Raw `MarketRegistry.Market`, as viem decodes the struct. */
interface RawMarket {
  readonly poolId: Hex;
  readonly token: Address;
  readonly quoteAsset: Address;
  readonly creator: Address;
  readonly model: number;
  readonly createdAt: number;
  readonly creatorBps: number;
  readonly protocolBps: number;
  readonly reserveBps: number;
  readonly positionTokenId: bigint;
  readonly locker: Address;
  readonly splitter: Address;
  readonly vesting: Address;
}

/**
 * Reads a batch of `Market` structs out of a multicall result.
 *
 * The cast is unavoidable and the reason is worth recording: viem infers a
 * multicall's return types from a *literal* array of calls, and both callers below
 * build their call list with `.map`, so the inference collapses to the union of
 * everything the ABI could return. Naming the shape back is the only option short
 * of one round trip per market, which is the thing multicall exists to avoid.
 *
 * So the cast is made falsifiable instead of trusted: the first element is checked
 * for the field every `Market` has. A wrong shape then fails here, with a message,
 * rather than surfacing later as a market whose every field is `undefined`.
 */
function asMarkets(results: readonly unknown[]): readonly RawMarket[] {
  const first = results[0];
  if (
    results.length > 0 &&
    (typeof first !== "object" || first === null || !("poolId" in first))
  ) {
    throw new Error(
      "marketRegistry returned something that is not a Market struct; " +
        "the ABI in @verdant/sdk is out of date with the deployed contract",
    );
  }
  return results as readonly RawMarket[];
}

function toRecord(raw: RawMarket): MarketRecord {
  return {
    poolId: raw.poolId,
    token: raw.token,
    quoteAsset: raw.quoteAsset,
    creator: raw.creator,
    model: raw.model,
    createdAt: raw.createdAt,
    creatorBps: raw.creatorBps,
    protocolBps: raw.protocolBps,
    reserveBps: raw.reserveBps,
    positionTokenId: raw.positionTokenId,
    locker: raw.locker,
    splitter: raw.splitter,
    // The contract's "no vesting" is the zero address; `undefined` here so a
    // caller that forgets the case gets a type error rather than rendering a
    // link to address zero.
    vesting: raw.vesting === ZERO_ADDRESS ? undefined : raw.vesting,
  };
}

/**
 * The pool key of a market that has already been read.
 *
 * The composition every caller with a `MarketRecord` wants, given here so that
 * nobody has to remember which of the record's two addresses is `currency0`. The
 * quoter and the swap builder both take a key, and this is where they should get
 * it from.
 */
export function poolKeyOf(market: MarketRecord, hook: Address): PoolKey {
  return poolKeyFor(market.quoteAsset, market.token, hook);
}

/**
 * How many markets exist. Also the upper bound for `readMarketPage`.
 */
export async function readMarketCount(
  client: PublicClient,
  addresses: VerdantAddresses,
): Promise<number> {
  const count = await client.readContract({
    address: addresses.marketRegistry,
    abi: marketRegistryAbi,
    functionName: "marketCount",
  });
  return Number(count);
}

/**
 * A page of markets in creation order, newest first.
 *
 * Newest first because that is what every listing wants and because the registry
 * is append-only, which makes "newest" a slice from the end rather than a sort.
 * The registry's own order is insertion order and is never rewritten, so a page
 * boundary is stable — a market created between two requests shifts the window by
 * one rather than reshuffling it.
 *
 * This exists for the case where there is no indexer: it is correct, and it costs
 * one multicall per page. It is not a substitute for the indexer, which is what
 * makes searching, sorting by activity and price history possible at all.
 */
export async function readMarketPage(
  client: PublicClient,
  addresses: VerdantAddresses,
  options: { readonly offset?: number; readonly limit?: number } = {},
): Promise<readonly MarketRecord[]> {
  const { offset = 0, limit = 20 } = options;
  const count = await readMarketCount(client, addresses);

  // Newest first: index count-1-offset downwards. Clamped rather than throwing,
  // so a page past the end is empty instead of an error — pagination that runs
  // off the end is normal, not exceptional.
  const highest = count - 1 - offset;
  if (highest < 0 || limit <= 0) return [];

  const indices: bigint[] = [];
  for (let i = highest; i > highest - limit && i >= 0; i--) {
    indices.push(BigInt(i));
  }

  const markets = await client.multicall({
    allowFailure: false,
    contracts: indices.map((index) => ({
      address: addresses.marketRegistry,
      abi: marketRegistryAbi,
      functionName: "marketAt",
      args: [index],
    })),
  });

  return asMarkets(markets).map(toRecord);
}

/** Every market a creator has launched, newest first. */
export async function readMarketsByCreator(
  client: PublicClient,
  addresses: VerdantAddresses,
  creator: Address,
): Promise<readonly MarketRecord[]> {
  const poolIds = await client.readContract({
    address: addresses.marketRegistry,
    abi: marketRegistryAbi,
    functionName: "marketsByCreator",
    args: [creator],
  });

  if (poolIds.length === 0) return [];

  const markets = await client.multicall({
    allowFailure: false,
    contracts: [...poolIds].reverse().map((poolId) => ({
      address: addresses.marketRegistry,
      abi: marketRegistryAbi,
      functionName: "marketOf",
      args: [poolId],
    })),
  });

  return asMarkets(markets).map(toRecord);
}

/**
 * One market's registry record, by pool id or by token.
 *
 * The registry answers both questions, which is why neither branch computes a pool
 * id: `marketByToken` is the only thing that knows what a token is quoted in, and
 * `marketOf` has already been given the id. Both revert on an unknown market rather
 * than returning a zeroed struct, so a caller cannot mistake absence for a market
 * whose every field is zero.
 */
export async function readMarketRecord(
  client: PublicClient,
  addresses: VerdantAddresses,
  identifier: MarketIdentifier,
): Promise<MarketRecord> {
  const raw =
    "poolId" in identifier
      ? await client.readContract({
          address: addresses.marketRegistry,
          abi: marketRegistryAbi,
          functionName: "marketOf",
          args: [identifier.poolId],
        })
      : await client.readContract({
          address: addresses.marketRegistry,
          abi: marketRegistryAbi,
          functionName: "marketByToken",
          args: [identifier.token],
        });

  return toRecord(raw as RawMarket);
}

/**
 * Everything about one market, at one block.
 *
 * Two layers of requests: the record, and then everything that depends on it. The
 * record has to come first because it carries the pool id a token alone does not
 * determine; the three reads after it — the block's time, the hook's schedule and
 * the token's own disclosures — are independent of each other and issued together,
 * the last of them as one multicall.
 *
 * They are not atomic with each other, which is worth being precise about: each
 * multicall is consistent within itself, and the timestamp could in principle come
 * from a block one later. The consequence is bounded and harmless — a countdown one
 * block stale — whereas the alternative, using the reader's own clock, is unbounded
 * and wrong in a way that no amount of retrying fixes.
 */
export async function readMarket(
  client: PublicClient,
  addresses: VerdantAddresses,
  identifier: MarketIdentifier,
): Promise<MarketSnapshot> {
  const market = await readMarketRecord(client, addresses, identifier);

  const [block, config, token] = await Promise.all([
    client.getBlock(),
    client.readContract({
      address: addresses.hook,
      abi: verdantHookAbi,
      functionName: "configOf",
      args: [market.poolId],
    }),
    readToken(client, market.token),
  ]);

  const [model, initTime, stages] = config as readonly [
    number,
    number,
    readonly Stage[],
  ];

  const schedule: ScheduleConfig = {
    model,
    initTime,
    // The hook returns `uint40`/`uint28` values, which viem gives as numbers
    // small enough to be exact. Copied into plain objects so the snapshot does
    // not hand out viem's decoded arrays.
    stages: stages.map((stage) => ({
      startOffset: Number(stage.startOffset),
      feePpm: Number(stage.feePpm),
    })),
  };

  const at = Number(block.timestamp);

  return {
    market,
    token,
    schedule,
    at,
    feePpm: feeAt(schedule, at),
    stageIndex: stageAt(schedule, at),
    stageCount: schedule.stages.length,
    nextTransitionAt: nextTransition(schedule, at),
    secondsToNextTransition: secondsUntilNextTransition(schedule, at),
  };
}

/** A market's token: its name, its supply, and what it discloses about itself. */
export async function readToken(
  client: PublicClient,
  token: Address,
): Promise<TokenInfo> {
  const [name, symbol, decimals, totalSupply, metadataURI, metadataMutable] =
    await client.multicall({
      allowFailure: false,
      contracts: [
        { address: token, abi: verdantTokenAbi, functionName: "name" },
        { address: token, abi: verdantTokenAbi, functionName: "symbol" },
        { address: token, abi: verdantTokenAbi, functionName: "decimals" },
        { address: token, abi: verdantTokenAbi, functionName: "totalSupply" },
        { address: token, abi: verdantTokenAbi, functionName: "metadataURI" },
        {
          address: token,
          abi: verdantTokenAbi,
          functionName: "metadataMutable",
        },
      ],
    });

  return {
    name: name as string,
    symbol: symbol as string,
    decimals: Number(decimals),
    totalSupply: totalSupply as bigint,
    metadataURI: metadataURI as string,
    metadataMutable: metadataMutable as boolean,
  };
}

/**
 * The fee the hook itself reports for a timestamp.
 *
 * Not used to render anything — a snapshot's `feePpm` is computed locally, because
 * a countdown needs the whole schedule anyway and one round trip per second is not
 * a design. This exists so that a test can put the question to the chain and
 * demand the same answer, which is the property that makes computing locally safe
 * rather than merely fast.
 */
export async function readHookFee(
  client: PublicClient,
  addresses: VerdantAddresses,
  poolId: Hex,
  timestamp: number,
): Promise<number> {
  const fee = await client.readContract({
    address: addresses.hook,
    abi: verdantHookAbi,
    functionName: "feeAt",
    args: [poolId, BigInt(timestamp)],
  });
  return Number(fee);
}
