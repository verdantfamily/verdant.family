/**
 * A hook that moves money through a delta it never asked permission to return.
 *
 * Uniswap honours a delta only from an address mined for it, and the address is mined from what
 * `getHookPermissions` declares. A hook that computes a fee, takes the tokens and returns a
 * `BeforeSwapDelta` while declaring `beforeSwapReturnDelta: false` therefore loses the delta
 * with the tokens already gone: the pool is short by exactly the fee, and every trade that
 * charges it reverts `CurrencyNotSettled`.
 *
 * SIMPLE lost a launch to this with the declaration and the mined address disagreeing. HRBR
 * lost one with them agreeing — both said `afterSwapReturnDelta` and neither described the
 * `_beforeSwap` that actually charged. Ten failing tests, three repair rounds, and fee
 * arithmetic that was correct the whole way through.
 *
 * Compiled rather than hand-parsed: what solc emits for a named-argument struct literal and for
 * a tuple return is the part most likely to be misremembered.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DYNAMIC_FEE_FLAG } from "@verdant/config";

import type { DeploymentSpecification } from "./deployment-spec.js";
import { deploymentInconsistencies } from "./deployment-validation.js";
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
    throw new Error("forge is not on the PATH; this reads a compiled program");
  });
});

/** HRBR's shape: a sell fee charged through a before-swap delta. */
function hook({ declaresIt }: { readonly declaresIt: boolean }): string {
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library Hooks {
    struct Permissions {
        bool beforeInitialize;
        bool afterInitialize;
        bool beforeAddLiquidity;
        bool afterAddLiquidity;
        bool beforeRemoveLiquidity;
        bool afterRemoveLiquidity;
        bool beforeSwap;
        bool afterSwap;
        bool beforeDonate;
        bool afterDonate;
        bool beforeSwapReturnDelta;
        bool afterSwapReturnDelta;
        bool afterAddLiquidityReturnDelta;
        bool afterRemoveLiquidityReturnDelta;
    }
}

type BeforeSwapDelta is int256;

function toBeforeSwapDelta(int128 specified, int128 unspecified) pure returns (BeforeSwapDelta) {
    return BeforeSwapDelta.wrap(int256(specified) << 128 | int256(uint256(uint128(unspecified))));
}

contract MarketHook {
    uint256 internal constant SELL_FEE_PPM = 10_000;

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
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
            beforeSwapReturnDelta: ${declaresIt ? "true" : "false"},
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function _beforeSwap(uint256 amount) internal pure returns (BeforeSwapDelta delta, uint24 fee) {
        fee = 0;
        uint256 feeAmount = amount * SELL_FEE_PPM / 1_000_000;
        delta = toBeforeSwapDelta(int128(int256(feeAmount)), 0);
    }
}
`;
}

/** The control: a hook that charges through the pool's fee and returns no delta at all. */
const NO_DELTA = hook({ declaresIt: false }).replace(
  "        delta = toBeforeSwapDelta(int128(int256(feeAmount)), 0);",
  "        delta = BeforeSwapDelta.wrap(int256(feeAmount) * 0);",
);

function deploymentSpec(permissions: readonly string[]): DeploymentSpecification {
  return {
    version: 1,
    specificationVersion: 1,
    components: [
      {
        componentId: "marketHook",
        contractName: "MarketHook",
        role: "hook",
        constructorArguments: [],
        immutable: [],
        wiring: [],
        controller: null,
        custody: false,
        claimsFees: false,
      },
    ],
    pool: { feeMode: "dynamic", lpFee: DYNAMIC_FEE_FLAG, tickSpacing: 200 },
    hookPermissions: permissions,
    requiresPoolIdBeforeInitialize: false,
    requiresAgenRouter: false,
    custodyComponentId: null,
    feeClaimComponentId: null,
    oneTimeInitialization: [],
  } as unknown as DeploymentSpecification;
}

/**
 * Through the whole check rather than the one function, so a finding has to survive the
 * structural comparisons that run before it.
 */
async function problemsFor(source: string, permissions: readonly string[]) {
  workspace = await createWorkspace({ vendorRoot: VENDOR });
  await workspace.write([{ path: "src/MarketHook.sol", content: source }]);

  const { stdout } = await run("forge", ["build", "--force", "--json"], {
    cwd: workspace.root,
    maxBuffer: 512 * 1024 * 1024,
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));

  return deploymentInconsistencies({
    root: workspace.root,
    buildOutput: JSON.parse(stdout),
    deployment: deploymentSpec(permissions),
    // Enough of one for the presence check that runs before the AST comparisons.
    artifacts: [
      { contractName: "MarketHook", sourcePath: "src/MarketHook.sol", abi: [] } as never,
    ],
    fee: {
      mode: "dynamic",
      lpFee: DYNAMIC_FEE_FLAG,
      reason: "the hook states nothing about the pool's fee",
      problem: null,
      stated: false,
    } as never,
  });
}

describe("a fee charged through a before-swap delta", () => {
  it("is refused when the hook does not declare beforeSwapReturnDelta", async () => {
    const problems = await problemsFor(hook({ declaresIt: false }), ["beforeSwap"]);

    const delta = problems.find((problem) => problem.detail.includes("beforeSwapReturnDelta"));
    expect(delta).toBeDefined();
    expect(delta?.contractName).toBe("MarketHook");
    // Names the consequence, because the revert arrives a long way from the cause.
    expect(delta?.detail).toContain("CurrencyNotSettled");
  }, 180_000);

  it("is accepted when it does", async () => {
    const problems = await problemsFor(hook({ declaresIt: true }), [
      "beforeSwap",
      "beforeSwapReturnDelta",
    ]);

    expect(problems.filter((problem) => problem.detail.includes("beforeSwapReturnDelta"))).toEqual(
      [],
    );
  }, 180_000);

  it("says nothing about a hook that returns no delta", async () => {
    const problems = await problemsFor(NO_DELTA, ["beforeSwap"]);

    expect(problems.filter((problem) => problem.detail.includes("ReturnDelta"))).toEqual([]);
  }, 180_000);
});
