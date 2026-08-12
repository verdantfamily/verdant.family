/**
 * These tests run the real compiler.
 *
 * Mocking `forge` here would test that this file can parse a string somebody wrote by
 * hand, which is not the risky part. The risky part is whether a generated hook
 * compiles against the vendored v4 tree at all, and whether solc's JSON says what this
 * code believes it says — both of which are claims about somebody else's software and
 * both of which change when that software is upgraded.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { build, forModel, test as runTests } from "./foundry.js";
import type { Workspace } from "./workspace.js";
import { createWorkspace } from "./workspace.js";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = resolve(here, "../../contracts/vendor");

let workspace: Workspace | null = null;

async function open(): Promise<Workspace> {
  workspace = await createWorkspace({ vendorRoot: VENDOR });
  return workspace;
}

afterEach(async () => {
  await workspace?.dispose();
  workspace = null;
});

beforeAll(async () => {
  // A clear failure here beats every test below failing for the same hidden reason.
  await promisify(execFile)("forge", ["--version"]).catch(() => {
    throw new Error("forge is not on the PATH; the market compiler cannot build without it");
  });
});

/**
 * A hook doing the three things the production hook structurally cannot: telling a buy
 * from a sell, writing state during a swap, and declaring the permission that lets it
 * take a fee into custody. If this stops compiling, the product does not work.
 */
const GENERATED_HOOK = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

contract GeneratedHook {
    uint256 public consecutiveBuys;

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function feeFor(bool zeroForOne) public returns (uint24) {
        if (zeroForOne) {
            consecutiveBuys += 1;
        } else {
            consecutiveBuys = 0;
        }
        return consecutiveBuys >= 10 ? 0 : 5_000;
    }
}
`;

describe("the scratch workspace", () => {
  it("compiles a generated v4 hook against the vendored tree", async () => {
    const space = await open();
    await space.write([{ path: "src/GeneratedHook.sol", content: GENERATED_HOOK }]);

    const result = await build({ root: space.root });

    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("refuses a generated path that would escape the project", async () => {
    const space = await open();

    await expect(
      space.write([{ path: "../../packages/contracts/src/VerdantHook.sol", content: "" }]),
    ).rejects.toThrow(/escapes the workspace/);

    await expect(space.write([{ path: "/etc/passwd", content: "" }])).rejects.toThrow(
      /must be relative/,
    );
  });
});

describe("diagnostics", () => {
  it("locates an error at a line and column with the source in view", async () => {
    const space = await open();
    await space.write([
      {
        path: "src/Broken.sol",
        content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract Broken {
    uint256 public total;

    function add(uint256 amount) external {
        total += amuont;
    }
}
`,
      },
    ]);

    const result = await build({ root: space.root });
    expect(result.ok).toBe(false);

    const error = result.diagnostics.find((d) => d.severity === "error");
    expect(error).toBeDefined();
    expect(error?.type).toBe("DeclarationError");
    expect(error?.file).toBe("src/Broken.sol");
    expect(error?.line).toBe(8);
    expect(error?.message).toMatch(/Undeclared identifier/);
    // The excerpt is what makes this actionable rather than merely true.
    expect(error?.excerpt).toContain("amuont");
    expect(error?.excerpt).toContain("^");
  });

  it("renders errors for a model without the vendored cascade", () => {
    const rendered = forModel([
      {
        severity: "error",
        type: "TypeError",
        code: "9553",
        file: "src/GeneratedHook.sol",
        line: 41,
        column: 16,
        message: "Invalid type for argument.",
        excerpt: "41 |         return x;\n   |                ^",
      },
      {
        severity: "error",
        type: "TypeError",
        code: "1234",
        file: "vendor/v4-periphery/lib/v4-core/src/PoolManager.sol",
        line: 9,
        column: 1,
        message: "Note: declared here.",
        excerpt: null,
      },
      {
        severity: "warning",
        type: "Warning",
        code: "2072",
        file: "src/GeneratedHook.sol",
        line: 12,
        column: 9,
        message: "Unused local variable.",
        excerpt: null,
      },
    ]);

    expect(rendered).toContain("src/GeneratedHook.sol:41:16");
    expect(rendered).toContain("TypeError 9553");
    expect(rendered).toContain("return x;");
    // The note inside v4 and the warning are both noise for a repair turn.
    expect(rendered).not.toContain("PoolManager.sol");
    expect(rendered).not.toContain("Unused local variable");
  });

  it("says so plainly when there is nothing to fix", () => {
    expect(forModel([])).toBe("no errors");
  });
});

describe("the test runner", () => {
  it("reports passing and failing generated tests separately", async () => {
    const space = await open();
    await space.write([
      { path: "src/GeneratedHook.sol", content: GENERATED_HOOK },
      {
        path: "test/GeneratedHook.t.sol",
        content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GeneratedHook} from "../src/GeneratedHook.sol";

contract GeneratedHookTest is Test {
    GeneratedHook hook;

    function setUp() public {
        hook = new GeneratedHook();
    }

    function test_aBuyIncrementsTheStreak() public {
        hook.feeFor(true);
        assertEq(hook.consecutiveBuys(), 1);
    }

    function test_aSellResetsTheStreak() public {
        hook.feeFor(true);
        hook.feeFor(false);
        assertEq(hook.consecutiveBuys(), 0);
    }

    function test_theTenthBuyIsFree() public {
        for (uint256 i = 0; i < 9; i++) {
            hook.feeFor(true);
        }
        assertEq(hook.feeFor(true), 0);
    }

    function test_thisOneIsWrongOnPurpose() public {
        hook.feeFor(true);
        assertEq(hook.consecutiveBuys(), 99);
    }
}
`,
      },
    ]);

    const result = await runTests({ root: space.root });

    expect(result.buildFailure).toBeNull();
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.ok).toBe(false);

    const failure = result.outcomes.find((outcome) => !outcome.passed);
    expect(failure?.name).toContain("thisOneIsWrongOnPurpose");
    expect(failure?.reason).toBeTruthy();
  });

  it("distinguishes a suite that will not compile from a suite that fails", async () => {
    const space = await open();
    await space.write([
      { path: "src/GeneratedHook.sol", content: GENERATED_HOOK },
      {
        path: "test/GeneratedHook.t.sol",
        content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GeneratedHook} from "../src/GeneratedHook.sol";

contract GeneratedHookTest is Test {
    function test_callsSomethingThatIsNotThere() public {
        GeneratedHook hook = new GeneratedHook();
        hook.thisMethodDoesNotExist();
    }
}
`,
      },
    ]);

    const result = await runTests({ root: space.root });

    expect(result.ok).toBe(false);
    expect(result.outcomes).toEqual([]);
    expect(result.buildFailure).not.toBeNull();
    expect(result.buildFailure?.length).toBeGreaterThan(0);
    expect(forModel(result.buildFailure ?? [])).toMatch(/thisMethodDoesNotExist|not found|member/i);
  });
});
