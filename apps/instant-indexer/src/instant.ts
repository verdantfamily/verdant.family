/**
 * Instant markets, as the chain reports them.
 *
 * The indexing logic, unchanged from when it lived beside Verdant's and Agen's in the
 * shared indexer. What changed is the address space around it: this is now its own service
 * with its own database, so these tables cannot be confused with the Programmable ones and
 * a deploy of this cannot re-index those.
 *
 * ## Why the fee is not in the swap rows
 *
 * `InstantHook` overrides the pool's LP fee to zero on every swap and takes its 1.50%
 * from the ether leg instead, so the `fee` the PoolManager reports is zero and the fee a
 * trader actually paid appears nowhere in the `Swap` event. That is stored as observed
 * rather than corrected: the rate is a constant of the deployment — `InstantFees`, 1.50%
 * total — so any consumer that needs it knows it without this table guessing. See
 * ADR-014.
 */

import { ponder } from "ponder:registry";
import { boostBuyback, instantMarket, instantSwap, poolInit } from "ponder:schema";
import { eq } from "ponder";
import { abi } from "@verdant/sdk";
import { erc20Abi } from "viem";

ponder.on("InstantFactory:MarketCreated", async ({ event, context }) => {
  const poolId = event.args.poolId;
  const token = event.args.token;

  /**
   * The pool, opened seconds ago in this same transaction.
   *
   * `InstantFactory.create` initialises the pool and then emits this event, so the row is
   * always there. Its absence means the PoolManager being watched is not the one this
   * factory used, which would produce markets with no price and no fee — so it throws
   * rather than defaulting, because that state is indistinguishable from a working
   * indexer until somebody tries to trade.
   */
  const opened = await context.db.find(poolInit, { id: poolId });
  if (opened === null) {
    throw new Error(
      `Instant market ${poolId} has no Initialize event. The PoolManager address is ` +
        `wrong, in which case no Instant market will ever index correctly.`,
    );
  }

  /**
   * What the token calls itself, and where its document is.
   *
   * `metadataURI` is the whole of an Instant market's description: the picture, the text
   * and the creator's links are fields in a JSON document at that address, and the token
   * carries only the address. It is read here so a consumer has it without a second call,
   * and it is not followed here — fetching somebody's URL inside an indexing function
   * would make backfill depend on a web server being up.
   */
  const [name, symbol, decimals, totalSupply, metadataURI] = await Promise.all([
    context.client.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "name",
      cache: "immutable",
    }),
    context.client.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "symbol",
      cache: "immutable",
    }),
    context.client.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "decimals",
      cache: "immutable",
    }),
    context.client.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "totalSupply",
    }),
    context.client.readContract({
      abi: abi.verdantTokenAbi,
      address: token,
      functionName: "metadataURI",
      cache: "immutable",
    }),
  ]);

  await context.db.insert(instantMarket).values({
    id: poolId,
    token,
    // The shared hook, taken from the pool the factory opened rather than from
    // configuration, so this row describes the market that exists rather than the
    // deployment this indexer was pointed at.
    hook: opened.hooks,
    creator: event.args.creator,
    vault: event.args.vault,

    fee: opened.fee,
    tickSpacing: opened.tickSpacing,

    name,
    symbol,
    decimals,
    totalSupply,
    metadataURI,

    locker: event.args.locker,
    positionTokenId: event.args.positionTokenId,
    positionLiquidity: event.args.liquidity,

    createdAt: Number(event.block.timestamp),
    createdAtBlock: event.block.number,
    createdTx: event.transaction.hash,

    // The opening price, and the current one. They differ already if the creator bought
    // in the same transaction — Instant's first buy happens after this event — and the
    // swap handler moves the second while the first stays put.
    initialSqrtPriceX96: opened.sqrtPriceX96,
    initialTick: opened.tick,
    sqrtPriceX96: opened.sqrtPriceX96,
    tick: opened.tick,
    liquidity: 0n,

    swapCount: 0,
    volumeQuote: 0n,
    volumeToken: 0n,
    lastSwapAt: null,

    /*
     * Boost, unknown at creation and mostly never known.
     *
     * A market's escrow is not in `MarketCreated` — the event carries the vault, and the vault's
     * recipient is whatever the launch named. So this stays null until the escrow announces the
     * market itself, and for every market launched before Boost existed it stays null forever:
     * `InstantFeeVault.creator` is immutable, so those can never be Boosted and null is the
     * permanent, correct answer rather than a gap waiting to be filled.
     */
    boostEscrow: null,
    boostEnabled: false,
    boostLocked: false,
    boostSpentQuote: 0n,
    boostAgenRoutedQuote: 0n,
    boostAgenDonatedQuote: 0n,
    boostPlatformCaptured: false,
    boostVolumeQuote: 0n,
    boostVolumeToken: 0n,
    boostSunkToken: 0n,
    boostCount: 0,
    lastBoostAt: null,
  });
});

/**
 * A market attached itself to an escrow, which is what makes it Boost-capable in this feed.
 *
 * Emitted by the escrow rather than by the factory, because the escrow is what knows: enrolment
 * derives the vault from the registry and checks that the vault pays the escrow, so this event
 * is the chain's own confirmation that the two belong together.
 *
 * The market may not exist here yet in one ordering — an escrow enrolling a market indexed from
 * a later start block — so a missing row is skipped rather than thrown on. Boost cannot have
 * spent anything for a market this feed has never seen.
 */
ponder.on("BoostEscrow:MarketEnrolled", async ({ event, context }) => {
  const existing = await context.db.find(instantMarket, { id: event.args.poolId });
  if (existing === null) return;

  await context.db
    .update(instantMarket, { id: event.args.poolId })
    .set({ boostEscrow: event.log.address });
});

/** The switch was thrown. State only; no amounts move on a toggle that this feed records. */
ponder.on("BoostEscrow:BoostSet", async ({ event, context }) => {
  await updateByToken(context, event.args.token, () => ({ boostEnabled: event.args.enabled }));
});

ponder.on("BoostEscrow:BoostLocked", async ({ event, context }) => {
  await updateByToken(context, event.args.token, () => ({ boostEnabled: true, boostLocked: true }));
});

/**
 * Agen's own contribution, counted apart from the creator's fees.
 *
 * `fromAgen` is the escrow's own flag and the only thing that distinguishes the two, because
 * both end up in the same commitment. Recorded separately so an interface can never present a
 * platform top-up as part of what the creator gave up — the product does not claim Agen's 0.50%
 * is routed into Boost, and this column is what keeps that claim checkable.
 */
ponder.on("BoostEscrow:BoostFunded", async ({ event, context }) => {
  if (!event.args.fromAgen) return;

  // `BoostFunded(fromAgen: true)` is emitted for both a routed platform fee and a discretionary
  // contribution, so the routed total is taken from `PlatformFeeRouted` below and this counts the
  // difference. Subtracting there rather than adding here keeps each handler owning one number.
  await updateByToken(context, event.args.token, (row) => ({
    boostAgenDonatedQuote: row.boostAgenDonatedQuote + event.args.amount,
  }));
});

/**
 * Agen's 0.50%, routed into a market's buybacks by the fee architecture.
 *
 * The event that distinguishes the enforced half of Boost from a voluntary top-up. A market emitting
 * this is one whose Instant deployment pays its platform fee to a `BoostTreasury`, so it is also
 * where `boostPlatformCaptured` is learned — the launch event cannot carry it, because it depends on
 * the deployment rather than on the market.
 *
 * The donated total is corrected down by the same amount, because `BoostFunded` fires for this too.
 */
ponder.on("BoostEscrow:PlatformFeeRouted", async ({ event, context }) => {
  await updateByToken(context, event.args.token, (row) => ({
    boostAgenRoutedQuote: row.boostAgenRoutedQuote + event.args.amount,
    boostAgenDonatedQuote:
      row.boostAgenDonatedQuote > event.args.amount
        ? row.boostAgenDonatedQuote - event.args.amount
        : 0n,
    boostPlatformCaptured: true,
  }));
});

/**
 * One buyback, and the numbers that separate Boost volume from organic.
 *
 * The amounts come from the escrow rather than from the `Swap` this transaction also produced.
 * Matching the two would mean pairing events from two contracts on figures that legitimately
 * differ — the hook takes 1.50% off the ether leg between them — and a mismatch would silently
 * attribute a buyback to organic demand, which is the one error this table exists to prevent.
 */
ponder.on("BoostEscrow:BoostExecuted", async ({ event, context }) => {
  const market = await marketByToken(context, event.args.token);

  await context.db.insert(boostBuyback).values({
    id: `${event.transaction.hash}-${String(event.log.logIndex)}`,
    poolId: market?.id ?? null,
    token: event.args.token,
    escrow: event.log.address,
    caller: event.args.caller,
    etherSpent: event.args.etherSpent,
    tokensBought: event.args.tokensBought,
    tokensSunk: event.args.tokensSunk,
    cumulativeSunk: event.args.cumulativeSunk,
    remainingPending: event.args.remainingPending,
    timestamp: Number(event.block.timestamp),
    blockNumber: event.block.number,
    transactionHash: event.transaction.hash,
  });

  if (market === undefined || market === null) return;

  await context.db.update(instantMarket, { id: market.id }).set((row) => ({
    boostEscrow: row.boostEscrow ?? event.log.address,
    boostSpentQuote: row.boostSpentQuote + event.args.etherSpent,
    // The pool's own volume for this trade, so that subtracting it from `volumeQuote` leaves
    // what wallets other than the escrow spent.
    boostVolumeQuote: row.boostVolumeQuote + event.args.etherSpent,
    boostVolumeToken: row.boostVolumeToken + event.args.tokensBought,
    // The escrow's cumulative figure rather than a sum of ours, so a missed event shows up as a
    // discontinuity instead of a quietly low total.
    boostSunkToken: event.args.cumulativeSunk,
    boostCount: row.boostCount + 1,
    lastBoostAt: Number(event.block.timestamp),
  }));
});

/** Ponder's handler context, recovered from a handler's own signature. */
type BoostContext = Parameters<Parameters<typeof ponder.on<"BoostEscrow:BoostExecuted">>[1]>[0]["context"];

/**
 * The market a token belongs to.
 *
 * `instant_market` is keyed by pool id and Boost's events carry the token, so this is the join.
 * Undefined for a token this feed has not indexed, which is a normal state during a backfill
 * rather than an error.
 */
async function marketByToken(context: BoostContext, token: `0x${string}`) {
  const rows = await context.db.sql
    .select()
    .from(instantMarket)
    .where(eq(instantMarket.token, token))
    .limit(1);

  return rows[0];
}

/** Update a market found by its token, or do nothing if this feed has not seen it. */
async function updateByToken(
  context: BoostContext,
  token: `0x${string}`,
  change: (row: {
    readonly boostAgenRoutedQuote: bigint;
    readonly boostAgenDonatedQuote: bigint;
  }) => Record<string, unknown>,
): Promise<void> {
  const market = await marketByToken(context, token);
  if (market === undefined) return;

  await context.db.update(instantMarket, { id: market.id }).set(change(market));
}

/**
 * The argument Ponder hands a `PoolManager:Swap` handler.
 *
 * The type is generated per event from the configuration and cannot be written out by
 * hand, so it is recovered from the signature of the handler it belongs to.
 */
type SwapHandler = Parameters<Parameters<typeof ponder.on<"PoolManager:Swap">>[1]>[0];

/**
 * A swap in an Instant market's pool.
 *
 * A function rather than a registration, because `src/index.ts` owns the `PoolManager`
 * handlers: v4 emits every pool's swaps from one contract and Ponder allows one handler
 * per event, so the entry point has to be in one place even in a service that indexes
 * nothing else.
 *
 * Returns whether the pool was one of Instant's. Nothing in this service acts on the
 * answer any more — a pool that is not Instant's is simply somebody else's — but the
 * signature is unchanged from when the shared indexer used it to tell "handled" from "not
 * mine", and a caller that wants to count what it skipped still can.
 */
export async function indexInstantSwap({ event, context }: SwapHandler): Promise<boolean> {
  const existing = await context.db.find(instantMarket, { id: event.args.id });
  if (existing === null) return false;

  // The deltas are the swapper's, not the pool's. Instant's launch token is always
  // `currency1`, because ether is the zero address and every token sorts above it, so a
  // negative `amount0` is the trader paying ether: a buy.
  //
  // Worth stating because v4's own docstring on this event says "the delta of the
  // currency0 balance of the pool", which is the opposite. The code emits
  // `delta.amount0()` from the value it then accounts against `msg.sender`, so the comment
  // is wrong and the code is what matters. Reading the comment is how the Verdant handler
  // was first written, and it labelled every buy a sell.
  const buy = event.args.amount0 < 0n;
  const quoteAmount = event.args.amount0 < 0n ? -event.args.amount0 : event.args.amount0;
  const tokenAmount = event.args.amount1 < 0n ? -event.args.amount1 : event.args.amount1;

  await context.db.insert(instantSwap).values({
    id: `${event.transaction.hash}-${String(event.log.logIndex)}`,
    poolId: event.args.id,
    sender: event.args.sender,
    amount0: event.args.amount0,
    amount1: event.args.amount1,
    buy,
    quoteAmount,
    tokenAmount,
    sqrtPriceX96: event.args.sqrtPriceX96,
    liquidity: event.args.liquidity,
    tick: event.args.tick,
    feePpm: event.args.fee,
    timestamp: Number(event.block.timestamp),
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    transactionHash: event.transaction.hash,
  });

  await context.db.update(instantMarket, { id: event.args.id }).set((row) => ({
    sqrtPriceX96: event.args.sqrtPriceX96,
    tick: event.args.tick,
    liquidity: event.args.liquidity,
    swapCount: row.swapCount + 1,
    volumeQuote: row.volumeQuote + quoteAmount,
    volumeToken: row.volumeToken + tokenAmount,
    lastSwapAt: Number(event.block.timestamp),
  }));

  return true;
}
