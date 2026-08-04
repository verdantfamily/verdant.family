import type { MarketModel } from "./bounds.js";

/**
 * Launch models — DATA ONLY.
 *
 * A launch model is a *shape of market*: what the token is paired against, how the swap
 * fee is charged, which currency the creator earns in, and who can ever touch the launch
 * position. It is a coarser thing than the fee models in `models.ts`, which describe only
 * how the fee moves over time. A creator picks a launch model first — "ether or an
 * equity" — and a fee model second, inside it.
 *
 * Keeping the two apart is what lets a fee schedule apply to both pair types without
 * duplicating either concept, and it is why `feeModels` below is a list rather than a
 * single value.
 *
 * `status` is the honest one. It describes contract readiness, never interface
 * readiness, because a form that accepts input for a contract that cannot execute it is
 * worse than a form that is absent:
 *
 *  - `ready`    — the contracts are deployed on Robinhood Chain and verified against it,
 *                 and the arguments the form produces are the arguments they take.
 *  - `building` — the interface exists and is specified, the contract path does not yet.
 *  - `design`   — an idea with a written mechanism and no contracts at all.
 */
export type LaunchModelStatus = "ready" | "building" | "design";

export const LAUNCH_MODEL_STATUS_LABELS: Record<LaunchModelStatus, string> = {
  // Not "ready to deploy", which was true only until it was deployed.
  ready: "Live",
  building: "In progress",
  design: "Design",
};

export type LaunchModelId = "classic" | "stock-paired" | "evergreen";

export interface LaunchModelDefinition {
  readonly id: LaunchModelId;
  readonly label: string;
  readonly status: LaunchModelStatus;
  /** One sentence, on the chooser card. No performance claims. */
  readonly summary: string;
  /** What the market is quoted in, for a human: "Ether" or "A tokenized equity". */
  readonly pair: string;
  /** The fee models from `models.ts` a creator may choose inside this launch model. */
  readonly feeModels: readonly MarketModel[];
  /** The currency a creator's fee share arrives in. */
  readonly rewardCurrency: string;
  /** Bullets for the chooser card, in the order they should be read. */
  readonly highlights: readonly string[];
  /** Everything the model does that a creator cannot change afterwards. */
  readonly fixedBehaviour: readonly string[];
  readonly risks: readonly string[];
  /** For `building` and `design`: what is actually left to do, stated plainly. */
  readonly remaining?: readonly string[];
}

export const LAUNCH_MODELS: Record<LaunchModelId, LaunchModelDefinition> = {
  classic: {
    id: "classic",
    label: "Classic",
    status: "ready",
    summary:
      "A fixed-supply token quoted in ether, with the swap fee written into the pool at creation and the launch position locked by a contract.",
    pair: "Ether",
    feeModels: ["fixed", "progressive"],
    rewardCurrency: "Ether on buys, your token on sells",
    highlights: [
      "Separate buy and sell fees, or one fee for both",
      "Optionally a fee schedule that steps on a timetable",
      "Whole supply into the pool in a single transaction",
      "Launch position locked, with no early release path",
    ],
    fixedBehaviour: [
      "Supply is minted once at creation. There is no mint function and no owner.",
      "The fee schedule is written into the hook at creation and cannot be edited by anyone, including Verdant.",
      "The launch position is transferred to a locker with no operator and no early-release path.",
      "The token has no transfer tax and no blocklist.",
      "Fee revenue is split between the creator and the protocol in shares fixed at creation.",
    ],
    risks: [
      "A locked position keeps liquidity in the pool. It says nothing about a price.",
      "Fee revenue depends entirely on trading, which Verdant does not and cannot guarantee.",
      "Because the fee is charged by Uniswap rather than skimmed by the hook, a creator's share arrives in ether from buys and in their own token from sells.",
      "A swap submitted close to a scheduled fee transition may execute under either fee.",
    ],
  },

  "stock-paired": {
    id: "stock-paired",
    label: "Stock-Paired",
    status: "ready",
    summary:
      "The same market, quoted in a tokenized equity instead of ether — pair your token against NVIDIA, Apple, the S&P 500 or silver.",
    pair: "A reviewed tokenized equity",
    feeModels: ["fixed", "progressive"],
    rewardCurrency: "The quote asset on buys, your token on sells",
    highlights: [
      "Priced against a first-party Robinhood equity token",
      "A reviewed allowlist, not any ERC-20 on the chain",
      "Fee revenue accrues in the quote asset",
      "Same locked position and immutable schedule as Classic",
    ],
    fixedBehaviour: [
      "The quote asset is chosen once, at creation, and is part of the pool's identity forever.",
      "Only assets on the reviewed allowlist can be used as a quote side.",
      "Everything Classic fixes at creation is fixed here too.",
    ],
    risks: [
      "The launched token is not a share. It is not redeemable for the quote asset and carries no rights in the underlying company, fund or security.",
      "The quote asset remains subject to its issuer's terms, including any transfer or redemption controls, which Verdant does not control and cannot override.",
      "A quote asset that becomes illiquid makes the market it prices hard to exit, independently of the market's own liquidity.",
      "Equity tokens track a market that closes. Prices can gap across a weekend while the pool trades continuously.",
      "The initial buy is funded in the quote asset, so a creator has to hold the equity token before launching. Nothing routes ether into it for them.",
    ],
  },

  evergreen: {
    id: "evergreen",
    label: "Evergreen",
    status: "design",
    summary:
      "A share of every fee is set aside and can be added back to the locked position as liquidity by anyone, forever.",
    pair: "Ether",
    feeModels: ["fixed", "progressive"],
    rewardCurrency: "Ether on buys, your token on sells",
    highlights: [
      "A reserve share of fees, unclaimable by anyone",
      "Anyone can convert the reserve into locked liquidity",
      "Liquidity that grows with volume rather than with a promise",
    ],
    fixedBehaviour: [
      "The reserve share is fixed at creation.",
      "Reserve balances can never be withdrawn by the creator or by the protocol.",
    ],
    risks: [
      "Reinforcement is not automatic. It needs someone to call it, which anyone may do and nobody is obliged to do.",
      "Deeper liquidity is not the same as a better market and implies nothing about price.",
    ],
    remaining: [
      "The reserve share and the reinforce path exist in the contracts, but the model is disabled in the registry and has no acceptance record.",
    ],
  },
};

/** Chooser order: what a creator can use, then what is coming. */
export const LAUNCH_MODEL_ORDER: readonly LaunchModelId[] = [
  "classic",
  "stock-paired",
  "evergreen",
];

export function launchModel(id: string): LaunchModelDefinition | undefined {
  return LAUNCH_MODELS[id as LaunchModelId];
}
