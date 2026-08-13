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

/**
 * Where the boundaries of an Agen launch's three bands fall, in ticks below the
 * opening price.
 *
 * Agen launches on the same grid as Verdant — same spacing, same usable bounds —
 * but it spreads the supply over three one-sided ranges rather than one, and
 * these are the two boundaries between them. 18 000 ticks is 6.049x of price and
 * 36 800 is 39.65x; both are multiples of `TICK_SPACING`, so the boundaries are
 * exactly representable rather than nearly.
 *
 * The Solidity definition is `AgenCurve.sol`, and this is the TypeScript one, for
 * the same reason `VerdantConstants.sol` and this file both exist: Solidity cannot
 * import from TypeScript. The geometry itself was chosen by simulation in
 * `apps/agen/scripts/curve.ts`, which remains the place to change it — a boundary
 * moved without recomputing the allocations that go with it silently changes the
 * depth of all three bands.
 *
 * The allocations are not here because nothing off chain needs them: the factory
 * splits the supply, and no interface has cause to say which fraction went where.
 */
export const AGEN_BAND_WIDTHS = {
  /** The fast opening band, which the pool opens at the top of. */
  opening: 18_000,
  /** The middle band. Its floor must stay strictly above the tail's. */
  middle: 36_800,
} as const;

/**
 * What every Agen launch is, before anybody configures anything.
 *
 * An Agen market is standardised: the same supply, the same opening valuation, the same
 * three one-sided locked bands, no paired asset. None of it is a creator's decision, and
 * the launch screen no longer asks — a form field for the opening valuation was asking
 * somebody to price a token that has never traded, which is a question with no method
 * behind it, and two markets launched at different valuations are not comparable on any
 * page that lists them both.
 *
 * ## Why the numbers live here
 *
 * Solidity cannot import from TypeScript, so `AgenCurve.sol` holds the geometry the chain
 * enforces and this holds the geometry everything else reads. That is two definitions of
 * one thing, which is a duplication with a test against it rather than a duplication
 * nobody noticed: see the parity test in `packages/sdk`. What is *not* duplicated is the
 * supply and the opening valuation, which appear once, here, and are read by the
 * compiler, the launch route and the interface alike.
 */
export const AGEN_LAUNCH = {
  /**
   * Whole tokens, before the 1e18 scale. Every Agen market has exactly this many.
   *
   * The same figure as `BOUNDS.token.defaultTotalSupplyTokens`, which is Verdant's
   * default for a configurable supply. Agen's is not configurable, which is why it is
   * stated separately rather than borrowed: the two are equal today and mean different
   * things, and a market compiler reading "the default" would silently follow Verdant if
   * that default ever moved.
   */
  supplyTokens: 1_000_000_000n,

  /**
   * What the whole supply is worth, in wei, the moment the pool opens.
   *
   * Every Agen market opens here. Denominated in the quote asset rather than in dollars,
   * which was considered and rejected: a dollar baseline needs a rate, chain 4663 has no
   * oracle to read one from, and taking it from an exchange would put a third party's
   * uptime between a creator and their launch. Ether is the unit the pool is priced in
   * and the only one that is exact.
   *
   * ## It is a baseline, not the opening market cap
   *
   * This is the price before anybody trades. A creator's initial buy moves along the
   * curve like any other buy, so a market launched with one opens above this — the only
   * influence anybody has over where their market actually starts.
   */
  valuationWei: 1_500_000_000_000_000_000n,

  /**
   * The depth of the opening band, in ether of buying pressure to cross it.
   *
   * Not read by anything: the allocation that produces it is `AgenCurve.OPENING_BPS`, and
   * this is the number that allocation was chosen to hit. Recorded because a reader
   * asking "how deep does it open" cannot answer it from 1 484 basis points, and because
   * the simulation that picked it (`apps/agen/scripts/curve.ts`) is otherwise the only
   * place the intent is written down.
   */
  openingDepthEth: 0.25,
} as const;

/** Native ETH is always currency0, so no address sorting is ever required (D4). */
export const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000" as const;

export const MARKET_MODELS = ["fixed", "progressive", "evergreen"] as const;
export type MarketModel = (typeof MARKET_MODELS)[number];

/** Sentinel for a permanent liquidity lock: type(uint32).max. */
export const PERMANENT_LOCK = 4_294_967_295 as const;

/**
 * Ceiling on the protocol's share of a market's fee revenue.
 *
 * `ModelRegistry` sets `protocolBps` for future markets and each market
 * snapshots it at creation, so this is the bound that limits what the registry
 * owner can ever take. It is enforced in `ModelRegistry` as an immutable
 * constructor argument, not only asserted here.
 */
export const MAX_PROTOCOL_BPS = 2_000 as const;

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
    /**
     * The denominator, and the sum the three shares must come to. Asserted by
     * the factory on the *derived* creator share rather than validated as three
     * independent inputs — see docs/decisions/005-splits-belong-to-the-splitter.md.
     */
    total: 10_000,
    /**
     * Set by ModelRegistry and snapshotted per market at creation. The cap is
     * enforced in the contract as well as here, so the registry cannot
     * confiscate a future market's economics.
     */
    protocolBps: { min: 0, max: MAX_PROTOCOL_BPS, default: 1_000 },
    /**
     * Zero in v1. Only Evergreen unlocks a reserve share, and the floor below
     * applies where it is unlocked — `MODEL_BOUNDS.fixed` and
     * `MODEL_BOUNDS.progressive` pin it to `{ min: 0, max: 0 }`.
     */
    reserveBps: { min: 1_000, max: 8_000 },
    /**
     * There is deliberately no `creatorBps` here. The creator share is
     * `total - protocolBps - reserveBps`, which leaves the creator nothing to
     * choose and nothing to get wrong. It was previously an input with its own
     * cap of 8 000, which could not be reconciled with the sum: for Fixed and
     * Progressive, where the reserve is 0, the only split reaching 10 000 would
     * have been exactly 8 000/2 000, and the register's own defaults
     * (5 000 + 1 000 + 2 000) came to 8 000 rather than 10 000.
     */
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
  /**
   * Disabled in v1, and the two facts below are really one fact.
   *
   * Evergreen is the model whose fees partly reinforce the locked position, so
   * its `reserveBps` floor is 1 000 — an Evergreen market that reserved nothing
   * would be a Progressive market wearing another name. But v1 has no consumer
   * for a reserve share: `reinforce()` does not exist yet, so `VerdantFactory`
   * asks the registry `creationAllowed(model, stages, 0)` with the reserve pinned
   * to zero (ADR-005). Zero is below the floor, so every Evergreen creation is
   * refused.
   *
   * Left enabled, that combination is worse than useless: the interface reads
   * `enabled` to decide what to offer, so it would advertise a model whose every
   * launch reverts. `BoundsParity.t.sol` asserts the general form — an enabled
   * model must be creatable with the reserve share v1 actually passes — so
   * re-enabling this without shipping `reinforce()` fails a test rather than
   * reaching a creator.
   */
  evergreen: {
    enabled: false,
    minStages: 1,
    maxStages: 8,
    reserveBps: BOUNDS.splits.reserveBps,
  },
} as const satisfies Record<MarketModel, ModelBounds>;

export type Bounds = typeof BOUNDS;
export type ModelBoundsMap = typeof MODEL_BOUNDS;
