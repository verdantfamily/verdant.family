/**
 * Tested against real compilations, for the reason the gates and the dev-buy probe are.
 *
 * This reads solc's AST, so a hand-written fixture would be testing this file against a
 * belief about what solc emits. The EMBER case below is that market's own guard, copied
 * from `test/agen/generated/ember/EmberHook.sol` — it is the market that made the pool's
 * fee a question, because opening it dynamic reverts `initialize` and loses the launch.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DYNAMIC_FEE_FLAG } from "@verdant/config";

import { requiredFeeMode } from "./feemode.js";
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

/** Compile a hook against the real prelude and ask what fee its pool must open with. */
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
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";

contract MarketHook is AgenBaseHook {
    using PoolIdLibrary for PoolKey;

    address public immutable marketToken;
    PoolId public boundPoolId;
    bool public poolBound;

    error InvalidPool();

    constructor(IPoolManager manager, address marketToken_) AgenBaseHook(manager) {
        marketToken = marketToken_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.afterInitialize = true;
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

  return requiredFeeMode({
    root: workspace.root,
    buildOutput: JSON.parse(stdout) as unknown,
    hookContractName: "MarketHook",
  });
}

describe("which fee a market's pool must be opened with", () => {
  it("reads EMBER's requirement that the pool charge nothing", async () => {
    // The real guard, verbatim in shape: a `||` chain in `afterInitialize` that reverts,
    // with the fee check as one of its terms. Before this probe existed the manifest
    // opened every market dynamic, and this market's launch reverted inside `initialize`
    // after all five of its contracts had been deployed.
    const result = await probe(`    function _afterInitialize(address, PoolKey calldata key, uint160, int24)
        internal
        override
    {
        if (key.tickSpacing != 200 || key.fee != 0) revert InvalidPool();

        boundPoolId = key.toId();
        poolBound = true;
    }`);

    expect(result.problem).toBeNull();
    expect(result.mode).toBe("zero");
    expect(result.lpFee).toBe(0);
    expect(result.reason).toMatch(/_afterInitialize/);
  });

  it("reads an ordinary dynamic-fee hook's requirement", async () => {
    const result = await probe(`    function _afterInitialize(address, PoolKey calldata key, uint160, int24)
        internal
        override
    {
        if (key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG) revert InvalidPool();

        boundPoolId = key.toId();
        poolBound = true;
    }`);

    expect(result.problem).toBeNull();
    expect(result.mode).toBe("dynamic");
    expect(result.lpFee).toBe(DYNAMIC_FEE_FLAG);
  });

  it("defaults a hook with no opinion about the fee to dynamic", async () => {
    const result = await probe(`    function _afterInitialize(address, PoolKey calldata key, uint160, int24)
        internal
        override
    {
        boundPoolId = key.toId();
        poolBound = true;
    }`);

    expect(result.problem).toBeNull();
    expect(result.mode).toBe("dynamic");
    expect(result.lpFee).toBe(DYNAMIC_FEE_FLAG);
    expect(result.reason).toMatch(/places no constraint/);
  });

  it("understands the same requirement written as a require", async () => {
    // `require(key.fee == 0)` and `if (key.fee != 0) revert` say the same thing, and a
    // check that read the polarity off the comparison alone would get one of them
    // exactly backwards.
    const result = await probe(`    function _afterInitialize(address, PoolKey calldata key, uint160, int24)
        internal
        override
    {
        require(key.fee == 0, "fee");
        boundPoolId = key.toId();
        poolBound = true;
    }`);

    expect(result.problem).toBeNull();
    expect(result.mode).toBe("zero");
  });

  it("reads a fixed pool fee", async () => {
    const result = await probe(`    function _afterInitialize(address, PoolKey calldata key, uint160, int24)
        internal
        override
    {
        if (key.fee != 3000) revert InvalidPool();
        poolBound = true;
    }`);

    expect(result.problem).toBeNull();
    expect(result.mode).toBe("fixed");
    expect(result.lpFee).toBe(3_000);
  });

  it("fails the build when a hook wants two different fees at once", async () => {
    const result = await probe(`    function _beforeInitialize(address, PoolKey calldata key, uint160) internal override {
        if (key.fee != 0) revert InvalidPool();
    }

    function _afterInitialize(address, PoolKey calldata key, uint160, int24)
        internal
        override
    {
        if (key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG) revert InvalidPool();
        poolBound = true;
    }`);

    expect(result.problem).toMatch(/two different things at once/);
  });

  it("fails the build rather than guessing at a fee it cannot resolve", async () => {
    // Compared against an immutable. Nothing here executes the contract, so the value
    // is genuinely unknown — and a pool opened at a guessed fee is the failure this
    // module exists to prevent.
    const result = await probe(`    uint24 public immutable requiredFee = 500;

    function _afterInitialize(address, PoolKey calldata key, uint160, int24)
        internal
        override
    {
        if (key.fee != requiredFee) revert InvalidPool();
        poolBound = true;
    }`);

    expect(result.problem).toMatch(/cannot read|cannot resolve/);
  });

  it("says so when the hook is not in the build at all", async () => {
    workspace = await createWorkspace({ vendorRoot: VENDOR });

    const result = await requiredFeeMode({
      root: workspace.root,
      buildOutput: { sources: {} },
      hookContractName: "MarketHook",
    });

    expect(result.problem).toMatch(/could not find MarketHook/);
  });
});
