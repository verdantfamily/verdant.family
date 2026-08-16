/**
 * A component that decided for itself who would wire it.
 *
 * POT — "a jackpot that pays every twenty-fifth buyer" — wrote `constructor() AgenWired(msg.sender)
 * {}` on its vault. That is how ownership is written everywhere else, and here it names
 * AgenDeployer: components are created through CREATE2 by the deployer, so a constructor's
 * `msg.sender` is the deployer and never the factory. The factory then makes every wiring call
 * itself, was refused by the vault it had just deployed, and the market died inside `setUp` with
 * `WiringFailed(1, NotInstaller(...))` — after four minutes in which every contract compiled,
 * every argument resolved and the deployment graph was proven materializable.
 *
 * Compiled rather than pattern-matched on text, because what solc emits for a base constructor
 * invocation is exactly the belief worth checking.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DYNAMIC_FEE_FLAG } from "@verdant/config";

import type { DeploymentSpecification } from "./deployment-spec.js";
import { installersTakenFromTheDeployer } from "./deployment-validation.js";
import { generatedSources } from "./gates.js";
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
    throw new Error("forge is not on the PATH; this reads a compiled program");
  });
});

/** POT's vault, with the installer taken from the two places it could come from. */
function vault({ from }: { readonly from: "msg.sender" | "an argument" }): string {
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgenWired} from "./AgenWired.sol";

contract JackpotVault is AgenWired {
    address public hook;

    ${
      from === "msg.sender"
        ? "constructor() AgenWired(msg.sender) {}"
        : "constructor(address installer_) AgenWired(installer_) {}"
    }

    function setHook(address hook_) external onlyInstaller {
        _wireOnce(hook);
        hook = hook_;
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
        componentId: "jackpotVault",
        contractName: "JackpotVault",
        role: "vault",
        constructorArguments: [],
        immutable: [],
        wiring: [
          {
            functionName: "setHook",
            argument: "COMPONENT:hook",
            caller: "INSTALLER",
            phase: "before_pool_initialize",
            once: true,
          },
        ],
        controller: null,
        custody: true,
        claimsFees: false,
      },
    ],
    pool: { feeMode: "dynamic", lpFee: DYNAMIC_FEE_FLAG, tickSpacing: 200 },
    hookPermissions: [],
    requiresPoolIdBeforeInitialize: false,
    requiresAgenRouter: false,
    custodyComponentId: "jackpotVault",
    feeClaimComponentId: null,
    oneTimeInitialization: [],
  } as unknown as DeploymentSpecification;
}

async function sourcesOf(content: string) {
  workspace = await createWorkspace({ vendorRoot: VENDOR });

  const wired = preludeSources().find((file) => file.path.endsWith("AgenWired.sol"))!;
  await workspace.write([
    { path: "src/AgenWired.sol", content: wired.content },
    { path: "src/JackpotVault.sol", content },
  ]);

  const { stdout } = await run("forge", ["build", "--force", "--json"], {
    cwd: workspace.root,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));

  return generatedSources({ root: workspace.root, buildOutput: JSON.parse(stdout) });
}

describe("who the launch will be to a component it deploys", () => {
  it("refuses an installer taken from the deployer", async () => {
    const sources = await sourcesOf(vault({ from: "msg.sender" }));

    const problems = installersTakenFromTheDeployer({ sources, deployment: deploymentSpec() });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.contractName).toBe("JackpotVault");
    // Names the cause and the fix, so the repair has somewhere to go.
    expect(problems[0]?.detail).toContain("CREATE2");
    expect(problems[0]?.detail).toContain("INFRA:INSTALLER");
  }, 180_000);

  it("accepts an installer the deployment declared", async () => {
    const sources = await sourcesOf(vault({ from: "an argument" }));

    expect(installersTakenFromTheDeployer({ sources, deployment: deploymentSpec() })).toEqual([]);
  }, 180_000);
});
