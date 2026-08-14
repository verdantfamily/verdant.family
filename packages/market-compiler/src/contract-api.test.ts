/**
 * What a generator is told about the contracts it is allowed to call.
 *
 * The property under test is narrow and was expensive to learn: a name that appears here is
 * one the compiler accepted, and a name that does not appear here is one no prompt should
 * ever suggest. Everything else in this file is presentation.
 */

import { describe, expect, it } from "vitest";
import type { Abi } from "viem";

import { apiFromAbi, apiFromSource, contractApis, renderContractApis } from "./contract-api.js";

const ACCOUNTING_ABI = [
  {
    type: "constructor",
    inputs: [
      { name: "marketCreator_", type: "address" },
      { name: "configuredFeeReceiver_", type: "address" },
      { name: "installer_", type: "address" },
    ],
    stateMutability: "nonpayable",
  },
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
  {
    type: "function",
    name: "totalClaimable",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const satisfies Abi;

const VAULT_ABI = [
  {
    type: "function",
    name: "credit",
    inputs: [
      { name: "currency", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "receive", stateMutability: "payable" },
] as const satisfies Abi;

describe("the interface of a compiled contract", () => {
  it("lists the members a caller may use, and no others", () => {
    const api = apiFromAbi({
      contractName: "FlowtestCreatorFeeAccounting",
      sourcePath: "contracts/FlowtestCreatorFeeAccounting.sol",
      abi: ACCOUNTING_ABI,
    });

    expect(api.constructorParameters).toBe(
      "address marketCreator_, address configuredFeeReceiver_, address installer_",
    );
    expect(api.functions.map((member) => member.name)).toEqual([
      "recordSellFee",
      "totalClaimable",
    ]);

    const record = api.functions.find((member) => member.name === "recordSellFee")!;
    expect(record.parameters).toBe("address currency, uint256 collectedFee");
  });

  /**
   * The half of the FLOWTEST failure that no instruction was ever going to fix.
   *
   * `FeeVault(someAddress)` is a compile error and the message solc gives for it talks about
   * the address rather than about the vault, so a model reading the error looks in the wrong
   * place. Stated as a property of the type, where a caller will see it before writing the
   * line.
   */
  it("says when an address has to be cast through payable", () => {
    const api = apiFromAbi({ contractName: "FeeVault", sourcePath: null, abi: VAULT_ABI });

    expect(api.requiresPayableCast).toBe(true);
    expect(renderContractApis(new Map([["FeeVault", api]]))).toContain("FeeVault(payable(theAddress))");
  });

  it("does not claim a payable cast is needed where it is not", () => {
    const api = apiFromAbi({
      contractName: "FlowtestCreatorFeeAccounting",
      sourcePath: null,
      abi: ACCOUNTING_ABI,
    });

    expect(api.requiresPayableCast).toBe(false);
  });
});

describe("the interface read from a source file", () => {
  it("finds the externally callable functions and the payable receive", () => {
    const [api] = apiFromSource({
      path: "contracts/FeeVault.sol",
      content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract FeeVault {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function credit(address currency, uint256 amount) external {
        currency; amount;
    }

    function _internalOnly(uint256 value) internal pure returns (uint256) {
        return value;
    }

    receive() external payable {}
}
`,
    });

    expect(api!.contractName).toBe("FeeVault");
    expect(api!.constructorParameters).toBe("address owner_");
    expect(api!.requiresPayableCast).toBe(true);
    expect(api!.from).toBe("source");

    // Internal members are not callable, so listing them would put a name in front of a
    // model that using would be a compile error.
    expect(api!.functions.map((member) => member.name)).toEqual(["credit"]);
  });

  /**
   * A reading of one file cannot see through inheritance, and says so.
   *
   * Silence about an inherited member is the acceptable failure. Silence that reads like
   * completeness is not: a caller told "these are the only members" about a partial list
   * would conclude a real function does not exist.
   */
  it("admits that it did not resolve base contracts", () => {
    const apis = contractApis({
      sources: [
        {
          path: "contracts/Thing.sol",
          content: "contract Thing is Base { function go() external {} }",
        },
      ],
    });

    expect(renderContractApis(apis)).toContain("inherited from a base contract are not listed");
  });
});

describe("choosing between the compiler and the file", () => {
  it("prefers the compiled ABI where both exist", () => {
    const apis = contractApis({
      sources: [
        {
          path: "contracts/Accounting.sol",
          content: "contract Accounting { function stale() external {} }",
        },
      ],
      artifacts: [
        {
          contractName: "Accounting",
          sourcePath: "contracts/Accounting.sol",
          abi: ACCOUNTING_ABI,
          bytecode: "0x",
          deployedBytecode: "0x",
          compilerVersion: "0.8.26",
          sourceHash: "0x",
          source: "",
        },
      ],
    });

    const api = apis.get("Accounting")!;
    expect(api.from).toBe("abi");
    expect(api.functions.map((member) => member.name)).not.toContain("stale");
  });

  it("leaves the contract being written out of its own briefing", () => {
    const apis = contractApis({
      sources: [
        { path: "contracts/A.sol", content: "contract A { function a() external {} }" },
        { path: "contracts/B.sol", content: "contract B { function b() external {} }" },
      ],
    });

    const rendered = renderContractApis(apis, { exclude: ["A"] });

    expect(rendered).toContain("function b()");
    expect(rendered).not.toContain("function a(");
  });

  it("renders nothing at all when there is nothing to say", () => {
    expect(renderContractApis(new Map())).toBe("");
  });
});
