/**
 * What Agen has already built, described so a planner can recognise it.
 *
 * ## Why this exists
 *
 * A cold Tidal build spent over nine minutes and never finished planning. The market
 * needed six-hour windows, fee routing, proportional claims and a state transition —
 * and Agen already had proven implementations of the first three. The planner did not
 * know that in terms it could match against, so it set about designing all four from
 * nothing, and the slowest stage in the pipeline was spent reinventing tested code.
 *
 * The prelude has always been written into the workspace. What was missing was a
 * description of it in the language of requirements rather than of Solidity: not "an
 * abstract contract with a rewardPerShare index" but "value owed to many wallets in
 * proportion to something they did". A planner matches against the second.
 *
 * ## What this is not
 *
 * Not a menu of market types, and not a constraint on what a market may be. Nothing here
 * restricts the plan: a market that needs a structure this list does not contain gets one
 * designed for it, and that path is unchanged. The catalogue only removes the obligation
 * to reinvent the parts that are the same in every market that needs them.
 *
 * The distinction matters because it is the difference between reuse and templates. A
 * template decides the shape of the market. This decides only that epoch bookkeeping is
 * epoch bookkeeping, and leaves what happens when an epoch closes entirely open.
 *
 * ## Keeping it honest
 *
 * `fits` and `doesNotDo` are load-bearing in opposite directions. A vague `fits` gets a
 * component reused where its semantics do not hold, which is worse than generating one:
 * the code compiles, passes its own tests, and implements the wrong market. `doesNotDo`
 * is where a reuse is refused, and it is the half worth writing carefully.
 */

import { PRELUDE_CONTRACTS } from "./prelude.js";

export interface CatalogueEntry {
  /** Stable id a plan cites when it reuses this. */
  readonly id: string;
  /** The Solidity contract, as it exists in the generated workspace. */
  readonly contractName: string;
  /**
   * How a market uses it.
   *
   * `inherit` is a base or mixin a generated contract extends. `deploy` is a finished
   * contract deployed alongside, which is never generated and never rewritten.
   */
  readonly use: "inherit" | "deploy";
  /** What it does, in one line. */
  readonly provides: string;
  /** The requirement it answers, phrased the way a specification would phrase it. */
  readonly fits: readonly string[];
  /** Where it stops. A requirement past this line needs something generated. */
  readonly doesNotDo: readonly string[];
}

export const CATALOGUE: readonly CatalogueEntry[] = [
  {
    id: "base-hook",
    contractName: "AgenBaseHook",
    use: "inherit",
    provides:
      "the v4 hook entry points, already restricted to the pool manager, plus isBuy, " +
      "swapAmount, inputCurrency and takeInto",
    fits: ["any market with a hook at all — this is not optional"],
    doesNotDo: ["anything market-specific: every callback body is yours to write"],
  },
  {
    id: "epochs",
    contractName: "EpochAccounting",
    use: "inherit",
    provides:
      "fixed-length periods that close lazily on the first interaction after they " +
      "elapse, including catching up several at once after a quiet spell",
    fits: [
      "rounds, windows, hourly or daily periods, anything on a repeating clock",
      "a rule that settles or resets when a period ends",
    ],
    doesNotDo: [
      "wake itself up — nothing on chain can, so a period ends on the next interaction " +
        "and the market must disclose that rather than imply a timer",
      "decide what happens when a period closes: that is the market's own logic",
      "variable-length or conditionally-extended periods",
    ],
  },
  {
    id: "reward-shares",
    contractName: "RewardAccumulator",
    use: "inherit",
    provides:
      "reward-per-share accounting with pull-based claims, so paying many wallets costs " +
      "the same regardless of how many there are",
    fits: [
      "value owed to many wallets in proportion to something they did",
      "any rule with the words distribute, split among, share of, or claimable",
    ],
    doesNotDo: [
      "push payments: wallets claim, and a market that promises automatic payout is " +
        "promising a loop that stops working exactly when the market succeeds",
      "shares that decay or expire on their own",
    ],
  },
  {
    id: "fee-vault",
    contractName: "FeeVault",
    use: "deploy",
    provides:
      "custody of collected fees with a credited ledger, one way in for the hook and one " +
      "way out for the owner",
    fits: [
      "fees routed somewhere other than the LPs: a treasury, a buyback reserve, a pool",
      "any rule where the hook takes value it should not itself hold",
    ],
    doesNotDo: [
      "spend or swap what it holds — a buyback is a separate concern",
      "split a balance between claimants: pair it with reward-shares for that",
    ],
  },
  {
    id: "oracle",
    contractName: "OracleAdapter",
    use: "deploy",
    provides: "an external price behind a staleness bound, with an explicit answer when the feed is stale",
    fits: ["a rule denominated in a currency the pool does not price, typically USD"],
    doesNotDo: ["make a stale feed safe: the market still has to say what it does when the price is old"],
  },
  {
    id: "keeper",
    contractName: "KeeperAdapter",
    use: "inherit",
    provides: "a permissionless upkeep entry point for work no trade happens to trigger",
    fits: ["a market that must still progress when nobody is trading"],
    doesNotDo: ["guarantee anyone calls it: the market must remain correct if nobody does"],
  },
  {
    id: "wiring",
    contractName: "AgenWired",
    use: "inherit",
    provides:
      "a factory-only setter for the address a contract cannot learn in its constructor, " +
      "because two contracts needing each other's addresses is circular under CREATE2",
    fits: [
      "a hook that must be told its vault, or a ledger that must be told its hook",
      "any component the factory finishes wiring after the bundle is deployed",
    ],
    doesNotDo: [
      "excuse a permissionless setter: until the factory calls it the slot is unclaimed, " +
        "and whoever claims it keeps it",
    ],
  },
];

/** The catalogue as the planner sees it. */
export function catalogueForModel(): string {
  return CATALOGUE.map((entry) => {
    const lines = [
      `${entry.id} — ${entry.contractName} (${entry.use})`,
      `    provides: ${entry.provides}`,
      ...entry.fits.map((fit) => `    fits: ${fit}`),
      ...entry.doesNotDo.map((limit) => `    does not: ${limit}`),
    ];
    return lines.join("\n");
  }).join("\n\n");
}

export function catalogueEntry(id: string): CatalogueEntry | undefined {
  return CATALOGUE.find((entry) => entry.id === id);
}

/**
 * Contracts a plan may name without anything being generated for them.
 *
 * The `deploy` entries are finished contracts already in the workspace. Asking a model
 * to write a FeeVault produces a second one that has to be repaired into working order,
 * which is how a live build spent two of its three repair rounds.
 */
export const REUSED_CONTRACTS: readonly string[] = PRELUDE_CONTRACTS;
