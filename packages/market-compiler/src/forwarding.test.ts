/**
 * The wiring one component promised to do for another, read out of the compiled program.
 *
 * PULSE and HRBR were both lost to this in the same benchmark run. Agen's `FeeVault` refuses
 * every `credit` until `setHook` names the address allowed to pay into it, and both designs
 * satisfied the design-stage check the accepted way: the accounting contract that owns the
 * vault was handed the vault and the hook, so it *could* install one into the other. Neither
 * generated accounting contract did. The markets deployed, wired, opened their pool, and
 * reverted `NotHook` on the first sell — which arrived as six behaviour tests failing on a
 * revert the repair could not place, three repair rounds spent rewriting correct tests, and
 * two builds lost.
 *
 * The call is in the program or it is not, so it is read here rather than inferred from a
 * trace later. Compiled, not hand-written: the belief about what solc emits is the thing most
 * likely to be wrong.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DYNAMIC_FEE_FLAG } from "@verdant/config";

import type { DeploymentSpecification } from "./deployment-spec.js";
import { unmadeForwardingCalls } from "./deployment-validation.js";
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

/** The accounting contract, with and without the call it promised to make. */
function accounting({ forwards }: { readonly forwards: boolean }): string {
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IFeeVault {
    function setHook(address hook_) external;
}

contract FeeAccounting {
    address public immutable installer;
    address public vault;
    address public hook;

    constructor(address installer_) {
        installer = installer_;
    }

    function setFeeVault(address vault_) external {
        vault = vault_;
    }

    function setHook(address hook_) external {
        hook = hook_;
        ${forwards ? "IFeeVault(vault).setHook(hook_);" : "// the vault is never told"}
    }
}
`;
}

function specFor({
  vaultWiring = [],
}: {
  readonly vaultWiring?: readonly { functionName: string; argument: string }[];
}): DeploymentSpecification {
  const wiring = (calls: readonly { functionName: string; argument: string }[]) =>
    calls.map((call) => ({
      ...call,
      caller: "INSTALLER",
      phase: "before_pool_initialize",
      once: true,
    }));

  return {
    version: 1,
    specificationVersion: 1,
    components: [
      {
        componentId: "feeAccounting",
        contractName: "FeeAccounting",
        role: "accounting",
        constructorArguments: [{ name: "installer_", type: "address", source: "INFRA:INSTALLER" }],
        immutable: ["installer_"],
        wiring: wiring([
          { functionName: "setFeeVault", argument: "COMPONENT:feeVault" },
          { functionName: "setHook", argument: "COMPONENT:hook" },
        ]),
        controller: null,
        custody: false,
        claimsFees: true,
      },
      {
        componentId: "feeVault",
        contractName: "FeeVault",
        role: "vault",
        constructorArguments: [{ name: "owner_", type: "address", source: "COMPONENT:feeAccounting" }],
        immutable: ["owner_"],
        wiring: wiring(vaultWiring),
        controller: "COMPONENT:feeAccounting",
        custody: true,
        claimsFees: false,
      },
      {
        componentId: "hook",
        contractName: "MarketHook",
        role: "hook",
        constructorArguments: [
          { name: "manager_", type: "address", source: "INFRA:POOL_MANAGER" },
          { name: "vault_", type: "address", source: "COMPONENT:feeVault" },
        ],
        immutable: ["manager_", "vault_"],
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
    custodyComponentId: "feeVault",
    feeClaimComponentId: "feeAccounting",
    oneTimeInitialization: [],
  } as unknown as DeploymentSpecification;
}

async function sourcesOf(content: string) {
  workspace = await createWorkspace({ vendorRoot: VENDOR });
  await workspace.write([{ path: "src/FeeAccounting.sol", content }]);

  const { stdout } = await run("forge", ["build", "--force", "--json"], {
    cwd: workspace.root,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));

  return generatedSources({ root: workspace.root, buildOutput: JSON.parse(stdout) });
}

describe("an owner handed both addresses", () => {
  it("is refused when it never installs one into the other", async () => {
    const sources = await sourcesOf(accounting({ forwards: false }));

    const [problem] = unmadeForwardingCalls({ sources, deployment: specFor({}) });

    expect(problem).toBeDefined();
    expect(problem?.contractName).toBe("FeeAccounting");
    expect(problem?.detail).toContain("setHook");
    expect(problem?.detail).toContain("credit");
    // Aimed at the component that has to change, not at the vault that is correct.
    expect(problem?.detail).toContain("FeeAccounting");
  }, 120_000);

  it("is accepted when the call is there", async () => {
    const sources = await sourcesOf(accounting({ forwards: true }));

    expect(unmadeForwardingCalls({ sources, deployment: specFor({}) })).toHaveLength(0);
  }, 120_000);

  /** Nothing to forward: the launch itself wires the vault, which is the simpler shape. */
  it("says nothing when the deployment declares the call itself", async () => {
    const sources = await sourcesOf(accounting({ forwards: false }));

    expect(
      unmadeForwardingCalls({
        sources,
        deployment: specFor({ vaultWiring: [{ functionName: "setHook", argument: "COMPONENT:hook" }] }),
      }),
    ).toHaveLength(0);
  }, 120_000);
});
