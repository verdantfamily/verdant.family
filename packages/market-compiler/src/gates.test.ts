/**
 * The gates are tested against real compilations, not against hand-written AST.
 *
 * A hand-written fixture would encode this file's belief about what solc emits, and the
 * belief is the thing most likely to be wrong — particularly for the cases that matter,
 * where a model writes `delegatecall` in a form nobody predicted. So every prohibition
 * below is proven by compiling a contract that actually contains it.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  analyseGenerated,
  combine,
  elevatedRiskIsCovered,
  hookPermissionParity,
  invariantCoverage,
  invariantsWereProven,
} from "./gates.js";
import type { Workspace } from "./workspace.js";
import { createWorkspace } from "./workspace.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = resolve(here, "../../contracts/vendor");

let workspace: Workspace | null = null;

afterEach(async () => {
  await workspace?.dispose();
  workspace = null;
});

beforeAll(async () => {
  await run("forge", ["--version"]).catch(() => {
    throw new Error("forge is not on the PATH; the gates cannot analyse without a build");
  });
});

/** Compile a generated contract and hand its AST to the gates. */
async function analyse(source: string, hookContractName?: string) {
  workspace = await createWorkspace({ vendorRoot: VENDOR });
  await workspace.write([{ path: "src/Generated.sol", content: source }]);

  const { stdout } = await run("forge", ["build", "--force", "--json"], {
    cwd: workspace.root,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));

  return analyseGenerated({
    root: workspace.root,
    buildOutput: JSON.parse(stdout),
    ...(hookContractName === undefined ? {} : { hookContractName }),
  });
}

function contract(body: string): string {
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract Generated {
${body}
}
`;
}

describe("structural prohibitions", () => {
  it("passes an ordinary generated contract", async () => {
    const result = await analyse(
      contract(`    uint256 public jackpot;

    function accrue(uint256 amount) external {
        jackpot += amount;
    }`),
    );

    expect(result.findings).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("marks delegatecall elevated rather than refusing it", async () => {
    // Policy change worth pinning: refusing this outright meant rejecting legitimate
    // architectures over how they were implemented.
    const result = await analyse(
      contract(`    function reroute(address target, bytes calldata data) external {
        (bool ok,) = target.delegatecall(data);
        require(ok);
    }`),
    );

    const finding = result.findings.find((f) => f.code === "GATE_DELEGATECALL");
    expect(finding?.severity).toBe("elevated");
    expect(finding?.file).toBe("src/Generated.sol");
    expect(finding?.line).toBe(6);
    // Elevated does not stop a launch on its own; `elevatedRiskIsCovered` decides that.
    expect(result.passed).toBe(true);
  });

  it("blocks selfdestruct", async () => {
    const result = await analyse(
      contract(`    function rugPull(address payable to) external {
        selfdestruct(to);
    }`),
    );

    expect(result.findings.some((f) => f.code === "GATE_SELFDESTRUCT")).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("marks a raw value-bearing call elevated", async () => {
    // Sending ether to a wallet has no typed interface to go through, so refusing this
    // rejected correct code.
    const result = await analyse(
      contract(`    function payOut(address to, uint256 amount) external {
        (bool ok,) = to.call{value: amount}("");
        require(ok);
    }`),
    );

    const finding = result.findings.find((f) => f.code === "GATE_LOW_LEVEL_CALL");
    expect(finding?.severity).toBe("elevated");
    expect(result.passed).toBe(true);
  });

  it("blocks tx.origin", async () => {
    const result = await analyse(
      contract(`    function isDirect() external view returns (bool) {
        return tx.origin == msg.sender;
    }`),
    );

    expect(result.findings.some((f) => f.code === "GATE_TX_ORIGIN")).toBe(true);
  });

  it("marks inline assembly elevated, without judging what it does", async () => {
    // The gate still does not try to reason about the assembly. It cannot; what it can
    // do is insist the code around it was fuzzed and name it on the review screen.
    const result = await analyse(
      contract(`    function size(address who) external view returns (uint256 n) {
        assembly {
            n := extcodesize(who)
        }
    }`),
    );

    const finding = result.findings.find((f) => f.code === "GATE_INLINE_ASSEMBLY");
    expect(finding?.severity).toBe("elevated");
    expect(result.passed).toBe(true);
  });

  it("still refuses selfdestruct and tx.origin, which no mechanic needs", async () => {
    const destroyed = await analyse(
      contract(`    function rugPull(address payable to) external {
        selfdestruct(to);
    }`),
    );
    expect(destroyed.passed).toBe(false);

    const origin = await analyse(
      contract(`    function isDirect() external view returns (bool) {
        return tx.origin == msg.sender;
    }`),
    );
    expect(origin.passed).toBe(false);
  });

  it("warns about a loop over a collection without blocking it", async () => {
    const result = await analyse(
      contract(`    address[] public holders;
    mapping(address => uint256) public owed;

    function distribute(uint256 amount) external {
        for (uint256 i = 0; i < holders.length; i++) {
            owed[holders[i]] += amount / holders.length;
        }
    }`),
    );

    const finding = result.findings.find((f) => f.code === "GATE_UNBOUNDED_LOOP");
    expect(finding?.severity).toBe("warning");
    // A gas hazard is not a theft, so it is surfaced rather than refused.
    expect(result.passed).toBe(true);
  });

  it("refuses to clear a market when there was nothing to analyse", async () => {
    workspace = await createWorkspace({ vendorRoot: VENDOR });
    const result = await analyseGenerated({ root: workspace.root, buildOutput: { sources: {} } });

    expect(result.passed).toBe(false);
    expect(result.findings[0]?.code).toBe("GATE_NO_SOURCES");
  });

  it("does not judge the vendored tree by these rules", async () => {
    // v4 contains assembly and low-level calls because it is mature code doing things
    // that need them. A gate that failed every build over that would be useless.
    const result = await analyse(
      `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";

contract Generated {
    function permissions() external pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions(false, false, false, false, false, false, true, true, false, false, false, false, false, false);
    }
}
`,
    );

    expect(result.findings).toEqual([]);
  });

  /**
   * Three markets in one benchmark run — SIMPLE, TESTC and SHIFT — were refused as unsafe
   * with every test passing, for inline assembly none of them contained. It was in
   * `MarketTestBase`, which Agen writes: the hook miner searches in scratch space because
   * doing it in Solidity ran the fixture out of memory.
   *
   * A test is deployed nowhere and called by nobody, so it can never be the reason a market
   * is unsafe. The shape here is the fixture's own — assembly in a file under test/.
   */
  it("does not judge a market by the tests, including the ones Agen wrote", async () => {
    workspace = await createWorkspace({ vendorRoot: VENDOR });
    await workspace.write([
      {
        path: "src/Generated.sol",
        content: contract(`    uint256 public total;

    function accrue(uint256 amount) external {
        total += amount;
    }`),
      },
      {
        path: "test/MarketTestBase.sol",
        content: contract(`    function findSalt(bytes32 seed) internal pure returns (bytes32 salt) {
        assembly {
            mstore(0x00, seed)
            salt := keccak256(0x00, 0x20)
        }
    }`).replace("contract Generated", "contract MarketTestBase"),
      },
    ]);

    const { stdout } = await run("forge", ["build", "--force", "--json"], {
      cwd: workspace.root,
      maxBuffer: 64 * 1024 * 1024,
    }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));

    const result = await analyseGenerated({
      root: workspace.root,
      buildOutput: JSON.parse(stdout),
    });

    expect(result.findings.filter((f) => f.code === "GATE_INLINE_ASSEMBLY")).toEqual([]);
    expect(result.passed).toBe(true);
  }, 120_000);
});

describe("an unguarded hook", () => {
  /**
   * The regression for a market that was generated, compiled, passed twenty-three of
   * its own tests, cleared every other gate, and could be drained by anybody. Its
   * ledger was permissioned correctly; the hook the ledger trusted was not.
   */
  const OPEN_HOOK = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract MarketHook {
    mapping(address => uint256) public credited;

    function onTrade(address trader, uint256 amount) external {
        credited[trader] += amount;
    }
}
`;

  const GUARDED_BY_LINE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract MarketHook {
    address public immutable poolManager;
    mapping(address => uint256) public credited;

    error NotPoolManager(address caller);

    constructor(address poolManager_) {
        poolManager = poolManager_;
    }

    function onTrade(address trader, uint256 amount) external {
        if (msg.sender != poolManager) revert NotPoolManager(msg.sender);
        credited[trader] += amount;
    }
}
`;

  const GUARDED_BY_MODIFIER = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract MarketHook {
    address public immutable poolManager;
    mapping(address => uint256) public credited;

    error NotPoolManager(address caller);

    constructor(address poolManager_) {
        poolManager = poolManager_;
    }

    modifier onlyPoolManager() {
        if (msg.sender != poolManager) revert NotPoolManager(msg.sender);
        _;
    }

    function onTrade(address trader, uint256 amount) external onlyPoolManager {
        credited[trader] += amount;
    }
}
`;

  it("blocks a hook whose state-changing entry point checks nobody", async () => {
    const result = await analyse(OPEN_HOOK, "MarketHook");

    const finding = result.findings.find((f) => f.code === "GATE_UNGUARDED_HOOK_MUTATOR");
    expect(finding?.severity).toBe("blocker");
    expect(finding?.detail).toContain("onTrade");
    expect(result.passed).toBe(false);
  });

  it("accepts a guard written inline", async () => {
    const result = await analyse(GUARDED_BY_LINE, "MarketHook");
    expect(result.findings).toEqual([]);
  });

  it("accepts a guard written as a modifier", async () => {
    // Resolving modifiers matters: rejecting the idiomatic form would push generation
    // towards the sloppier one.
    const result = await analyse(GUARDED_BY_MODIFIER, "MarketHook");
    expect(result.findings).toEqual([]);
  });

  it("accepts a guard inherited from the prelude, which it cannot see", async () => {
    // The prelude is excluded from the sources this walks, so `onlyInstaller` has no
    // definition here to resolve. Without allowing for that, the gate would block the
    // one-time wiring setter it tells generators to write — and the alternative it would
    // be pushing them back towards is the permissionless setter a live PULSE build
    // shipped, where anybody could have claimed the fee vault first.
    const result = await analyse(
      `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract MarketHook {
    address public feeVault;

    modifier onlyInstaller() {
        _;
    }

    function setFeeVault(address vault) external onlyInstaller {
        feeVault = vault;
    }
}
`,
      "MarketHook",
    );

    expect(result.findings).toEqual([]);
  });

  it("warns rather than blocks on a crank that cannot name a beneficiary", async () => {
    // Permissionless settlement is a real design: a quiet market still has to close its
    // rounds. Blocking it would push generation towards markets that cannot.
    const result = await analyse(
      `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract MarketHook {
    uint256 public round;

    function settleIfDue() external {
        round += 1;
    }
}
`,
      "MarketHook",
    );

    const finding = result.findings.find((f) => f.code === "GATE_UNGUARDED_HOOK_MUTATOR");
    expect(finding?.severity).toBe("warning");
    expect(result.passed).toBe(true);
  });

  it("says nothing about view functions, which cannot be abused this way", async () => {
    const result = await analyse(
      `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract MarketHook {
    uint256 public total;

    function feeFor(bool isBuy) external view returns (uint256) {
        return isBuy ? total : total * 2;
    }
}
`,
      "MarketHook",
    );

    expect(result.findings).toEqual([]);
  });

  it("holds only the hook to this, since a one-time setter legitimately has no guard", async () => {
    // The wiring pattern: settable once, by anyone, before the market exists. Judging
    // every contract by the hook's standard would reject it.
    const result = await analyse(
      `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract Ledger {
    address public hook;

    function setHook(address hook_) external {
        require(hook == address(0), "wired");
        hook = hook_;
    }
}
`,
      "MarketHook",
    );

    expect(result.findings).toEqual([]);
  });
});

describe("what elevated risk has to buy", () => {
  const elevated = [
    {
      code: "GATE_DELEGATECALL",
      severity: "elevated" as const,
      title: "Delegate call",
      detail: "d",
      file: "contracts/Hook.sol",
      line: 12,
    },
  ];

  it("passes when a fuzz test exercised the code", () => {
    const result = elevatedRiskIsCovered({
      findings: elevated,
      fuzzedTests: ["testFuzz_forwardingIsBounded(uint256)"],
    });

    expect(result.passed).toBe(true);
  });

  it("blocks when nothing was fuzzed", () => {
    const result = elevatedRiskIsCovered({ findings: elevated, fuzzedTests: [] });

    expect(result.passed).toBe(false);
    expect(result.findings[0]?.code).toBe("GATE_ELEVATED_RISK_UNTESTED");
    expect(result.findings[0]?.detail).toContain("Delegate call");
  });

  it("asks nothing of a market that used no low-level code", () => {
    expect(elevatedRiskIsCovered({ findings: [], fuzzedTests: [] }).passed).toBe(true);
  });
});

describe("hook permission parity", () => {
  it("accepts an address whose bits match the declaration", () => {
    // 0x18c8: afterInitialize | beforeAddLiquidity | beforeSwap | afterSwap | beforeSwapReturnDelta
    const result = hookPermissionParity({
      declared: [
        "afterInitialize",
        "beforeAddLiquidity",
        "beforeSwap",
        "afterSwap",
        "beforeSwapReturnDelta",
      ],
      address: "0x5d157BF2dda7249eB6f1aF7b859f18BbC1b7d8C8",
    });

    expect(result.passed).toBe(true);
  });

  it("catches the silent failure where a declared callback would never be called", () => {
    // The production hook's address, which has no afterSwap bit. A market whose
    // jackpot accrues in afterSwap would trade perfectly and never pay out.
    const result = hookPermissionParity({
      declared: ["beforeInitialize", "afterInitialize", "beforeAddLiquidity", "beforeSwap", "afterSwap"],
      address: "0x0000000000000000000000000000000000003880",
    });

    expect(result.passed).toBe(false);
    expect(result.findings[0]?.code).toBe("GATE_HOOK_PERMISSION_MISMATCH");
    expect(result.findings[0]?.detail).toContain("afterSwap");
    expect(result.findings[0]?.detail).toContain("silently never run");
  });

  it("catches an address claiming a callback the contract does not implement", () => {
    const result = hookPermissionParity({
      declared: ["beforeSwap"],
      address: "0x00000000000000000000000000000000000038C0",
    });

    expect(result.passed).toBe(false);
    expect(result.findings[0]?.detail).toMatch(/which the contract does not implement/);
  });
});

describe("evidence for claimed invariants", () => {
  it("clears an invariant that a passing test exercises", () => {
    const result = invariantsWereProven({
      invariantIds: ["fee-ceiling"],
      passingTests: ["invariant_feeCeiling_neverExceedsThreePercent()"],
    });

    expect(result.passed).toBe(true);
  });

  it("refuses a market that claims a property nothing tested", () => {
    const result = invariantsWereProven({
      invariantIds: ["fee-ceiling", "reserves-conserved"],
      passingTests: ["invariant_feeCeiling_holds()"],
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.detail).toContain("reserves-conserved");
    expect(result.findings[0]?.detail).toContain("no evidence");
  });

  // A live GROVE build tested all six of its invariants, passed all 22 tests, and was
  // refused at the last gate because one test was called what it does rather than what
  // it proves. The evidence was there and the gate was reading the wrong field.
  it("clears an invariant a passing test claims in the comment above it", () => {
    const suite = {
      content: [
        "contract GroveBehaviorTest is MarketTestBase {",
        "    // Invariant: buy-fee-free — Every swap that buys GROVE has no trading fee.",
        "    function test_buy_has_no_fee() public {",
        "        assertEq(credited(), 0);",
        "    }",
        "}",
      ].join("\n"),
    };

    const result = invariantsWereProven({
      invariantIds: ["buy-fee-free"],
      passingTests: ["test_buy_has_no_fee()"],
      coverage: invariantCoverage({ invariantIds: ["buy-fee-free"], sources: [suite] }),
    });

    expect(result.passed).toBe(true);
  });

  it("refuses an invariant whose only claiming test did not pass", () => {
    const suite = {
      content: [
        "    // Invariant: buy-fee-free",
        "    function test_buy_has_no_fee() public {}",
      ].join("\n"),
    };

    const result = invariantsWereProven({
      invariantIds: ["buy-fee-free"],
      passingTests: ["test_something_else()"],
      coverage: invariantCoverage({ invariantIds: ["buy-fee-free"], sources: [suite] }),
    });

    expect(result.passed).toBe(false);
  });
});

describe("which test stands behind which invariant", () => {
  it("attaches a comment to the declaration below it, and not to the rest of the file", () => {
    const coverage = invariantCoverage({
      invariantIds: ["fee-ceiling", "buy-fee-free"],
      sources: [
        {
          content: [
            "    // Invariant: fee-ceiling — no trade may be charged more than 2%.",
            "    function test_fee_is_capped() public {}",
            "",
            "    function test_unrelated() public {}",
          ].join("\n"),
        },
      ],
    });

    expect(coverage.get("fee-ceiling")).toEqual(["test_fee_is_capped"]);
    expect(coverage.get("buy-fee-free")).toEqual([]);
  });

  // The distinction the old whole-file search could not make. A suite that lists its
  // invariants at the top and then tests three of them is a suite with an untested
  // invariant, and generation has to hear that before the market is built on it.
  it("does not read a file-header list of invariants as coverage", () => {
    const coverage = invariantCoverage({
      invariantIds: ["treasury-destination"],
      sources: [
        {
          content: [
            "// Invariants covered here: treasury-destination",
            "",
            "contract T is MarketTestBase {",
            "    function test_sells_are_charged() public {}",
            "}",
          ].join("\n"),
        },
      ],
    });

    expect(coverage.get("treasury-destination")).toEqual([]);
  });

  it("matches a fuzz test against the name forge reports for it", () => {
    const result = invariantsWereProven({
      invariantIds: ["fee-conservation"],
      passingTests: ["testFuzz_sells_conserve_fees(uint128)"],
      coverage: invariantCoverage({
        invariantIds: ["fee-conservation"],
        sources: [
          {
            content: [
              "    /// Invariant: fee-conservation",
              "    function testFuzz_sells_conserve_fees(uint128 amount) public {}",
            ].join("\n"),
          },
        ],
      }),
    });

    expect(result.passed).toBe(true);
  });
});

describe("the combined verdict", () => {
  it("fails when any gate blocks, and keeps every finding", () => {
    const verdict = combine([
      { passed: true, findings: [] },
      {
        passed: true,
        findings: [
          { code: "GATE_UNBOUNDED_LOOP", severity: "warning", title: "t", detail: "d", file: null, line: null },
        ],
      },
      {
        passed: false,
        findings: [
          { code: "GATE_DELEGATECALL", severity: "blocker", title: "t", detail: "d", file: null, line: null },
        ],
      },
    ]);

    expect(verdict.passed).toBe(false);
    expect(verdict.findings).toHaveLength(2);
  });
});
