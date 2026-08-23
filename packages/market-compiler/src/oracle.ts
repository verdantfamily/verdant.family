/**
 * The specification's own arithmetic, executed, beside the contract's.
 *
 * `AgenFeePolicy.sol` is written from the same reading of the market that the cards and
 * the core tests use, which makes a whole class of disagreement impossible and one class
 * still very possible: the rendering. A boundary is `>=` in the reading and `>` in the
 * Solidity; a percentage divides before it multiplies and truncates; a rate is grouped
 * into a literal that drops a digit. Every one of those compiles, and every one of them
 * is a different market.
 *
 * So the ladder is evaluated twice. Here, over integers, from the branches themselves —
 * and again by solc, over the generated library, at the same inputs. Where they disagree
 * the test says which input and both answers:
 *
 *     a sell of exactly 1% of the total supply: 40000 != 5000
 *
 * which is a sentence somebody can act on, and which a model asked to repair the hook
 * fixes on the first attempt. "A behaviour test failed" is the same defect described in a
 * way that costs three rounds and usually the build.
 *
 * ## Why the points are these points
 *
 * A threshold is only ever wrong near itself. A quarter of the way up, a hair under,
 * exactly on it, a hair over — those four decide inclusivity and truncation, and nothing
 * between them adds anything. The bases are deliberately awkward for the same reason: a
 * supply is round by construction and hid an integer division that truncated for years,
 * so a basis with a remainder is in the table on purpose.
 */

import { feeGates, type FeeGate } from "./fee-policy.js";
import { applyStatedEconomics } from "./requirements.js";
import type { MarketSpecification } from "./spec.js";
import { feeProgram, overThreshold, type FeeProgram, type Side } from "./threshold.js";

/** One row of the table: what goes in, what the specification says comes out. */
export interface FeeVector {
  readonly side: Side;
  readonly tokenAmount: bigint;
  readonly totalSupply: bigint;
  readonly poolLiquidity: bigint;
  /** The gate answers, in the order the policy takes them. */
  readonly gates: readonly boolean[];
  readonly expectedPpm: number;
  /** The case in words, so a failure names the trade rather than a row number. */
  readonly because: string;
}

/** A supply a real launch has: round, and large enough that a share of it is not dust. */
const SUPPLY = 1_000_000_000n * 10n ** 18n;

/**
 * A basis with a remainder, which is where a truncating comparison shows itself.
 *
 * The pool's liquidity is whatever the last trade left behind and is never round, so a
 * liquidity gate lives at this value in practice and at a round one never.
 */
const AWKWARD = SUPPLY + 37n;

/** Where a threshold is worth testing, as a multiple of itself. */
const AROUND: readonly [number, string][] = [
  [0.25, "a quarter of"],
  [0.995, "just under"],
  [1, "exactly"],
  [1.005, "just over"],
  [2.5, "well above"],
];

/**
 * Every trade worth asking the library about.
 *
 * Empty when there is no library — a market whose fee Agen did not write has nothing here
 * to check, and the model's own tests are what cover it.
 *
 * The prompt matters and is not optional in practice: `feePolicySource` locks the stated
 * economics onto the specification before it writes the ladder, so a table built from the
 * unlocked one is a table about a different market. It was, briefly, and the disagreement
 * it produced looked exactly like the contract bug this is meant to find.
 */
export function feeVectors(
  specification: MarketSpecification,
  prompt?: string,
): readonly FeeVector[] {
  const locked =
    prompt === undefined ? specification : applyStatedEconomics(prompt, specification);
  const gates = feeGates(specification, prompt);
  const vectors: FeeVector[] = [];

  for (const side of ["buy", "sell"] as const) {
    const program = feeProgram(locked, side);
    if (program === null) continue;

    const none = gates.map(() => false);
    const trade = side === "buy" ? "a buy" : "a sell";

    // The ordinary trade, which is most of them and is the one nobody thinks to check.
    vectors.push(
      vector({ program, gates, side, answers: none, tokenAmount: 1n, because: `a plain ${trade}` }),
    );

    for (const branch of program.branches) {
      if (branch.kind === "size" && branch.threshold !== null) {
        const { threshold } = branch;
        const basis = threshold.basis === "supply" ? SUPPLY : AWKWARD;
        const named = threshold.basis === "supply" ? "the total supply" : "the pool's liquidity";

        for (const [factor, words] of AROUND) {
          const share = BigInt(Math.round(threshold.percent * factor * 10_000));
          const tokenAmount = (basis * share) / 1_000_000n;
          if (tokenAmount <= 0n) continue;

          vectors.push(
            vector({
              program,
              gates,
              side,
              answers: none,
              tokenAmount,
              totalSupply: threshold.basis === "supply" ? basis : SUPPLY,
              poolLiquidity: threshold.basis === "supply" ? 0n : basis,
              because: `${trade} of ${words} ${percent(threshold.percent)} of ${named}`,
            }),
          );
        }
        continue;
      }

      // A gate on state: once holding, and once holding while the trade is also over
      // whatever size gate sits beside it, which is the only statement of precedence
      // between the two that anything makes.
      const held = gates.map((gate) => gate.ruleId === branch.ruleId);
      if (!held.some(Boolean)) continue;

      vectors.push(
        vector({
          program,
          gates,
          side,
          answers: held,
          tokenAmount: 1n,
          because: `${trade} while ${branch.phrase}`,
        }),
      );

      const sized = program.branches.find(
        (other) => other.kind === "size" && other.threshold !== null,
      );
      if (sized?.threshold === undefined || sized.threshold === null) continue;

      const basis = sized.threshold.basis === "supply" ? SUPPLY : AWKWARD;
      vectors.push(
        vector({
          program,
          gates,
          side,
          answers: held,
          tokenAmount: (basis * BigInt(Math.round(sized.threshold.percent * 10_000))) / 1_000_000n,
          totalSupply: sized.threshold.basis === "supply" ? basis : SUPPLY,
          poolLiquidity: sized.threshold.basis === "supply" ? 0n : basis,
          because: `${trade} of exactly ${percent(sized.threshold.percent)} while ${branch.phrase}`,
        }),
      );
    }
  }

  return vectors;
}

/** One row, with the answer worked out from the branches rather than written down. */
function vector({
  program,
  gates,
  side,
  answers,
  tokenAmount,
  totalSupply = SUPPLY,
  poolLiquidity = 0n,
  because,
}: {
  readonly program: FeeProgram;
  readonly gates: readonly FeeGate[];
  readonly side: Side;
  readonly answers: readonly boolean[];
  readonly tokenAmount: bigint;
  readonly totalSupply?: bigint;
  readonly poolLiquidity?: bigint;
  readonly because: string;
}): FeeVector {
  return {
    side,
    tokenAmount,
    totalSupply,
    poolLiquidity,
    gates: answers,
    expectedPpm: evaluate({ program, gates, answers, tokenAmount, totalSupply, poolLiquidity }),
    because,
  };
}

/**
 * What the specification says this trade pays.
 *
 * The same walk the generated library makes — branches in order, first match wins, base
 * underneath — so a disagreement is about the Solidity and never about which of two
 * different ladders was meant.
 */
function evaluate({
  program,
  gates,
  answers,
  tokenAmount,
  totalSupply,
  poolLiquidity,
}: {
  readonly program: FeeProgram;
  readonly gates: readonly FeeGate[];
  readonly answers: readonly boolean[];
  readonly tokenAmount: bigint;
  readonly totalSupply: bigint;
  readonly poolLiquidity: bigint;
}): number {
  for (const branch of program.branches) {
    if (branch.kind === "state") {
      const at = gates.findIndex((gate) => gate.name === branch.name);
      if (at >= 0 && answers[at] === true) return branch.ppm;
      continue;
    }

    if (branch.threshold === null) continue;

    const basisAmount = branch.threshold.basis === "supply" ? totalSupply : poolLiquidity;
    if (overThreshold(branch.threshold, { amount: tokenAmount, basisAmount })) return branch.ppm;
  }

  return program.basePpm;
}

/** The table as Solidity, for the core suite to carry. */
export interface OracleTests {
  /** The import the core suite needs to reach the library. */
  readonly imports: string;
  /** One test function, asserting every vector. */
  readonly functions: string;
  /** What it proves, for the build record. */
  readonly proves: string;
}

/**
 * The table, as a test function the core suite can hold.
 *
 * `null` where there is no library to check. It goes in with Agen's own tests rather than
 * beside them because it has to be authoritative for the same reason they are: a model
 * may not quarantine it, and a market that fails it is wrong rather than untested.
 */
export function oracleTests(
  specification: MarketSpecification,
  prompt?: string,
): OracleTests | null {
  const vectors = feeVectors(specification, prompt);
  if (vectors.length === 0) return null;

  const gates = feeGates(specification, prompt);
  const rows = vectors.map((entry) => {
    const answers = entry.gates.map((held) => `, ${String(held)}`).join("");
    const call = `AgenFeePolicy.feePpm(${String(entry.side === "buy")}, ${entry.tokenAmount.toString()}, ${entry.totalSupply.toString()}, ${entry.poolLiquidity.toString()}${answers})`;

    return `        assertEq(
            uint256(${call}),
            ${String(entry.expectedPpm)},
            "${entry.because} pays ${percent(entry.expectedPpm / 10_000)}"
        );`;
  });

  const named =
    gates.length === 0
      ? ""
      : `\n    /// The trailing booleans are ${list(gates.map((gate) => gate.name))}.`;

  return {
    imports: `import {AgenFeePolicy} from "../contracts/AgenFeePolicy.sol";`,
    functions: `    /// Every rate this market states, at the sizes where a rate goes wrong.
    /// A failure here names the trade the contract disagreed about.${named}
    function test_core_every_stated_rate_is_what_the_policy_charges() public pure {
${rows.join("\n")}
    }`,
    proves: `every stated rate is what the fee policy charges, at ${String(vectors.length)} sizes including each boundary exactly`,
  };
}

/** `2` reads as `2%`, `0.5` as `0.5%`. */
function percent(value: number): string {
  return `${value % 1 === 0 ? value.toFixed(0) : String(value)}%`;
}

/** `a, b and c`, for a sentence rather than a list. */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}
