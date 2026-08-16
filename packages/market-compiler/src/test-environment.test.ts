import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AGEN_LAUNCH, TICK_SPACING } from "@verdant/config";

import type { ContractArtifact } from "./artifacts.js";
import type { DeploymentSpecification } from "./deployment-spec.js";
import { test as forgeTest } from "./foundry.js";
import { marketSaltFor } from "./deployment.js";
import { MINING_LIMIT } from "./mining.js";
import type { MarketImplementationPlan } from "./plan.js";
import { preludeSources, testPreludeSources, tokenSource } from "./prelude.js";
import {
  CANONICAL_TEST_BASE,
  CANONICAL_TEST_SMOKE,
  canonicalTestEnvironment,
  manualTestInfrastructureProblems,
  nameLaunchFailure,
} from "./test-environment.js";
import { createWorkspace, type Workspace } from "./workspace.js";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = resolve(here, "../../contracts/vendor");
let workspace: Workspace | null = null;

beforeAll(async () => {
  await promisify(execFile)("forge", ["--version"]);
});

afterEach(async () => {
  await workspace?.dispose();
  workspace = null;
});

const constructorOf = (inputs: { name: string; type: string }[]) => ({
  type: "constructor",
  inputs,
});

const setter = (name: string, argument: string, type = "address") => ({
  type: "function",
  name,
  inputs: [{ name: argument, type }],
  outputs: [],
  stateMutability: "nonpayable",
});

function artifact(contractName: string, abi: unknown[]): ContractArtifact {
  return {
    contractName,
    sourcePath: `contracts/${contractName}.sol`,
    abi: abi as ContractArtifact["abi"],
    bytecode: "0x6080",
    deployedBytecode: "0x6080",
    compilerVersion: "0.8.26",
    sourceHash: "0x00",
    source: "",
  };
}

function plan(): MarketImplementationPlan {
  return {
    version: 1,
    specificationVersion: 1,
    approach: "A routed fee hook backed by a vault.",
    components: [
      {
        id: "token",
        contractName: "ShiftToken",
        role: "token",
        purpose: "The traded token",
        requiredBy: [],
        origin: "generate",
        reuses: [],
        dependsOn: [],
      },
      {
        id: "vault",
        contractName: "FeeVault",
        role: "vault",
        purpose: "Holds sell fees",
        requiredBy: ["sell-fee"],
        origin: "generate",
        reuses: [],
        dependsOn: [],
      },
      {
        id: "hook",
        contractName: "ShiftHook",
        role: "hook",
        purpose: "Charges the configured fee",
        requiredBy: ["sell-fee"],
        origin: "generate",
        reuses: [],
        dependsOn: ["vault"],
        hookPermissions: ["afterInitialize", "beforeSwap"],
      },
    ],
    dependencies: [],
    adaptations: [],
  };
}

/**
 * The declared deployment for the plan above.
 *
 * The fixture executes this rather than reading the artifacts and forming an opinion, so a
 * test that did not state it would be testing nothing the launcher does.
 */
function deployment(): DeploymentSpecification {
  return {
    version: 1,
    specificationVersion: 1,
    components: [
      {
        componentId: "token",
        contractName: "ShiftToken",
        role: "token",
        constructorArguments: [
          { name: "name_", type: "string", source: "LITERAL:NAME" },
          { name: "symbol_", type: "string", source: "LITERAL:SYMBOL" },
          { name: "supply_", type: "uint256", source: "LITERAL:SUPPLY" },
          { name: "recipient_", type: "address", source: "INFRA:INSTALLER" },
        ],
        immutable: ["recipient_"],
        wiring: [],
        controller: null,
        custody: false,
        claimsFees: false,
      },
      {
        componentId: "vault",
        contractName: "FeeVault",
        role: "vault",
        constructorArguments: [
          { name: "beneficiary_", type: "address", source: "ROLE:FEE_RECEIVER" },
        ],
        immutable: ["beneficiary_"],
        wiring: [
          {
            functionName: "setHook",
            argument: "COMPONENT:hook",
            caller: "INSTALLER",
            phase: "before_pool_initialize",
            once: true,
          },
        ],
        controller: "ROLE:FEE_RECEIVER",
        custody: true,
        claimsFees: true,
      },
      {
        componentId: "hook",
        contractName: "ShiftHook",
        role: "hook",
        constructorArguments: [
          { name: "manager_", type: "address", source: "INFRA:POOL_MANAGER" },
          { name: "vault_", type: "address", source: "COMPONENT:vault" },
          { name: "agenRouter_", type: "address", source: "INFRA:AGEN_ROUTER" },
          { name: "configuredFeeReceiver_", type: "address", source: "ROLE:FEE_RECEIVER" },
        ],
        immutable: ["manager_", "vault_", "agenRouter_", "configuredFeeReceiver_"],
        wiring: [
          {
            functionName: "bindPoolId",
            argument: "POOL_ID",
            caller: "INSTALLER",
            phase: "before_pool_initialize",
            once: true,
          },
        ],
        controller: null,
        custody: false,
        claimsFees: false,
      },
    ],
    pool: { feeMode: "dynamic", lpFee: 0x800000, tickSpacing: TICK_SPACING },
    hookPermissions: ["afterInitialize", "beforeSwap"],
    requiresPoolIdBeforeInitialize: true,
    requiresAgenRouter: true,
    custodyComponentId: "vault",
    feeClaimComponentId: "vault",
    oneTimeInitialization: [
      { componentId: "vault", functionName: "setHook", why: "the vault credits one hook forever" },
    ],
  };
}

const artifacts = [
  artifact("ShiftToken", [
    constructorOf([
      { name: "name_", type: "string" },
      { name: "symbol_", type: "string" },
      { name: "supply_", type: "uint256" },
      { name: "recipient_", type: "address" },
    ]),
  ]),
  artifact("FeeVault", [
    constructorOf([{ name: "beneficiary_", type: "address" }]),
    setter("setHook", "hook_"),
  ]),
  artifact("ShiftHook", [
    constructorOf([
      { name: "manager_", type: "address" },
      { name: "vault_", type: "address" },
      { name: "agenRouter_", type: "address" },
      { name: "configuredFeeReceiver_", type: "address" },
    ]),
    setter("bindPoolId", "poolId_", "bytes32"),
  ]),
];

describe("canonical generated-test environment", () => {
  it("renders production deployment semantics without model-authored setup", () => {
    const environment = canonicalTestEnvironment({
      plan: plan(),
      deployment: deployment(),
      artifacts,
      name: "Shift",
      symbol: "SHIFT",
      supplyTokens: 1_000_000_000n,
      lpFee: 0x800000,
      initialTick: AGEN_LAUNCH.initialTick,
      marketSalt: marketSaltFor("shift-test"),
    });

    expect(environment.source.path).toBe(CANONICAL_TEST_BASE);
    expect(environment.source.content).toContain("factory.deployMarket(manifest)");
    expect(environment.source.content).toContain("new AgenRouter(manager)");
    expect(environment.source.content).toContain(`MAX_LOOP = ${String(MINING_LIMIT)}`);
    // Allocation-free miner: the abi.encode loop was setUp MemoryOOG.
    expect(environment.source.content).toContain("mstore8(0x0b, 0xff)");
    expect(environment.source.content).toContain("keccak256(0x0b, 0x55)");
    expect(environment.source.content).not.toContain("abi.encode(namespace, i)");
    expect(environment.source.content).not.toContain("abi.encodePacked(bytes1(0xff)");
    expect(environment.source.content).toMatch(/FeeVault\(payable\(deployed\[\d+\]\.addr\)\)/);
    expect(environment.source.content).toContain(
      'abi.encodeWithSignature("setHook(address)", components[2].expected)',
    );
    expect(environment.source.content).toContain(
      'abi.encodeWithSignature("bindPoolId(bytes32)", predictedPoolId)',
    );
    // Distinct from the creator, so a market that resolves "the money address" two
    // different ways fails here rather than during a launch nobody can undo.
    expect(environment.source.content).not.toContain("FEE_RECEIVER = CREATOR");
    expect(environment.source.content).toMatch(/FEE_RECEIVER = address\(uint160\(0xFEE\)\)/);
    expect(environment.source.content).toContain("address(agenRouter)");
    expect(environment.source.content).toContain("agenRouter.swap");
    expect(environment.guidance).toContain("Do not declare setUp");
    // A live ORBIT suite asserted the creator was paid, because the prompt said so, and
    // failed against the address the launch actually credits.
    expect(environment.guidance).toContain("Fee money arrives at FEE_RECEIVER");
    expect(environment.guidance).toContain("component_vault: FeeVault");
  });

  it("names the contract behind a DeploymentFailed salt", () => {
    const environment = canonicalTestEnvironment({
      plan: plan(),
      deployment: deployment(),
      artifacts,
      name: "Shift",
      symbol: "SHIFT",
      supplyTokens: 1_000_000_000n,
      lpFee: 0x800000,
      initialTick: AGEN_LAUNCH.initialTick,
      marketSalt: marketSaltFor("shift-test"),
    });

    // The salt this reads must be the one the fixture computes. It is asserted against
    // the generated Solidity rather than against a constant, because the two drifting
    // apart would not fail anything — it would quietly stop naming the contract, and a
    // repair round would go back to being spent on an unreadable hash.
    const vault = environment.componentSalts.find((entry) => entry.componentId === "vault")!;
    expect(environment.source.content).toContain(
      'keccak256(abi.encode(CREATOR, MARKET_SALT, "vault"))',
    );
    expect(environment.source.content).toContain("address internal constant CREATOR = address(uint160(0xA11CE))");

    expect(nameLaunchFailure(`setUp(): DeploymentFailed(${vault.salt})`, environment.componentSalts))
      .toContain("FeeVault's constructor reverted");
    expect(nameLaunchFailure(`DeploymentFailed(${vault.salt})`, environment.componentSalts))
      .toContain("24576-byte contract size limit");

    // A salt from some other market is left alone rather than blamed on this one.
    const foreign = `0x${"ab".repeat(32)}`;
    expect(nameLaunchFailure(`DeploymentFailed(${foreign})`, environment.componentSalts)).toBe(
      `DeploymentFailed(${foreign})`,
    );
  });

  it("rejects generated setup and manual launch plumbing", () => {
    const problems = manualTestInfrastructureProblems([
      {
        path: "test/Shift.t.sol",
        content: `contract ShiftTest is AgenTest {
          function setUp() public {
            vm.deal(address(this), 10 ether);
            key = openMarket(address(token), address(hook), DYNAMIC_FEE);
          }
        }`,
      },
    ]);

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("inherits AgenTest directly"),
        expect.stringContaining("declares setUp"),
        expect.stringContaining("funds an actor manually"),
        expect.stringContaining("opens the pool manually"),
      ]),
    );
  });

  it.each([
    ["contract deployment", "new ShiftHook()"],
    ["deterministic address mining", "vm.computeCreateAddress(address(this), 3)"],
    ["CREATE2 prediction", "Create2.computeAddress(bytes32(0), bytes32(0))"],
    ["manual actor addresses", "address trader = makeAddr(\"trader\")"],
    [
      "PoolKey construction",
      "PoolKey({currency0: a, currency1: b, fee: 0, tickSpacing: key.tickSpacing, hooks: h})",
    ],
    ["separate PoolKey declaration", "PoolKey memory otherKey = key"],
    ["fee mode selection", "agenPoolKey(address(0), address(token), address(hook), 60, 0)"],
    ["fee flag selection", "uint24 fee = DYNAMIC_FEE_FLAG"],
    ["initial price geometry", "TickMath.getSqrtPriceAtTick(0)"],
    ["pool initialization", "manager.initialize(key, 1)"],
    ["liquidity geometry", "addLiquidity(key, 10 ether)"],
    ["position-manager liquidity", "positionManager.modifyLiquidities(bytes(\"\"), block.timestamp)"],
    ["liquidity calculations", "LiquidityAmounts.getLiquidityForAmount1(1, 2, 3)"],
    ["component wiring", "component_vault.setHook(address(hook))"],
    ["fee receiver wiring", "hook.setFeeReceiver(FEE_RECEIVER)"],
    ["launch ownership", "token.transferOwnership(CREATOR)"],
    ["manual allowance", "token.approve(address(router), 1)"],
    ["manual balances", "vm.deal(TRADER, 1 ether)"],
    ["manual token balances", "token.transfer(TRADER, 1 ether)"],
    ["direct router execution", "agenRouter.swap(key, true, 1, 0, bytes(\"\"))"],
    ["direct callbacks", "hook.beforeSwap(address(this), key, params, bytes(\"\"))"],
    ["factory reconstruction", "factory.poolKeyFor(address(0), address(token), 0, address(hook))"],
  ])("rejects %s in a generated behavior suite", (_label, statement) => {
    const problems = manualTestInfrastructureProblems([
      {
        path: "test/Shift.t.sol",
        content: `import {MarketTestBase} from "./MarketTestBase.sol";
contract ShiftTest is MarketTestBase {
  function test_rule() public { ${statement}; }
}`,
      },
    ]);

    expect(problems.length).toBeGreaterThan(0);
  });

  /**
   * The same statements, written as proof that they are not allowed.
   *
   * SIMPLE was refused here twice — its whole suite, on both attempts — because the only test
   * standing behind "the configured fee receiver is never the zero address" proved it the way
   * anyone would: by calling the setter and expecting a revert. Read as an attempt to wire the
   * market by hand, that cost a market whose contracts were never in question.
   */
  it.each([
    ["a guarded setter", "vm.expectRevert();\n    hook.setFeeReceiver(address(0));"],
    ["guarded ownership", "vm.expectRevert();\n    token.transferOwnership(TRADER);"],
    ["a guarded callback", "vm.expectRevert();\n    hook.beforeSwap(TRADER, key, params, bytes(\"\"));"],
    ["an expectation on one line", 'vm.expectRevert("nope"); vault.setHook(address(1));'],
  ])("accepts %s asserted to revert", (_label, statement) => {
    expect(
      manualTestInfrastructureProblems([
        {
          path: "test/Shift.t.sol",
          content: `import {MarketTestBase} from "./MarketTestBase.sol";
contract ShiftTest is MarketTestBase {
  function test_guard() public {
    ${statement}
  }
}`,
        },
      ]),
    ).toEqual([]);
  });

  /** A revert expectation does not make deploying infrastructure sensible, and does not excuse it. */
  it("still refuses infrastructure a test only claims will revert", () => {
    const problems = manualTestInfrastructureProblems([
      {
        path: "test/Shift.t.sol",
        content: `import {MarketTestBase} from "./MarketTestBase.sol";
contract ShiftTest is MarketTestBase {
  function test_guard() public {
    vm.expectRevert();
    deployPoolManager();
  }
}`,
      },
    ]);

    expect(problems.length).toBeGreaterThan(0);
  });

  it("accepts behavior-only tests inheriting the canonical base", () => {
    expect(
      manualTestInfrastructureProblems([
        {
          path: "test/Shift.t.sol",
          content: `import {MarketTestBase} from "./MarketTestBase.sol";
contract ShiftTest is MarketTestBase {
  function test_sellChargesFee() public {
    buy(1 ether);
    sell(uint128(tokenBalance(TRADER)));
    assertGt(FEE_RECEIVER.balance, 1_000 ether);
  }
}`,
        },
      ]),
    ).toEqual([]);
  });

  it("does not let generated output replace either canonical base", () => {
    const problems = manualTestInfrastructureProblems([
      {
        path: CANONICAL_TEST_BASE,
        content: "contract MarketTestBase {}",
      },
      {
        path: "test/AgenTest.sol",
        content: "contract AgenTest {}",
      },
      {
        path: CANONICAL_TEST_SMOKE,
        content: "contract MarketTestEnvironmentTest {}",
      },
    ]);

    expect(problems.filter((problem) => problem.includes("replace canonical"))).toHaveLength(3);
  });

  it(
    "launches through the real factory, wires components and executes behavior",
    async () => {
      const integrationPlan: MarketImplementationPlan = {
        version: 1,
        specificationVersion: 1,
        approach: "A factory-wired dynamic hook.",
        components: [
          {
            id: "token",
            contractName: "CanonicalToken",
            role: "token",
            purpose: "The traded token",
            requiredBy: [],
            origin: "generate",
            reuses: [],
            dependsOn: [],
          },
          {
            id: "vault",
            contractName: "CanonicalVault",
            role: "vault",
            purpose: "A component wired to the hook",
            requiredBy: ["fee"],
            origin: "generate",
            reuses: [],
            dependsOn: [],
          },
          {
            id: "hook",
            contractName: "CanonicalHook",
            role: "hook",
            purpose: "Checks launch-time roles and its pool id",
            requiredBy: ["fee"],
            origin: "generate",
            reuses: [],
            dependsOn: ["vault"],
            hookPermissions: ["afterInitialize", "beforeSwap"],
          },
        ],
        dependencies: [],
        adaptations: [],
      };

      const integrationArtifacts = [
        artifact("CanonicalToken", [constructorOf([{ name: "recipient_", type: "address" }])]),
        artifact("CanonicalVault", [
          constructorOf([
            { name: "installer_", type: "address" },
            { name: "beneficiary_", type: "address" },
          ]),
          setter("setHook", "hook_"),
        ]),
        artifact("CanonicalHook", [
          constructorOf([
            { name: "manager_", type: "address" },
            { name: "vault_", type: "address" },
            { name: "installer_", type: "address" },
            { name: "configuredFeeReceiver_", type: "address" },
          ]),
          setter("bindPoolId", "poolId_", "bytes32"),
        ]),
      ];

      const integrationDeployment: DeploymentSpecification = {
        version: 1,
        specificationVersion: 1,
        components: [
          {
            componentId: "token",
            contractName: "CanonicalToken",
            role: "token",
            constructorArguments: [
              { name: "recipient_", type: "address", source: "INFRA:INSTALLER" },
            ],
            immutable: ["recipient_"],
            wiring: [],
            controller: null,
            custody: false,
            claimsFees: false,
          },
          {
            componentId: "vault",
            contractName: "CanonicalVault",
            role: "vault",
            constructorArguments: [
              { name: "installer_", type: "address", source: "INFRA:INSTALLER" },
              { name: "beneficiary_", type: "address", source: "ROLE:FEE_RECEIVER" },
            ],
            immutable: ["installer_", "beneficiary_"],
            wiring: [
              {
                functionName: "setHook",
                argument: "COMPONENT:hook",
                caller: "INSTALLER",
                phase: "before_pool_initialize",
                once: true,
              },
            ],
            controller: "ROLE:FEE_RECEIVER",
            custody: true,
            claimsFees: true,
          },
          {
            componentId: "hook",
            contractName: "CanonicalHook",
            role: "hook",
            constructorArguments: [
              { name: "manager_", type: "address", source: "INFRA:POOL_MANAGER" },
              { name: "vault_", type: "address", source: "COMPONENT:vault" },
              { name: "installer_", type: "address", source: "INFRA:INSTALLER" },
              { name: "configuredFeeReceiver_", type: "address", source: "ROLE:FEE_RECEIVER" },
            ],
            immutable: ["manager_", "vault_", "installer_", "configuredFeeReceiver_"],
            wiring: [
              {
                functionName: "bindPoolId",
                argument: "POOL_ID",
                caller: "INSTALLER",
                phase: "before_pool_initialize",
                once: true,
              },
            ],
            controller: null,
            custody: false,
            claimsFees: false,
          },
        ],
        pool: { feeMode: "dynamic", lpFee: 0x800000, tickSpacing: TICK_SPACING },
        hookPermissions: ["afterInitialize", "beforeSwap"],
        requiresPoolIdBeforeInitialize: true,
        requiresAgenRouter: false,
        custodyComponentId: "vault",
        feeClaimComponentId: "vault",
        oneTimeInitialization: [],
      };

      const environment = canonicalTestEnvironment({
        plan: integrationPlan,
        deployment: integrationDeployment,
        artifacts: integrationArtifacts,
        name: "Canonical",
        symbol: "CANON",
        supplyTokens: 1_000_000_000n,
        lpFee: 0x800000,
        initialTick: AGEN_LAUNCH.initialTick,
        marketSalt: marketSaltFor("canonical-integration"),
      });

      workspace = await createWorkspace({ vendorRoot: VENDOR });
      await workspace.write([
        ...preludeSources().map((source) => ({
          path: source.path.replace(/^contracts\//, "src/"),
          content: source.content,
        })),
        ...testPreludeSources(),
        {
          ...tokenSource({
            contractName: "CanonicalToken",
            name: "Canonical",
            symbol: "CANON",
            supplyTokens: 1_000_000_000n,
          }),
          path: "src/CanonicalToken.sol",
        },
        {
          path: "src/CanonicalVault.sol",
          content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract CanonicalVault {
    address public immutable installer;
    address public immutable beneficiary;
    address public hook;

    constructor(address installer_, address beneficiary_) {
        installer = installer_;
        beneficiary = beneficiary_;
    }

    function setHook(address hook_) external {
        require(msg.sender == installer, "installer");
        require(hook == address(0) && hook_ != address(0), "hook");
        hook = hook_;
    }

    receive() external payable {}
}
`,
        },
        {
          path: "src/CanonicalHook.sol",
          content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {AgenBaseHook} from "./AgenBaseHook.sol";
import {CanonicalVault} from "./CanonicalVault.sol";

contract CanonicalHook is AgenBaseHook {
    using PoolIdLibrary for PoolKey;

    CanonicalVault public immutable vault;
    address public immutable installer;
    address public immutable configuredFeeReceiver;
    bytes32 public designatedPoolId;

    constructor(
        IPoolManager manager_,
        address vault_,
        address installer_,
        address configuredFeeReceiver_
    ) AgenBaseHook(manager_) {
        require(configuredFeeReceiver_ != address(0), "fee receiver");
        vault = CanonicalVault(payable(vault_));
        installer = installer_;
        configuredFeeReceiver = configuredFeeReceiver_;
    }

    function bindPoolId(bytes32 poolId_) external {
        require(msg.sender == installer, "installer");
        require(designatedPoolId == bytes32(0), "pool");
        designatedPoolId = poolId_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function _afterInitialize(address, PoolKey calldata key, uint160, int24) internal view override {
        require(designatedPoolId == PoolId.unwrap(key.toId()), "wrong pool");
    }

    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        pure
        override
        returns (BeforeSwapDelta, uint24)
    {
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
`,
        },
        {
          ...environment.source,
          content: environment.source.content.replaceAll("../contracts/", "../src/"),
        },
        environment.smoke,
        {
          path: "test/CanonicalBehavior.t.sol",
          content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MarketTestBase} from "./MarketTestBase.sol";

contract CanonicalBehaviorTest is MarketTestBase {
    function test_factoryLaunchIsWiredAndTrades() public {
        assertEq(component_vault.hook(), address(hook));
        // Both sides of the bundle name the same address for custody, and it is not the
        // creator. A launch reverted in production because these two disagreed.
        assertEq(component_vault.beneficiary(), FEE_RECEIVER);
        assertEq(hook.configuredFeeReceiver(), FEE_RECEIVER);
        assertTrue(FEE_RECEIVER != CREATOR);
        assertEq(tokenBalance(TRADER), 0);

        uint256 amountOut = buy(0.01 ether);

        assertGt(amountOut, 0);
        assertEq(tokenBalance(TRADER), amountOut);
    }

    /// The failure this bound exists for, written the way a generated suite writes it.
    /// A raw uint128 straight from the fuzzer used to reach the router as zero or dust,
    /// and "assertion failed: 0 <= 0" is what a correct market looked like when it did.
    function testFuzz_buys_always_move_tokens(uint128 amountIn) public {
        uint256 amountOut = buy(amountIn);

        assertGt(amountOut, 0);
        assertEq(tokenBalance(TRADER), amountOut);
    }

    /// A fuzzed sell needs no set-up, clamped the way a generated suite is told to clamp it.
    function testFuzz_sells_exactly_what_the_buy_produced(uint128 amountIn) public {
        uint256 bought = buy(_tradeSize(amountIn, MIN_TRADE, MAX_TRADE));

        sell(uint128(bought));

        assertEq(lastSellTokens, uint128(bought));
    }

    /// And a sale this market cannot supply stops here rather than selling something else.
    ///
    /// HRBR was refused over the difference: an unbounded uint128 asked to sell 1.9e36 tokens
    /// of a market that does not contain them, the helper sold what there was, and the market
    /// answered for a fee that was 1% of a trade nobody made.
    /// Through one external hop, because vm.expectRevert watches the next call and the sell
    /// helper buys before it sells.
    function sellForTest(uint128 amountIn) external {
        sell(amountIn);
    }

    function test_an_impossible_sell_stops_rather_than_selling_something_else() public {
        vm.expectRevert(
            bytes(
                "sell size exceeds what this market can supply; clamp the fuzzed amount and assert against lastSellTokens"
            )
        );

        this.sellForTest(type(uint128).max);
    }

    /// A seller holding nothing still sells the whole amount it asked for.
    ///
    /// This is the shape that failed with "0 != 10000000000000000". The suite asked to
    /// sell 1e18 and asserted a 1% fee of 1e16; the helper bought a millionth of an ether
    /// of tokens, sold that dust instead, and the market was blamed for the fee that
    /// followed. The market had been charging its fee correctly the whole time.
    function test_a_sell_from_nothing_still_sells_the_whole_amount() public {
        // Calibrated rather than guessed: the old helper bought exactly one MIN_TRADE
        // before selling, so ask for more than that buys and the shrink is unavoidable.
        // A fixed number cannot express this — how many tokens a millionth of an ether
        // buys depends on the opening price, which is why the original suite failed at
        // 1e18 on a market where this fixture would not have.
        buyAsWith(OTHER_TRADER, MIN_TRADE, 0, "");
        uint128 wanted = uint128(tokenBalance(OTHER_TRADER)) * 4;

        assertEq(tokenBalance(TRADER), 0);

        sell(wanted);

        assertEq(lastSellTokens, wanted);
    }

    /// Exact in the other direction too: a small sell is not rounded up to a floor.
    function test_a_small_sell_is_not_rounded_up() public {
        sell(100);

        assertEq(lastSellTokens, 100);
    }
}
`,
        },
      ]);

      // Fuzzed rather than shallow: the two fuzz cases below are the point of this run,
      // and one run apiece would not have caught what they exist to catch.
      const result = await forgeTest({ root: workspace.root, depth: "all" });
      expect(result.buildFailure).toBeNull();
      expect(result.failed).toBe(0);
      expect(result.passed).toBe(8);

      // Actually fuzzed, rather than executed once and counted as a pass.
      const fuzzed = result.outcomes.filter((outcome) => (outcome.runs ?? 0) > 1);
      expect(fuzzed.map((outcome) => outcome.name).sort()).toEqual([
        "testFuzz_buys_always_move_tokens(uint128)",
        "testFuzz_sells_exactly_what_the_buy_produced(uint128)",
      ]);
    },
    180_000,
  );
});
