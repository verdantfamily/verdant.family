/**
 * The trade fee this market was asked for, as Solidity Agen writes itself.
 *
 * Cards can be made to agree with the prompt at display time. The hook cannot: it is
 * what actually charges. A model asked to copy a rate from the specification still
 * invents 3,000 ppm, flips `>=` to `>`, or stacks the large-sell fee on the base.
 *
 * So the comparison is not described to the generator. It is written here, from the
 * same reading of the specification the cards and the core tests use, and the hook is
 * told to call it. What a trade pays is then one function, not three readings.
 *
 * ## Gates the hook answers
 *
 * The first version of this file wrote nothing at all for a market whose fee turned on
 * state — a streak, a cooldown, a holding period. That was the wrong place to draw the
 * line, and EXCT showed why: a consecutive-buy waiver on the buy side meant the
 * 0.5%/4%-above-1%-of-supply ladder on the *sell* side went back to being a model's
 * copy of a number, though nothing about it had become harder to compute. The gate was
 * unknowable; the rates never were.
 *
 * So a gate this package cannot compute becomes a `bool` parameter named after the rule
 * that stated it, and the rate it leads to stays here. The hook's job shrinks to
 * answering questions about its own state — which is the part it is genuinely better
 * placed to know, and the part `semantic-coverage.ts` can hold a test against.
 */

import type { GeneratedSource } from "./workspace.js";
import { applyStatedEconomics } from "./requirements.js";
import type { MarketSpecification } from "./spec.js";
import { feeProgram, thresholdSolidity, type FeeBranch, type FeeProgram } from "./threshold.js";

export const FEE_POLICY_PATH = "contracts/AgenFeePolicy.sol";

/** The names the policy already uses, which a gate may not take. */
const RESERVED = new Set(["buying", "tokenAmount", "totalSupply", "poolLiquidity", "feePpm"]);

/**
 * How many questions the policy will ask the hook before it stops being a help.
 *
 * Each gate is a boolean the hook has to work out and pass in the right position, and the
 * argument that makes a rate deterministic stops holding somewhere: a function taking
 * seven booleans is one a generator will call wrongly more often than it would have
 * written the ladder correctly by hand. Three covers every prompt this has been tried
 * against — Exact Flow needs one — and a market past it falls back to the model writing
 * the fee, which is where all of them used to be.
 */
const MOST_GATES = 3;

/** Put Agen's fee policy at the front of the sources, replacing any earlier copy. */
export function withFeePolicy(
  specification: MarketSpecification,
  sources: readonly GeneratedSource[],
  prompt?: string,
): readonly GeneratedSource[] {
  const policy = feePolicySource(specification, prompt);
  const without = sources.filter((file) => file.path !== FEE_POLICY_PATH);
  return policy === null ? without : [policy, ...without];
}

/** A state gate the generated hook has to answer, with the words it came from. */
export interface FeeGate {
  readonly name: string;
  readonly ruleId: string;
  readonly phrase: string;
}

/**
 * Every gate the policy asks the hook about, in the order it asks.
 *
 * Exported because two other places need to say the same list: the generator's brief,
 * which tells the hook what to compute, and the review screen, which owes the creator a
 * plain account of which of their clauses the contract keeps state for. Empty for a
 * market with no gates and for one this declines to write a policy for at all, which
 * callers can tell apart by asking `feePolicySource` — they are already asking, because
 * a list of gates means nothing without the library that takes them.
 */
export function feeGates(
  specification: MarketSpecification,
  prompt?: string,
): readonly FeeGate[] {
  const locked = prompt === undefined ? specification : applyStatedEconomics(prompt, specification);
  const buy = feeProgram(locked, "buy");
  const sell = feeProgram(locked, "sell");
  if (buy === null || sell === null) return [];

  return gatesOf([buy, sell]) ?? [];
}

/**
 * Whether what a trade pays depends on how big it is.
 *
 * Asked by `deployment-validation.ts`, because a market whose answer is yes has a
 * measurement problem a flat-fee market does not: the size that matters is the amount of
 * the launched token, and on an exact-output sell that is not the amount the swap
 * specified. A hook that never needs a size cannot get the size wrong.
 */
export function feeDependsOnTradeSize(
  specification: MarketSpecification,
  prompt?: string,
): boolean {
  const locked = prompt === undefined ? specification : applyStatedEconomics(prompt, specification);

  return (["buy", "sell"] as const).some((side) =>
    (feeProgram(locked, side)?.branches ?? []).some((branch) => branch.kind === "size"),
  );
}

/**
 * The library, or `null` when this package cannot read what a trade pays.
 *
 * Silence here is still deliberate, but it is now reserved for the case that earns it:
 * a rate nothing in the specification states, or a phase that changes which rules apply
 * at all. A gate on state is not that case — see the note at the top of the file.
 */
export function feePolicySource(
  specification: MarketSpecification,
  prompt?: string,
): GeneratedSource | null {
  const locked = prompt === undefined ? specification : applyStatedEconomics(prompt, specification);
  const buy = feeProgram(locked, "buy");
  const sell = feeProgram(locked, "sell");
  // Both sides, or neither. A library that invents a flat rate for the side this
  // package could not read would be the same crime the model commits.
  if (buy === null || sell === null) return null;

  // Null where the questions cannot be asked cleanly: too many of them, or two rules
  // whose ids differ only in punctuation both wanting the same parameter to answer for
  // them. Rather than pick, this declines to write the file at all.
  const gates = gatesOf([buy, sell]);
  if (gates === null) return null;

  const body = [...ladder(buy, true), ...ladder(sell, false)];

  return {
    path: FEE_POLICY_PATH,
    content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AgenFeePolicy
/// @notice What a trade pays, written by Agen from the locked specification.
/// @dev The hook takes this rate into the vault. It does not invent a second one.
library AgenFeePolicy {
${signature(gates)}
        // poolLiquidity is part of the signature so a liquidity gate and a supply
        // gate are the same call. An unused basis is named so the compiler keeps it.
        poolLiquidity;
        totalSupply;

${body.join("\n")}
    }
}
`,
  };
}

/**
 * The function this market's fee needs, with a parameter per gate.
 *
 * The four-argument form is written out exactly as it always was when a market has no
 * gates, because most markets have none and a signature that reflowed on an unrelated
 * change would be a diff in every generated hook.
 */
function signature(gates: readonly FeeGate[]): string {
  if (gates.length === 0) {
    return `    function feePpm(bool buying, uint256 tokenAmount, uint256 totalSupply, uint256 poolLiquidity)
        internal
        pure
        returns (uint24)
    {`;
  }

  const documented = gates.map(
    (gate) => `    /// @param ${gate.name} True exactly when ${gate.phrase} (rule \`${gate.ruleId}\`).`,
  );

  const parameters = [
    "        bool buying,",
    "        uint256 tokenAmount,",
    "        uint256 totalSupply,",
    "        uint256 poolLiquidity,",
    ...gates.map((gate, index) => `        bool ${gate.name}${index === gates.length - 1 ? "" : ","}`),
  ];

  return [
    "    /// @notice What this trade pays, in hundredths of a basis point.",
    ...documented,
    "    function feePpm(",
    ...parameters,
    "    ) internal pure returns (uint24) {",
  ].join("\n");
}

/** One side's branches, then the rate a trade that matched none of them pays. */
function ladder(program: FeeProgram, guarded: boolean): readonly string[] {
  const indent = guarded ? "            " : "        ";
  const lines = program.branches.map((branch) => `${indent}if (${test(branch)}) return ${ppm(branch.ppm)};`);

  lines.push(`${indent}return ${ppm(program.basePpm)};`);

  return guarded ? ["        if (buying) {", ...lines, "        }"] : lines;
}

/** The condition for one branch: arithmetic Agen owns, or a question the hook answered. */
function test(branch: FeeBranch): string {
  if (branch.kind === "size" && branch.threshold !== null) {
    return thresholdSolidity(branch.threshold, "tokenAmount");
  }
  return branch.name ?? "false";
}

/**
 * The gates both sides need, or `null` where two rules want the same name.
 *
 * A rule that charges on both sides states one gate and gets one parameter, which is
 * why this is a union keyed by name rather than a concatenation.
 */
function gatesOf(programs: readonly FeeProgram[]): readonly FeeGate[] | null {
  const byName = new Map<string, FeeGate>();

  for (const program of programs) {
    for (const branch of program.branches) {
      if (branch.kind !== "state" || branch.name === null) continue;
      if (RESERVED.has(branch.name)) return null;

      const seen = byName.get(branch.name);
      if (seen !== undefined) {
        if (seen.ruleId !== branch.ruleId) return null;
        continue;
      }

      byName.set(branch.name, {
        name: branch.name,
        ruleId: branch.ruleId,
        phrase: branch.phrase,
      });
    }
  }

  return byName.size > MOST_GATES ? null : [...byName.values()];
}

function ppm(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}
