/**
 * What Agen is permitted to do with somebody's money.
 *
 * A policy is the boundary between interpretation and enforcement. Above it, a model reads
 * `keep this conservative but move it if you find something better` and forms an opinion about what
 * that means. Below it, nothing reads English: every decision about capital is taken against the
 * numbers in this object, and a decision that violates one of them is refused by a function that has
 * never seen the sentence it came from.
 *
 * ## The clamp is the whole design
 *
 * A policy cannot be constructed. {@link clampPolicy} is the only thing that returns one, because a
 * type nobody else can build is the only version of "the AI cannot exceed platform limits" that does
 * not depend on every future caller remembering to check. If a model proposes 100% in one position,
 * that proposal is a `PolicyProposal` — an ordinary object with no authority — and the clamp turns it
 * into a policy by cutting it down to {@link PLATFORM_LIMITS}. There is no path from a proposal to a
 * policy that skips it, and no way to widen a policy afterwards: every field is `readonly` and every
 * change goes through the clamp again.
 *
 * So the worst a compromised model can do here is ask for something it will not get. That is a
 * deliberately smaller claim than "the model is well behaved", and it is the only one worth making.
 *
 * ## Percentages, and why not dollars
 *
 * Every limit is a percentage of the managed balance rather than an amount, so a policy stays true as
 * the balance moves and nothing has to be rewritten after a deposit. Amounts are wei, as `bigint`,
 * everywhere they appear in this module family — there is no oracle on this chain that this
 * repository trusts for an ether price, so a policy denominated in dollars would be a policy whose
 * meaning depended on an unverified third party.
 */

declare const CLAMPED: unique symbol;

/** How much risk the holder said they wanted, in the only three words that carry distinct meaning. */
export type RiskProfile = "conservative" | "balanced" | "aggressive";

/**
 * How much a venue has been checked, rather than who runs it.
 *
 * A tier rather than a protocol name because an allowlist of names is a list somebody has to
 * maintain in two places, and the question a policy is actually asking is "how sure are we about
 * this", not "is it the one called Aave".
 */
export type ProtocolTier = "verified" | "recognised" | "unverified";

/** The enforceable form of somebody's instructions. Only {@link clampPolicy} returns one. */
export interface Policy {
  readonly riskProfile: RiskProfile;
  /** Ceiling on any single position, as a percentage of the managed balance. */
  readonly maxPositionPct: number;
  /** Ceiling on everything scored as high risk, combined. */
  readonly maxHighRiskPct: number;
  /** Floor on what stays liquid and unencumbered. */
  readonly minCashPct: number;
  readonly allowLeverage: boolean;
  readonly allowedProtocols: readonly ProtocolTier[];
  /** Asset symbols, upper case. Empty means nothing is allowed, which is not the same as unset. */
  readonly allowedAssets: readonly string[];
  readonly maxSlippageBps: number;
  readonly maxDailyRebalances: number;
  readonly autoRebalance: boolean;
  /**
   * How much better a move has to look before it is worth making, in basis points of expected
   * annual net return, on top of what the move costs.
   */
  readonly minImprovementBps: number;
  readonly [CLAMPED]: true;
}

/** A policy as somebody or something asked for it: no authority, and every field optional. */
export type PolicyProposal = Partial<Omit<Policy, typeof CLAMPED>>;

/**
 * The ceilings no instruction can raise, from any source.
 *
 * These are not defaults and are not per-user. A holder who asks for everything in one position, and
 * a model that decides they meant it, both get {@link PLATFORM_LIMITS.maxPositionPct}. The numbers
 * are conservative on purpose: this is a first version managing other people's money, and the cost of
 * being too cautious is some forgone yield, while the cost of being too permissive is somebody's
 * balance.
 */
export const PLATFORM_LIMITS = {
  /** No single position may be more than this, however the holder phrases it. */
  maxPositionPct: 70,
  /** Everything high risk, combined. */
  maxHighRiskPct: 20,
  /** Nothing may drive the liquid floor below this. */
  minCashPct: 5,
  /** Past this, slippage stops being a tolerance and becomes the trade. */
  maxSlippageBps: 300,
  /**
   * A ceiling on churn. Every rebalance costs gas and slippage, so an automation that can move
   * eight times a day can lose money while every individual decision looks defensible.
   */
  maxDailyRebalances: 8,
  /** A move must beat its own cost by at least this much before it is worth making. */
  minImprovementBps: 100,
  /**
   * Leverage is refused at the platform level in V1, not offered as a setting.
   *
   * The spec allows for authorising it later. Until the execution path can prove it liquidates
   * safely, `allowLeverage: true` is not a configuration this system honours, and the clamp drops it
   * rather than storing a `true` that some later reader might act on.
   */
  allowLeverage: false,
} as const;

/**
 * Where each risk profile starts before anything the holder said is applied.
 *
 * Conservative is deliberately close to doing nothing: mostly liquid, one modest position, no
 * high-risk allocation at all. Somebody who says "keep this safe" and finds a fifth of it in a
 * volatile pool was not listened to, whatever the scoring model thought.
 */
const PROFILES: Record<RiskProfile, Omit<Policy, typeof CLAMPED>> = {
  conservative: {
    riskProfile: "conservative",
    maxPositionPct: 40,
    maxHighRiskPct: 0,
    minCashPct: 25,
    allowLeverage: false,
    allowedProtocols: ["verified"],
    allowedAssets: ["ETH"],
    maxSlippageBps: 50,
    maxDailyRebalances: 2,
    autoRebalance: true,
    minImprovementBps: 300,
  },
  balanced: {
    riskProfile: "balanced",
    maxPositionPct: 60,
    maxHighRiskPct: 10,
    minCashPct: 15,
    allowLeverage: false,
    allowedProtocols: ["verified", "recognised"],
    allowedAssets: ["ETH"],
    maxSlippageBps: 100,
    maxDailyRebalances: 4,
    autoRebalance: true,
    minImprovementBps: 200,
  },
  aggressive: {
    riskProfile: "aggressive",
    maxPositionPct: 70,
    maxHighRiskPct: 20,
    minCashPct: 10,
    allowLeverage: false,
    allowedProtocols: ["verified", "recognised"],
    allowedAssets: ["ETH"],
    maxSlippageBps: 200,
    maxDailyRebalances: 6,
    autoRebalance: true,
    minImprovementBps: 150,
  },
};

function bounded(value: number | undefined, fallback: number, low: number, high: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(high, Math.max(low, Math.round(value)));
}

/**
 * Asset symbols, normalised, deduplicated, and reduced to what this deployment can hold.
 *
 * Only ether. Not a placeholder for a longer list: Robinhood Chain has no stablecoin in this
 * repository's configuration, so accepting `USDC` would record a permission for an asset that does
 * not exist here, and something downstream would eventually try to honour it.
 */
const SUPPORTED_ASSETS: readonly string[] = ["ETH"];

function assets(requested: readonly string[] | undefined): readonly string[] {
  if (requested === undefined) return SUPPORTED_ASSETS;

  const kept = [...new Set(requested.map((symbol) => symbol.trim().toUpperCase()))].filter(
    (symbol) => SUPPORTED_ASSETS.includes(symbol),
  );

  // An instruction naming only assets this chain does not have leaves nothing to work with. The
  // supported set is the honest reading of "manage this" — the alternative is an empty allowlist that
  // silently means "do nothing" and reports itself as a working policy.
  return kept.length > 0 ? kept : SUPPORTED_ASSETS;
}

const TIERS: readonly ProtocolTier[] = ["verified", "recognised", "unverified"];

function protocols(
  requested: readonly ProtocolTier[] | undefined,
  profile: RiskProfile,
): readonly ProtocolTier[] {
  const fallback = PROFILES[profile].allowedProtocols;
  if (requested === undefined) return fallback;

  const kept = TIERS.filter((tier) => requested.includes(tier));
  if (kept.length === 0) return fallback;

  // Unverified venues are refused outside an aggressive mandate. Somebody who asked for caution and
  // named an unverified protocol has contradicted themselves, and the cautious half of that is the
  // half worth honouring.
  return profile === "aggressive" ? kept : kept.filter((tier) => tier !== "unverified");
}

/**
 * Turn a proposal into an enforceable policy.
 *
 * Every field is clamped independently, then the combination is checked: a per-position ceiling that
 * exceeds what is left after the cash floor is not a limit, it is arithmetic nobody can satisfy, and
 * a validator that only ever saw the fields one at a time would pass it.
 */
export function clampPolicy(proposal: PolicyProposal = {}): Policy {
  const riskProfile: RiskProfile =
    proposal.riskProfile !== undefined && proposal.riskProfile in PROFILES
      ? proposal.riskProfile
      : "balanced";

  const base = PROFILES[riskProfile];

  const minCashPct = bounded(
    proposal.minCashPct,
    base.minCashPct,
    PLATFORM_LIMITS.minCashPct,
    // A cash floor of 100% is a coherent thing to ask for — it is "stop managing, but keep the
    // account" — so the ceiling here is the whole balance rather than an arbitrary maximum.
    100,
  );

  const deployable = 100 - minCashPct;

  const maxPositionPct = Math.min(
    bounded(proposal.maxPositionPct, base.maxPositionPct, 0, PLATFORM_LIMITS.maxPositionPct),
    deployable,
  );

  const maxHighRiskPct = Math.min(
    bounded(proposal.maxHighRiskPct, base.maxHighRiskPct, 0, PLATFORM_LIMITS.maxHighRiskPct),
    // High risk is a subset of what may be deployed at all, and of what one position may hold. A
    // 20% high-risk allowance under a 10% position ceiling would otherwise permit two positions the
    // holder never agreed to.
    Math.min(deployable, maxPositionPct),
  );

  return {
    riskProfile,
    maxPositionPct,
    maxHighRiskPct,
    minCashPct,
    allowLeverage: PLATFORM_LIMITS.allowLeverage,
    allowedProtocols: protocols(proposal.allowedProtocols, riskProfile),
    allowedAssets: assets(proposal.allowedAssets),
    maxSlippageBps: bounded(
      proposal.maxSlippageBps,
      base.maxSlippageBps,
      1,
      PLATFORM_LIMITS.maxSlippageBps,
    ),
    maxDailyRebalances: bounded(
      proposal.maxDailyRebalances,
      base.maxDailyRebalances,
      0,
      PLATFORM_LIMITS.maxDailyRebalances,
    ),
    autoRebalance: proposal.autoRebalance ?? base.autoRebalance,
    minImprovementBps: bounded(
      proposal.minImprovementBps,
      base.minImprovementBps,
      PLATFORM_LIMITS.minImprovementBps,
      10_000,
    ),
  } as Policy;
}

/** The starting policy for a risk profile, clamped. */
export function profilePolicy(riskProfile: RiskProfile): Policy {
  return clampPolicy({ riskProfile });
}

/**
 * Re-clamp an existing policy with some fields changed.
 *
 * `go more aggressive` is a change to one field that should carry the rest of the profile with it, so
 * a bare override would leave a conservative cash floor on an aggressive mandate. Passing the profile
 * through the clamp again rebuilds from that profile's base and reapplies whatever the holder had
 * genuinely customised.
 */
export function revisePolicy(current: Policy, change: PolicyProposal): Policy {
  const riskProfile = change.riskProfile ?? current.riskProfile;
  const rebasing = riskProfile !== current.riskProfile;

  // On a profile change the untouched fields come from the new profile, not from the old policy.
  // Otherwise "go more aggressive" would raise the risk label and keep every limit that made the
  // account conservative, which is the opposite of what was asked.
  const carried: PolicyProposal = rebasing
    ? {}
    : {
        maxPositionPct: current.maxPositionPct,
        maxHighRiskPct: current.maxHighRiskPct,
        minCashPct: current.minCashPct,
        allowedProtocols: current.allowedProtocols,
        allowedAssets: current.allowedAssets,
        maxSlippageBps: current.maxSlippageBps,
        maxDailyRebalances: current.maxDailyRebalances,
        autoRebalance: current.autoRebalance,
        minImprovementBps: current.minImprovementBps,
      };

  return clampPolicy({ ...carried, ...change, riskProfile });
}

/** What the policy permits to be deployed at all, as a percentage. */
export function deployablePct(policy: Policy): number {
  return 100 - policy.minCashPct;
}
