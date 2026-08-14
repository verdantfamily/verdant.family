/**
 * The repairs that need no model, and the ones that must not be attempted without one.
 *
 * Both halves matter equally here. A rung that fixes too little wastes a model call on a
 * one-character edit; a rung that fixes too much silently rewrites a market's arithmetic to
 * make the compiler stop talking, which is the worse of the two by a distance.
 */

import { describe, expect, it } from "vitest";
import type { Abi } from "viem";

import { apiFromAbi } from "./contract-api.js";
import type { Diagnostic } from "./foundry.js";
import { mechanicalRepair } from "./mechanical-repair.js";

function error(over: Partial<Diagnostic>): Diagnostic {
  return {
    severity: "error",
    type: "TypeError",
    code: null,
    file: "contracts/FlowtestFeeHook.sol",
    line: 1,
    column: 1,
    message: "",
    excerpt: null,
    ...over,
  };
}

const ACCOUNTING = apiFromAbi({
  contractName: "FlowtestCreatorFeeAccounting",
  sourcePath: "contracts/FlowtestCreatorFeeAccounting.sol",
  abi: [
    {
      type: "function",
      name: "recordSellFee",
      inputs: [
        { name: "currency", type: "address" },
        { name: "collectedFee", type: "uint256" },
      ],
      outputs: [],
      stateMutability: "nonpayable",
    },
  ] as const satisfies Abi,
});

const apis = new Map([[ACCOUNTING.contractName, ACCOUNTING]]);

// --- the cast, which has exactly one right answer ---------------------------

describe("an address converted to a contract that can receive ether", () => {
  const message =
    'Explicit type conversion not allowed from non-payable "address" to "contract FeeVault", ' +
    "which has a payable fallback function.";

  it("casts through payable without asking a model", () => {
    const source = {
      path: "contracts/FlowtestFeeHook.sol",
      content: ["contract H {", "    constructor(address v) {", "        vault = FeeVault(v);", "    }", "}"].join(
        "\n",
      ),
    };

    const repaired = mechanicalRepair({
      sources: [source],
      diagnostics: [error({ message, line: 3, column: 17 })],
      apis,
    });

    expect(repaired.files).toHaveLength(1);
    expect(repaired.files[0]!.content).toContain("FeeVault(payable(v))");
    expect(repaired.fixes[0]).toContain("payable()");
  });

  it("keeps the rest of the line, and the rest of the file, exactly as it was", () => {
    const source = {
      path: "contracts/FlowtestFeeHook.sol",
      content: [
        "contract H {",
        "    uint256 public constant SELL_FEE_PPM = 10_000;",
        "        feeVault = FeeVault(feeVault_);",
        "    function untouched() external {}",
        "}",
      ].join("\n"),
    };

    const repaired = mechanicalRepair({
      sources: [source],
      diagnostics: [error({ message, line: 3, column: 20 })],
      apis,
    });

    const lines = repaired.files[0]!.content.split("\n");
    expect(lines[1]).toBe("    uint256 public constant SELL_FEE_PPM = 10_000;");
    expect(lines[2]).toBe("        feeVault = FeeVault(payable(feeVault_));");
    expect(lines[3]).toBe("    function untouched() external {}");
  });

  it("handles a call inside the conversion without losing a bracket", () => {
    const source = {
      path: "contracts/FlowtestFeeHook.sol",
      content: "        v = FeeVault(resolve(a, b));",
    };

    const repaired = mechanicalRepair({
      sources: [source],
      diagnostics: [error({ message, line: 1, column: 13 })],
      apis,
    });

    expect(repaired.files[0]!.content).toBe("        v = FeeVault(payable(resolve(a, b)));");
  });

  it("does not wrap something that is already wrapped", () => {
    const source = {
      path: "contracts/FlowtestFeeHook.sol",
      content: "        v = FeeVault(payable(feeVault_));",
    };

    const repaired = mechanicalRepair({
      sources: [source],
      diagnostics: [error({ message, line: 1, column: 13 })],
      apis,
    });

    expect(repaired.files).toHaveLength(0);
  });
});

// --- the ones that need a judgement, and get facts instead ------------------

describe("a call to something a sibling does not have", () => {
  /**
   * The FLOWTEST error, and the reason this rung reports rather than repairs.
   *
   * `recordFee(currency, toReceiver, toCreator)` and `recordSellFee(currency, total)` differ
   * by more than a name: one of them splits the fee and the other expects the callee to. A
   * rewrite that matched the signature without understanding that would compile and pay the
   * wrong people.
   */
  it("states what the sibling actually exposes and changes nothing", () => {
    const repaired = mechanicalRepair({
      sources: [
        {
          path: "contracts/FlowtestFeeHook.sol",
          content: "        feeAccounting.recordFee(currency, toReceiver, toCreator);",
        },
      ],
      diagnostics: [
        error({
          message:
            'Member "recordFee" not found or not visible after argument-dependent lookup in ' +
            "contract FlowtestCreatorFeeAccounting.",
          line: 1,
        }),
      ],
      apis,
    });

    expect(repaired.files).toHaveLength(0);
    expect(repaired.notes[0]).toContain("recordSellFee(address currency, uint256 collectedFee)");
    expect(repaired.notes[0]).toContain("do not add a function");
  });

  it("still names the missing member when the sibling is not one of ours", () => {
    const repaired = mechanicalRepair({
      sources: [],
      diagnostics: [
        error({
          message:
            'Member "mint" not found or not visible after argument-dependent lookup in contract Stranger.',
        }),
      ],
      apis,
    });

    expect(repaired.notes[0]).toContain("Stranger has no member mint");
  });
});

describe("a call with the wrong number of arguments", () => {
  it("reports the mismatch and leaves the choice of fix open", () => {
    const repaired = mechanicalRepair({
      sources: [{ path: "contracts/FlowtestFeeHook.sol", content: "        v.credit(a, b, c);" }],
      diagnostics: [
        error({
          message: "Wrong argument count for function call: 3 arguments given but expected 2.",
          line: 1,
        }),
      ],
      apis,
    });

    expect(repaired.files).toHaveLength(0);
    expect(repaired.notes[0]).toContain("passes 3 arguments to a function that takes 2");
    expect(repaired.notes[0]).toContain("rather than changing the callee");
  });
});

describe("what it refuses to touch", () => {
  it("ignores warnings", () => {
    const repaired = mechanicalRepair({
      sources: [{ path: "contracts/FlowtestFeeHook.sol", content: "        v = FeeVault(x);" }],
      diagnostics: [
        error({
          severity: "warning",
          message:
            'Explicit type conversion not allowed from non-payable "address" to "contract FeeVault", ' +
            "which has a payable fallback function.",
          line: 1,
          column: 13,
        }),
      ],
      apis,
    });

    expect(repaired.files).toHaveLength(0);
  });

  it("says nothing about an error it has no rule for", () => {
    const repaired = mechanicalRepair({
      sources: [{ path: "contracts/FlowtestFeeHook.sol", content: "contract H {}" }],
      diagnostics: [error({ message: "Stack too deep.", type: "CompilerError" })],
      apis,
    });

    expect(repaired.files).toHaveLength(0);
    expect(repaired.notes).toHaveLength(0);
  });
});
