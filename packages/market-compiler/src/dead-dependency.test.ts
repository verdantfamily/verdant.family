/**
 * A component a market is built with and then never uses.
 *
 * HRBR — "charge a 1% fee on every sell and send it to the token creator" — was lost twice to
 * this. Its four components were each correct: the hook took the creator's accounting contract
 * as an immutable, stored it, and never called it, while the accounting contract exposed
 * `creditCreatorFee` guarded to the hook, so nothing in the market could reach it. The fees
 * arrived in the vault, so the market traded and charged exactly what it promised; the ledger
 * the prompt was actually about stayed at zero for good.
 *
 * The behaviour tests caught it and it did not help. By then the contracts were read-only, so
 * the repair could only say the fix belonged in a file it had not been given, decline to
 * weaken a correct test, and give up — a market lost on a defect that is one sentence to read
 * out of the program while the contract is still editable.
 *
 * Compiled rather than hand-parsed, because the belief about what solc emits for an assignment
 * or a cast is the part most likely to be wrong.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DYNAMIC_FEE_FLAG } from "@verdant/config";

import type { DeploymentSpecification } from "./deployment-spec.js";
import { unusedComponentDependencies } from "./deployment-validation.js";
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

/** HRBR's shape: an accounting ledger only the hook can credit. */
const ACCOUNTING = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract CreatorFeeAccounting {
    address public hook;
    uint256 public creatorFeeBalance;

    error NotHook(address caller);

    function setHook(address hook_) external {
        hook = hook_;
    }

    function creditCreatorFee(uint256 amount) external {
        if (msg.sender != hook) revert NotHook(msg.sender);
        creatorFeeBalance += amount;
    }
}
`;

/**
 * The hook, with and without the call the market is about.
 *
 * The vault is here as the control: a dependency that is only ever paid, never called, is
 * legitimate and must not be reported.
 */
function hook({ credits }: { readonly credits: boolean }): string {
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IAccounting {
    function creditCreatorFee(uint256 amount) external;
}

interface IToken {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract MarketHook {
    address public immutable accounting;
    address public immutable vault;
    address public immutable token;

    constructor(address accounting_, address vault_, address token_) {
        accounting = accounting_;
        vault = vault_;
        token = token_;
    }

    function takeSellFee(uint256 amount) external {
        uint256 fee = amount / 100;
        IToken(token).transfer(vault, fee);
        ${credits ? "IAccounting(accounting).creditCreatorFee(fee);" : "// the ledger is never told"}
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
        componentId: "creatorFeeAccounting",
        contractName: "CreatorFeeAccounting",
        role: "accounting",
        constructorArguments: [],
        immutable: [],
        wiring: [
          {
            functionName: "setHook",
            argument: "COMPONENT:marketHook",
            caller: "INSTALLER",
            phase: "before_pool_initialize",
            once: true,
          },
        ],
        controller: null,
        custody: false,
        claimsFees: true,
      },
      {
        componentId: "creatorFeeVault",
        contractName: "FeeVault",
        role: "vault",
        constructorArguments: [],
        immutable: [],
        wiring: [],
        controller: null,
        custody: true,
        claimsFees: false,
      },
      {
        componentId: "marketToken",
        contractName: "MarketToken",
        role: "token",
        constructorArguments: [],
        immutable: [],
        wiring: [],
        controller: null,
        custody: false,
        claimsFees: false,
      },
      {
        componentId: "marketHook",
        contractName: "MarketHook",
        role: "hook",
        constructorArguments: [
          { name: "accounting_", type: "address", source: "COMPONENT:creatorFeeAccounting" },
          { name: "vault_", type: "address", source: "COMPONENT:creatorFeeVault" },
          { name: "token_", type: "address", source: "COMPONENT:marketToken" },
        ],
        immutable: ["accounting_", "vault_", "token_"],
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
    custodyComponentId: "creatorFeeVault",
    feeClaimComponentId: "creatorFeeAccounting",
    oneTimeInitialization: [],
  } as unknown as DeploymentSpecification;
}

async function sourcesOf(hookSource: string) {
  workspace = await createWorkspace({ vendorRoot: VENDOR });
  await workspace.write([
    { path: "src/MarketHook.sol", content: hookSource },
    { path: "src/CreatorFeeAccounting.sol", content: ACCOUNTING },
  ]);

  const { stdout } = await run("forge", ["build", "--force", "--json"], {
    cwd: workspace.root,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));

  return generatedSources({ root: workspace.root, buildOutput: JSON.parse(stdout) });
}

describe("a declared dependency", () => {
  it("is refused when the contract stores it and never uses it", async () => {
    const sources = await sourcesOf(hook({ credits: false }));

    const problems = unusedComponentDependencies({ sources, deployment: deploymentSpec() });

    expect(problems).toHaveLength(1);
    // Aimed at the contract that has to change, which is the one that must make the call.
    expect(problems[0]?.contractName).toBe("MarketHook");
    expect(problems[0]?.detail).toContain("CreatorFeeAccounting");
    // And it names what the market is missing, not merely that something is unused.
    expect(problems[0]?.detail).toContain("creditCreatorFee()");
  }, 180_000);

  it("is accepted when the call is there", async () => {
    const sources = await sourcesOf(hook({ credits: true }));

    expect(unusedComponentDependencies({ sources, deployment: deploymentSpec() })).toHaveLength(0);
  }, 180_000);

  /**
   * The control, and the reason this is not simply "every dependency must be called". A vault
   * that is paid by a token transfer is used without a single call on it, and reporting that
   * would refuse the most ordinary market Agen builds.
   */
  it("says nothing about a dependency that is paid rather than called", async () => {
    const sources = await sourcesOf(hook({ credits: true }));

    const problems = unusedComponentDependencies({ sources, deployment: deploymentSpec() });

    expect(problems.map((problem) => problem.detail).join(" ")).not.toContain("FeeVault");
  }, 180_000);
});
