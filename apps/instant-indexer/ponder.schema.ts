/**
 * What the Instant indexer stores.
 *
 * Three tables, all of them copied unchanged from the shared indexer when Instant moved
 * into its own service. The two rules that shape them are the shared indexer's and are
 * worth restating, because they are why some obvious columns are missing.
 *
 * **Store what was observed; derive the rest at read time.** Nothing here is updated
 * because time passed, only because something happened.
 *
 * **Never store a number the chain did not give us.** The most tempting omission is a
 * per-swap fee amount. For Instant it is doubly wrong: the hook overrides the pool's LP
 * fee to zero and takes its 1.50% from the ether leg, so v4 reports a rate of zero and the
 * fee a trader actually paid appears in no event at all. The rate is stored because it was
 * reported; the real one is a constant of the deployment (`InstantFees`) and any consumer
 * that needs it knows it without this schema guessing. See ADR-014.
 */

import { index, onchainTable, relations } from "ponder";

/**
 * The pool's opening price, from the PoolManager's own `Initialize`.
 *
 * A separate table, and the only state written before a market row exists. The reason is
 * ordering: an Instant launch is one transaction in which the factory initialises the pool
 * and *then* emits `MarketCreated`, so `Initialize` always arrives first and has nowhere
 * to go yet. Its price cannot be recovered later, because the creator's first buy happens
 * in that same transaction — by the time the market row is written the pool has already
 * moved off its opening tick.
 *
 * That makes this table the answer to "what did this market launch at", which is also the
 * only price a market with no trades has.
 *
 * Rows are written for every pool the PoolManager opens, not only Instant's. A pool only
 * becomes a market when the factory's event claims it; the rows nobody claims are eight
 * columns each and are never read.
 */
export const poolInit = onchainTable("pool_init", (t) => ({
  id: t.hex().primaryKey(),
  sqrtPriceX96: t.bigint().notNull(),
  tick: t.integer().notNull(),
  timestamp: t.integer().notNull(),
  blockNumber: t.bigint().notNull(),

  /**
   * The rest of the pool key, which is only ever announced here.
   *
   * Constants for Instant — ether, the dynamic-fee flag, Verdant's tick spacing and the
   * shared hook — and recorded anyway, so that an interface rebuilding the key to quote a
   * trade uses what the pool was opened with rather than what this build believes.
   */
  fee: t.integer().notNull(),
  tickSpacing: t.integer().notNull(),
  hooks: t.hex().notNull(),
}));

/**
 * One Instant market, keyed by pool id.
 *
 * The pool id because it is what v4 and the trade path address, and because it is
 * derivable off chain from the pool key — which for Instant is a function of the token
 * alone, since ether, the tick spacing, the dynamic-fee flag and the hook are all
 * constants of the deployment.
 *
 * ## What Instant does not have
 *
 * Most of what a Programmable market records. No specification or implementation hash,
 * because nothing was generated; no per-market hook, because the hook is shared; no
 * component list, because a market is three ordinary contracts rather than however many a
 * mechanic needed; no `creatorBps`/`protocolBps`, because Instant's split is 1.00%/0.50%
 * fixed in `InstantFees` and those legacy fields would be a second, misleading source of
 * truth. What it has instead is a vault.
 */
export const instantMarket = onchainTable(
  "instant_market",
  (t) => ({
    /** The v4 pool id: `keccak256(abi.encode(poolKey))`. */
    id: t.hex().primaryKey(),

    token: t.hex().notNull(),
    /** Shared across every Instant market, unlike Agen's per-market hook. */
    hook: t.hex().notNull(),
    /** Whoever sent the launch transaction. Not necessarily the fee recipient. */
    creator: t.hex().notNull(),

    /**
     * The market's `InstantFeeVault`, where the creator's 1.00% and the platform's 0.50%
     * accrue in ether.
     *
     * Recorded because it is the address a creator claims from, and because it is the
     * only per-market contract Instant has that Agen's schema has no column for. The
     * registry files it under `splitter`, which is the field's job rather than its type.
     */
    vault: t.hex().notNull(),

    /**
     * The pool's fee field and grid, from the PoolManager's own `Initialize`.
     *
     * Constants for Instant — the dynamic flag and Verdant's tick spacing — and read from
     * the chain anyway rather than assumed, so that an interface rebuilding the pool key
     * from this row is using what the pool was actually opened with.
     */
    fee: t.integer().notNull(),
    tickSpacing: t.integer().notNull(),

    // --- the token's own account of itself -----------------------------------
    name: t.text().notNull(),
    symbol: t.text().notNull(),
    decimals: t.integer().notNull(),
    totalSupply: t.bigint().notNull(),
    /** Points at the JSON document holding the picture, description and links. */
    metadataURI: t.text().notNull(),

    // --- the launch ----------------------------------------------------------
    /** Holds the single locked position forever. */
    locker: t.hex().notNull(),
    positionTokenId: t.bigint().notNull(),
    /** The liquidity of that position, which is the whole supply. */
    positionLiquidity: t.bigint().notNull(),

    createdAt: t.integer().notNull(),
    createdAtBlock: t.bigint().notNull(),
    createdTx: t.hex().notNull(),

    // --- the pool, as last seen ---------------------------------------------
    initialSqrtPriceX96: t.bigint().notNull(),
    initialTick: t.integer().notNull(),
    sqrtPriceX96: t.bigint().notNull(),
    tick: t.integer().notNull(),
    liquidity: t.bigint().notNull(),

    // --- running totals ------------------------------------------------------
    /**
     * Every swap in the pool, Boost buybacks included.
     *
     * Total rather than organic, deliberately. A buyback *is* a trade — real ether, real price
     * impact, real fee — so excluding it from the pool's own totals would make this column
     * disagree with the chain. Organic is the derived figure: `volumeQuote - boostVolumeQuote`.
     * The subtraction has to be available, because a Boosted market's volume is partly its own
     * creator's fees recycled and presenting that as demand would be the dishonest reading.
     */
    swapCount: t.integer().notNull(),
    volumeQuote: t.bigint().notNull(),
    volumeToken: t.bigint().notNull(),
    lastSwapAt: t.integer(),

    // --- Agen Boost ----------------------------------------------------------
    /**
     * The market's `BoostEscrow`, or null.
     *
     * Null for every market that named a wallet at launch, which is every market created before
     * Boost existed — `InstantFeeVault.creator` is immutable, so those can never be Boosted.
     * Set when the escrow announces the market rather than at creation, because the escrow is
     * what knows.
     */
    boostEscrow: t.hex(),
    boostEnabled: t.boolean().notNull(),
    boostLocked: t.boolean().notNull(),
    /** Ether the escrow has spent buying this token back. Cumulative. */
    boostSpentQuote: t.bigint().notNull(),
    /**
     * Ether of that spend which was Agen's 0.50%, routed by the fee architecture.
     *
     * The number that makes "all 1.50% is recycled" checkable: on a market that routes both streams
     * it should trend toward one third of `boostSpentQuote`, because 0.50 of 1.50 is a third. It is
     * kept apart from `boostAgenDonatedQuote` because a routed fee is a guarantee and a donation is
     * a choice, and conflating them would let a voluntary top-up be presented as the fee split.
     */
    boostAgenRoutedQuote: t.bigint().notNull(),
    /** Ether contributed from outside either fee stream. Discretionary, not routed. */
    boostAgenDonatedQuote: t.bigint().notNull(),
    /** Whether this market's platform 0.50% is captured by Boost at all. */
    boostPlatformCaptured: t.boolean().notNull(),
    /**
     * The portion of `volumeQuote` and `volumeToken` that was a buyback.
     *
     * Taken from the escrow's own `BoostExecuted` rather than by matching swaps, which would
     * mean pairing two events from two contracts on amounts that legitimately differ once the
     * hook has taken its cut.
     */
    boostVolumeQuote: t.bigint().notNull(),
    boostVolumeToken: t.bigint().notNull(),
    /**
     * Tokens at the dead address, as the escrow has reported sending them.
     *
     * Not a supply reduction: Instant tokens have no `burn`, so `totalSupply` above is unchanged
     * by any of this. A circulating supply is `totalSupply - boostSunkToken`, and the two must
     * never be conflated.
     */
    boostSunkToken: t.bigint().notNull(),
    boostCount: t.integer().notNull(),
    lastBoostAt: t.integer(),
  }),
  (table) => ({
    createdAtIdx: index().on(table.createdAt),
    creatorIdx: index().on(table.creator),
    tokenIdx: index().on(table.token),
  }),
);

/**
 * Every swap in an Instant market's pool.
 *
 * `feePpm` is what the pool reported charging, which for Instant is always zero — the
 * hook overrides the LP fee to nothing and takes its 1.50% from the ether leg instead, so
 * the fee a trader paid is not visible in this column and is not meant to be. It is
 * stored anyway because it is what the pool said, and a column that quietly substituted
 * the hook's rate would be this table asserting something it did not observe.
 */
export const instantSwap = onchainTable(
  "instant_swap",
  (t) => ({
    id: t.text().primaryKey(),
    poolId: t.hex().notNull(),
    /** Whoever called the PoolManager. Usually a router, not the trader. */
    sender: t.hex().notNull(),

    amount0: t.bigint().notNull(),
    amount1: t.bigint().notNull(),
    /** True when ether went in and tokens came out. */
    buy: t.boolean().notNull(),
    quoteAmount: t.bigint().notNull(),
    tokenAmount: t.bigint().notNull(),

    sqrtPriceX96: t.bigint().notNull(),
    liquidity: t.bigint().notNull(),
    tick: t.integer().notNull(),
    /** As the pool reported it. Zero for every Instant swap; see above. */
    feePpm: t.integer().notNull(),

    timestamp: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({
    poolIdx: index().on(table.poolId, table.timestamp),
    sequenceIdx: index().on(table.poolId, table.blockNumber, table.logIndex),
  }),
);

export const instantMarketRelations = relations(instantMarket, ({ many }) => ({
  swaps: many(instantSwap),
}));

export const instantSwapRelations = relations(instantSwap, ({ one }) => ({
  market: one(instantMarket, {
    fields: [instantSwap.poolId],
    references: [instantMarket.id],
  }),
}));

/**
 * One Boost buyback cycle.
 *
 * The audit trail. Every row is one `BoostExecuted`, which the escrow emits with the ether it
 * spent, the tokens it bought and the tokens it sent to the dead address — so Boost's whole
 * accounting is reconstructible from this table without trusting a running total.
 */
export const boostBuyback = onchainTable(
  "boost_buyback",
  (t) => ({
    id: t.text().primaryKey(),
    poolId: t.hex(),
    token: t.hex().notNull(),
    escrow: t.hex().notNull(),
    /** Whoever ran the cycle. Permissionless, so usually but not necessarily Agen's keeper. */
    caller: t.hex().notNull(),

    etherSpent: t.bigint().notNull(),
    tokensBought: t.bigint().notNull(),
    /** Sent to the dead address. Equals `tokensBought` unless the escrow held some already. */
    tokensSunk: t.bigint().notNull(),
    /** The escrow's own cumulative figure at this point, for checking the running total. */
    cumulativeSunk: t.bigint().notNull(),
    /** Still committed after this cycle. Non-zero when the pool could not absorb it all. */
    remainingPending: t.bigint().notNull(),

    timestamp: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token, table.timestamp),
    escrowIdx: index().on(table.escrow),
  }),
);
