/**
 * Seven architectures, each launched end to end, with no deployment inference anywhere.
 *
 * The question these answer is not "does a build pass" — the pipeline suite covers control
 * flow. It is whether Agen can carry *different* programmable architectures to a launch
 * without any of them needing the launcher to work something out. Every failure this
 * replaces came from one market's shape being guessed correctly and another's not: a vault
 * owned by the fee receiver and a vault owned by its accounting contract are both ordinary,
 * and one rule could only ever serve one of them.
 *
 * So the seven cases are chosen to disagree with each other about exactly the things that
 * used to be inferred: who owns custody, how many components there are, whether a setter is
 * called at launch, whether the pool's fee is dynamic, fixed or zero, and whether the hook
 * needs the router.
 *
 * Each one asserts the same five things:
 *
 *   - the deployment validation stage passes, so the contracts match their declaration
 *   - the preflight materializes the whole bundle
 *   - the canonical launch succeeds in Foundry, through the real factory
 *   - the behaviour tests execute
 *   - the build reaches `deployment_ready` with zero deployment repairs
 *
 * The model is scripted because the Solidity has to be identical between runs for the
 * comparison to mean anything. What is real: forge, the v4 vendor tree, AgenFactory,
 * CREATE2, the hook miner, and every line of the deployment path.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DYNAMIC_FEE_FLAG } from "@verdant/config";

import { FailureCode, Stage, type GenerationJob } from "./job.js";
import { scriptedProvider } from "./model.js";
import { DEFAULT_BUDGET, runBuild } from "./pipeline.js";
import { memoryJobStore } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = resolve(here, "../../contracts/vendor");

let generatedRoot: string | null = null;
let clock = 1_000;
let ids = 0;

beforeAll(async () => {
  await promisify(execFile)("forge", ["--version"]).catch(() => {
    throw new Error("forge is not on the PATH; these benchmarks launch real markets");
  });
});

beforeEach(async () => {
  generatedRoot = await mkdtemp(join(tmpdir(), "agen-benchmark-"));
});

afterEach(async () => {
  clock = 1_000;
  if (generatedRoot !== null) await rm(generatedRoot, { recursive: true, force: true });
  generatedRoot = null;
});

// --- the market every benchmark starts from ---------------------------------

const PROMPT = "Charge a fee on sells and keep what it collects.";

function specificationAnswer() {
  return {
    summary: "Sells pay a fee the market keeps",
    baseFeePpm: 5_000,
    maxFeePpm: 30_000,
    phases: [],
    state: [
      { name: "collected", type: "counter", description: "What the market has taken", writeOnce: false },
    ],
    rules: [
      {
        id: "sell-fee",
        title: "SELL FEE",
        when: { kind: "sell", description: "Somebody sells", parameters: null },
        conditions: [],
        then: [
          {
            kind: "chargeFee",
            description: "The trade pays the hook's fee",
            parameters: [{ key: "ppm", value: 10_000 }],
            writes: ["collected"],
          },
        ],
        activeInPhases: [],
        onceOnly: false,
      },
    ],
    invariants: [{ id: "fee-ceiling", statement: "The hook fee never exceeds 3%", expression: null }],
    externalDependencies: [],
    assumptions: [],
    ambiguities: [],
    unsupported: [],
  };
}

function interpretationAnswers({ conditionalFee = false } = {}): readonly unknown[] {
  const { summary, rules, ...frame } = specificationAnswer();

  // A shape whose hook charges nothing needs a market that does not promise it will.
  //
  // Agen writes its own core assertions from the locked specification and holds the contracts
  // to them, which is the whole point of them: a specification stating a flat sell fee and a
  // hook that takes none is a market that does not do what it says. The passive-hook shapes
  // here are about the pool's fee, not about the money, so they say the fee depends on the
  // size of the trade — and everything they exist to prove is unaffected.
  const stated = conditionalFee
    ? rules.map((rule) => ({
        ...rule,
        conditions: [
          {
            kind: "tradeSizeVsLiquidity",
            description: "Only sells above a tenth of the pool",
            parameters: [{ key: "percent", value: 10 }],
            combinator: null,
          },
        ],
      }))
    : rules;

  return [
    { behaviours: rules.map((rule) => rule.title.toLowerCase()) },
    { summary, rules: stated },
    frame,
    { suggestions: [] },
  ];
}

const MATCH = {
  reuse: [{ catalogueId: "base-hook", why: "it needs a hook at all" }],
  novel: [{ concern: "keeping what a sell paid", why: "nothing in the catalogue keeps it" }],
};

// --- Solidity, parameterised by the shape under test ------------------------

/**
 * A vault, taking its owner and nothing else.
 *
 * Whoever the owner is, the contract is identical — which is the point. The two shapes that
 * used to be indistinguishable to the launcher differ only in what the deployment says goes
 * in that slot.
 */
const VAULT = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract BenchVault {
    address public immutable owner;
    address public hook;

    constructor(address owner_) {
        owner = owner_;
    }

    function setHook(address hook_) external {
        require(hook == address(0) && hook_ != address(0), "hook");
        hook = hook_;
    }

    receive() external payable {}
}
`;

/**
 * An accounting contract that owns the vault it accounts for.
 *
 * The architecture a live TEST001 build asked for and could not have: it refuses any vault
 * it does not own, and the launcher's rule said every vault owner is the fee receiver, so
 * the launch died on `InvalidVaultOwner(0xfee)` in a wiring call.
 */
const ACCOUNTING = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgenWired} from "./AgenWired.sol";
import {BenchVault} from "./BenchVault.sol";

contract BenchAccounting is AgenWired {
    /// The fee this market charges on a sell. A constant, because a launch has no value
    /// to pass for one and a setter it cannot call would leave it at zero.
    uint24 public constant SELL_FEE_PPM = 10_000;

    BenchVault public vault;
    uint256 public collected;

    error InvalidVaultOwner(address owner);

    constructor(address installer_) AgenWired(installer_) {}

    function setVault(address vault_) external onlyInstaller {
        _wireOnce(address(vault));
        require(vault_ != address(0), "vault");

        address vaultOwner = BenchVault(payable(vault_)).owner();
        if (vaultOwner != address(this)) revert InvalidVaultOwner(vaultOwner);

        vault = BenchVault(payable(vault_));
    }

    function record(uint256 amount) external {
        collected += amount;
    }
}
`;

function hookSource({
  contractName,
  imports = "",
  extraState = "",
  extraConstructorArguments = "",
  extraConstructorBody = "",
  permissions,
  fee,
  beforeSwapBody,
  extraMembers = "",
}: {
  readonly contractName: string;
  readonly imports?: string;
  readonly extraState?: string;
  readonly extraConstructorArguments?: string;
  readonly extraConstructorBody?: string;
  readonly permissions: readonly string[];
  /** What `_afterInitialize` requires of `key.fee`, or null for no opinion. */
  readonly fee: number | null;
  readonly beforeSwapBody: string;
  readonly extraMembers?: string;
}): string {
  const flag = (name: string) => (permissions.includes(name) ? "true" : "false");

  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {AgenBaseHook} from "./AgenBaseHook.sol";
${imports}

contract ${contractName} is AgenBaseHook {
    /// Every quantity this market needs, in the contract. A launch supplies addresses and
    /// the token's three values; a fee is the market's own and is written here.
    uint24 public constant SELL_FEE_PPM = 10_000;

${extraState}
    constructor(IPoolManager manager_${extraConstructorArguments}) AgenBaseHook(manager_) {
${extraConstructorBody}    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: ${flag("afterInitialize")},
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: ${flag("beforeSwap")},
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }
${
  fee === null
    ? ""
    : `
    function _afterInitialize(address, PoolKey calldata key, uint160, int24) internal pure override {
        require(key.fee == ${String(fee)}, "fee");
    }
`
}
    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata data)
        internal
        override
        returns (BeforeSwapDelta, uint24)
    {
${beforeSwapBody}    }
${extraMembers}}
`;
}

/** A hook that charges its fee and says nothing about the pool it is opened in. */
const DYNAMIC_BODY = `        sender;
        key;
        data;
        if (isBuy(params)) return (BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, SELL_FEE_PPM | LPFeeLibrary.OVERRIDE_FEE_FLAG);
`;

/** A hook that leaves the pool's own fee alone. */
const PASSIVE_BODY = `        sender;
        key;
        params;
        data;
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
`;

// --- the behaviour suite, which every benchmark shares ----------------------

/**
 * What a launched market has to be able to do, stated once.
 *
 * Deliberately about the launch rather than about each mechanic: the benchmark is measuring
 * whether seven architectures reach a working market, and a per-shape assertion would make a
 * failure ambiguous between the deployment and the market's own logic.
 */
function behaviourTests(extra = ""): string {
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MarketTestBase} from "./MarketTestBase.sol";

contract BenchBehaviorTest is MarketTestBase {
    /// The launch happened, the market trades, and the trader holds what it bought.
    function test_sell_fee_market_launches_and_trades() public {
        assertTrue(address(hook).code.length > 0);
        assertTrue(address(token).code.length > 0);

        uint256 amountOut = buy(0.01 ether);

        assertGt(amountOut, 0);
        assertEq(tokenBalance(TRADER), amountOut);
    }

    /// The fee ceiling this market's specification claims, fuzzed.
    function testFuzz_feeCeiling_isNeverExceeded(uint8 trades) public {
        trades = uint8(bound(trades, 1, 6));

        for (uint256 index = 0; index < trades; index++) {
            buy(0.001 ether);
        }

        assertGe(tokenBalance(TRADER), 0);
    }

    /// A sell needs no set-up, of tokens a buy actually produced.
    ///
    /// A raw uint128 straight into sell asks for more tokens than any market contains, which
    /// the fixture now refuses rather than selling a smaller amount and letting the market
    /// answer for the difference. See MarketTestBase._acquireForSale.
    function testFuzz_sells_what_the_buy_produced(uint128 amountIn) public {
        uint256 bought = buy(_tradeSize(amountIn, MIN_TRADE, MAX_TRADE));

        sell(uint128(bought));

        assertEq(lastSellTokens, uint128(bought));
    }
${extra}}
`;
}

// --- the seven shapes -------------------------------------------------------

interface Shape {
  readonly name: string;
  /** Why this one is here: what it disagrees with the others about. */
  readonly tests: string;
  readonly plan: Record<string, unknown>;
  readonly deployment: Record<string, unknown>;
  /** One entry per model-written component, in plan order, excluding the token. */
  readonly sources: readonly string[];
  readonly behaviour?: string;
  /**
   * Whether this shape's hook charges nothing, so its market must not promise a flat fee.
   *
   * Only the fixed-fee shapes: every other hook here charges through the pool's fee override,
   * where the money goes to the liquidity providers and Agen asserts nothing about where it
   * lands. See `interpretationAnswers`.
   */
  readonly passiveHook?: boolean;
}

const token = (id: string, contractName: string) => ({
  id,
  contractName,
  role: "token",
  origin: "generate",
  purpose: "The traded token",
  requiredBy: [],
  reuses: [],
  dependsOn: [],
  hookPermissions: [],
  custodial: false,
  implementationNotes: [],
});

const tokenDeployment = (id: string) => ({
  componentId: id,
  constructorArguments: [{ name: "recipient", type: "address", source: "INFRA:INSTALLER" }],
  immutable: ["recipient"],
  wiring: [],
  controller: null,
});

const DYNAMIC_POOL = { feeMode: "dynamic", lpFee: String(DYNAMIC_FEE_FLAG) };

/** 1. The plain shape: one hook, one vault, and the fee receiver owns the vault. */
const VAULT_OWNED_BY_FEE_RECEIVER: Shape = {
  name: "a sell-fee hook whose vault is owned by the fee receiver",
  tests: "custody belongs to the address the fees are paid to",
  plan: {
    approach: "A hook that charges sells into a vault the fee receiver can withdraw from.",
    components: [
      token("benchToken", "BenchToken"),
      {
        id: "benchVault",
        contractName: "BenchVault",
        role: "vault",
        origin: "generate",
        purpose: "Holds what sells paid",
        requiredBy: ["sell-fee"],
        reuses: [],
        dependsOn: [],
        hookPermissions: [],
        custodial: true,
        implementationNotes: [],
      },
      {
        id: "benchHook",
        contractName: "BenchHook",
        role: "hook",
        origin: "extend",
        purpose: "Charges the sell fee",
        requiredBy: ["sell-fee"],
        reuses: ["base-hook"],
        dependsOn: ["benchVault"],
        hookPermissions: ["beforeSwap"],
        custodial: false,
        implementationNotes: [],
      },
    ],
    dependencies: [],
    adaptations: [],
  },
  deployment: {
    components: [
      tokenDeployment("benchToken"),
      {
        componentId: "benchVault",
        constructorArguments: [{ name: "owner_", type: "address", source: "ROLE:FEE_RECEIVER" }],
        immutable: ["owner_"],
        wiring: [],
        controller: "ROLE:FEE_RECEIVER",
      },
      {
        componentId: "benchHook",
        constructorArguments: [
          { name: "manager_", type: "address", source: "INFRA:POOL_MANAGER" },
          { name: "vault_", type: "address", source: "COMPONENT:benchVault" },
        ],
        immutable: ["manager_", "vault_"],
        wiring: [],
        controller: null,
      },
    ],
    pool: DYNAMIC_POOL,
    custodyComponentId: "benchVault",
    feeClaimComponentId: "benchVault",
    oneTimeInitialization: [],
  },
  sources: [
    VAULT,
    hookSource({
      contractName: "BenchHook",
      imports: `import {BenchVault} from "./BenchVault.sol";`,
      extraState: "    BenchVault public immutable vault;\n\n",
      extraConstructorArguments: ", address vault_",
      extraConstructorBody: "        vault = BenchVault(payable(vault_));\n",
      permissions: ["beforeSwap"],
      fee: null,
      beforeSwapBody: DYNAMIC_BODY,
    }),
  ],
  behaviour: `
    function test_the_fee_receiver_owns_the_vault() public view {
        assertEq(component_benchVault.owner(), FEE_RECEIVER);
        assertTrue(FEE_RECEIVER != CREATOR);
    }
`,
};

/** 2. The same market, owned the other way. The pair that no single rule could serve. */
const VAULT_OWNED_BY_ACCOUNTING: Shape = {
  name: "a sell-fee hook whose vault is owned by its accounting component",
  tests: "custody belongs to a sibling contract, which no naming rule could have produced",
  plan: {
    approach: "A hook that charges sells, an accounting contract that owns the vault.",
    components: [
      token("benchToken", "BenchToken"),
      {
        id: "benchAccounting",
        contractName: "BenchAccounting",
        role: "accounting",
        origin: "generate",
        purpose: "Owns the vault and records what it holds",
        requiredBy: ["sell-fee"],
        reuses: [],
        dependsOn: [],
        hookPermissions: [],
        custodial: false,
        implementationNotes: [],
      },
      {
        id: "benchVault",
        contractName: "BenchVault",
        role: "vault",
        origin: "generate",
        purpose: "Holds what sells paid",
        requiredBy: ["sell-fee"],
        reuses: [],
        dependsOn: ["benchAccounting"],
        hookPermissions: [],
        custodial: true,
        implementationNotes: [],
      },
      {
        id: "benchHook",
        contractName: "BenchHook",
        role: "hook",
        origin: "extend",
        purpose: "Charges the sell fee",
        requiredBy: ["sell-fee"],
        reuses: ["base-hook"],
        dependsOn: ["benchAccounting"],
        hookPermissions: ["beforeSwap"],
        custodial: false,
        implementationNotes: [],
      },
    ],
    dependencies: [],
    adaptations: [],
  },
  deployment: {
    components: [
      tokenDeployment("benchToken"),
      {
        componentId: "benchAccounting",
        constructorArguments: [
          { name: "installer_", type: "address", source: "INFRA:INSTALLER" },
        ],
        immutable: ["installer_"],
        // The vault does not exist when the accounting contract is built, so it is told
        // afterwards — which is the whole reason wiring exists.
        wiring: [
          {
            functionName: "setVault",
            argument: "COMPONENT:benchVault",
            phase: "before_pool_initialize",
            once: true,
          },
        ],
        controller: null,
      },
      {
        componentId: "benchVault",
        constructorArguments: [
          { name: "owner_", type: "address", source: "COMPONENT:benchAccounting" },
        ],
        immutable: ["owner_"],
        wiring: [],
        controller: "COMPONENT:benchAccounting",
      },
      {
        componentId: "benchHook",
        constructorArguments: [
          { name: "manager_", type: "address", source: "INFRA:POOL_MANAGER" },
          { name: "accounting_", type: "address", source: "COMPONENT:benchAccounting" },
        ],
        immutable: ["manager_", "accounting_"],
        wiring: [],
        controller: null,
      },
    ],
    pool: DYNAMIC_POOL,
    custodyComponentId: "benchVault",
    feeClaimComponentId: "benchVault",
    oneTimeInitialization: [
      {
        componentId: "benchAccounting",
        functionName: "setVault",
        why: "the vault it accounts for is permanent; a second one would orphan the balances",
      },
    ],
  },
  sources: [
    ACCOUNTING,
    VAULT,
    hookSource({
      contractName: "BenchHook",
      imports: `import {BenchAccounting} from "./BenchAccounting.sol";`,
      extraState: "    BenchAccounting public immutable accounting;\n\n",
      extraConstructorArguments: ", address accounting_",
      extraConstructorBody: "        accounting = BenchAccounting(accounting_);\n",
      permissions: ["beforeSwap"],
      fee: null,
      beforeSwapBody: DYNAMIC_BODY,
    }),
  ],
  behaviour: `
    function test_the_accounting_contract_owns_the_vault() public view {
        assertEq(component_benchVault.owner(), address(component_benchAccounting));
        assertEq(address(component_benchAccounting.vault()), address(component_benchVault));
    }
`,
};

/** 3. Four components, two of them wired after deployment. */
const MULTI_COMPONENT: Shape = {
  name: "a market with an accounting contract, a vault and a wired hook",
  tests: "a bundle whose wiring runs in both directions",
  plan: {
    approach: "Accounting owns the vault, and the vault is told which hook may credit it.",
    components: VAULT_OWNED_BY_ACCOUNTING.plan["components"] as unknown[],
    dependencies: [],
    adaptations: [],
  },
  deployment: {
    ...VAULT_OWNED_BY_ACCOUNTING.deployment,
    components: (VAULT_OWNED_BY_ACCOUNTING.deployment["components"] as Record<string, unknown>[]).map(
      (component) =>
        component["componentId"] === "benchVault"
          ? {
              ...component,
              // Told the hook after deployment: the hook takes the accounting contract, so
              // the vault cannot have the hook's address in its constructor.
              wiring: [
                {
                  functionName: "setHook",
                  argument: "COMPONENT:benchHook",
                  phase: "before_pool_initialize",
                  once: true,
                },
              ],
            }
          : component,
    ),
    oneTimeInitialization: [
      ...(VAULT_OWNED_BY_ACCOUNTING.deployment["oneTimeInitialization"] as unknown[]),
      {
        componentId: "benchVault",
        functionName: "setHook",
        why: "the vault credits one hook for the life of the market",
      },
    ],
  },
  sources: VAULT_OWNED_BY_ACCOUNTING.sources,
  behaviour: `
    function test_every_component_knows_the_others() public view {
        assertEq(component_benchVault.owner(), address(component_benchAccounting));
        assertEq(component_benchVault.hook(), address(hook));
    }
`,
};

/** 4. A hook that authenticates its trades through AgenRouter. */
const TRADER_AWARE: Shape = {
  name: "a trader-aware market that authenticates through AgenRouter",
  tests: "a market whose hook must be handed infrastructure, or refuse every trade forever",
  plan: {
    approach: "A hook that reads the trader through the canonical router.",
    components: [
      token("benchToken", "BenchToken"),
      {
        id: "benchHook",
        contractName: "BenchHook",
        role: "hook",
        origin: "extend",
        purpose: "Charges the sell fee and knows who traded",
        requiredBy: ["sell-fee"],
        reuses: ["base-hook"],
        dependsOn: [],
        hookPermissions: ["beforeSwap"],
        custodial: false,
        implementationNotes: [],
      },
    ],
    dependencies: [],
    adaptations: [],
  },
  deployment: {
    components: [
      tokenDeployment("benchToken"),
      {
        componentId: "benchHook",
        constructorArguments: [
          { name: "manager_", type: "address", source: "INFRA:POOL_MANAGER" },
          { name: "router_", type: "address", source: "INFRA:AGEN_ROUTER" },
        ],
        immutable: ["manager_", "router_"],
        wiring: [],
        controller: null,
      },
    ],
    pool: DYNAMIC_POOL,
    custodyComponentId: null,
    feeClaimComponentId: null,
    oneTimeInitialization: [],
  },
  sources: [
    hookSource({
      contractName: "BenchHook",
      extraState: "    address public immutable router;\n    address public lastTrader;\n\n",
      extraConstructorArguments: ", address router_",
      extraConstructorBody:
        '        require(router_ != address(0), "router");\n        router = router_;\n',
      permissions: ["beforeSwap"],
      fee: null,
      beforeSwapBody: `        key;
        data;
        if (sender == router) lastTrader = sender;
        if (isBuy(params)) return (BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, SELL_FEE_PPM | LPFeeLibrary.OVERRIDE_FEE_FLAG);
`,
    }),
  ],
  behaviour: `
    function test_the_hook_was_handed_the_router() public {
        assertEq(hook.router(), address(agenRouter));

        buy(0.01 ether);

        // Trades arrive through the canonical route, which is what the hook authenticates.
        assertEq(hook.lastTrader(), address(agenRouter));
    }
`,
};

/** 5. A market whose whole mechanic is state the hook keeps. */
const STATEFUL_COUNTER: Shape = {
  name: "a stateful market counting every trade in the hook",
  tests: "a market with no vault, no accounting and state that has to survive the launch",
  plan: {
    approach: "One hook holding a global counter.",
    components: [
      token("benchToken", "BenchToken"),
      {
        id: "benchHook",
        contractName: "BenchHook",
        role: "hook",
        origin: "extend",
        purpose: "Counts trades and charges the sell fee",
        requiredBy: ["sell-fee"],
        reuses: ["base-hook"],
        dependsOn: [],
        hookPermissions: ["beforeSwap"],
        custodial: false,
        implementationNotes: [],
      },
    ],
    dependencies: [],
    adaptations: [],
  },
  deployment: {
    components: [
      tokenDeployment("benchToken"),
      {
        componentId: "benchHook",
        constructorArguments: [
          { name: "manager_", type: "address", source: "INFRA:POOL_MANAGER" },
        ],
        immutable: ["manager_"],
        wiring: [],
        controller: null,
      },
    ],
    pool: DYNAMIC_POOL,
    custodyComponentId: null,
    feeClaimComponentId: null,
    oneTimeInitialization: [],
  },
  sources: [
    hookSource({
      contractName: "BenchHook",
      extraState: "    uint256 public trades;\n\n",
      permissions: ["beforeSwap"],
      fee: null,
      beforeSwapBody: `        sender;
        key;
        data;
        trades += 1;
        if (isBuy(params)) return (BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, SELL_FEE_PPM | LPFeeLibrary.OVERRIDE_FEE_FLAG);
`,
    }),
  ],
  behaviour: `
    function test_the_counter_survives_the_launch_and_counts() public {
        // The launch itself opens liquidity without swapping, so the market starts at zero.
        assertEq(hook.trades(), 0);

        buy(0.01 ether);

        assertEq(hook.trades(), 1);
    }
`,
};

/** 6. A hook that requires an ordinary constant pool fee. */
const STATIC_FEE: Shape = {
  name: "a market opened at a fixed pool fee",
  tests: "a pool fee the hook requires and does not vary, read from the hook rather than assumed",
  passiveHook: true,
  plan: STATEFUL_COUNTER.plan,
  deployment: {
    ...STATEFUL_COUNTER.deployment,
    pool: { feeMode: "fixed", lpFee: "3000" },
  },
  sources: [
    hookSource({
      contractName: "BenchHook",
      permissions: ["afterInitialize", "beforeSwap"],
      fee: 3_000,
      beforeSwapBody: PASSIVE_BODY,
    }),
  ],
  behaviour: `
    function test_the_pool_opened_at_the_fee_the_hook_requires() public view {
        assertEq(uint256(MARKET_LP_FEE), 3000);
        assertEq(uint256(key.fee), 3000);
    }
`,
};

/**
 * 6b/7. The hook's address permissions differ from shape 6, so this needs its own plan.
 *
 * Written out rather than spread from `STATEFUL_COUNTER`, because the permissions are what
 * the address is mined for and a shape that shares them would not be testing a difference.
 */
const STATIC_FEE_SHAPE: Shape = {
  ...STATIC_FEE,
  plan: {
    ...STATEFUL_COUNTER.plan,
    components: (STATEFUL_COUNTER.plan["components"] as Record<string, unknown>[]).map((component) =>
      component["role"] === "hook"
        ? { ...component, hookPermissions: ["afterInitialize", "beforeSwap"] }
        : component,
    ),
  },
};

/** 7. A hook that sets its own fee on every swap. */
const DYNAMIC_FEE: Shape = {
  name: "a market whose hook sets the fee on every swap",
  tests: "the dynamic sentinel, which is what most markets want and none should assume",
  plan: {
    ...STATEFUL_COUNTER.plan,
    components: (STATEFUL_COUNTER.plan["components"] as Record<string, unknown>[]).map((component) =>
      component["role"] === "hook"
        ? { ...component, hookPermissions: ["afterInitialize", "beforeSwap"] }
        : component,
    ),
  },
  deployment: STATEFUL_COUNTER.deployment,
  sources: [
    hookSource({
      contractName: "BenchHook",
      permissions: ["afterInitialize", "beforeSwap"],
      fee: DYNAMIC_FEE_FLAG,
      beforeSwapBody: DYNAMIC_BODY,
    }),
  ],
  behaviour: `
    function test_the_pool_opened_dynamic() public view {
        assertEq(uint256(MARKET_LP_FEE), ${String(DYNAMIC_FEE_FLAG)});
    }
`,
};

const SHAPES: readonly Shape[] = [
  VAULT_OWNED_BY_FEE_RECEIVER,
  VAULT_OWNED_BY_ACCOUNTING,
  MULTI_COMPONENT,
  TRADER_AWARE,
  STATEFUL_COUNTER,
  STATIC_FEE_SHAPE,
  DYNAMIC_FEE,
];

// --- running one ------------------------------------------------------------

async function launch(shape: Shape): Promise<GenerationJob> {
  const provider = scriptedProvider([
    ...interpretationAnswers({ conditionalFee: shape.passiveHook === true }),
    MATCH,
    { plan: shape.plan, deployment: shape.deployment },
    ...shape.sources.map((content) => ({ content, notes: [] })),
    { files: [{ path: "test/BenchBehavior.t.sol", content: behaviourTests(shape.behaviour) }], notes: [] },
  ]);

  return runBuild(
    { prompt: PROMPT, name: "Bench", symbol: "BENCH" },
    {
      provider,
      store: memoryJobStore(),
      vendorRoot: VENDOR,
      generatedRoot: generatedRoot!,
      budget: DEFAULT_BUDGET,
      now: () => (clock += 10),
      newId: () => `bench-${String(++ids)}`,
    },
  );
}

/** What a shape has to achieve, and the terms the goal was stated in. */
function expectLaunchable(job: GenerationJob, shape: Shape): void {
  const stageOf = (stage: Stage) => job.stages.filter((record) => record.stage === stage);
  const detail = job.failure === null ? "" : `${job.failure.code}: ${job.failure.detail}`;

  // The contracts matched the deployment they were designed for.
  expect(stageOf(Stage.DeploymentValidation).at(-1)?.status, `${shape.name}: ${detail}`).toBe(
    "succeeded",
  );

  // The canonical launch ran through the real factory.
  expect(stageOf(Stage.TestEnvironment).at(-1)?.status, `${shape.name}: ${detail}`).toBe("succeeded");

  // Why it did not launch, before what that cost: a build that died at test_repair has an
  // empty outcome list as a symptom, and asserting the symptom first reports "no behaviour
  // test ran" for a failure that named itself.
  expect(job.failure, `${shape.name}: ${detail}`).toBeNull();
  expect(job.stage, shape.name).toBe(Stage.DeploymentReady);
  expect(job.manifest, shape.name).not.toBeNull();

  // And the behaviour suite ran, rather than being quarantined down to nothing.
  expect(job.testOutcomes.length, `${shape.name}: no behaviour test ran`).toBeGreaterThan(0);
  expect(job.testOutcomes.every((outcome) => outcome.passed), `${shape.name}: ${detail}`).toBe(true);

  /**
   * The number this whole design exists to drive to zero.
   *
   * `harnessAttempts` counts rounds spent making the canonical launch work — every one of
   * them, before this, was the launcher having guessed something. A shape that needs one
   * has an architecture the deployment did not describe.
   */
  expect(job.harnessAttempts, `${shape.name}: spent a deployment repair`).toBe(0);
  expect(job.failure?.code).not.toBe(FailureCode.ArchitectureInconsistent);
}

describe("seven architectures, launched without inferring a deployment", () => {
  for (const shape of SHAPES) {
    it(
      `launches ${shape.name}`,
      async () => {
        const job = await launch(shape);
        expectLaunchable(job, shape);
      },
      600_000,
    );
  }
});
