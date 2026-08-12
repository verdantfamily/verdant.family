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

  /**
   * The rest of the pool key, which is only ever announced here.
   *
   * Verdant does not need these — every one of them is a constant for its markets —
   * but a generated market's fee is whatever its build chose and its hook is unique to
   * it, and the registry records the pool id without the key that hashes to it. So
   * this event is the only place an Agen pool's fee can be read from, and an interface
   * that cannot read it cannot rebuild the key to quote a trade.
   */
  fee: t.integer().notNull(),
  tickSpacing: t.integer().notNull(),
  hooks: t.hex().notNull(),
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

// --- the agent layer ------------------------------------------------------
//
// Agen's agents sit above the market layer and are indexed beside it rather than
// inside it. The two rules at the top of this file still hold, and a third joins them
// for agents specifically:
//
// **Relate to the market layer; do not restate it.** An agent-created market is an
// ordinary `market` row — the same factory made it, with the same fee schedule and the
// same splitter. So `agent.poolId` points at it and nothing about it is copied. A
// second `name`, `symbol` or `volumeQuote` on the agent side would be a second answer
// to a question the market table already answers, and the two would diverge the first
// time one handler ran and the other did not.
//
// The same applies to the mandate. Every permission an agent has is fixed at launch
// and readable from `AgentMandate` forever, and none of it is in an event. Copying it
// here would put a permission the interface displays behind an indexer that may be
// behind the chain, so the mandate is read from the chain by the SDK at the moment it
// matters and appears in no table.

/**
 * One agent, keyed by the id the registry assigns.
 *
 * The id rather than any of its four addresses, because it is what every agent event
 * that knows its own agent carries, and because the SDK derives it locally from the
 * developer and a salt — so an interface can address a row before the agent exists.
 *
 * ## Why the market fields are nullable
 *
 * Because an agent exists before its market is proved. `createAgent` produces an agent
 * in `Created` holding a commitment to a market that has not launched; `bindMarket`
 * fills these in. An agent that never binds stays here with them null forever, which
 * is a real and visible state — "created, never launched" — and not an error.
 *
 * There is at most one market per agent, enforced on chain: `bindMarket` reverts once
 * `poolId` is set. That is why this is a column and not a join table. A launch count
 * is `poolId === null ? 0 : 1`, and a table would invite the idea that it could be
 * more.
 */
export const agent = onchainTable(
  "agent",
  (t) => ({
    /** `keccak256(abi.encode(chainId, registry, developer, salt))`. */
    id: t.hex().primaryKey(),

    /** Who created it and who its revenue's developer leg pays. */
    developer: t.hex().notNull(),
    /** Who may pause, resume, revoke, and kill the mandate. */
    guardian: t.hex().notNull(),
    /** The only address that may submit an action. Immutable on chain. */
    operator: t.hex().notNull(),

    // --- the agent's four contracts ------------------------------------------
    mandate: t.hex().notNull(),
    treasury: t.hex().notNull(),
    router: t.hex().notNull(),
    executionModule: t.hex().notNull(),

    /**
     * A pointer to a description, and the only mutable field on the record.
     *
     * Safe to be mutable precisely because nothing the contracts enforce reads it, so
     * changing it cannot change what the agent may do.
     */
    metadataURI: t.text().notNull(),

    // --- lifecycle -----------------------------------------------------------
    /**
     * `AgentLifecycle.State` as its ordinal: 0 created, 1 market bound, 2 active,
     * 3 paused, 4 revoked.
     *
     * The number and not a string, because the number is what `AgentStateChanged`
     * carries. `@verdant/sdk`'s `agents.lifecycle` maps it to a name and answers what
     * it permits, so there is one such table and it is not this one.
     */
    state: t.integer().notNull(),
    stateChangedAt: t.integer().notNull(),

    /**
     * The two stops that are not the lifecycle.
     *
     * Separate from `state` because they are separate contracts and either can be
     * pulled without the other. An agent can read as `Active` while its mandate is
     * dead or its treasury is frozen, and the execution module checks all three — so
     * an interface that showed only `state` would say an agent was running when
     * nothing it proposed could execute.
     */
    mandateRevoked: t.boolean().notNull(),
    treasuryPaused: t.boolean().notNull(),

    // --- the market it committed to, and the one it proved -------------------
    /** The commitment made at creation. What `bindMarket` checks a market against. */
    marketCommitment: t.hex().notNull(),
    /** The bound market's pool id. Null until `bindMarket`. Joins `market.id`. */
    poolId: t.hex(),
    /** The launch token. Null until bound. Also on the market row; kept for the join. */
    token: t.hex(),
    /** The market's fee splitter, which the router claims from. Null until bound. */
    splitter: t.hex(),
    marketBoundAt: t.integer(),

    // --- the revenue split, fixed at launch ----------------------------------
    // In `AgentLaunched` and in the router's immutables, and it never changes. Stored
    // because it is disclosure: what share of an agent's earnings goes where is the
    // first thing anyone deciding whether to buy from it wants to know.
    operationsBps: t.integer().notNull(),
    buybacksBps: t.integer().notNull(),
    developerBps: t.integer().notNull(),
    protocolBps: t.integer().notNull(),

    // --- creation ------------------------------------------------------------
    createdAt: t.integer().notNull(),
    createdAtBlock: t.bigint().notNull(),
    createdTx: t.hex().notNull(),
  }),
  (table) => ({
    // The listings that exist: newest agents, one developer's agents, agents in a
    // given state, and the reverse lookup from a market to the agent that launched it.
    createdAtIdx: index().on(table.createdAt),
    developerIdx: index().on(table.developer),
    stateIdx: index().on(table.state),
    poolIdIdx: index().on(table.poolId),
  }),
);

/**
 * Which agent a per-agent contract belongs to.
 *
 * The same problem `marketContract` solves, and worse. An agent's mandate, treasury,
 * execution module and router are four contracts deployed per agent, and their events
 * mostly do not carry an agent id: `AgentTreasury.Spent` reports an asset, a
 * destination and an amount, and the only thing tying it to an agent is which treasury
 * emitted it. That link is knowable from `AgentLaunched` and from nowhere else.
 *
 * Keyed by address, so every child handler resolves its agent with a primary-key
 * lookup rather than a scan.
 */
export const agentContract = onchainTable("agent_contract", (t) => ({
  id: t.hex().primaryKey(),
  agentId: t.hex().notNull(),
  /** `mandate`, `treasury`, `router` or `executionModule`. */
  kind: t.text().notNull(),
}));

/**
 * A service an agent offers, keyed by the id the registry derives.
 *
 * `version` is the field that matters most: it is bumped on every update, and a quote
 * written against an older version is refused rather than repriced. So a stale
 * version in this table is not a cosmetic lag — it is an interface offering to pay a
 * price the chain will reject.
 *
 * Retired services stay here with `active` false and `retiredAt` set. Deleting them
 * would erase the history of what an agent used to sell, which is exactly what
 * someone auditing a past payment needs.
 */
export const agentService = onchainTable(
  "agent_service",
  (t) => ({
    id: t.hex().primaryKey(),
    agentId: t.hex().notNull(),

    /** Fixed at registration; `update` cannot change it. */
    paymentAsset: t.hex().notNull(),
    price: t.bigint().notNull(),
    /** Bumped on every write. A quote must carry the current one. */
    version: t.integer().notNull(),
    /**
     * The service's own flag, not the effective answer.
     *
     * A service flagged active still cannot be paid if its agent is paused or
     * revoked. The registry's `isActive` combines the two and the execution module
     * checks that; this column is only half of it, which is why the API joins the
     * agent's state rather than serving this alone.
     */
    active: t.boolean().notNull(),

    registeredAt: t.integer().notNull(),
    updatedAt: t.integer().notNull(),
    /** Null until retired. */
    retiredAt: t.integer(),
  }),
  (table) => ({
    agentIdx: index().on(table.agentId),
  }),
);

/**
 * What an agent has earned in one asset, and what has been paid out of it.
 *
 * Keyed by agent and asset, because every figure is per asset: revenue arrives in
 * ether and in whatever the market is quoted in, and there is no rate on chain to
 * total them with. A single "lifetime revenue" number would require inventing one.
 *
 * The four legs are columns rather than rows for once, and the reason is that there
 * are exactly four of them, fixed in `RevenueAllocationLib`, forever. A leg table
 * would make "which legs exist" a data question when it is a code question, and every
 * read would need four joins or a pivot.
 */
export const agentRevenue = onchainTable(
  "agent_revenue",
  (t) => ({
    agentId: t.hex().notNull(),
    /** The zero address is ether. */
    asset: t.hex().notNull(),

    /** Recognised, cumulative. The base every allocation is a share of. */
    received: t.bigint().notNull(),

    // Divided to each leg, cumulatively. Not derived from `received` and the basis
    // points: the router allocates in whole units and keeps up to three units of dust
    // unallocated, so the sum of these is at or just below the share of `received`,
    // and recomputing it here would disagree with the chain by that dust.
    operationsAllocated: t.bigint().notNull(),
    buybacksAllocated: t.bigint().notNull(),
    developerAllocated: t.bigint().notNull(),
    protocolAllocated: t.bigint().notNull(),

    // Actually paid out. The difference from allocated is what `settle` would move.
    operationsSettled: t.bigint().notNull(),
    buybacksSettled: t.bigint().notNull(),
    developerSettled: t.bigint().notNull(),
    protocolSettled: t.bigint().notNull(),

    lastEventAt: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.asset] }),
    agentIdx: index().on(table.agentId),
  }),
);

/**
 * What an agent's treasury has taken in and paid out, per asset.
 *
 * Separate from `agentRevenue` because they are separate contracts holding separate
 * money for separate purposes: the router receives earnings and divides them, and the
 * treasury holds the operations leg and spends it. Summing them would double-count
 * every unit that passed through both.
 *
 * Deliberately not a balance. A balance is the chain's to report — the treasury can be
 * sent assets by anyone at any time, in a transfer that emits `Transfer` on the token
 * and nothing here — so a balance maintained by addition would drift the first time
 * that happened. These are the flows that were observed; the balance is read from the
 * chain.
 */
export const agentTreasuryAsset = onchainTable(
  "agent_treasury_asset",
  (t) => ({
    agentId: t.hex().notNull(),
    asset: t.hex().notNull(),

    /** Announced arrivals, from `Received`. Not every arrival announces itself. */
    received: t.bigint().notNull(),
    /** Left through `spend`, which is the only exit the treasury has. */
    spent: t.bigint().notNull(),
    spendCount: t.integer().notNull(),

    /** When the current spending period began, from `PeriodRolled`. */
    periodStartedAt: t.integer(),
    lastEventAt: t.integer().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.asset] }),
    agentIdx: index().on(table.agentId),
  }),
);

/**
 * Everything an agent has ever done, as one ordered stream.
 *
 * The table the profile page's feed is built from, and the reason it exists rather
 * than the page querying eight tables and merging them: "what has this agent been
 * doing" is one question, asked in time order, and answering it by union across tables
 * with different shapes puts the ordering logic in every consumer.
 *
 * ## Structured, not phrased
 *
 * `type` is a machine constant and `data` is the fields that type carries. Nothing here
 * is a sentence. An indexer that stored "Executor 0x… granted until Aug 14" would have
 * decided the wording, the date format and the language for every consumer forever,
 * and changing any of them would mean a resync. So the frontend formats and this
 * stores what happened.
 *
 * `data` is JSON rather than a wide nullable table because the seventeen types share
 * almost no fields: a service payment has a request id and a nonce, a settlement has a
 * leg index, a state change has two states. Columns for all of them would be a row of
 * nulls with three values in it.
 */
export const agentActivity = onchainTable(
  "agent_activity",
  (t) => ({
    /** Transaction hash and log index: unique, and stable across a reorg replay. */
    id: t.text().primaryKey(),
    agentId: t.hex().notNull(),

    /** One of `AgentActivityType`. A constant, never a phrase. */
    type: t.text().notNull(),
    /**
     * Who caused it, where the event says. Null where nothing did — an allocation is
     * arithmetic anyone may trigger and the actor is not meaningful.
     */
    actor: t.hex(),
    /** The asset involved, where there is one. */
    asset: t.hex(),
    /**
     * The amount involved, where there is one, in the asset's own smallest unit.
     *
     * A column rather than a field in `data` because it is the one number a feed
     * renders for most types, and because filtering or summing a JSON field is
     * something a query planner cannot help with.
     */
    amount: t.bigint(),

    /** The fields specific to this type. See `AgentActivityData`. */
    data: t.json().$type<AgentActivityData>().notNull(),

    timestamp: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    /**
     * Where in the block this sat.
     *
     * Kept for the same reason `swap` keeps it: a block number alone does not order
     * two events in one block, and an agent's creation, its market binding and its
     * activation can all be in one. The primary key contains it, but as text — `"…-10"`
     * sorts below `"…-2"` — so it cannot be ordered by.
     */
    logIndex: t.integer().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({
    // The feed: one agent, newest first, by position in the chain.
    agentIdx: index().on(table.agentId, table.blockNumber, table.logIndex),
    typeIdx: index().on(table.agentId, table.type),
  }),
);

/**
 * The kinds of thing an agent does.
 *
 * One constant per state-changing agent event that a person would want to see, which
 * is all nineteen of them minus the two that are bookkeeping: `AgentRegistered`
 * duplicates `AgentLaunched` within the same transaction, and a self-transition to
 * `Created` is not a transition.
 *
 * These strings are the API's contract with the frontend, so they are append-only.
 * Renaming one would silently drop every historical row of that kind out of whatever
 * the frontend knows how to render.
 */
export const AgentActivityType = {
  Created: "AGENT_CREATED",
  StateChanged: "AGENT_STATE_CHANGED",
  MetadataUpdated: "AGENT_METADATA_UPDATED",
  MarketLaunched: "AGENT_MARKET_LAUNCHED",
  MandateRevoked: "AGENT_MANDATE_REVOKED",
  TreasuryPauseChanged: "AGENT_TREASURY_PAUSE_CHANGED",
  TreasuryFunded: "AGENT_TREASURY_FUNDED",
  TreasurySpent: "AGENT_TREASURY_SPENT",
  TreasuryPeriodRolled: "AGENT_TREASURY_PERIOD_ROLLED",
  ServiceRegistered: "AGENT_SERVICE_REGISTERED",
  ServiceUpdated: "AGENT_SERVICE_UPDATED",
  ServiceRetired: "AGENT_SERVICE_RETIRED",
  ServicePaid: "AGENT_SERVICE_PAID",
  RevenueRecognised: "AGENT_REVENUE_RECOGNISED",
  RevenueAllocated: "AGENT_REVENUE_ALLOCATED",
  RevenueSettled: "AGENT_REVENUE_SETTLED",
  MarketFeesClaimed: "AGENT_MARKET_FEES_CLAIMED",
  MarketSplitterBound: "AGENT_MARKET_SPLITTER_BOUND",
} as const;

export type AgentActivityType =
  (typeof AgentActivityType)[keyof typeof AgentActivityType];

/**
 * The type-specific half of an activity row.
 *
 * A union discriminated by nothing, because the discriminant is the row's own `type`
 * column. Every member is optional so a consumer reads the fields its type has; the
 * alternative — a tagged union in the JSON — would store the type twice and allow the
 * two copies to disagree.
 */
export interface AgentActivityData {
  /** `StateChanged`: the ordinals, so the frontend names them via the SDK. */
  readonly previousState?: number;
  readonly newState?: number;

  /** `MetadataUpdated`. */
  readonly metadataURI?: string;

  /** `MarketLaunched`: the market this agent proved. Joins `market.id`. */
  readonly poolId?: string;
  readonly token?: string;
  readonly splitter?: string;

  /** `TreasuryPauseChanged`. */
  readonly paused?: boolean;

  /** `TreasuryFunded`: where it came from. `TreasurySpent`: where it went. */
  readonly from?: string;
  readonly to?: string;
  /** `TreasurySpent`: the quote hash the spend was authorised by. */
  readonly actionHash?: string;

  /** `Service*`. */
  readonly serviceId?: string;
  readonly serviceVersion?: number;
  readonly price?: string;
  readonly active?: boolean;

  /** `ServicePaid`: who was paid, and the replay fields. */
  readonly providerAgentId?: string;
  readonly requestId?: string;
  readonly nonce?: string;

  /** `RevenueRecognised`: the running total after this one. */
  readonly totalReceived?: string;

  /** `RevenueAllocated`: what each leg gained. Four numbers in one event. */
  readonly operations?: string;
  readonly buybacks?: string;
  readonly developer?: string;
  readonly protocol?: string;

  /** `RevenueSettled`: which leg, by index into `RevenueAllocationLib`'s order. */
  readonly leg?: number;

  /** `MarketFeesClaimed`: both sides of the splitter's payout. */
  readonly quoteAmount?: string;
  readonly tokenAmount?: string;
}

// --- Agen's generated markets ---------------------------------------------
//
// A separate table from `market`, and the separation is the same one the contracts
// make. A Verdant market has a fixed shape — one token, one model, one fee schedule,
// one splitter — and half the columns above describe it. A generated market has no
// fixed shape: it is however many contracts a mechanic needs, its fee is whatever its
// own hook decides per swap, and it has no schedule to read. Widening `market` to hold
// both would mean a dozen nullable columns and a `kind` discriminator on the table the
// whole feed is built from, for two things that share only a pool.
//
// What they do share is Uniswap, so the swap side is genuinely the same shape and is
// stored the same way one table over.

/**
 * One generated market, keyed by pool id.
 *
 * The pool id for the same reason `market` uses it: it is what v4 and the trade path
 * address, and it is derivable off chain from the pool key. `AgenMarketRegistry`
 * indexes by token, pool and hook, so every lookup an interface makes has an on-chain
 * counterpart if this table is ever behind.
 */
export const agenMarket = onchainTable(
  "agen_market",
  (t) => ({
    /** The v4 pool id: `keccak256(abi.encode(poolKey))`. */
    id: t.hex().primaryKey(),

    /** The registry's index, which is also creation order. */
    marketIndex: t.integer().notNull(),
    token: t.hex().notNull(),
    /** The generated hook. Unique per market, unlike Verdant's one shared hook. */
    hook: t.hex().notNull(),
    creator: t.hex().notNull(),
    /** `currency0`. The zero address is ether, which is what every launch opens against. */
    quoteAsset: t.hex().notNull(),

    /**
     * The pool's fee field: the dynamic flag, or a fixed rate the hook demanded.
     *
     * Recorded from the PoolManager's own `Initialize`, which is the only place it
     * appears — the registry stores the pool id but not the key that hashes to it. It
     * is what an interface needs to rebuild the pool key and quote a trade.
     */
    fee: t.integer().notNull(),
    tickSpacing: t.integer().notNull(),

    // --- what the market was built from --------------------------------------
    // Both hashes are in the registry's record. Together they let anyone check that
    // the contract they are trading against is the one whose rules they were shown.
    specificationHash: t.hex().notNull(),
    implementationHash: t.hex().notNull(),
    metadataURI: t.text().notNull(),

    // --- the token's own account of itself -----------------------------------
    name: t.text().notNull(),
    symbol: t.text().notNull(),
    decimals: t.integer().notNull(),
    totalSupply: t.bigint().notNull(),

    // --- the launch ----------------------------------------------------------
    /** Holds the three locked positions forever. Only `collect()` moves anything. */
    locker: t.hex().notNull(),
    /** The first of the three position NFTs; the others are this plus one and two. */
    firstPositionId: t.bigint().notNull(),
    /** How much of the supply went into the locked bands. */
    supplyLocked: t.bigint().notNull(),

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
    volumeQuote: t.bigint().notNull(),
    volumeToken: t.bigint().notNull(),
    lastSwapAt: t.integer(),
  }),
  (table) => ({
    createdAtIdx: index().on(table.createdAt),
    creatorIdx: index().on(table.creator),
    tokenIdx: index().on(table.token),
    hookIdx: index().on(table.hook),
  }),
);

/**
 * Every swap in a generated market's pool.
 *
 * The same columns as `swap`, and deliberately not the same table: that one's rows
 * join `market`, and a row pointing at a market that does not exist would break the
 * relation for every consumer of the Verdant feed. `feePpm` is what the pool reported
 * charging, which for a dynamic-fee market is the hook's per-swap override — the whole
 * point of a generated mechanic, and the number worth keeping per trade.
 */
export const agenSwap = onchainTable(
  "agen_swap",
  (t) => ({
    id: t.text().primaryKey(),
    poolId: t.hex().notNull(),
    /** Whoever called the PoolManager. Usually a router, not the trader. */
    sender: t.hex().notNull(),

    amount0: t.bigint().notNull(),
    amount1: t.bigint().notNull(),
    /** True when the quote asset went in and tokens came out. */
    buy: t.boolean().notNull(),
    quoteAmount: t.bigint().notNull(),
    tokenAmount: t.bigint().notNull(),

    sqrtPriceX96: t.bigint().notNull(),
    liquidity: t.bigint().notNull(),
    tick: t.integer().notNull(),
    /** Hundredths of a basis point, as charged. 10 000 is 1%. */
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

/** Every contract a generated market is made of, so an interface can list them. */
export const agenComponent = onchainTable(
  "agen_component",
  (t) => ({
    /** The contract's own address, which is unique across markets. */
    id: t.hex().primaryKey(),
    poolId: t.hex().notNull(),
    /** `AgenMarketRegistry`'s role constant. 0 token, 1 hook, 6 locker, 255 other. */
    role: t.integer().notNull(),
    /** keccak256 of the deployed runtime code, so the code can be checked later. */
    codeHash: t.hex().notNull(),
  }),
  (table) => ({
    poolIdx: index().on(table.poolId),
  }),
);

export const agenMarketRelations = relations(agenMarket, ({ many }) => ({
  swaps: many(agenSwap),
  components: many(agenComponent),
}));

export const agenSwapRelations = relations(agenSwap, ({ one }) => ({
  market: one(agenMarket, { fields: [agenSwap.poolId], references: [agenMarket.id] }),
}));

export const marketRelations = relations(market, ({ many, one }) => ({
  swaps: many(swap),
  claims: many(claim),
  feeCollections: many(feeCollection),
  /**
   * The agent that launched this market, where one did.
   *
   * The join that makes attribution possible on a market page without a second
   * query, and the direction that matters: most markets have no agent, so the
   * question is asked of every market and answered by a null for nearly all of them.
   */
  agent: one(agent, { fields: [market.id], references: [agent.poolId] }),
}));

export const swapRelations = relations(swap, ({ one }) => ({
  market: one(market, { fields: [swap.poolId], references: [market.id] }),
}));

export const agentRelations = relations(agent, ({ many, one }) => ({
  activity: many(agentActivity),
  services: many(agentService),
  revenue: many(agentRevenue),
  treasuryAssets: many(agentTreasuryAsset),
  /** The market it launched, where it has bound one. */
  market: one(market, { fields: [agent.poolId], references: [market.id] }),
}));

export const agentActivityRelations = relations(agentActivity, ({ one }) => ({
  agent: one(agent, { fields: [agentActivity.agentId], references: [agent.id] }),
}));
