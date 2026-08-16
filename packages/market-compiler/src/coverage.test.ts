/**
 * Which test proves which promise, as a field rather than a naming convention.
 *
 * Two of ten real prompts were refused at generation for this and nothing else: the suites
 * were fine, the fuzz test plainly bounded the fee, and the words did not line up with the
 * invariant's id. The mapping is asked for directly now, and Agen writes the annotation the
 * gate reads — so the only way to lose a build here is to have no test at all, which is the
 * thing that was supposed to be checked.
 */

import { describe, expect, it } from "vitest";

import { CORE_TEST_PATH } from "./core-tests.js";
import { annotateCoverage, generateTests } from "./engineer.js";
import { invariantCoverage } from "./gates.js";
import { scriptedProvider } from "./model.js";
import type { MarketSpecification } from "./spec.js";

const SUITE = [
  {
    path: "test/Market.t.sol",
    content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MarketTestBase} from "./MarketTestBase.sol";

contract MarketTest is MarketTestBase {
    /// Sells of every size stay under the cap.
    function testFuzz_hookFeeStaysUnderCap(uint128 size) public {
        sell(size);
    }

    function test_buysAreFree() public {
        buy(0.01 ether);
    }
}
`,
  },
];

describe("a suite that proves an invariant without naming it", () => {
  it("is not covered on its own wording", () => {
    const coverage = invariantCoverage({ invariantIds: ["fee-ceiling"], sources: SUITE });
    expect(coverage.get("fee-ceiling")).toEqual([]);
  });

  it("is covered once the model's mapping is written into the file", () => {
    const annotated = annotateCoverage(SUITE, [
      { invariantId: "fee-ceiling", testName: "testFuzz_hookFeeStaysUnderCap" },
    ]);

    const coverage = invariantCoverage({ invariantIds: ["fee-ceiling"], sources: annotated });
    expect(coverage.get("fee-ceiling")).toEqual(["testFuzz_hookFeeStaysUnderCap"]);
  });

  it("keeps the annotation with the test it belongs to, indented as the code is", () => {
    const [annotated] = annotateCoverage(SUITE, [
      { invariantId: "buys-free", testName: "test_buysAreFree" },
    ]);

    expect(annotated?.content).toContain(
      "    /// Invariant: buys-free\n    function test_buysAreFree()",
    );
  });

  /** Two promises can rest on one test, and the gate has to see both. */
  it("writes every claim a single test carries", () => {
    const annotated = annotateCoverage(SUITE, [
      { invariantId: "fee-ceiling", testName: "testFuzz_hookFeeStaysUnderCap" },
      { invariantId: "no-overcharge", testName: "testFuzz_hookFeeStaysUnderCap" },
    ]);

    const coverage = invariantCoverage({
      invariantIds: ["fee-ceiling", "no-overcharge"],
      sources: annotated,
    });

    expect(coverage.get("fee-ceiling")).toHaveLength(1);
    expect(coverage.get("no-overcharge")).toHaveLength(1);
  });

  it("leaves a file alone when nothing claims anything in it", () => {
    expect(annotateCoverage(SUITE, [])).toEqual(SUITE);
    expect(annotateCoverage(SUITE, [{ invariantId: "x", testName: "test_thatDoesNotExist" }])).toEqual(
      SUITE,
    );
  });
});

/**
 * EMBR: "charge a 3% fee on sells and a 1% fee on buys, send every fee straight to the
 * creator". Understood perfectly, and refused at generation. Three of its five invariants were
 * the sell rate, the buy rate and the fee ceiling — the three things Agen's own suite asserts
 * outright — and because the mapping only looked at the model's files, the market was lost
 * unless the model wrote a second copy of tests Agen had already written.
 */
describe("an invariant that Agen's own suite already proves", () => {
  const core = [
    {
      path: CORE_TEST_PATH,
      content: [
        "contract MarketCoreTest is MarketTestBase {",
        "    function test_core_sells_pay_the_stated_fee() public {}",
        "}",
      ].join("\n"),
    },
  ];

  it("is covered by citing the test Agen wrote, without a second one being written", async () => {
    const provider = scriptedProvider([
      {
        files: [{ path: "test/Market.t.sol", content: "contract T is MarketTestBase {}" }],
        coverage: [{ invariantId: "sell-fee-rate", testName: "test_core_sells_pay_the_stated_fee" }],
        notes: [],
      },
    ]);

    const output = await generateTests(provider, {
      specification: market(),
      sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
      context: { architecture: "", generation: "", testing: "" },
      core,
    });

    // The claim landed in Agen's file, which is where the proof is and where the gate looks.
    expect(output.value.core[0]?.content).toContain(
      "/// Invariant: sell-fee-rate\n    function test_core_sells_pay_the_stated_fee",
    );
    expect(
      invariantCoverage({ invariantIds: ["sell-fee-rate"], sources: output.value.core }).get(
        "sell-fee-rate",
      ),
    ).toEqual(["test_core_sells_pay_the_stated_fee"]);
  });

  /**
   * PULSE cited both core tests correctly and was refused anyway, because it spelled them the
   * way forge reports them: `MarketCoreTest.testFuzz_...`. A qualifier is not an invention.
   */
  it("is covered however the model spells the test's name", async () => {
    const provider = scriptedProvider([
      {
        files: [{ path: "test/Market.t.sol", content: "contract T is MarketTestBase {}" }],
        coverage: [
          {
            invariantId: "sell-fee-rate",
            testName: "MarketCoreTest.test_core_sells_pay_the_stated_fee()",
          },
        ],
        notes: [],
      },
    ]);

    const output = await generateTests(provider, {
      specification: market(),
      sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
      context: { architecture: "", generation: "", testing: "" },
      core,
    });

    expect(
      invariantCoverage({ invariantIds: ["sell-fee-rate"], sources: output.value.core }).get(
        "sell-fee-rate",
      ),
    ).toEqual(["test_core_sells_pay_the_stated_fee"]);
  });

  it("still refuses an invariant that neither suite stands behind", async () => {
    const provider = scriptedProvider([
      {
        files: [{ path: "test/Market.t.sol", content: "contract T is MarketTestBase {}" }],
        coverage: [],
        notes: [],
      },
      {
        files: [{ path: "test/Market.t.sol", content: "contract T is MarketTestBase {}" }],
        coverage: [],
        notes: [],
      },
    ]);

    await expect(
      generateTests(provider, {
        specification: market(),
        sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
        context: { architecture: "", generation: "", testing: "" },
        core,
      }),
    ).rejects.toThrow(/sell-fee-rate/);
  });

  /**
   * EMBR again, on its second failure. One file of its suite declared its own `PoolKey` and
   * called the hook's callback directly; the whole suite was refused and the market ended.
   * The file goes, the market stays — but only because what is left still proves the invariant.
   */
  it("drops a file that misuses the fixture rather than the market", async () => {
    const provider = scriptedProvider([
      {
        files: [
          {
            path: "test/Market.t.sol",
            content:
              "contract T is MarketTestBase {\n    function test_sells() public {}\n}",
          },
          {
            path: "test/Security.t.sol",
            content:
              "contract S is MarketTestBase {\n    function test_poke() public {\n" +
              "        hook.beforeSwap(address(this), key, params, \"\");\n    }\n}",
          },
        ],
        coverage: [{ invariantId: "sell-fee-rate", testName: "test_sells" }],
        notes: [],
      },
    ]);

    const output = await generateTests(provider, {
      specification: market(),
      sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
      context: { architecture: "", generation: "", testing: "" },
      testEnvironment: { guidance: "" },
      core,
    });

    expect(output.value.files.map((file) => file.path)).toEqual(["test/Market.t.sol"]);
    expect(output.value.discarded[0]?.path).toBe("test/Security.t.sol");
    expect(output.value.discarded[0]?.why).toContain("hook callback");
  });

  /** The drop is not a way to accept a suite that proves nothing. */
  it("refuses when dropping the offending file would leave an invariant unproven", async () => {
    const suite = {
      files: [
        {
          path: "test/Security.t.sol",
          content:
            "contract S is MarketTestBase {\n    function test_sells() public {\n" +
            "        hook.beforeSwap(address(this), key, params, \"\");\n    }\n}",
        },
      ],
      coverage: [{ invariantId: "sell-fee-rate", testName: "test_sells" }],
      notes: [],
    };

    const provider = scriptedProvider([suite, suite]);

    await expect(
      generateTests(provider, {
        specification: market(),
        sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
        context: { architecture: "", generation: "", testing: "" },
        testEnvironment: { guidance: "" },
        core,
      }),
    ).rejects.toThrow(/hook callback/);
  });

  /** Agen's suite is not the model's to rewrite, whatever comes back at its path. */
  it("keeps Agen's file even when the model returns one of its own at that path", async () => {
    const provider = scriptedProvider([
      {
        files: [
          { path: CORE_TEST_PATH, content: "contract MarketCoreTest { function test_nothing() public {} }" },
          { path: "test/Market.t.sol", content: "contract T is MarketTestBase {}" },
        ],
        coverage: [{ invariantId: "sell-fee-rate", testName: "test_core_sells_pay_the_stated_fee" }],
        notes: [],
      },
    ]);

    const output = await generateTests(provider, {
      specification: market(),
      sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
      context: { architecture: "", generation: "", testing: "" },
      core,
    });

    expect(output.value.files.map((file) => file.path)).toEqual(["test/Market.t.sol"]);
  });
});

function market(): MarketSpecification {
  return {
    version: 1,
    name: "Ember",
    symbol: "EMBR",
    summary: "Sells pay three percent",
    baseFeePpm: 3_000,
    maxFeePpm: 33_000,
    phases: [],
    state: [],
    rules: [],
    invariants: [
      { id: "sell-fee-rate", statement: "Each sell pays exactly 3%.", expression: "fee == 3%" },
    ],
    externalDependencies: [],
    assumptions: [],
    ambiguities: [],
    suggestions: [],
    unsupported: [],
  };
}
