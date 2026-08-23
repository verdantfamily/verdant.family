/**
 * A size-gated fee read off the wrong currency.
 *
 * `params.amountSpecified` is an amount of whichever currency the swap named. For an
 * exact-input sell that is the launched token, which is what a threshold like "a sell of
 * at least 1% of the immutable supply" is measured in. For an exact-output sell —
 * "give me exactly this much ether" — it is the quote asset, and the token going in is
 * not known until the swap has run.
 *
 * So a hook that measures every trade with `abs(amountSpecified)` compares a quote amount
 * against a token supply, and the surcharge is avoided by anybody who routes exact-output.
 * `context.ts` has said so for a while; nothing checked it, and the fixture could not have
 * caught it because `MarketTestBase` only ever swapped exact-input.
 *
 * Read from the source text rather than the AST on purpose: the question is whether the
 * hook shows any sign of having considered the case, and the signs are a comparison
 * against zero, an `_afterSwap`, or a read of the unspecified side.
 */

import { describe, expect, it } from "vitest";

import type { DeploymentSpecification } from "./deployment-spec.js";
import { sizeReadFromTheSpecifiedAmount } from "./deployment-validation.js";
import type { MarketSpecification } from "./spec.js";

function specification(partial: Partial<MarketSpecification>): MarketSpecification {
  return {
    version: 1,
    name: "Exact Flow",
    symbol: "EXCT",
    summary: "A market.",
    baseFeePpm: 5_000,
    maxFeePpm: 40_000,
    rules: [],
    state: [],
    phases: [],
    invariants: [],
    externalDependencies: [],
    assumptions: [],
    ambiguities: [],
    unsupported: [],
    disclosures: [],
    ...partial,
  } as MarketSpecification;
}

/** EXCT's sell ladder: half a percent, four percent at or above 1% of the supply. */
const SIZE_GATED = specification({
  rules: [
    {
      id: "default",
      title: "DEFAULT",
      when: { kind: "buyOrSell", description: "any trade" },
      conditions: [],
      then: [{ kind: "chargeFee", description: "0.5%", parameters: { feePercent: 0.5 } }],
    },
    {
      id: "large-sell",
      title: "LARGE",
      when: { kind: "sell", description: "a sell" },
      conditions: [
        {
          kind: "tradeSizeVsSupply",
          description: "at least 1% of the immutable total supply",
          parameters: { operator: ">=", percent: 1, basis: "totalSupply" },
        },
      ],
      then: [{ kind: "chargeFee", description: "4%", parameters: { feePercent: 4 } }],
    },
  ],
});

/** The same market with the threshold taken out: one rate, whatever the size. */
const FLAT = specification({
  rules: [
    {
      id: "default",
      title: "DEFAULT",
      when: { kind: "buyOrSell", description: "any trade" },
      conditions: [],
      then: [{ kind: "chargeFee", description: "0.5%", parameters: { feePercent: 0.5 } }],
    },
  ],
});

const DEPLOYMENT = {
  components: [{ componentId: "marketHook", contractName: "MarketHook", role: "hook" }],
} as unknown as DeploymentSpecification;

function sourcesOf(body: string) {
  return [
    {
      text: `contract MarketHook {
    function _beforeSwap(PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
${body}
    }
}`,
    },
  ];
}

/** What a model writes when it has read "take its absolute value" and stopped there. */
const BLIND = `        uint256 amount = params.amountSpecified < 0
            ? uint256(-params.amountSpecified)
            : uint256(params.amountSpecified);
        uint24 fee = AgenFeePolicy.feePpm(isBuy(params), amount, token.totalSupply(), 0);`;

function problems(specification: MarketSpecification, body: string) {
  return sizeReadFromTheSpecifiedAmount({
    sources: sourcesOf(body),
    deployment: DEPLOYMENT,
    specification,
  });
}

describe("the size a hook measures a gated fee against", () => {
  it("is refused when the absolute specified amount is the only reading", () => {
    const found = problems(SIZE_GATED, BLIND);

    expect(found).toHaveLength(1);
    expect(found[0]?.contractName).toBe("MarketHook");
    // Says which currency it actually measured, and what to do on each side.
    expect(found[0]?.detail).toContain("exact-output sell");
    expect(found[0]?.detail).toContain("_afterSwap");
  });

  it("is refused when the base hook's swapAmount is the only reading", () => {
    const found = problems(
      SIZE_GATED,
      `        uint24 fee = AgenFeePolicy.feePpm(isBuy(params), swapAmount(params), token.totalSupply(), 0);`,
    );

    expect(found).toHaveLength(1);
    // The helper is the likeliest route in, because the prompt asks for it by name.
    expect(found[0]?.detail).toContain("swapAmount is the size of the swap");
  });

  it("is accepted when the hook asks the token amount whether it knows", () => {
    const body = `        (uint256 amount, bool known) = tokenAmount(params);
        if (!known) revert ExactOutputSellNotSupported();
        uint24 fee = AgenFeePolicy.feePpm(isBuy(params), amount, token.totalSupply(), 0);`;

    expect(problems(SIZE_GATED, body)).toHaveLength(0);
  });

  it("is accepted when the exact-output case is resolved after the swap", () => {
    const body = `${BLIND}
    }

    function _afterSwap(PoolKey calldata key, SwapParams calldata, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (int128)
    {
        uint256 tokenIn = uint256(int256(-delta.amount1()));`;

    expect(problems(SIZE_GATED, body)).toHaveLength(0);
  });

  /**
   * The control, and the reason this is not simply "every hook must branch on the sign".
   * A flat fee is the same rate at every size, so it cannot be measured in the wrong
   * currency — and demanding the branch anyway would refuse the most ordinary market Agen
   * builds.
   */
  it("says nothing about a market whose fee does not turn on size", () => {
    expect(problems(FLAT, BLIND)).toHaveLength(0);
  });

  it("says nothing when the caller supplied no specification to read", () => {
    expect(
      sizeReadFromTheSpecifiedAmount({
        sources: sourcesOf(BLIND),
        deployment: DEPLOYMENT,
        specification: undefined,
      }),
    ).toHaveLength(0);
  });
});
