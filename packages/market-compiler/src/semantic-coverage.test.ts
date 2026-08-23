import { describe, expect, it } from "vitest";

import type { CreatorIntent } from "./intent.js";
import { claimCoverage, semanticCoverage } from "./semantic-coverage.js";
import type { MarketSpecification } from "./spec.js";

const specification = {
  version: 1,
  name: "Floor",
  symbol: "FLOR",
  summary: "A market",
  baseFeePpm: 5_000,
  maxFeePpm: 40_000,
  phases: [],
  state: [],
  rules: [
    {
      id: "large-sell",
      title: "LARGE SELL",
      when: { kind: "sell", description: "a sell" },
      conditions: [],
      then: [{ kind: "setFee", description: "charge 4%" }],
    },
  ],
  invariants: [{ id: "fee-ceiling", statement: "No trade pays over 4%" }],
  externalDependencies: [],
  assumptions: [],
  ambiguities: [],
  suggestions: [],
  unsupported: [],
} satisfies MarketSpecification;

const intent: CreatorIntent = {
  prompt: "Large sells pay 4%.",
  complete: true,
  problems: [],
  atoms: [
    {
      id: "intent-1",
      kind: "fee",
      quote: "Large sells pay 4%.",
      start: 0,
      end: 19,
      ruleIds: ["large-sell"],
      objective: true,
      status: "implemented",
    },
  ],
};

describe("semantic coverage", () => {
  const source = {
    content: `
      /// Rule: large-sell
      /// Invariant: fee-ceiling
      function test_large_sell_fee() public {
        sell(100);
        assertEq(tokenBalance(address(this)), 0);
      }
    `,
  };

  it("reads rule and invariant claims only from attached test comments", () => {
    expect(claimCoverage("Rule", ["large-sell"], [source]).get("large-sell")).toEqual([
      "test_large_sell_fee",
    ]);

    expect(
      claimCoverage("Rule", ["large-sell"], [
        {
          content:
            "// Rule: large-sell\ncontract Test {\n  function test_unrelated() public {}\n}",
        },
      ]).get("large-sell"),
    ).toEqual([]);
  });

  it("is complete only when the claimed test actually passed", () => {
    expect(
      semanticCoverage({
        intent,
        specification,
        sources: [source],
        outcomes: [
          {
            suite: "test/Floor.t.sol:FloorTest",
            name: "test_large_sell_fee()",
            passed: true,
            reason: null,
          },
        ],
      }).complete,
    ).toBe(true);

    const missing = semanticCoverage({
      intent,
      specification,
      sources: [source],
      outcomes: [],
    });
    expect(missing.complete).toBe(false);
    expect(missing.unproven.join(" ")).toContain("LARGE SELL");
  });

  it("does not accept an annotation on an empty test as semantic evidence", () => {
    const report = semanticCoverage({
      intent,
      specification,
      sources: [
        {
          content: `
            /// Rule: large-sell
            /// Intent: intent-1
            function test_large_sell_fee() public {}
          `,
        },
      ],
      outcomes: [
        {
          suite: "test/Floor.t.sol:FloorTest",
          name: "test_large_sell_fee()",
          passed: true,
          reason: null,
        },
      ],
    });

    expect(report.complete).toBe(false);
    expect(report.unproven.join(" ")).toContain("LARGE SELL");
  });
});
