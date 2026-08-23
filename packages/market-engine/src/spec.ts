/**
 * `AgenMarketSpec` v1 — the closed vocabulary, and the canonical form it normalizes to.
 *
 * Two types, and the distinction between them is the whole design.
 *
 * `AgenMarketSpec` is what a model is allowed to say. Every discriminant is a closed
 * union, every number arrives in the units a person wrote it in, and there is no field
 * whose meaning depends on prose. It is deliberately shaped like the sentences a
 * creator actually writes — a base rate, how it changes, what large trades pay, where
 * the money goes — because a schema that mirrors the request is one a model can fill in
 * without inventing structure.
 *
 * `CanonicalConfig` is what the engine runs. It is the authoritative representation:
 * review cards, the execution graph, the simulator, the encoder, the commitment hash
 * and the Solidity all read this and nothing else. Normalization is allowed to change
 * how the same economics are written down; it is not allowed to change the economics.
 *
 * ## What v1 deliberately does not have
 *
 * Recorded here rather than discovered by a creator. Each of these is a specific
 * `UNSUPPORTED` with a reason, not a gap:
 *
 *  - **Wallet primitives.** Cooldowns, per-wallet caps, per-wallet counters. They need
 *    the trader's identity, and v4 reports the router as the sender. Agen can only
 *    learn the real trader through `AgenRouter`'s `hookData`, so any such rule binds
 *    router-routed trades and is bypassed by a direct `PoolManager` swap. A limit that
 *    a determined trader can step around is worse than no limit, because it reads like
 *    a promise on the review screen.
 *
 *  - **Burn and buyback.** The fee is captured in the quote asset. Burning the quote
 *    asset destroys a real asset rather than the launched token, and burning the
 *    launched token means buying it first — a swap inside a swap, on the swap path, in
 *    a contract that cannot be changed after deployment.
 *
 *  - **LP incentives as a recipient.** There is a clean way to do this (charge the LP
 *    share as an actual v4 LP fee and take only the remainder as a delta) and it
 *    changes which currency each share is paid in, because v4 takes an LP fee from the
 *    input side. That is a real design with a real answer and it is not v1.
 *
 *  - **Stage-scoped size tiers.** "For the first hour, large sells pay 6%" needs a tier
 *    that is only live in one stage. Expressible, but it multiplies the evaluation
 *    matrix and every boundary that goes with it.
 *
 *  - **Dollar-denominated volume.** There is no price oracle on chain 4663 and quote
 *    assets are ether or first-party equity tokens. See `UNSUPPORTED_TRIGGER`.
 */

import type { Address } from "viem";

// --- the units values arrive in -------------------------------------------

/**
 * A percentage exactly as a person writes it: `"2"`, `"0.5"`, `"1.25"`.
 *
 * A string rather than a number, and this is load-bearing. `0.5` has already been
 * through JSON and a binary float by the time it reaches us, and `2.675 * 10_000` is
 * 26749.999999999996. Carrying the decimal digits means `percentToPpm` converts exactly
 * and refuses anything finer than one ppm instead of rounding into a rate nobody chose.
 */
export type PercentText = string;

/**
 * A non-negative integer as a decimal string.
 *
 * Token supplies and quote amounts exceed `Number.MAX_SAFE_INTEGER` routinely — a 1e9
 * supply at 18 decimals is 1e27 — so they never travel as JSON numbers.
 */
export type IntegerText = string;

// --- closed vocabulary ----------------------------------------------------

/**
 * Which direction a trade goes, defined by what the trader receives or sends.
 *
 * `BUY` is the trader receiving the launched token; `SELL` is the trader sending it.
 * Never inferred from `zeroForOne`, which only says which pool currency is the input
 * and means the opposite thing depending on which side of the pair the launched token
 * sorted onto. `orientation.ts` owns that translation.
 */
export type Side = "BUY" | "SELL";

/** How a size threshold compares. Normalized away entirely — see `CanonicalTier`. */
export type Operator = "GT" | "GTE";

/** Which axis a fee ladder advances along. */
export type LadderAxis = "TIME" | "QUOTE_VOLUME";

/** A rate that may differ by direction. Equal buy and sell is the ordinary case. */
export interface SidedRate {
  readonly buy: PercentText;
  readonly sell: PercentText;
}

/**
 * How a trade's size is measured.
 *
 * `PERCENT_REFERENCE_SUPPLY` is a percentage of the launched token's frozen supply,
 * never of pool reserves, LP position size or quote-side value. The name says
 * "reference" rather than "total" because the value is captured once at launch and
 * never read again: a runtime `totalSupply()` on the swap path would make the meaning of
 * every threshold depend on a call the engine does not control.
 */
export type SizeMeasure =
  | {
      readonly kind: "PERCENT_REFERENCE_SUPPLY";
      readonly percent: PercentText;
      readonly operator: Operator;
    }
  | {
      readonly kind: "ABSOLUTE_TOKENS";
      readonly tokens: IntegerText;
      readonly operator: Operator;
    };

/** The same measurement without a comparison, for a ceiling. */
export type SizeAmount =
  | { readonly kind: "PERCENT_REFERENCE_SUPPLY"; readonly percent: PercentText }
  | { readonly kind: "ABSOLUTE_TOKENS"; readonly tokens: IntegerText };

/** A size-gated rate: trades on this side at or past this size pay this instead. */
export interface SizeTier {
  readonly side: Side;
  readonly measure: SizeMeasure;
  readonly rate: PercentText;
}

/** A stage of a time ladder. `afterSeconds` is measured from pool initialisation. */
export interface TimeStage {
  readonly afterSeconds: number;
  readonly rate: SidedRate;
}

/** A stage of a volume ladder, in the quote asset's own base units. */
export interface VolumeStage {
  readonly afterQuoteAmount: IntegerText;
  readonly rate: SidedRate;
}

/**
 * How the base rate changes, or `null` for a market with one rate forever.
 *
 * One axis per market in v1. A market whose rate depends on both elapsed time and
 * cumulative volume has an ordering question with no obvious answer — does the later
 * trigger win, or the higher rate, or the first to fire — and guessing it is exactly the
 * kind of invention this engine exists to refuse. Such a request is
 * `UNSUPPORTED_COMBINATION`.
 */
export type FeeLadder =
  | { readonly axis: "TIME"; readonly stages: readonly TimeStage[] }
  | { readonly axis: "QUOTE_VOLUME"; readonly stages: readonly VolumeStage[] };

/**
 * Who receives a share of the collected fee.
 *
 * Closed by construction, and none of these variants carries calldata, a call target or
 * a selector. `ADDRESS` is a plain destination the engine credits; it is never called
 * into, so a recipient cannot be a contract that reenters, reverts the swap, or
 * consumes unbounded gas.
 */
export type Recipient =
  | { readonly kind: "CREATOR" }
  | { readonly kind: "TREASURY" }
  | { readonly kind: "ADDRESS"; readonly address: Address };

/** One leg of the split. Shares are percentages of the collected fee. */
export interface DistributionShare {
  readonly recipient: Recipient;
  readonly share: PercentText;
}

/**
 * A ceiling on one trade's size. The only protection in v1.
 *
 * Included because it needs no identity, no storage and no history: one comparison
 * against a number frozen at launch. A trade above the ceiling reverts, which is the
 * whole point of a ceiling and is the one place in the engine where the swap path is
 * allowed to fail deliberately.
 */
export interface MaxTradeSize {
  readonly kind: "MAX_TRADE_SIZE";
  readonly side: Side | "BOTH";
  readonly amount: SizeAmount;
}

export type Protection = MaxTradeSize;

/** The economics of a programmable market, as a model is permitted to state them. */
export interface AgenMarketSpec {
  readonly engineVersion: 1;
  /** The rate before any stage or tier applies. Required: never defaulted. */
  readonly baseRate: SidedRate;
  readonly ladder: FeeLadder | null;
  readonly sizeTiers: readonly SizeTier[];
  readonly distribution: readonly DistributionShare[];
  readonly protections: readonly Protection[];
}

// --- what the launch supplies, not the model ------------------------------

/**
 * The facts a launch knows and a prompt does not.
 *
 * Kept out of `AgenMarketSpec` on purpose: a model that could state the reference
 * supply could state the wrong one, and the supply is what every percentage threshold
 * is measured against. It comes from the token the factory is about to deploy.
 */
export interface MarketBinding {
  /** The launched token's whole supply, in its own base units. Frozen at launch. */
  readonly referenceSupply: bigint;
  readonly quoteAsset: QuoteAssetBinding;
  /**
   * The launched token's ticker, for naming the fee currency to a creator.
   *
   * Display only, and deliberately outside the commitment hash for the same reason the
   * quote asset's symbol and decimals are: a ticker is not economics. What is in the hash
   * is `feeCurrency` itself, which decides which asset arrives.
   */
  readonly launchedTokenSymbol: string;
}

export interface QuoteAssetBinding {
  /**
   * The quote asset, as v4 identifies it.
   *
   * The zero address is **native Robinhood Chain ETH**, which is v4's own representation of
   * native currency and not a token contract. It is deliberately not modelled as an ERC-20
   * and there is no wrapping anywhere: a market quoted in ETH is quoted in ETH, its vault
   * holds ETH when the derivation says so, and a creator never sees WETH.
   */
  readonly address: Address;
  /** `ETH`, `NVDA`. Used to denominate volume thresholds in the interface. */
  readonly symbol: string;
  readonly decimals: number;
}

/** Whether a binding names native currency rather than a token. */
export function isNativeQuote(quoteAsset: QuoteAssetBinding): boolean {
  return /^0x0{40}$/i.test(quoteAsset.address);
}

// --- the canonical form ---------------------------------------------------

/**
 * A stage of the canonical ladder.
 *
 * Stage 0 always exists and always has threshold 0 — it is the base rate, expressed as
 * the first stage rather than as a separate field. That unification is why there is no
 * precedence question between "the base fee" and "the ladder": there is only the ladder,
 * and a market with one rate is a ladder with one stage.
 */
export interface CanonicalStage {
  /** Seconds since initialisation on `TIME`, quote base units on `QUOTE_VOLUME`, 0 for stage 0. */
  readonly threshold: bigint;
  readonly buyFeePpm: number;
  readonly sellFeePpm: number;
}

/**
 * A canonical size tier. The comparison is always `>=`.
 *
 * `GT T` became `GTE T + 1`, which is exact rather than approximate because token
 * amounts are integers: no amount lies strictly between `T` and `T + 1`. Normalizing the
 * operator away means the runtime has one comparison instead of two, and the Solidity
 * cannot disagree with the TypeScript about which of `>` and `>=` a tier meant.
 */
export interface CanonicalTier {
  readonly thresholdTokens: bigint;
  readonly feePpm: number;
}

export interface CanonicalShare {
  readonly recipient: Recipient;
  readonly sharePpm: number;
}

/**
 * Which asset a market's fees are collected and paid out in.
 *
 * Not a creator's choice and not a model's — the compiler derives it, because it is forced
 * by which of v4's two callbacks can settle a fee at the moment the rule deciding that fee
 * is evaluable. `orientation.ts` sets out the table in full. In short: a market with size
 * tiers has to collect in the launched token, because a tier is measured on the token leg
 * and the fee has to be taken from a leg that is known at the same time; a market without
 * tiers collects in the quote asset, which is what a creator would rather hold.
 *
 * Deterministic, fixed at launch, inside the commitment hash, and stated outright on the
 * review card.
 */
export type FeeCurrency = "QUOTE" | "TOKEN";

/**
 * The authoritative representation of a programmable market.
 *
 * Everything downstream reads this. If two things about a market can disagree, one of
 * them is not reading this.
 */
export interface CanonicalConfig {
  readonly engineVersion: 1;
  readonly referenceSupply: bigint;
  readonly quoteAsset: QuoteAssetBinding;
  /** Display only, outside the commitment. See `MarketBinding.launchedTokenSymbol`. */
  readonly launchedTokenSymbol: string;
  /** Derived, never stated. See `FeeCurrency`. */
  readonly feeCurrency: FeeCurrency;
  /** `null` when the market has a single stage and therefore no axis at all. */
  readonly ladderAxis: LadderAxis | null;
  /** At least one, ordered by threshold ascending, first threshold always 0. */
  readonly stages: readonly CanonicalStage[];
  /** Ascending by threshold. The last one whose threshold is met wins. */
  readonly buyTiers: readonly CanonicalTier[];
  readonly sellTiers: readonly CanonicalTier[];
  /** Ordered canonically, totalling exactly `PPM_ONE`. */
  readonly distribution: readonly CanonicalShare[];
  readonly maxBuyTokens: bigint | null;
  readonly maxSellTokens: bigint | null;
}
