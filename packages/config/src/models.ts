import type { MarketModel } from "./bounds.js";

/**
 * Model metadata — DATA ONLY.
 *
 * Every model must state its mechanism, the parameters it unlocks, and the
 * risks it introduces, because the create flow renders all three side by side
 * (§3.1 step 3). A model without a written risk list does not ship.
 *
 * Copy here is reviewed by a human against contract behaviour before each
 * release; a wrong disclosure is a security bug with no test that catches it
 * (§20.5).
 */
export interface ModelDefinition {
  id: MarketModel;
  label: string;
  /** One line, no performance claims. */
  thesis: string;
  /** Plain-language mechanism. No metaphor without a definition. */
  mechanism: string;
  unlockedParameters: readonly string[];
  risks: readonly string[];
  traits: readonly string[];
}

export const MODELS: Record<MarketModel, ModelDefinition> = {
  fixed: {
    id: "fixed",
    label: "Fixed",
    thesis: "One fee, unchanged for the life of the market.",
    mechanism:
      "A single fee stage. The LP fee is constant and is set at creation. Fee revenue accrues to the locked liquidity position and is split between the creator and the protocol when anyone calls collect().",
    unlockedParameters: ["initialFeePpm", "creatorBps"],
    risks: [
      "A fixed fee does not adapt to changing liquidity or volume.",
      "Fee revenue depends entirely on trading activity, which Verdant does not and cannot guarantee.",
    ],
    traits: ["static"],
  },

  progressive: {
    id: "progressive",
    label: "Progressive",
    thesis: "A fee schedule fixed at creation, advancing on a timetable.",
    mechanism:
      "Two to eight stages. Stage n activates at the pool's initialization time plus that stage's offset in seconds. The active fee is the fee of the latest stage whose offset has elapsed. The schedule is immutable and derives only from block.timestamp — there is no discretion, no oracle, and no off-chain trigger.",
    unlockedParameters: ["stages", "creatorBps"],
    risks: [
      "A fee schedule is not a price guarantee and says nothing about outcomes.",
      "Stage transitions land on L2 timestamps, so a transition may occur slightly before or after the countdown shown in the interface.",
      "A swap submitted close to a transition may execute under either fee.",
    ],
    traits: ["staged", "decaying", "rising"],
  },

  evergreen: {
    id: "evergreen",
    label: "Evergreen",
    thesis:
      "A share of fee revenue is added back to the locked position as liquidity.",
    mechanism:
      "Any valid fee schedule, plus a mandatory reserve share of collected fees. Reserve balances accumulate in both currencies and can be converted into additional liquidity in the locked position by anyone, at any time, via reinforce(). No swap is performed. Reserve balances can never be withdrawn by the creator or by the protocol.",
    unlockedParameters: ["stages", "creatorBps", "reserveBps"],
    risks: [
      "Reinforcement is not automatic. It requires someone to call reinforce(), which anyone may do and nobody is obliged to do.",
      "Reserve funds are unclaimable by any party, so a market whose reinforcement never succeeds leaves them permanently unused.",
      "Adding liquidity depends on the pool's price at the moment of the call. See the reinforcement risk note in the docs.",
      "Deeper liquidity is not the same as a better market and implies nothing about price.",
    ],
    traits: ["reinforcing", "staged", "decaying", "rising"],
  },
};

/**
 * Trait definitions. Every organic term in the interface carries its technical
 * definition at first use (§11.4), and a trait is always derived from immutable
 * configuration — never a claim about performance.
 */
export const TRAIT_DEFINITIONS = {
  static: "The fee never changes. The market has exactly one fee stage.",
  staged: "The fee changes on a timetable fixed at creation.",
  decaying: "Every stage transition lowers the fee.",
  rising: "Every stage transition raises the fee.",
  reinforcing:
    "A share of fee revenue is set aside and can be added to the locked liquidity position by anyone.",
  "permanently-locked":
    "The liquidity position can never be withdrawn, by anyone, ever.",
  "time-locked":
    "The liquidity position cannot be withdrawn before a specific date.",
  "creator-allocation": "The creator holds a share of the token supply.",
  "vested-allocation":
    "The creator's allocation is released linearly after a cliff.",
  "immutable-recipients":
    "Nobody can change where fee revenue is sent, including Verdant.",
} as const;

export type TraitId = keyof typeof TRAIT_DEFINITIONS;
