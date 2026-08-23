/**
 * A hook remembering one market's history for every pool that names it.
 *
 * `poolManager.initialize` is permissionless and a hook's address is public, so a
 * deployed hook is a contract anybody may attach to a pool of their own choosing. For a
 * stateless hook that costs nothing — every answer comes out of the `PoolKey` it was
 * handed. For one that counts, it is the whole mechanic: EXCT's "ten consecutive buys
 * earns a free buy" held in a plain `uint256` is a counter a stranger drives with ten
 * dust buys in a pool of worthless tokens, and then spends here.
 *
 * The hand-written `InstantHook` has always refused a pool the factory never registered.
 * Generated hooks inherit no such refusal, and nothing used to ask them for one.
 *
 * Compiled rather than hand-parsed, because whether solc reports `_counters[key.toId()]++`
 * as an assignment to a mapping or to its element is exactly the belief most likely to be
 * wrong, and it decides the answer.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DYNAMIC_FEE_FLAG } from "@verdant/config";

import type { DeploymentSpecification } from "./deployment-spec.js";
import { stateSharedAcrossPools } from "./deployment-validation.js";
import { generatedSources } from "./gates.js";
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

/**
 * EXCT's streak, written four ways.
 *
 * Deliberately not built on `AgenBaseHook`: the callback names and the `PoolKey` are all
 * this check reads, and a bare contract keeps the fixture to the one thing under test.
 */
function hook({ state }: { readonly state: "shared" | "keyed" | "pinned" | "none" }): string {
  const declaration = {
    shared: "uint256 private _consecutiveBuys;",
    keyed: "mapping(PoolId => uint256) private _consecutiveBuys;",
    pinned: "uint256 private _consecutiveBuys;\n    PoolId private _pool;",
    none: "uint256 public immutable rate = 5_000;",
  }[state];

  const guard =
    state === "pinned"
      ? "        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(_pool)) revert WrongPool();\n"
      : "";

  const body = {
    shared: "        if (buying) _consecutiveBuys++;\n        else _consecutiveBuys = 0;",
    keyed:
      "        if (buying) _consecutiveBuys[key.toId()]++;\n" +
      "        else _consecutiveBuys[key.toId()] = 0;",
    pinned: "        if (buying) _consecutiveBuys++;\n        else _consecutiveBuys = 0;",
    none: "        buying;",
  }[state];

  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

contract MarketHook {
    using PoolIdLibrary for PoolKey;

    error WrongPool();

    ${declaration}

    function _beforeSwap(PoolKey calldata key, bool buying) internal {
${guard}${body}
    }

    function poke(PoolKey calldata key, bool buying) external {
        _beforeSwap(key, buying);
    }
}
`;
}

function deploymentSpec(): DeploymentSpecification {
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
    hookPermissions: [],
    requiresPoolIdBeforeInitialize: false,
    requiresAgenRouter: false,
    custodyComponentId: null,
    feeClaimComponentId: null,
    oneTimeInitialization: [],
  } as unknown as DeploymentSpecification;
}

async function sourcesOf(hookSource: string) {
  workspace = await createWorkspace({ vendorRoot: VENDOR });
  await workspace.write([{ path: "src/MarketHook.sol", content: hookSource }]);

  const { stdout } = await run("forge", ["build", "--force", "--json"], {
    cwd: workspace.root,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));

  return generatedSources({ root: workspace.root, buildOutput: JSON.parse(stdout) });
}

describe("state a hook keeps across trades", () => {
  it("is refused when one counter answers for every pool", async () => {
    const sources = await sourcesOf(hook({ state: "shared" }));

    const problems = stateSharedAcrossPools({ sources, deployment: deploymentSpec() });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.contractName).toBe("MarketHook");
    // Names the variable, so a repair knows which one to move.
    expect(problems[0]?.detail).toContain("_consecutiveBuys");
    // And both remedies, because either is correct and the choice is the hook's.
    expect(problems[0]?.detail).toContain("mapping(PoolId => ...)");
    expect(problems[0]?.detail).toContain("key.toId()");
  }, 180_000);

  it("is accepted when the pool's own id keys it", async () => {
    const sources = await sourcesOf(hook({ state: "keyed" }));

    expect(stateSharedAcrossPools({ sources, deployment: deploymentSpec() })).toHaveLength(0);
  }, 180_000);

  it("is accepted when the hook turns away every pool but its own", async () => {
    const sources = await sourcesOf(hook({ state: "pinned" }));

    expect(stateSharedAcrossPools({ sources, deployment: deploymentSpec() })).toHaveLength(0);
  }, 180_000);

  /**
   * The control. A hook with nothing to remember cannot have a stranger's pool change
   * what this market does, and reporting one would refuse the most ordinary market Agen
   * builds — a flat fee taken into a vault.
   */
  it("says nothing about a hook that remembers nothing", async () => {
    const sources = await sourcesOf(hook({ state: "none" }));

    expect(stateSharedAcrossPools({ sources, deployment: deploymentSpec() })).toHaveLength(0);
  }, 180_000);
});
