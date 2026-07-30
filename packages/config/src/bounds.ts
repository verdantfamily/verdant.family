/**
 * Parameter bounds — DATA ONLY.
 *
 * This file is the single source of truth for every bound in the protocol. It
 * is transcribed from the parameter register in the architecture document
 * (§19.1) and is consumed in three places that must never disagree:
 *
 *   1. the Zod schemas in @verdant/sdk
 *   2. the ModelRegistry deployment script (bounds are written on-chain)
 *   3. VerdantHook's re-validation at beforeInitialize
 *
 * A bound that appears in only one of those places is a bug. The SDK re-reads
 * the on-chain values at runtime and warns loudly on drift.
 *
 * Units:
 *   ppm      hundredths of a basis point — Uniswap's LP fee unit. 10_000 = 1%.
 *            MAX_LP_FEE in v4 is 1_000_000 (100%); Verdant caps far below it.
 *   bps      1/10_000.
 *   seconds  all durations. Never blocks — on Arbitrum Orbit chains
 *            `block.number` is the L1 block number (see docs/verification.md V7).
 */

export const SECONDS = {
  minute: 60,
  hour: 60 * 60,
  day: 24 * 60 * 60,
} as const;

/** Uniswap's LP fee ceiling, for reference. Verdant never approaches it. */
export const MAX_LP_FEE_PPM = 1_000_000 as const;

/** `PoolKey.fee` sentinel selecting a dynamic-fee pool. */
export const DYNAMIC_FEE_FLAG = 0x800000 as const;

/** Flag OR-ed into a fee returned from beforeSwap to override the stored fee. */
export const OVERRIDE_FEE_FLAG = 0x400000 as const;

/**
 * The tick spacing for every Verdant pool. A constant, not a parameter:
 * `VerdantHook.beforeInitialize` re-asserts it, so a pool with any other spacing
 * cannot be created through the hook.
 *
 * 200 rather than 60 — see docs/decisions/001-tick-spacing.md. Briefly: it is
 * this chain's convention by 23:1 in a 1 566-pool sample, it crosses materially
 * fewer initialized ticks per swap on markets that move in multiples, and the
 * granularity given up (2.02% per step against 0.60%) is irrelevant at the range
 * widths Verdant creates.
 *
 * This is the only definition of a tick spacing in the repository. Nothing else
 * may hardcode one; `packages/sdk/src/config.test.ts` enforces that.
 */
export const TICK_SPACING = 200 as const;

/** v4's own tick bound, `TickMath.MAX_TICK`. Not itself a multiple of 200. */
export const MAX_TICK_ABSOLUTE = 887_272 as const;

/**
 * The widest ticks a Verdant pool can actually use: the largest multiples of
 * TICK_SPACING lying strictly inside v4's ±887 272.
 *
 * `887272 / 200 = 4436.36`, so `4436 x 200 = 887200`. At spacing 60 these would
 * have been ±887 220, which is why the constants moved rather than merely the
 * spacing.
 */
export const MIN_USABLE_TICK = -887_200 as const;
export const MAX_USABLE_TICK = 887_200 as const;

/** Full-range bounds, as a pair, for the callers that want one value. */
export const TICK_BOUNDS = {
  min: MIN_USABLE_TICK,
  max: MAX_USABLE_TICK,
} as const;

/** Native ETH is always currency0, so no address sorting is ever required (D4). */
export const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000" as const;

export const MARKET_MODELS = ["fixed", "progressive", "evergreen"] as const;
export type MarketModel = (typeof MARKET_MODELS)[number];

/** Sentinel for a permanent liquidity lock: type(uint32).max. */
export const PERMANENT_LOCK = 4_294_967_295 as const;

export const BOUNDS = {
  token: {
    nameLength: { min: 1, max: 32 },
    symbolLength: { min: 1, max: 11 },
    /** Hard-coded in the token constructor; non-18 breaks all price derivation. */
    decimals: 18,
    /** Whole tokens, before the 1e18 scale. */
    totalSupplyTokens: { min: 1_000_000n, max: 1_000_000_000_000_000n },
    defaultTotalSupplyTokens: 1_000_000_000n,
    creatorAllocationBps: { min: 0, max: 2_000, default: 0 },
    metadataUriLength: { min: 0, max: 256 },
    defaultMetadataMutable: true,
  },

  vesting: {
    /** 0 means no vesting at all; otherwise the duration floor applies. */
    duration: { min: 30 * SECONDS.day, max: 730 * SECONDS.day, default: 0 },
    /** Cliff must not exceed duration, or the allocation locks forever. */
    cliff: { min: 0, default: 0 },
    /**
     * A zero-duration allocation is an instant unlock. Flagged `severe` in the
     * preview when the allocation exceeds this share of supply.
     */
    instantUnlockWarnAboveBps: 500,
  },

  schedule: {
    stageCount: { min: 1, max: 8, default: 1 },
    /** Stage 0's offset must be exactly 0. */
    firstOffset: 0,
    /** Seconds after the pool's initTime. */
    startOffset: { min: 0, max: 730 * SECONDS.day },
    /**
     * Minimum spacing between consecutive stages. Chosen to sit well outside
     * any plausible L2 timestamp drift; sub-minute stages would also be
     * unobservable and would invite timing games.
     *
     * OPEN: the actual drift bound is not yet cited (V6).
     */
    minStageGap: 5 * SECONDS.minute,
    feePpm: { min: 100, max: 100_000, default: 10_000 },
  },

  splits: {
    /** Every split must sum to exactly this. */
    total: 10_000,
    creatorBps: { min: 0, max: 8_000, default: 5_000 },
    /** Set by ModelRegistry and snapshotted per market at creation. */
    protocolBps: { min: 0, max: 2_000, default: 1_000 },
    /** Zero unless the model is evergreen, where the floor applies. */
    reserveBps: { min: 1_000, max: 8_000, default: 2_000 },
  },

  liquidity: {
    tickSpacing: TICK_SPACING,
    tick: TICK_BOUNDS,
    /** Share of total supply that must go into the initial position. */
    tokenShareBps: { min: 6_000, max: 10_000 },
    /** Refuse locks shorter than this outright; a short lock is a rug vector. */
    lockDuration: { min: 180 * SECONDS.day },
    defaultLockPermanent: true,
    /** Require explicit confirmation above this price impact. */
    priceImpactConfirmBps: 500,
  },

  creation: {
    deadline: { max: SECONDS.hour, default: 20 * SECONDS.minute },
  },

  trading: {
    defaultSlippageBps: 50,
    /**
     * A swap submitted within this window of a stage transition may execute
     * under either fee, so quote at the worse of the two and say so.
     */
    transitionBoundaryWindow: 60,
  },
} as const;

export interface ModelBounds {
  /** A disabled model is rejected by the registry, not hidden by the UI. */
  readonly enabled: boolean;
  readonly minStages: number;
  readonly maxStages: number;
  /** `{ min: 0, max: 0 }` means the model forbids a reserve share entirely. */
  readonly reserveBps: { readonly min: number; readonly max: number };
}

/**
 * Per-model view of which parameters are unlocked, mirroring §5.2. The hook
 * re-validates model-specific field usage, so this is a UI and validation
 * convenience, not the enforcement point.
 *
 * The `satisfies` clause is load-bearing: adding a model to MARKET_MODELS
 * without giving it bounds here is a compile error rather than a runtime gap.
 */
export const MODEL_BOUNDS = {
  fixed: {
    enabled: true,
    minStages: 1,
    maxStages: 1,
    reserveBps: { min: 0, max: 0 },
  },
  progressive: {
    enabled: true,
    minStages: 2,
    maxStages: 8,
    reserveBps: { min: 0, max: 0 },
  },
  evergreen: {
    enabled: true,
    minStages: 1,
    maxStages: 8,
    reserveBps: BOUNDS.splits.reserveBps,
  },
} as const satisfies Record<MarketModel, ModelBounds>;

export type Bounds = typeof BOUNDS;
export type ModelBoundsMap = typeof MODEL_BOUNDS;
