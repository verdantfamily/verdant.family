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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "./foundry.js";
import { overridePoints, PRELUDE_CONTRACTS, preludeSources, tokenSource } from "./prelude.js";
import type { Workspace } from "./workspace.js";
import { createWorkspace } from "./workspace.js";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = resolve(here, "../../contracts/vendor");

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
  await workspace.write(
    preludeSources().map((source) => ({
      path: source.path.replace(/^contracts\//, "src/"),
      content: source.content,
    })),
  );
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
