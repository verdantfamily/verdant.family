/**
 * Two markets that share no mechanic, for proving the pipeline is not shaped around one.
 *
 * A generation system quietly specialised to its demo is easy to build by accident: the
 * prompts, the schema and the context all drift towards the example that was used while
 * writing them, and the second real market reveals it. These two are chosen to have as
 * little in common as two markets can:
 *
 *   **surcharge** is stateless per trade and reactive. It looks at the size of the swap
 *   in front of it, charges accordingly, splits the proceeds between two sinks, and
 *   keeps one counter. Its only history is a streak and a lifetime total.
 *
 *   **epoch** is periodic and competitive. It divides time into hours, ranks traders
 *   inside each hour, pays the winner from a pool, and has a rule that fires when
 *   *nothing* happens. Its state is a leaderboard, which cannot be a counter, and its
 *   trigger is an absence, which cannot be a swap callback alone.
 *
 * What that difference exercises: one needs a fee override and two accumulators, the
 * other needs epoch arithmetic, a per-epoch winner, a pull-based payout and a timeout.
 * A pipeline that only handles the first will fail on the second in a way that is
 * obvious rather than subtle.
 *
 * These are *specifications and prompts*, not implementations. The Solidity is the
 * generator's job — writing it here and calling the result generation would prove
 * nothing at all.
 */

import type { MarketSpecification } from "./spec.js";

export interface MarketFixture {
  readonly key: string;
  /** What a creator would type into the launch flow. */
  readonly prompt: string;
  readonly name: string;
  readonly symbol: string;
  /**
   * The specification a competent interpretation produces.
   *
   * Used to drive the stages after interpretation without a model, and as the yardstick
   * for a live run: a model that returns something structurally unlike this from the
   * same prompt has misunderstood it.
   */
  readonly specification: MarketSpecification;
}

/** Reactive, per-trade, two sinks and a streak. */
export const SURCHARGE: MarketFixture = {
  key: "surcharge",
  name: "Canopy",
  symbol: "CNPY",
  prompt:
    "Launch CNPY with a 0.5% base fee. If somebody sells more than 1% of current liquidity, " +
    "charge an additional 2% and use it for buybacks. Track consecutive buys. After 10 buys " +
    "without a sell, make the next trade hook-fee-free and reset the counter. At $1M cumulative " +
    "volume permanently reduce the base fee to 0.25%.",
  specification: {
    version: 1,
    name: "Canopy",
    symbol: "CNPY",
    summary: "Large sells fund buybacks; every tenth buy in a streak trades free",
    baseFeePpm: 5_000,
    // 0.5% base plus the 2% surcharge: the most any single trade can pay.
    maxFeePpm: 25_000,
    phases: [
      { name: "launch", description: "Before the volume milestone", transitionsTo: ["mature"] },
      { name: "mature", description: "After $1M cumulative volume", terminal: true },
    ],
    state: [
      { name: "consecutiveBuys", type: "counter", description: "Buys since the last sell", initial: 0 },
      { name: "buybackReserve", type: "accumulator", description: "Quote asset held for buybacks" },
      { name: "cumulativeVolume", type: "accumulator", description: "Lifetime quote volume" },
      {
        name: "baseFeeReduced",
        type: "boolean",
        description: "Set when the milestone lowers the base fee",
        initial: false,
        writeOnce: true,
      },
    ],
    rules: [
      {
        id: "large-sell-surcharge",
        title: "LARGE SELL SURCHARGE",
        when: { kind: "sell", description: "Somebody sells into the pool" },
        conditions: [
          {
            kind: "tradeSizeVsLiquidity",
            description: "The sell exceeds 1% of current pool liquidity",
            parameters: { operator: ">", percent: 1 },
          },
        ],
        then: [
          { kind: "extraFee", description: "Charge an additional 2%", parameters: { feePpm: 20_000 } },
          {
            kind: "routeFee",
            description: "Send the surcharge to the buyback reserve",
            parameters: { destination: "buybackReserve", share: 100 },
            writes: ["buybackReserve"],
          },
        ],
      },
      {
        id: "buy-streak",
        title: "BUY STREAK",
        when: { kind: "buy", description: "Somebody buys from the pool" },
        conditions: [
          {
            kind: "consecutiveCount",
            description: "Ten buys have happened with no sell between them",
            parameters: { state: "consecutiveBuys", operator: ">=", value: 10 },
          },
        ],
        then: [
          { kind: "waiveFee", description: "This trade pays no hook fee" },
          {
            kind: "resetCounter",
            description: "Start the streak again",
            parameters: { state: "consecutiveBuys" },
            writes: ["consecutiveBuys"],
          },
        ],
      },
      {
        id: "volume-milestone",
        title: "VOLUME MILESTONE",
        when: {
          kind: "volumeThreshold",
          description: "Cumulative volume reaches $1M",
          parameters: { amountUsd: 1_000_000 },
        },
        conditions: [],
        onceOnly: true,
        then: [
          {
            kind: "setFee",
            description: "Permanently reduce the base fee to 0.25%",
            parameters: { feePpm: 2_500 },
            writes: ["baseFeeReduced"],
          },
          {
            kind: "transitionPhase",
            description: "Enter the mature phase",
            parameters: { phase: "mature" },
          },
        ],
      },
    ],
    invariants: [
      {
        id: "fee-ceiling",
        statement: "The total hook-imposed fee never exceeds 3%",
        expression: "hookFeePpm <= 30000",
      },
      {
        id: "reserve-conserved",
        statement: "Everything routed to the buyback reserve is present in its balance",
      },
      {
        id: "milestone-irreversible",
        statement: "Once the base fee is reduced it never rises again",
      },
    ],
    externalDependencies: [],
    assumptions: [
      // Both settled: a fixture stands for a specification that has already been through
      // the conversation, so the readings that would have been questions are marked as
      // agreed rather than left to be asked again.
      {
        id: "large-sell",
        term: "large sell",
        interpretation: "A sell larger than 1% of the pool's current liquidity",
        why: "The prompt says large without saying large compared to what.",
        parameters: { percent: 1 },
        importance: "high",
        confirmed: true,
      },
      {
        id: "volume-denomination",
        term: "$1M volume",
        interpretation: "Cumulative quote-asset volume, valued at the launch price",
        why: "A dollar figure needs something on chain to measure it in.",
        importance: "high",
        confirmed: true,
      },
    ],
    ambiguities: [],
    suggestions: [],
    unsupported: [],
  },
};

/** Periodic, competitive, with a rule that fires when nothing happens. */
export const EPOCH: MarketFixture = {
  key: "epoch",
  name: "Regent",
  symbol: "KING",
  prompt:
    "Every hour, whoever buys the most becomes the King for that hour. 20% of all trading " +
    "fees go into a reward pool, and at the end of each hour the King can claim what the pool " +
    "collected during it. If nobody buys for 15 minutes, the current pool becomes claimable by " +
    "the last buyer instead, and the hour restarts.",
  specification: {
    version: 1,
    name: "Regent",
    symbol: "KING",
    summary: "The largest buyer each hour claims 20% of that hour's fees",
    baseFeePpm: 10_000,
    // No rule raises the fee; a fifth of it is redirected rather than added.
    maxFeePpm: 10_000,
    phases: [],
    state: [
      { name: "currentEpoch", type: "counter", description: "Hours since the market opened", initial: 0 },
      { name: "epochStartedAt", type: "timer", description: "When the current hour began" },
      { name: "epochLeader", type: "address", description: "Largest buyer in the current hour" },
      { name: "epochLeaderVolume", type: "amount", description: "What the leader has bought this hour" },
      { name: "rewardPool", type: "accumulator", description: "Fees set aside for the current hour" },
      { name: "lastBuyAt", type: "timer", description: "When the most recent buy happened" },
      { name: "lastBuyer", type: "address", description: "Who made the most recent buy" },
      {
        name: "claimable",
        type: "accumulator",
        description: "Rewards owed per wallet, withdrawn rather than pushed",
      },
    ],
    rules: [
      {
        id: "fee-to-pool",
        title: "REWARD POOL",
        when: { kind: "swap", description: "Any trade happens" },
        conditions: [],
        then: [
          {
            kind: "routeFee",
            description: "A fifth of the fee joins this hour's reward pool",
            parameters: { destination: "rewardPool", share: 20 },
            writes: ["rewardPool"],
          },
        ],
      },
      {
        id: "leaderboard",
        title: "HOURLY KING",
        when: { kind: "buy", description: "Somebody buys from the pool" },
        conditions: [
          {
            kind: "tradeSizeAbsolute",
            description: "The buy is larger than the current leader's total for this hour",
            parameters: { operator: ">", state: "epochLeaderVolume" },
          },
        ],
        then: [
          {
            kind: "setLeader",
            description: "The buyer becomes King for the rest of the hour",
            parameters: { state: "epochLeader" },
            writes: ["epochLeader", "epochLeaderVolume", "lastBuyer", "lastBuyAt"],
          },
        ],
      },
      {
        id: "epoch-settlement",
        title: "HOUR ENDS",
        when: {
          kind: "timeElapsed",
          description: "An hour has passed since the current one began",
          parameters: { seconds: 3_600 },
        },
        conditions: [],
        then: [
          {
            kind: "creditReward",
            description: "The hour's pool becomes claimable by the King",
            parameters: { recipient: "epochLeader" },
            writes: ["claimable", "rewardPool"],
          },
          {
            kind: "startEpoch",
            description: "A new hour begins with an empty pool and no King",
            writes: ["currentEpoch", "epochStartedAt", "epochLeader", "epochLeaderVolume"],
          },
        ],
      },
      {
        id: "inactivity-payout",
        title: "QUIET MARKET",
        when: {
          kind: "inactivity",
          description: "Fifteen minutes pass with no buy",
          parameters: { seconds: 900 },
        },
        conditions: [],
        then: [
          {
            kind: "creditReward",
            description: "The pool becomes claimable by the last buyer instead",
            parameters: { recipient: "lastBuyer" },
            writes: ["claimable", "rewardPool"],
          },
          {
            kind: "startEpoch",
            description: "The hour restarts",
            writes: ["currentEpoch", "epochStartedAt", "epochLeader", "epochLeaderVolume"],
          },
        ],
      },
    ],
    invariants: [
      {
        id: "fee-ceiling",
        statement: "The total hook-imposed fee never exceeds 3%",
        expression: "hookFeePpm <= 30000",
      },
      {
        id: "pool-conserved",
        statement: "Every unit that enters the reward pool is either still in it or claimable",
      },
      {
        id: "one-king",
        statement: "An hour has at most one King, and the pool for an hour is credited once",
      },
    ],
    externalDependencies: [],
    assumptions: [
      {
        id: "largest-buyer",
        term: "buys the most",
        interpretation: "The largest single buy in the hour, not the cumulative total",
        why: "Both readings are ordinary English and they crown different wallets.",
        importance: "high",
        confirmed: true,
      },
      {
        id: "settlement-trigger",
        term: "at the end of each hour",
        interpretation:
          "Settled lazily on the first trade after the hour ends, because the EVM cannot " +
          "wake itself up on a timer",
        why: "Nothing on chain runs on a clock, so the hour has to end on somebody's trade.",
        importance: "high",
        confirmed: true,
      },
      {
        id: "claim-not-push",
        term: "can claim",
        interpretation: "The King withdraws the reward; it is not sent automatically",
        why: "The prompt says claim, which is a pull.",
        importance: "low",
      },
    ],
    ambiguities: [],
    suggestions: [],
    unsupported: [],
  },
};

export const FIXTURES: readonly MarketFixture[] = [SURCHARGE, EPOCH];
