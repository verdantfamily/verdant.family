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
import { annotateCoverage, ArtefactError, generateTests } from "./engineer.js";
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

  /**
   * FRAG asked for a 0.5% sell fee and lost its build here, four times in a row.
   *
   * Generation asks for "a fuzz or invariant test" behind every invariant, and forge only runs a
   * Foundry invariant test if it is called `invariant_*`. The model wrote `invariant_sell_fee`,
   * named it in the coverage field, and was told no test stood behind `sell-fee` — then told the
   * same thing on all three retries, because there was nothing about the answer to correct.
   */
  it("counts a Foundry invariant test, which cannot be named anything else", () => {
    const suite = [
      {
        path: "test/Frag.t.sol",
        content:
          "contract F is MarketTestBase {\n" +
          "    /// Invariant: sell-fee\n" +
          "    function invariant_sell_fee() public {}\n}",
      },
    ];

    expect(invariantCoverage({ invariantIds: ["sell-fee"], sources: suite }).get("sell-fee")).toEqual([
      "invariant_sell_fee",
    ]);
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

/**
 * A suite that is incomplete rather than wrong.
 *
 * This was the largest source of run-to-run variance in the benchmark, and the mechanism was the
 * retry rather than the model: a suite that proved every invariant but one was thrown away whole,
 * the model wrote a new one from the market, and the new one missed something else. TYPO came back
 * refused for a different uncovered invariant on each attempt, having discarded a working suite
 * twice. The same market, the same prompt, two different failures.
 *
 * So the accepted tests stay and the model is asked for the gap. What is proved below is that they
 * stay — byte for byte, including a file the second answer never mentions — because the value of
 * this path is entirely in what it does not touch.
 */
describe("a suite missing one invariant's test", () => {
  const twoFiles = {
    files: [
      {
        path: "test/Fees.t.sol",
        content: "contract F is MarketTestBase {\n    function test_sells_pay() public {}\n}",
      },
      {
        path: "test/Rules.t.sol",
        content: "contract R is MarketTestBase {\n    function test_rule_fires() public {}\n}",
      },
    ],
    coverage: [{ invariantId: "sell-fee-rate", testName: "test_sells_pay" }],
    notes: [],
  };

  const twoInvariants = (): MarketSpecification => ({
    ...market(),
    invariants: [
      { id: "sell-fee-rate", statement: "Each sell pays exactly 3%.", expression: "fee == 3%" },
      { id: "accrual-monotonic", statement: "Accrued fees never decrease.", expression: "a' >= a" },
    ],
  });

  it("keeps every accepted test and adds only the missing one", async () => {
    const provider = scriptedProvider([
      twoFiles,
      // The second answer returns one file: the new test, and nothing it was not asked for.
      {
        files: [
          {
            path: "test/Accrual.t.sol",
            content:
              "contract A is MarketTestBase {\n    function testFuzz_accrual_only_grows() public {}\n}",
          },
        ],
        coverage: [
          { invariantId: "sell-fee-rate", testName: "test_sells_pay" },
          { invariantId: "accrual-monotonic", testName: "testFuzz_accrual_only_grows" },
        ],
        notes: [],
      },
    ]);

    let thrown: unknown;
    let output: Awaited<ReturnType<typeof generateTests>> | undefined;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        output = await generateTests(provider, {
          specification: twoInvariants(),
          sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
          context: { architecture: "", generation: "", testing: "" },
          ...(thrown instanceof ArtefactError
            ? {
                previous: thrown.files ?? [],
                missingCoverage: thrown.missingCoverage ?? [],
                validationProblems: thrown.problems,
              }
            : {}),
        });
        break;
      } catch (error) {
        thrown = error;
      }
    }

    // The first answer was refused for the invariant nothing proved, and for nothing else.
    expect(thrown).toBeInstanceOf(ArtefactError);
    expect((thrown as ArtefactError).missingCoverage?.join(" ")).toContain("accrual-monotonic");

    const files = output?.value.files ?? [];
    expect(files.map((file) => file.path).sort()).toEqual([
      "test/Accrual.t.sol",
      "test/Fees.t.sol",
      "test/Rules.t.sol",
    ]);

    // Rules.t.sol proves nothing and was never mentioned again. It survives anyway: a test that
    // was passing must not quietly become a different test on the way to fixing something else.
    expect(files.find((file) => file.path === "test/Rules.t.sol")?.content).toBe(
      twoFiles.files[1]!.content,
    );

    expect(
      invariantCoverage({
        invariantIds: ["sell-fee-rate", "accrual-monotonic"],
        sources: files,
      }).get("accrual-monotonic"),
    ).toEqual(["testFuzz_accrual_only_grows"]);
  });

  /**
   * A suite that misuses the fixture is wrong, not incomplete, and wrong suites are still
   * re-rolled. Getting this backwards would keep a broken file forever by only ever adding to it.
   */
  it("is not treated as incomplete when something else is also wrong", async () => {
    const provider = scriptedProvider([
      {
        files: [
          {
            path: "test/Bad.t.sol",
            content:
              "contract B is MarketTestBase {\n    function test_poke() public {\n" +
              '        hook.beforeSwap(address(this), key, params, "");\n    }\n}',
          },
        ],
        coverage: [],
        notes: [],
      },
    ]);

    const error = await generateTests(provider, {
      specification: twoInvariants(),
      sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
      context: { architecture: "", generation: "", testing: "" },
      testEnvironment: { guidance: "" },
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ArtefactError);
    expect((error as ArtefactError).missingCoverage).toBeUndefined();
  });

  /** An answer that returns more than it was asked for still cannot delete what it omits. */
  it("keeps the omitted files even when the answer rewrites one it was given", async () => {
    const provider = scriptedProvider([
      twoFiles,
      {
        files: [
          {
            path: "test/Fees.t.sol",
            content:
              "contract F is MarketTestBase {\n    function test_sells_pay() public {}\n" +
              "    function testFuzz_accrual_only_grows() public {}\n}",
          },
        ],
        coverage: [
          { invariantId: "sell-fee-rate", testName: "test_sells_pay" },
          { invariantId: "accrual-monotonic", testName: "testFuzz_accrual_only_grows" },
        ],
        notes: [],
      },
    ]);

    const first = await generateTests(provider, {
      specification: twoInvariants(),
      sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
      context: { architecture: "", generation: "", testing: "" },
    }).catch((thrown: unknown) => thrown as ArtefactError);

    const output = await generateTests(provider, {
      specification: twoInvariants(),
      sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
      context: { architecture: "", generation: "", testing: "" },
      previous: first.files ?? [],
      missingCoverage: first.missingCoverage ?? [],
    });

    expect(output.value.files.map((file) => file.path).sort()).toEqual([
      "test/Fees.t.sol",
      "test/Rules.t.sol",
    ]);
    expect(output.value.files.find((file) => file.path === "test/Fees.t.sol")?.content).toContain(
      "testFuzz_accrual_only_grows",
    );
  });
});

/**
 * A suite that is wrong in one file, where that file is also the only proof.
 *
 * An offending file is normally dropped and the market kept, which is safe precisely because the
 * proof is checked to survive without it. When it does not survive, the drop is refused and the
 * whole suite used to go back to the model — so a market lost its build for one test reaching
 * around the fixture, and the re-roll then had to rediscover every test that was already fine.
 * EMBR and STORY are both this, EMBR twice in one run.
 *
 * The suite stays and the named files are rewritten. What matters below is the same thing that
 * matters for the incomplete case: the files nobody complained about are not touched.
 */
/**
 * FRAG's answer, accepted.
 *
 * The whole path, as the model actually walked it: an invariant test under the only prefix forge
 * will run it under, named in the coverage field. This used to be refused at generation and asked
 * for again three times, and the same correct answer came back every time.
 */
describe("a suite that proves its invariants with Foundry invariant tests", () => {
  it("is accepted rather than asked for again", async () => {
    const provider = scriptedProvider([
      {
        files: [
          {
            path: "test/Frag.t.sol",
            content: "contract F is MarketTestBase {\n    function invariant_sell_fee_rate() public {}\n}",
          },
        ],
        coverage: [{ invariantId: "sell-fee-rate", testName: "invariant_sell_fee_rate" }],
        notes: [],
      },
    ]);

    const output = await generateTests(provider, {
      specification: market(),
      sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
      context: { architecture: "", generation: "", testing: "" },
    });

    expect(output.value.files).toHaveLength(1);
    expect(output.value.files[0]?.content).toContain("/// Invariant: sell-fee-rate");
  });
});

describe("a suite whose only fault is one file reaching around the fixture", () => {
  const suite = {
    files: [
      {
        path: "test/Fees.t.sol",
        content:
          "contract F is MarketTestBase {\n    function test_sells_pay() public {\n" +
          '        hook.beforeSwap(address(this), key, params, "");\n    }\n}',
      },
      {
        path: "test/Rules.t.sol",
        content: "contract R is MarketTestBase {\n    function test_rule_fires() public {}\n}",
      },
    ],
    coverage: [{ invariantId: "sell-fee-rate", testName: "test_sells_pay" }],
    notes: [],
  };

  /** The offending file cannot simply be dropped: it is the only thing proving the invariant. */
  it("is reported as repairable rather than re-rolled", async () => {
    const error = await generateTests(scriptedProvider([suite]), {
      specification: market(),
      sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
      context: { architecture: "", generation: "", testing: "" },
      testEnvironment: { guidance: "" },
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ArtefactError);
    expect((error as ArtefactError).manualInfrastructure?.join(" ")).toContain("test/Fees.t.sol");
    expect((error as ArtefactError).manualInfrastructure?.join(" ")).toContain("hook callback");

    // The add-only path stays off. Asking for another test would leave the bad file in the suite
    // until the retries ran out, which is why the two repairs are separate.
    expect((error as ArtefactError).missingCoverage).toBeUndefined();
  });

  it("keeps the file nobody complained about and replaces only the named one", async () => {
    const first = (await generateTests(scriptedProvider([suite]), {
      specification: market(),
      sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
      context: { architecture: "", generation: "", testing: "" },
      testEnvironment: { guidance: "" },
    }).catch((thrown: unknown) => thrown)) as ArtefactError;

    // The corrected file, proving the same invariant under the same name, through a trade.
    const corrected = {
      files: [
        {
          path: "test/Fees.t.sol",
          content:
            "contract F is MarketTestBase {\n    function test_sells_pay() public {\n" +
            "        sell(1 ether);\n    }\n}",
        },
      ],
      coverage: [{ invariantId: "sell-fee-rate", testName: "test_sells_pay" }],
      notes: [],
    };

    const output = await generateTests(scriptedProvider([corrected]), {
      specification: market(),
      sources: [{ path: "contracts/Hook.sol", content: "contract Hook {}" }],
      context: { architecture: "", generation: "", testing: "" },
      testEnvironment: { guidance: "" },
      previous: first.files ?? [],
      manualInfrastructure: first.manualInfrastructure ?? [],
    });

    expect(output.value.files.map((file) => file.path).sort()).toEqual([
      "test/Fees.t.sol",
      "test/Rules.t.sol",
    ]);

    // Untouched, byte for byte: the whole point of repairing rather than re-rolling.
    expect(output.value.files.find((file) => file.path === "test/Rules.t.sol")?.content).toBe(
      suite.files[1]!.content,
    );
    expect(output.value.files.find((file) => file.path === "test/Fees.t.sol")?.content).not.toContain(
      "beforeSwap",
    );
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
