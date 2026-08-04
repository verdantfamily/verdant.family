/**
 * What the indexer stores.
 *
 * Two rules shape every table here.
 *
 * **Store what was observed; derive the rest at read time.** The active fee, the
 * current stage, the countdown to the next transition and the trait badges are all
 * functions of a market's immutable schedule and the clock. They are computed by
 * `@verdant/sdk`, the tested twin of `ScheduleLib.sol`. Storing them would create a
 * third implementation that goes stale by the second — literally, because the fee
 * changes with time and nothing on chain fires when it does. So a row is never
 * updated because time passed, only because something happened.
 *
 * **Never store a number the chain did not give us.** The most tempting omission
 * here is a per-swap fee *amount*: the event reports the fee *rate* it charged, and
 * multiplying that by the input looks like the fee. It is not, quite — v4 applies
 * the rate per tick-crossing step with its own rounding — and a figure that is
 * nearly right is worse than no figure, because it will be summed and shown as
 * revenue. The rate is stored because it was reported; what was actually earned is
 * observable from `feeCollection` and `claim`, which are events about real money
 * moving.
 */

import { index, onchainTable, primaryKey, relations } from "ponder";

/** One step of a market's fee schedule, as the hook holds it. */
export interface ScheduleStage {
  readonly startOffset: number;
  readonly feePpm: number;
}

/**
 * The pool's opening price, from the PoolManager's own `Initialize`.
 *
 * A separate table, and the only piece of state written before a market row exists.
 * The reason is ordering: a Verdant launch is one transaction in which the factory
 * initialises the pool and *then* emits `MarketCreated`, so `Initialize` always
 * arrives first and has nowhere to go yet. Its price cannot be recovered later —
 * the first buy happens in the same transaction, so by the time the market row is
 * written the pool has already moved off its opening tick.
 *
 * That makes this table the answer to "what did this market launch at", which is
 * also the only price a market with no trades has.
 */
export const poolInit = onchainTable("pool_init", (t) => ({
  id: t.hex().primaryKey(),
  sqrtPriceX96: t.bigint().notNull(),
  tick: t.integer().notNull(),
  timestamp: t.integer().notNull(),
  blockNumber: t.bigint().notNull(),
}));

/**
 * One market, keyed by pool id.
 *
 * The pool id rather than the token, because it is what v4, the hook and the
 * registry all use, and because `@verdant/sdk`'s `poolIdFor` derives it locally
 * from the pair — so a client that knows what a market is quoted in can address a
 * row without a lookup. A client holding only a token cannot: the quote asset is
 * the creator's choice and nothing about the token discloses it, which is why the
 * API still answers to a token address and why `quoteAsset` is stored below.
 */
export const market = onchainTable(
  "market",
  (t) => ({
    /** The v4 pool id: `keccak256(abi.encode(poolKey))`. */
    id: t.hex().primaryKey(),

    token: t.hex().notNull(),
    /**
     * The pool's `currency0`: what this market is priced and traded in. The zero
     * address is native ether; anything else is the tokenized equity the creator
     * launched against. Stored rather than assumed, because it is the one field of
     * the pool key that is not a constant — every other one is the same for every
     * market ever created.
     */
    quoteAsset: t.hex().notNull(),
    creator: t.hex().notNull(),
    /** Index into ModelRegistry's models; the SDK maps it to a name. */
    model: t.integer().notNull(),

    // --- the token's own account of itself -----------------------------------
    name: t.text().notNull(),
    symbol: t.text().notNull(),
    decimals: t.integer().notNull(),
    totalSupply: t.bigint().notNull(),
    metadataURI: t.text().notNull(),
    /** Whether the creator may still edit that URI. Disclosed, not inferred. */
    metadataMutable: t.boolean().notNull(),

    // --- the quote asset's account of itself ---------------------------------
    // Read from the ERC-20 at creation and stored, exactly as the launch token's
    // are and for the same reason: an amount in an equity's smallest unit cannot be
    // rendered without them, and leaving a consumer to fetch them would put an RPC
    // call behind every number on the page. Ether has no contract to ask, so its
    // three are the constants v4's zero address stands for.
    quoteName: t.text().notNull(),
    quoteSymbol: t.text().notNull(),
    quoteDecimals: t.integer().notNull(),

    // --- the market's contracts ----------------------------------------------
    splitter: t.hex().notNull(),
    locker: t.hex().notNull(),
    /** Null where the creator configured no vesting. */
    vesting: t.hex(),
    positionTokenId: t.bigint().notNull(),
    /** The liquidity minted at launch, which cannot be added to or withdrawn early. */
    initialLiquidity: t.bigint().notNull(),

    // --- the splits, as snapshotted at creation ------------------------------
    // In the registry's record but in no event, so they are read rather than
    // observed. They are what a market's fee disclosure is made of.
    creatorBps: t.integer().notNull(),
    protocolBps: t.integer().notNull(),
    reserveBps: t.integer().notNull(),

    // --- the fee schedule ----------------------------------------------------
    // The hook's own account of it, read at the creation block, which is the state
    // after `afterInitialize` has written the init time. The two words the
    // `MarketConfigured` event carries are *not* this: they are packed before the
    // pool exists, so their init time is zero.
    stages: t.json().$type<readonly ScheduleStage[]>().notNull(),
    /** Pool initialisation time in seconds. Every stage offset is relative to it. */
    initTime: t.integer().notNull(),

    // --- creation ------------------------------------------------------------
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
    swapCount: t.integer().notNull(),
    /**
     * The quote asset through the pool, both directions, in its own smallest unit.
     *
     * Not converted to anything. A stock-paired market's volume is an amount of that
     * equity, and expressing it in ether would mean inventing a price the chain never
     * quoted — the market has no ether side to read one from.
     */
    volumeQuote: t.bigint().notNull(),
    volumeToken: t.bigint().notNull(),
    lastSwapAt: t.integer(),
  }),
  (table) => ({
    // The listings that exist: newest markets, one creator's markets, and the
    // token-to-market lookup an explorer link arrives on.
    createdAtIdx: index().on(table.createdAt),
    creatorIdx: index().on(table.creator),
    tokenIdx: index().on(table.token),
  }),
);

/**
 * Which market a per-market contract belongs to.
 *
 * A splitter's `Claimed` event says who was paid and how much, but not which market
 * paid them — the address is the only link, and it is only knowable from the
 * factory's `MarketCreated`. This table is that link, keyed by address so every
 * child handler resolves its market with a primary-key lookup rather than a scan.
 */
export const marketContract = onchainTable("market_contract", (t) => ({
  id: t.hex().primaryKey(),
  poolId: t.hex().notNull(),
  /** `token`, `splitter`, `locker` or `vesting`. */
  kind: t.text().notNull(),
}));

/**
 * Every swap in a Verdant pool.
 *
 * `feePpm` is what the pool reported charging, which for these pools is the hook's
 * per-swap override rather than the stored pool fee. Keeping it makes the trade
 * history independently checkable: if a swap's recorded rate ever disagrees with
 * what the schedule says was in force at its timestamp, one of the two is wrong and
 * it is worth finding out which.
 */
export const swap = onchainTable(
  "swap",
  (t) => ({
    /** Transaction hash and log index: unique, and stable across a reorg replay. */
    id: t.text().primaryKey(),
    poolId: t.hex().notNull(),
    /** Whoever called the PoolManager. Usually a router, not the trader. */
    sender: t.hex().notNull(),

    /** Pool-side deltas, signed as v4 reports them. Negative leaves the pool. */
    amount0: t.bigint().notNull(),
    amount1: t.bigint().notNull(),
    /** True when the quote asset went in and tokens came out. */
    buy: t.boolean().notNull(),
    /** Unsigned magnitudes, for the common case of showing a trade. */
    quoteAmount: t.bigint().notNull(),
    tokenAmount: t.bigint().notNull(),

    sqrtPriceX96: t.bigint().notNull(),
    liquidity: t.bigint().notNull(),
    tick: t.integer().notNull(),
    /** Hundredths of a basis point, as charged. 10 000 is 1%. */
    feePpm: t.integer().notNull(),

    timestamp: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    /**
     * Where in the block this swap sat.
     *
     * Kept because block number alone does not order two swaps in one block, and a
     * candle's open and close are exactly that question asked of the first and last
     * block of a bucket. The primary key contains it, but as text — `"…-10"` sorts
     * below `"…-2"` — so it cannot be ordered by.
     */
    logIndex: t.integer().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({
    poolIdx: index().on(table.poolId, table.timestamp),
    // The order a candle is built in: within one pool, by position in the chain.
    sequenceIdx: index().on(table.poolId, table.blockNumber, table.logIndex),
  }),
);

/** A `collect()` on a market's locker: fees pushed out of the locked position. */
export const feeCollection = onchainTable(
  "fee_collection",
  (t) => ({
    id: t.text().primaryKey(),
    poolId: t.hex().notNull(),
    locker: t.hex().notNull(),
    /** Anyone may call it, so who did is worth keeping. */
    caller: t.hex().notNull(),
    positionTokenId: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({
    poolIdx: index().on(table.poolId, table.timestamp),
  }),
);

/**
 * A claim from a market's splitter.
 *
 * The splitter is pull-based, so this is the event that means somebody was actually
 * paid — as distinct from `feeCollection`, which means money arrived and is waiting
 * for someone to come and get it.
 */
export const claim = onchainTable(
  "claim",
  (t) => ({
    id: t.text().primaryKey(),
    poolId: t.hex().notNull(),
    splitter: t.hex().notNull(),
    recipient: t.hex().notNull(),
    /** The quote side of the payout, in whatever the market is quoted in. */
    quoteAmount: t.bigint().notNull(),
    tokenAmount: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({
    poolIdx: index().on(table.poolId, table.timestamp),
    recipientIdx: index().on(table.recipient),
  }),
);

/** A release from a creator's vesting contract. */
export const vestingRelease = onchainTable(
  "vesting_release",
  (t) => ({
    id: t.text().primaryKey(),
    poolId: t.hex().notNull(),
    vesting: t.hex().notNull(),
    beneficiary: t.hex().notNull(),
    amount: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({
    poolIdx: index().on(table.poolId, table.timestamp),
  }),
);

/**
 * Token balances, so a market can say how many people hold it.
 *
 * Keyed by token and address rather than a synthetic id, so an update is an upsert
 * on the natural key and two rows for one holder are not expressible. There is
 * deliberately no `holderCount` column on `market`: a count maintained by
 * increment-on-first-receipt and decrement-on-zero is a second source of truth that
 * drifts, and counting rows is what a database is for.
 */
export const holder = onchainTable(
  "holder",
  (t) => ({
    token: t.hex().notNull(),
    address: t.hex().notNull(),
    balance: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.address] }),
    tokenIdx: index().on(table.token),
  }),
);

export const marketRelations = relations(market, ({ many }) => ({
  swaps: many(swap),
  claims: many(claim),
  feeCollections: many(feeCollection),
}));

export const swapRelations = relations(swap, ({ one }) => ({
  market: one(market, { fields: [swap.poolId], references: [market.id] }),
}));
