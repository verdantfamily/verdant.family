/**
 * Tested against real compilations, for the same reason the gates are.
 *
 * This reads solc's AST, so a hand-written fixture would test this file against a
 * belief about what solc emits rather than against what it emits. The hook shapes below
 * are compiled, and the EMBER case is the real market's own guard — the one that made
 * the launch buy a question in the first place.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { supportsAtomicDevBuy } from "./devbuy.js";
import { preludeSources } from "./prelude.js";
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
    throw new Error("forge is not on the PATH; this cannot read an AST without a build");
  });
});

/**
 * Compile a hook against the real prelude and ask whether the factory could buy from it.
 *
 * The prelude goes in because the hook extends `AgenBaseHook`, and because the answer
 * has to survive the callbacks being inherited rather than declared: the sender the
 * check looks at is a parameter of an override, not of the interface.
 */
async function probe(body: string) {
  workspace = await createWorkspace({ vendorRoot: VENDOR });

  await workspace.write([
    ...preludeSources().map((source) => ({
      path: source.path.replace(/^contracts\//, "src/"),
      content: source.content,
    })),
    {
      path: "src/MarketHook.sol",
      content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgenBaseHook} from "./AgenBaseHook.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";

contract MarketHook is AgenBaseHook {
    uint256 public volume;
    address public immutable tradeRouter;

    error UnauthorizedRoute(address sender);
    error InvalidTradeSignal();

    constructor(IPoolManager manager, address tradeRouter_) AgenBaseHook(manager) {
        tradeRouter = tradeRouter_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeSwap = true;
    }

${body}
}
`,
    },
  ]);

  const { stdout } = await run("forge", ["build", "--force", "--json"], {
    cwd: workspace.root,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));

  return supportsAtomicDevBuy({
    root: workspace.root,
    buildOutput: JSON.parse(stdout) as unknown,
    hookContractName: "MarketHook",
  });
}

describe("whether the factory may buy from a market it has just opened", () => {
  it("allows it for a hook that treats every swap the same", async () => {
    const result = await probe(`    function _beforeSwap(address, PoolKey calldata, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
        volume += swapAmount(params);
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }`);

    expect(result.supported).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("refuses it for a hook that insists on its own router", async () => {
    // EMBER, reduced to the two lines that matter. The launch buy comes from the
    // factory, so this hook reverts it — and because the buy happens inside
    // `deployMarket`, the whole launch goes with it.
    const result = await probe(`    function _beforeSwap(address sender, PoolKey calldata, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
        if (sender != tradeRouter) revert UnauthorizedRoute(sender);
        volume += swapAmount(params);
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }`);

    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/which contract a trade arrives through/);
    expect(result.evidence).toEqual([{ callback: "_beforeSwap", reads: "the caller" }]);
  });

  it("refuses it for a hook that needs the trade to carry data", async () => {
    // The other half of EMBER's route: the trader's identity arrives in hookData,
    // because `sender` is the router. A launch buy carries none.
    const result = await probe(`    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata hookData)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
        if (hookData.length != 32) revert InvalidTradeSignal();
        volume += 1;
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }`);

    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/carry information the launch cannot supply/);
  });

  it("is not fooled by a parameter that is only named", async () => {
    // Naming a parameter is not reading it. A hook that declares `sender` and ignores
    // it treats the factory like anybody else, and its creator should be offered the
    // buy rather than told a story about routers.
    const result = await probe(`    function _beforeSwap(address sender, PoolKey calldata, SwapParams calldata, bytes calldata hookData)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
        volume += 1;
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }`);

    expect(result.supported).toBe(true);
  });

  it("says no when it cannot find the hook at all", async () => {
    workspace = await createWorkspace({ vendorRoot: VENDOR });

    const result = await supportsAtomicDevBuy({
      root: workspace.root,
      buildOutput: { sources: {} },
      hookContractName: "MarketHook",
    });

    // An unanswered question immediately before a creator is offered the field is not
    // a yes.
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/could not find MarketHook/);
  });
});
