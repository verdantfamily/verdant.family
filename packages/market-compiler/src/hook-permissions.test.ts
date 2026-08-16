/**
 * The callbacks a hook is mined for, against the ones it declares.
 *
 * SIMPLE — "buys have no hook fee, sells pay a 1% fee to the configured fee receiver", the
 * plainest market in the benchmark — was lost here, and lost expensively: seventeen tests, six
 * of them failing, three repair rounds, and a `CurrencyNotSettled` revert a long way from its
 * cause. The hook charged the sell fee through a before-swap delta while declaring no
 * `beforeSwapReturnDelta`. Uniswap discards a delta from an address that is not mined for one,
 * so the fee left the pool with nothing accounting for it and every trade in the market
 * reverted — including the core suite, so the whole build read as a broken market.
 *
 * A repair added the declaration, correctly, and it changed nothing: the address had been mined
 * from the deployment's list at design time and no one read the hook again. Mining for the
 * declared set afterwards turned all seventeen tests green with no other change.
 *
 * Read off a compiled program rather than a hand-written string, because the belief about what
 * solc emits for a named-argument struct literal is the part most likely to be wrong.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { hookPermissionsDeclaredIn } from "./deployment-validation.js";
import { generatedSources } from "./gates.js";
import { permissionBits } from "./mining.js";
import type { HookPermission } from "./gates.js";
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

/** A hook declaring its permissions the way generated hooks do: one struct literal. */
function hook({ returnsDelta }: { readonly returnsDelta: boolean }): string {
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

contract MarketHook {
    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: ${returnsDelta ? "true" : "false"},
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }
}
`;
}

async function declaredIn(content: string): Promise<Set<string> | null> {
  workspace = await createWorkspace({ vendorRoot: VENDOR });
  await workspace.write([{ path: "src/MarketHook.sol", content }]);

  const { stdout } = await run("forge", ["build", "--force", "--json"], {
    cwd: workspace.root,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));

  const sources = await generatedSources({
    root: workspace.root,
    buildOutput: JSON.parse(stdout),
  });

  return hookPermissionsDeclaredIn(sources, "MarketHook");
}

describe("what a hook says it implements", () => {
  it("is read from the struct literal generated hooks actually write", async () => {
    const declared = await declaredIn(hook({ returnsDelta: false }));

    expect(declared).not.toBeNull();
    expect([...declared!].sort()).toEqual(["afterSwap", "afterSwapReturnDelta", "beforeSwap"]);
  }, 120_000);

  /**
   * The one bit that cost SIMPLE its launch. 196 is the set without it and 204 the set with it;
   * a hook mined at the first while declaring the second has its fee delta thrown away.
   */
  it("changes the address the hook has to be mined at when a repair adds a callback", async () => {
    const before = await declaredIn(hook({ returnsDelta: false }));
    const after = await declaredIn(hook({ returnsDelta: true }));

    expect(permissionBits([...before!] as readonly HookPermission[])).toBe(196n);
    expect(permissionBits([...after!] as readonly HookPermission[])).toBe(204n);
  }, 240_000);

  /** Null rather than an empty set, so "could not read it" is not mistaken for "declares nothing". */
  it("says nothing about a contract that does not declare permissions at all", async () => {
    const declared = await declaredIn(
      "// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\n\ncontract MarketHook {}\n",
    );

    expect(declared).toBeNull();
  }, 120_000);
});
