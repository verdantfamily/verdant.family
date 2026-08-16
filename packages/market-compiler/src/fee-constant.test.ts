/**
 * A hook's fee requirement, written the way hooks actually write it.
 *
 * `if (key.fee != 3000) revert` and `if (key.fee != BASE_LP_FEE_PPM) revert` are the same
 * sentence about the same market, and only the first used to be legible. The second read as a
 * hook with no opinion, so the pool opened at whatever the architecture had predicted at design
 * time — and in one benchmark run EMBR and SPEC were both lost there, each hook stating its
 * requirement plainly against a `uint24 public constant` set to a literal, each pool opened at
 * zero, each launch reverting `InvalidPoolFee(0)` from inside `initialize` with every contract
 * already deployed and paid for.
 *
 * Neither was a broken market, and neither was repairable: the repair loops rewrite contracts,
 * and the contracts were right. The pool fee was wrong, and nothing downstream of the reader can
 * change that. Which spelling a model reaches for is not a fact about the market, so a pipeline
 * where it decides whether the market launches is a pipeline that flips on a coin.
 *
 * Read off a compiled program rather than a hand-written AST, because the belief about what solc
 * emits for a constant reference is exactly the part most likely to be wrong.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { generatedSources } from "./gates.js";
import { requiredFeeMode } from "./feemode.js";
import type { FeeRequirement } from "./feemode.js";
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
 * A hook shaped like the generated ones: a `PoolKey` callback refusing every pool but one.
 *
 * @param declarations What to declare above the guard.
 * @param against What the guard compares `key.fee` to.
 */
function hook({
  declarations,
  against,
}: {
  readonly declarations: string;
  readonly against: string;
}): string {
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

type Currency is address;

struct PoolKey {
    Currency currency0;
    Currency currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

contract MarketHook {
${declarations}
    error InvalidPoolFee(uint24 fee);

    function _beforeInitialize(address, PoolKey calldata key, uint160) internal view {
        if (key.fee != ${against}) revert InvalidPoolFee(key.fee);
    }
}
`;
}

async function requirementOf(content: string): Promise<FeeRequirement> {
  workspace = await createWorkspace({ vendorRoot: VENDOR });
  await workspace.write([{ path: "src/MarketHook.sol", content }]);

  const { stdout } = await run("forge", ["build", "--force", "--json"], {
    cwd: workspace.root,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));

  const buildOutput = JSON.parse(stdout) as Record<string, unknown>;
  const sources = await generatedSources({ root: workspace.root, buildOutput });

  return requiredFeeMode({
    root: workspace.root,
    buildOutput,
    sources,
    hookContractName: "MarketHook",
  } as Parameters<typeof requiredFeeMode>[0]);
}

describe("a hook that guards the pool's fee against a named constant", () => {
  it("states the constant's value, exactly as if it had been written inline", async () => {
    const named = await requirementOf(
      hook({
        declarations: "    uint24 public constant BASE_LP_FEE_PPM = 3_000;\n",
        against: "BASE_LP_FEE_PPM",
      }),
    );

    expect(named.problem).toBeNull();
    expect(named.stated).toBe(true);
    expect(named.lpFee).toBe(3_000);
    expect(named.mode).toBe("fixed");
  }, 180_000);

  /**
   * The pair that matters. Two spellings of one market must not produce two markets, because a
   * requirement read as silence is overruled by the design's prediction and the launch reverts.
   */
  it("says the same thing as the literal spelling of the same guard", async () => {
    const named = await requirementOf(
      hook({ declarations: "    uint24 internal constant FEE = 500;\n", against: "FEE" }),
    );
    await workspace?.dispose();
    workspace = null;
    const literal = await requirementOf(hook({ declarations: "", against: "500" }));

    expect(named.stated).toBe(true);

    expect(named.stated).toBe(literal.stated);
    expect(named.lpFee).toBe(literal.lpFee);
    expect(named.mode).toBe(literal.mode);
  }, 240_000);

  /**
   * The other half of the same blind spot, and it needed no constant at all: solc keeps a
   * literal as it was written, so the digit separator in `3_000` — which is how a person writes
   * three thousand parts per million — made an inline guard unreadable too.
   */
  it("reads a literal written with digit separators", async () => {
    const found = await requirementOf(hook({ declarations: "", against: "3_000" }));

    expect(found.stated).toBe(true);
    expect(found.lpFee).toBe(3_000);
  }, 180_000);

  it("follows arithmetic over constants, which is how a ceiling gets written", async () => {
    const found = await requirementOf(
      hook({
        declarations:
          "    uint24 internal constant BASE = 2_500;\n" +
          "    uint24 internal constant EXTRA = 500;\n",
        against: "BASE + EXTRA",
      }),
    );

    expect(found.stated).toBe(true);
    expect(found.lpFee).toBe(3_000);
  }, 180_000);

  /**
   * Still silent where the comparison is against something only known at run time. Silence is
   * the honest answer there, and the declared deployment decides — which is what declaring it
   * was for. Inventing a number here is the failure this module exists to remove.
   */
  it("stays silent about a fee it cannot resolve at compile time", async () => {
    const found = await requirementOf(
      hook({
        declarations: "    uint24 public immutable configuredFee;\n",
        against: "configuredFee",
      }),
    );

    expect(found.stated).toBe(false);
  }, 180_000);
});
