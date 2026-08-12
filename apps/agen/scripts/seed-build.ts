#!/usr/bin/env node
/**
 * Runs one build into the app's own job store, using a scripted model.
 *
 * The interpretation and review screens are the two hardest things in this interface to
 * be confident about, because both render a document produced by a model that is not
 * configured on this machine. Rather than mock them in a component test — which would
 * assert that a fixture I wrote renders, and nothing about whether the real shapes fit —
 * this drives the actual pipeline with a scripted provider and leaves a real job on
 * disk. The screens then load it through the real API.
 *
 * It is a development tool, not a test and not a fixture the product depends on. The
 * Solidity in it is a stand-in for generator output and is labelled as such; when a key
 * exists, the same screens will be loading the real thing through the same path.
 *
 * Usage: node scripts/seed-build.ts
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fileJobStore, runBuild, scriptedProvider } from "@verdant/market-compiler";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../..");
const GENERATED_ROOT = resolve(REPO_ROOT, "generated");

const HOOK = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// A stand-in for generated output. See the note at the top of seed-build.ts.
contract SurchargeHook {
    uint24 public constant BASE_FEE_PPM = 5_000;
    uint24 public constant SURCHARGE_PPM = 20_000;

    uint256 public buybackReserve;
    uint256 public consecutiveBuys;

    function onSwap(bool isBuy, uint256 sizeBps) external returns (uint24 feePpm) {
        if (isBuy) {
            consecutiveBuys += 1;
            return BASE_FEE_PPM;
        }

        consecutiveBuys = 0;
        if (sizeBps > 100) {
            buybackReserve += SURCHARGE_PPM;
            return BASE_FEE_PPM + SURCHARGE_PPM;
        }
        return BASE_FEE_PPM;
    }
}
`;

const TESTS = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SurchargeHook} from "../contracts/SurchargeHook.sol";

contract SurchargeHookTest is Test {
    SurchargeHook hook;

    function setUp() public {
        hook = new SurchargeHook();
    }

    function test_feeCeiling_isNeverExceeded(bool isBuy, uint256 sizeBps) public {
        assertLe(hook.onSwap(isBuy, bound(sizeBps, 0, 10_000)), 30_000);
    }

    function test_aLargeSellPaysTheSurcharge() public {
        assertEq(hook.onSwap(false, 150), 25_000);
    }

    function test_aSmallSellDoesNot() public {
        assertEq(hook.onSwap(false, 50), 5_000);
    }

    function test_reserveConserved_growsOnlyOnLargeSells() public {
        hook.onSwap(true, 500);
        assertEq(hook.buybackReserve(), 0);
        hook.onSwap(false, 500);
        assertEq(hook.buybackReserve(), 20_000);
    }
}
`;

/** Everything in a specification except the half the first call answers. */
function frameOf<T extends { summary: unknown; rules: unknown }>(whole: T) {
  const { summary: _summary, rules: _rules, ...frame } = whole;
  return frame;
}

const specification = {
  summary: "Large sells pay an extra 2%, routed to buybacks",
  baseFeePpm: 5_000,
  maxFeePpm: 25_000,
  phases: [],
  state: [
    { name: "buybackReserve", type: "accumulator", description: "Quote asset held for buybacks", writeOnce: false },
    { name: "consecutiveBuys", type: "counter", description: "Buys since the last sell", writeOnce: false },
  ],
  rules: [
    {
      id: "large-sell-surcharge",
      title: "LARGE SELL SURCHARGE",
      when: { kind: "sell", description: "Someone sells into the pool", parameters: null },
      conditions: [
        {
          kind: "tradeSizeVsLiquidity",
          description: "The sell is larger than 1% of current pool liquidity",
          parameters: [{ key: "percent", value: 1 }],
          combinator: null,
        },
      ],
      then: [
        {
          kind: "extraFee",
          description: "Charge an additional 2% on the sell",
          parameters: [{ key: "feePpm", value: 20_000 }],
          writes: [],
        },
        {
          kind: "routeFee",
          description: "Send the surcharge to the buyback reserve",
          parameters: [
            { key: "destination", value: "buybackReserve" },
            { key: "share", value: 100 },
          ],
          writes: ["buybackReserve"],
        },
      ],
      activeInPhases: [],
      onceOnly: false,
    },
  ],
  invariants: [
    { id: "fee-ceiling", statement: "The total hook fee never exceeds 3%", expression: "hookFeePpm <= 30000" },
    { id: "reserve-conserved", statement: "The reserve only grows on qualifying sells", expression: null },
  ],
  externalDependencies: [],
  assumptions: [
    {
      id: "large-sell",
      term: "large sell",
      interpretation: "A sell larger than 1% of the pool's current liquidity",
      why: "The prompt gives the threshold, so this only names what it is measured against.",
      parameters: [{ key: "percent", value: 1 }],
      importance: "medium",
      requiresConfirmation: false,
    },
    {
      id: "routing",
      term: "used for buybacks",
      interpretation: "Held in a reserve the market can spend later, rather than bought back per trade",
      why: "Buying back inside the swap that triggered it would move the price against the seller.",
      parameters: null,
      importance: "low",
      requiresConfirmation: false,
    },
  ],
  ambiguities: [],
  unsupported: [],
};

const plan = {
  approach:
    "A single hook that measures each sell against the pool's liquidity, charges a surcharge " +
    "above the threshold, and credits a reserve the market can draw on for buybacks.",
  components: [
    {
      id: "canopyToken",
      contractName: "CanopyToken",
      role: "token",
      origin: "generate",
      purpose: "The traded token",
      requiredBy: [],
      dependsOn: [],
      hookPermissions: [],
      custodial: false,
      implementationNotes: [],
    },
    {
      id: "surchargeHook",
      contractName: "SurchargeHook",
      role: "hook",
      origin: "extend",
      purpose: "Measures sells and charges the surcharge",
      requiredBy: ["large-sell-surcharge"],
      dependsOn: [],
      hookPermissions: ["beforeSwap"],
      custodial: false,
      implementationNotes: ["Compare against liquidity at swap time, not at launch"],
    },
  ],
  dependencies: [],
  adaptations: [
    {
      requested: "use the extra fee for buybacks",
      implemented: "accumulate it in a reserve, spent separately",
      reason: "buying back inside the swap that charged the fee would reenter the pool mid-swap",
    },
  ],
};

const job = await runBuild(
  {
    prompt:
      "Charge 0.5% base. If somebody sells more than 1% of current liquidity, charge an " +
      "additional 2% and use it for buybacks.",
    name: "Canopy",
    symbol: "CNPY",
  },
  {
    provider: scriptedProvider([
      // Interpretation is four calls: what the market does, the rules formalising it,
      // the frame around them, and the critique that runs beside the frame.
      { behaviours: specification.rules.map((rule) => rule.title.toLowerCase()) },
      { summary: specification.summary, rules: specification.rules },
      frameOf(specification),
      { suggestions: [] },
      // Planning is two calls: what is already solved, then what to build.
      { reuse: [{ catalogueId: "base-hook", why: "it needs a hook" }], novel: [] },
      plan,
      // One answer per generated component; the token is written by Agen, not scripted.
      { content: HOOK, notes: [] },
      { files: [{ path: "test/SurchargeHook.t.sol", content: TESTS }], notes: [] },
    ]),
    store: fileJobStore(resolve(GENERATED_ROOT, "_jobs")),
    vendorRoot: resolve(REPO_ROOT, "packages/contracts/vendor"),
    generatedRoot: GENERATED_ROOT,
  },
);

console.log(`stage: ${job.stage}`);
if (job.failure !== null) {
  console.log(`failed: ${job.failure.code} — ${job.failure.detail}`);
}
console.log(`tests: ${String(job.testOutcomes.filter((o) => o.passed).length)} passing`);
console.log(`\nopen: http://127.0.0.1:4400/launch?build=${job.id}`);
