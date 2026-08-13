/**
 * The prelude has to compile, and a hook written the way the generator is told to write
 * one has to compile against it.
 *
 * Worth its own test because the cost of being wrong is measured in live builds: a
 * broken base contract would fail every generated market at the same place, three
 * repair rounds deep, several minutes in, with the model being blamed for it.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build, test as forgeTest } from "./foundry.js";
import {
  overridePoints,
  PRELUDE_CONTRACTS,
  preludeSources,
  testPreludeSources,
  tokenSource,
} from "./prelude.js";
import type { Workspace } from "./workspace.js";
import { createWorkspace } from "./workspace.js";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = resolve(here, "../../contracts/vendor");
const AGEN_SRC = resolve(here, "../../contracts/src/agen");

/**
 * The two prelude files that also exist as deployed contracts.
 *
 * `AgenRouter` writes the encoding and a generated hook reads it, so these two copies
 * have to agree on the layout byte for byte. A drift would not fail a build: it would
 * produce markets whose hooks decline every trade the router sends, which is a per-wallet
 * mechanic that silently refuses everybody and is discovered after launch.
 *
 * Compared on the code rather than the whole file, because the deployed contracts carry
 * a longer commentary — the argument for why the design is safe belongs with the source
 * of truth, and repeating it in a string constant the model reads would be noise.
 */
describe("the prelude's copies of the deployed contracts", () => {
  const bodyOf = (text: string): string =>
    text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("///") && !line.trimStart().startsWith("//"))
      .map((line) => line.trimEnd())
      .filter((line) => line !== "")
      .join("\n");

  it.each([
    ["AgenHookData", "contracts/AgenHookData.sol"],
    ["AgenRouted", "contracts/AgenRouted.sol"],
  ])("ships the same %s a market will be launched against", async (name, path) => {
    const deployed = await readFile(resolve(AGEN_SRC, `${name}.sol`), "utf8");
    const shipped = preludeSources().find((source) => source.path === path);

    expect(shipped, `${name} is not in the prelude`).toBeDefined();
    expect(bodyOf(shipped!.content)).toBe(bodyOf(deployed));
  });
});

let workspace: Workspace | null = null;

afterEach(async () => {
  await workspace?.dispose();
  workspace = null;
});

beforeAll(async () => {
  await promisify(execFile)("forge", ["--version"]).catch(() => {
    throw new Error("forge is not on the PATH");
  });
});

/** The scratch workspace uses `src/`, so the prelude's paths are rewritten for it. */
async function open() {
  workspace = await createWorkspace({ vendorRoot: VENDOR });
  await workspace.write([
    ...preludeSources().map((source) => ({
      path: source.path.replace(/^contracts\//, "src/"),
      content: source.content,
    })),
    // The harness already lives under test/, which is where the scratch project looks
    // for it too, so its path survives the rewrite the contracts need.
    ...testPreludeSources(),
  ]);
  return workspace;
}

describe("the generated-workspace prelude", () => {
  it("compiles on its own", async () => {
    const space = await open();
    const result = await build({ root: space.root });

    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  });

  it("names what a generated market must not redefine", () => {
    expect(PRELUDE_CONTRACTS).toContain("AgenBaseHook");
  });

  it("carries a market hook written the way the generator is instructed to write one", async () => {
    const space = await open();

    // Deliberately the shape the context tells a model to produce: extend the base,
    // declare permissions, override one internal, use the helpers. If this stops
    // compiling, every generated market stops compiling.
    await space.write([
      {
        path: "src/StreakHook.sol",
        content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {AgenBaseHook} from "./AgenBaseHook.sol";

contract StreakHook is AgenBaseHook {
    uint24 public constant BASE_FEE_PPM = 5_000;

    uint256 public consecutiveBuys;

    constructor(IPoolManager manager) AgenBaseHook(manager) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function _beforeSwap(address, PoolKey calldata, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
        if (isBuy(params)) {
            consecutiveBuys += 1;
        } else {
            consecutiveBuys = 0;
        }

        uint24 fee = consecutiveBuys >= 10 ? 0 : BASE_FEE_PPM;
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
`,
      },
    ]);

    const result = await build({ root: space.root });
    const errors = result.diagnostics.filter((entry) => entry.severity === "error");

    expect(errors.map((entry) => entry.message)).toEqual([]);
  });

  it("leaves a market no way to ship an unguarded callback", async () => {
    // The bug a gate had to be written for. Against this base it is structurally
    // impossible: the entry points are the base's and they are already guarded.
    const [base] = preludeSources();

    expect(base?.content).toContain("modifier onlyPoolManager()");
    expect(base?.content).toContain("revert NotPoolManager(msg.sender)");

    for (const callback of ["beforeSwap", "afterSwap", "beforeAddLiquidity", "afterInitialize"]) {
      expect(base?.content).toMatch(new RegExp(`function ${callback}\\([^)]*\\)[\\s\\S]{0,120}onlyPoolManager`));
    }
  });
});

/**
 * The harness is the one piece of the prelude whose correctness cannot be read off the
 * source: `deployHook` is right only if the pool manager subsequently agrees, and
 * "subsequently" means running a real swap against a real PoolManager. So this suite
 * runs the tests rather than compiling them.
 *
 * The build that motivated it is worth keeping in mind. EMBRT generated a correct
 * market, and its test suite deployed the hook at an address whose bits enabled nothing,
 * so every assertion about fees came back zero and every repair round went looking for
 * the bug in the hook.
 */
describe("the test harness generated suites are built on", () => {
  const HOOK = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {AgenBaseHook} from "./AgenBaseHook.sol";

contract SellFeeHook is AgenBaseHook {
    uint24 public constant SELL_FEE_PPM = 10_000;

    constructor(IPoolManager manager) AgenBaseHook(manager) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
    }

    function _beforeSwap(address, PoolKey calldata, SwapParams calldata params, bytes calldata)
        internal
        pure
        override
        returns (BeforeSwapDelta, uint24)
    {
        uint24 fee = isBuy(params) ? 0 : SELL_FEE_PPM;
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
`;

  /** Written the way the testing context instructs a model to write it. */
  const SUITE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

import {AgenTest} from "./AgenTest.sol";
import {SellFeeHook} from "../src/SellFeeHook.sol";
import {HarnessToken} from "../src/HarnessToken.sol";

contract SellFeeHookTest is AgenTest {
    SellFeeHook internal hook;
    HarnessToken internal token;

    function setUp() public {
        deployPoolManager();
        hook = SellFeeHook(deployHook("SellFeeHook.sol:SellFeeHook", abi.encode(manager)));

        // Mined above the zero address, which is how v4 addresses native ether, so the
        // pool sorts the way every Agen market does: quote first, token second.
        token = new HarnessToken(address(this));
        token.approve(address(swapRouter), type(uint256).max);
        token.approve(address(liquidityRouter), type(uint256).max);

        vm.deal(address(this), 1_000 ether);
    }

    function test_hook_address_encodes_its_permissions() public view {
        assertEq(uint160(address(hook)) & Hooks.BEFORE_SWAP_FLAG, Hooks.BEFORE_SWAP_FLAG);
        assertEq(uint160(address(hook)) & Hooks.AFTER_SWAP_FLAG, 0);
    }

    /// The assertion that matters: v4 itself validates the address, and a pool whose hook
    /// sits at the wrong one cannot be created at all.
    function test_pool_manager_accepts_a_pool_using_it() public {
        manager.initialize(poolKey(), 79228162514264337593543950336);
    }

    /// A real swap, through the manager, settled.
    ///
    /// This is the one that proves the harness is usable rather than merely correct: a
    /// generated suite that called _beforeSwap directly would revert with ManagerLocked
    /// the moment its hook touched the manager, which is what happened to a live build.
    function test_a_real_swap_runs_the_hook() public {
        PoolKey memory key = poolKey();
        manager.initialize(key, 79228162514264337593543950336);

        addLiquidity(key, 10 ether);
        swapExactIn(key, true, 0.01 ether);
    }

    function poolKey() internal view returns (PoolKey memory) {
        return agenPoolKey(
            Currency.wrap(address(0)),
            Currency.wrap(address(token)),
            IHooks(address(hook)),
            60
        );
    }
}
`;

  /** Ordinary enough that nothing about the harness depends on it. */
  const TOKEN = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract HarnessToken {
    string public constant name = "Harness";
    string public constant symbol = "HRN";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address recipient) {
        totalSupply = 1_000_000_000 ether;
        balanceOf[recipient] = totalSupply;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
`;

  it("deploys a hook the pool manager will actually accept, and swaps against it", async () => {
    const space = await open();
    await space.write([
      { path: "src/SellFeeHook.sol", content: HOOK },
      { path: "src/HarnessToken.sol", content: TOKEN },
      { path: "test/SellFeeHook.t.sol", content: SUITE },
    ]);

    const result = await forgeTest({ root: space.root });

    expect(result.buildFailure).toBeNull();
    expect(result.outcomes.filter((outcome) => !outcome.passed)).toEqual([]);
    expect(result.passed).toBe(3);
  }, 180_000);
});

describe("the token Agen writes itself", () => {
  /** The scratch workspace uses `src/`, so the token's path is rewritten for it. */
  async function openWith(source: { path: string; content: string }) {
    workspace = await createWorkspace({ vendorRoot: VENDOR });
    await workspace.write([
      { path: source.path.replace(/^contracts\//, "src/"), content: source.content },
    ]);
    return workspace;
  }

  it("compiles, and mints the whole supply to one recipient", async () => {
    const space = await openWith(
      tokenSource({
        contractName: "CanopyToken",
        name: "Canopy",
        symbol: "CNPY",
        supplyTokens: 1_000_000_000n,
      }),
    );

    const result = await build({ root: space.root });

    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("escapes a name chosen to break the file", async () => {
    // A creator can call a token anything, and the name reaches Solidity as a literal.
    const token = tokenSource({
      contractName: "AwkwardToken",
      name: 'the "operator" is gone',
      symbol: "OP",
      supplyTokens: 1n,
    });

    expect(token.content).toContain('the \\"operator\\" is gone');

    const space = await openWith(token);
    expect((await build({ root: space.root })).ok).toBe(true);
  });
});

describe("what the generator is told about this v4 commit", () => {
  it("lists every override point the base hook offers, as an override rather than a callback", () => {
    const points = overridePoints();

    expect(points).toHaveLength(5);
    expect(points.every((point) => point.includes("internal override"))).toBe(true);

    // The one that cost a repair round: the override returns nothing, though the
    // external callback it backs returns a selector.
    expect(points).toContain("function _afterInitialize(address, PoolKey calldata, uint160, int24) internal override");
    expect(points.find((point) => point.includes("_beforeSwap"))).toContain(
      "returns (BeforeSwapDelta delta, uint24 fee)",
    );
  });

  it("is telling the truth: a hook written the way it says compiles", async () => {
    // Every claim in V4_GOTCHAS that a compiler can check, in one contract. If a v4 bump
    // makes any of this false, the advice becomes confident misinformation, and this
    // fails rather than the next live build failing three repair rounds deep.
    const space = await open();
    await space.write([
      {
        path: "src/GotchaHook.sol",
        content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";

import {AgenBaseHook} from "./AgenBaseHook.sol";

contract GotchaHook is AgenBaseHook {
    constructor(IPoolManager manager) AgenBaseHook(manager) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
        permissions.beforeSwapReturnDelta = true;
        permissions.afterSwapReturnDelta = false;
    }

    function differs(Currency a, Currency b, PoolId x, PoolId y) external pure returns (bool) {
        return Currency.unwrap(a) != Currency.unwrap(b) || PoolId.unwrap(x) != PoolId.unwrap(y);
    }

    function widen(int128 value) external pure returns (uint256) {
        return uint256(int256(value));
    }

    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        pure
        override
        returns (BeforeSwapDelta, uint24)
    {
        return (toBeforeSwapDelta(int128(1), int128(0)), 0);
    }
}
`,
      },
    ]);

    const result = await build({ root: space.root });
    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
