/**
 * The deterministic market deployment inherited by every generated behavior suite.
 *
 * The model does not write this file. It is rendered from the same implementation plan,
 * compiled ABIs and deployment resolver that build the production manifest, then the real
 * AgenFactory performs the launch inside Foundry. Generated tests inherit the result and
 * are limited to behavior: trades, time, callers and assertions.
 */

import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

import type { ContractArtifact } from "./artifacts.js";
import { materializeDeployment, type DeploymentEnvironment, type WiringIntent } from "./deployment.js";
import type { DeploymentSpecification } from "./deployment-spec.js";
import { deploymentSpecOrder } from "./deployment-spec.js";
import { ROLE, type ComponentDeployment, type ConstructorArgument } from "./manifest.js";
import { MINING_LIMIT, permissionBits } from "./mining.js";
import { deploymentOrder, type MarketComponent, type MarketImplementationPlan } from "./plan.js";
import type { GeneratedSource } from "./workspace.js";

const EXTERNAL = {
  poolManager: "0x0000000000000000000000000000000000001001",
  installer: "0x0000000000000000000000000000000000001002",
  creator: "0x0000000000000000000000000000000000001003",
  feeReceiver: "0x0000000000000000000000000000000000001004",
  agenRouter: "0x0000000000000000000000000000000000001005",
} as const satisfies Record<string, Address>;

const ACTORS = {
  creator: "address(uint160(0xA11CE))",
  feeReceiver: "address(uint160(0xFEE))",
  treasury: "address(uint160(0x7A3A))",
  beneficiary: "address(uint160(0xBE7E))",
  recipient: "address(uint160(0xEC17))",
  trader: "address(uint160(0xB0B))",
  otherTrader: "address(uint160(0xCAFE))",
} as const;

export const CANONICAL_TEST_BASE = "test/MarketTestBase.sol";
export const CANONICAL_TEST_SMOKE = "test/MarketTestEnvironment.t.sol";

export interface CanonicalTestEnvironmentInput {
  readonly plan: MarketImplementationPlan;
  readonly artifacts: readonly ContractArtifact[];
  readonly name: string;
  readonly symbol: string;
  readonly supplyTokens: bigint;
  readonly lpFee: number;
  readonly initialTick: number;
  readonly marketSalt: Hex;
  /**
   * How this market is deployed, as the architecture stage declared it.
   *
   * The fixture executes exactly this. It has no opinion of its own about which address
   * belongs in which constructor slot, which is the difference between a test that proves
   * a launch and one that proves a launch nobody will perform.
   */
  readonly deployment: DeploymentSpecification;
}

export interface CanonicalTestEnvironment {
  readonly source: GeneratedSource;
  readonly smoke: GeneratedSource;
  readonly guidance: string;
  /**
   * The CREATE2 salt each component is deployed under, so a launch failure can name it.
   *
   * `AgenDeployer` reverts with `DeploymentFailed(salt)` and nothing else — a reverting
   * constructor and oversized code both arrive as the zero address, and the reason does
   * not bubble up. A repair round handed only that hash is a round spent asking a model
   * to fix a market it has not been told the name of.
   */
  readonly componentSalts: readonly ComponentSalt[];
  /**
   * How the launch will construct and wire this bundle, in words.
   *
   * The one thing a deployability repair was never told. A market that reverts during
   * wiring is a market whose own expectation and the launcher's placement disagree, and
   * a model shown only the revert has to guess which address it was handed — a live
   * TEST001 build guessed, changed a parameter's type in the hope that the launcher
   * would notice, and spent its round on a change that could not have worked. Handing
   * over the placement turns that guess into a comparison.
   */
  readonly placement: readonly string[];
}

export interface ComponentSalt {
  readonly componentId: string;
  readonly contractName: string;
  readonly salt: Hex;
}

/** The creator the fixture launches as, as `MarketTestBase` spells it. */
const FIXTURE_CREATOR = "0x00000000000000000000000000000000000a11ce" as const;

/**
 * The salt `MarketTestBase` computes, computed the same way here.
 *
 * Must stay byte-identical to the Solidity above — `keccak256(abi.encode(CREATOR,
 * MARKET_SALT, "<id>"))`, with the id encoded as a dynamic string. A drift between the
 * two would silently stop naming the component that failed.
 */
function componentSaltFor(marketSalt: Hex, componentId: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "string" }],
      [FIXTURE_CREATOR, marketSalt, componentId],
    ),
  );
}

/**
 * Rewrite a launch revert so it names the contract rather than a hash.
 *
 * Returns the reason unchanged when it carries no salt this market recognises.
 */
export function nameLaunchFailure(
  reason: string,
  componentSalts: readonly ComponentSalt[],
): string {
  return reason.replace(/DeploymentFailed\((0x[0-9a-fA-F]{64})\)/g, (whole, salt: string) => {
    const component = componentSalts.find(
      (entry) => entry.salt.toLowerCase() === salt.toLowerCase(),
    );
    if (component === undefined) return whole;

    return (
      `${whole} — ${component.contractName}'s constructor reverted, or its deployed ` +
      `bytecode exceeds the 24576-byte contract size limit. Nothing else can make ` +
      `CREATE2 return the zero address.`
    );
  });
}

/**
 * Render the launch fixture. Constructor placement and post-deployment wiring come from
 * `resolveDeployment`; this module only translates those settled semantics to Solidity
 * expressions whose PoolManager, factory and router addresses are known at test runtime.
 */
function canonicalSmokeSource(): GeneratedSource {
  return {
    path: CANONICAL_TEST_SMOKE,
    content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CanonicalHookMiner, MarketTestBase} from "./MarketTestBase.sol";

/// @dev Deterministic preflight: behavior tests are not generated until this launch passes.
contract MarketTestEnvironmentTest is MarketTestBase {
    function test_canonical_launch_is_ready() public view {
        assertEq(address(agenRouter).code.length > 0, true);
        assertTrue(address(token).code.length > 0);
        assertTrue(address(hook).code.length > 0);
        assertEq(launchedMarket.creator, CREATOR);
        assertEq(launchedMarket.token, address(token));
        assertEq(launchedMarket.hook, address(hook));
        assertEq(keccak256(abi.encode(key)), launchedMarket.poolId);
        assertEq(address(key.hooks), address(hook));
        assertEq(key.fee, MARKET_LP_FEE);
        assertEq(token.allowance(TRADER, address(agenRouter)), type(uint256).max);
    }

    /// A second search after the v4 stack is already in memory. The leaky miner
    /// died here with MemoryOOG; this must return an address, not run out of heap.
    function test_hook_miner_does_not_grow_memory() public pure {
        (address mined,) = CanonicalHookMiner.findFromInitcode(
            address(uint160(0xA6E4)),
            uint160(0x3FFF),
            bytes32(uint256(1)),
            hex"600160005260206000f3"
        );
        assertTrue(uint160(mined) & 0x3FFF == 0x3FFF);
    }
}
`,
  };
}

export function canonicalTestEnvironment(
  input: CanonicalTestEnvironmentInput,
): CanonicalTestEnvironment {
  const artifacts = artifactsFor(input.artifacts);

  /**
   * The same materializer production uses, against test addresses.
   *
   * This fixture used to call the resolver and so inherited every one of its guesses,
   * which is why a market could pass its behaviour tests and then be launched differently:
   * two callers of one inference engine agree only for as long as they are handed the same
   * contracts. Now both execute the declared deployment and the only thing that differs is
   * which addresses the symbols resolve to.
   */
  const resolved = materializeDeployment({
    spec: input.deployment,
    artifacts: input.artifacts,
    environment: {
      poolManager: EXTERNAL.poolManager,
      installer: EXTERNAL.installer,
      creator: EXTERNAL.creator,
      feeReceiver: EXTERNAL.feeReceiver,
      agenRouter: EXTERNAL.agenRouter,
      // As production sets them: Agen's launch screen names one destination, so a market
      // asking for a treasury or a beneficiary is told the same address there and here.
      // Distinct placeholders would make this fixture prove a launch production cannot do.
      treasury: EXTERNAL.feeReceiver,
      beneficiary: EXTERNAL.feeReceiver,
      name: input.name,
      symbol: input.symbol,
      supplyTokens: input.supplyTokens,
    },
  });

  const byId = new Map(input.plan.components.map((component) => [component.id, component]));
  const ordered = deploymentSpecOrder(input.deployment).map((component) => {
    const planned = byId.get(component.componentId);
    if (planned === undefined) {
      throw new Error(
        `cannot build the canonical test environment: the deployment names ${component.componentId}, which is not in the plan`,
      );
    }
    return planned;
  });

  const deployment = new Map(resolved.deployments.map((entry) => [entry.componentId, entry]));
  const index = new Map(ordered.map((component, componentIndex) => [component.id, componentIndex]));
  const tokenIndex = roleIndex(ordered, "token");
  const hookIndex = roleIndex(ordered, "hook");
  const fields = componentFields(ordered);

  const imports = ordered.map((component) => {
    const artifact = artifacts.get(component.contractName);
    if (artifact === undefined) {
      throw new Error(`cannot build the canonical test environment: no artifact for ${component.contractName}`);
    }
    return `import {${component.contractName}} from "../${artifact.sourcePath}";`;
  });

  const componentBuilders = ordered.flatMap((component, componentIndex) => {
    const artifact = artifacts.get(component.contractName)!;
    const constructor = deployment.get(component.id);
    const values = constructor?.argumentValues ?? [];
    const types = constructor?.argumentTypes ?? [];
    const args = values.map((value, argumentIndex) =>
      solidityArgument(value, types[argumentIndex] ?? "", index),
    );
    const initCode =
      args.length === 0
        ? `type(${component.contractName}).creationCode`
        : `abi.encodePacked(type(${component.contractName}).creationCode, abi.encode(${args.join(", ")}))`;
    const role = ROLE[component.role] ?? ROLE["other"]!;

    // Each component's locals live in their own block.
    //
    // Three of them at function scope is nine live stack slots on top of everything
    // else this function holds, and the legacy code generator runs out at sixteen: an
    // ordinary three-component market compiled its own contracts and then failed with
    // "Stack too deep" inside Agen's fixture, reported to the creator as an Agen
    // infrastructure failure. Braces end each variable's life at the closing one, so
    // the slots are reused and the cost no longer grows with the bundle.
    if (component.role === "hook") {
      const flags = permissionBits(component.hookPermissions ?? []);
      return [
        "        {",
        `            bytes memory initCode = ${initCode};`,
        `            (address expected, bytes32 salt) = CanonicalHookMiner.findFromInitcode(`,
        `                address(agenDeployer),`,
        `                uint160(${flags.toString()}),`,
        `                keccak256(abi.encode(CREATOR, MARKET_SALT, "${component.id}")),`,
        `                initCode`,
        `            );`,
        `            components[${String(componentIndex)}] = AgenFactory.Component({`,
        `                salt: salt,`,
        `                expected: expected,`,
        `                role: ${String(role)},`,
        `                initCode: initCode`,
        "            });",
        "        }",
        "",
      ];
    }

    return [
      "        {",
      `            bytes memory initCode = ${initCode};`,
      `            bytes32 salt = keccak256(abi.encode(CREATOR, MARKET_SALT, "${component.id}"));`,
      `            components[${String(componentIndex)}] = AgenFactory.Component({`,
      `                salt: salt,`,
      `                expected: agenDeployer.computeAddress(salt, keccak256(initCode)),`,
      `                role: ${String(role)},`,
      `                initCode: initCode`,
      "            });",
      "        }",
      "",
    ];
  });

  const poolWiring = resolved.wiring.some((intent) => "poolId" in intent);
  const wiring = resolved.wiring.flatMap((intent, wiringIndex) =>
    renderWiring(intent, wiringIndex, index),
  );

  // The launch's own parties first, so a market that pays a wallet directly is covered
  // whether or not it deploys anything to hold the money.
  const accountExpressions = [
    "FEE_RECEIVER",
    "CREATOR",
    ...ordered
      .filter((component) => component.role !== "token" && component.role !== "hook")
      .map((component) => `address(${fields.get(component.id)!})`),
  ];

  const declarations = ordered.map(
    (component) => `    ${component.contractName} internal ${fields.get(component.id)!};`,
  );
  const assignments = ordered.map(
    (component, componentIndex) =>
      `        ${fields.get(component.id)!} = ${component.contractName}(payable(deployed[${String(componentIndex)}].addr));`,
  );

  const source = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {AgenDeployer} from "agen-protocol/AgenDeployer.sol";
import {AgenFactory} from "agen-protocol/AgenFactory.sol";
import {AgenMarketRegistry} from "agen-protocol/AgenMarketRegistry.sol";
import {AgenRouter} from "agen-protocol/AgenRouter.sol";

import {AgenTest} from "./AgenTest.sol";
${imports.join("\n")}

library CanonicalHookMiner {
    uint160 internal constant FLAG_MASK = 0x3FFF;
    uint256 internal constant MAX_LOOP = ${String(MINING_LIMIT)};

    error NoSaltFound(uint160 targetFlags, uint256 tried);

    /**
     * Same salt rule as mining.ts, without growing memory.
     *
     * The first version of this loop used abi.encode and abi.encodePacked on every
     * candidate. Solidity never reclaims that memory, Foundry caps EVM memory at
     * 128MB, and a 14-bit permission search plus the Uniswap v4 stack sat against
     * that cap. The visible failure was setUp(): EvmError: MemoryOOG — before any
     * generated behavior test ran, on markets whose contracts were fine.
     *
     * Scratch space (0x00..0x5f) is overwritten in place. The free-memory pointer
     * is restored so later Solidity allocations in setUp still see a sane heap.
     */
    function findFromInitcode(
        address deployer,
        uint160 targetFlags,
        bytes32 namespace,
        bytes memory initcode
    )
        internal
        pure
        returns (address hookAddress, bytes32 salt)
    {
        bytes32 initCodeHash = keccak256(initcode);

        assembly {
            let free := mload(0x40)
            let i := 0
            for {} lt(i, MAX_LOOP) { i := add(i, 1) } {
                mstore(0x00, namespace)
                mstore(0x20, i)
                let candidate := keccak256(0x00, 0x40)

                mstore(0x00, deployer)
                mstore8(0x0b, 0xff)
                mstore(0x20, candidate)
                mstore(0x40, initCodeHash)
                let computed := and(keccak256(0x0b, 0x55), 0xffffffffffffffffffffffffffffffffffffffff)

                if eq(and(computed, FLAG_MASK), targetFlags) {
                    mstore(0x40, free)
                    hookAddress := computed
                    salt := candidate
                    break
                }
            }
            mstore(0x40, free)
        }

        if (hookAddress == address(0)) revert NoSaltFound(targetFlags, MAX_LOOP);
    }
}

abstract contract MarketTestBase is AgenTest {
    using PoolIdLibrary for PoolKey;

    // Every role is a different address, because production's are. Aliasing the fee
    // receiver to the creator made a whole class of launch failure untestable: two
    // components resolving "the money address" differently agree perfectly when both
    // answers are the same wallet, and revert during wiring when they are not.
    address internal constant CREATOR = ${ACTORS.creator};
    address internal constant FEE_RECEIVER = ${ACTORS.feeReceiver};
    address internal constant TREASURY = ${ACTORS.treasury};
    address internal constant BENEFICIARY = ${ACTORS.beneficiary};
    address internal constant RECIPIENT = ${ACTORS.recipient};
    address internal constant TRADER = ${ACTORS.trader};
    address internal constant OTHER_TRADER = ${ACTORS.otherTrader};

    uint24 internal constant MARKET_LP_FEE = ${String(input.lpFee)};
    int24 internal constant MARKET_INITIAL_TICK = ${String(input.initialTick)};
    bytes32 internal constant MARKET_SALT = ${input.marketSalt};

    /**
     * The band inside which a trade is a trade.
     *
     * A fuzzer handed a raw uint128 spends most of its budget on numbers that cannot buy
     * anything: zero, which the router refuses outright, and one wei, which rounds to
     * zero tokens out and then fails any honest assertion that the market did something.
     * Neither says anything about the rules the market was built to enforce, and a whole
     * class of "1 fuzz test failed / assertion failed: 0 <= 0" came from nothing else.
     *
     * The floor is deliberately tiny rather than comfortable. Anything an amount is
     * clamped to is an amount the test did not ask for, so the only safe floor is the
     * smallest one that still buys a non-zero number of tokens — a generous floor would
     * quietly move a deliberate small trade across whatever threshold the market's own
     * rules care about. The ceiling stays well inside the opening bands, so a trade
     * cannot fail for having exhausted the launch liquidity either.
     */
    uint128 internal constant MIN_TRADE = 0.000001 ether;
    uint128 internal constant MAX_TRADE = 10 ether;

    /**
     * Clamped, never wrapped.
     *
     * forge-std's bound is the reflex here and it is wrong for this: it maps an
     * out-of-range value across the whole band, so a test asking for a fraction of the
     * floor gets
     * something near the ceiling. A test that says "buy a little" has to buy a little.
     */
    function _tradeSize(uint128 amount, uint128 low, uint128 high)
        internal
        pure
        returns (uint128)
    {
        if (amount < low) return low;
        if (amount > high) return high;
        return amount;
    }

    /// The number of tokens the last sell put into the pool: its input, never its proceeds.
    ///
    /// Named for the unit because the ambiguity cost a launch. STREAK's suite read it as "the
    /// output delivered to the trader after the hook fee", reconstructed a gross amount from
    /// it, and asserted a 0.5% fee against a base that was never the base — on a market that
    /// charges exactly 0.5%, which Agen's own core test proved in the same run.
    uint128 internal lastSellTokens;

    PositionManager internal positionManager;
    AgenRouter internal agenRouter;
    AgenDeployer internal agenDeployer;
    AgenMarketRegistry internal registry;
    AgenFactory internal factory;
    AgenMarketRegistry.Market internal launchedMarket;
    PoolKey internal key;

${declarations.join("\n")}

    function setUp() public {
        deployPoolManager();
        agenRouter = new AgenRouter(manager);
        positionManager = new PositionManager(
            manager,
            IAllowanceTransfer(address(0)),
            300_000,
            IPositionDescriptor(address(0)),
            IWETH9(address(0))
        );

        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        agenDeployer = new AgenDeployer(predictedFactory);
        registry = new AgenMarketRegistry(predictedFactory);
        factory = new AgenFactory(manager, positionManager, agenDeployer, registry);
        assertEq(address(factory), predictedFactory, "canonical factory prediction");

        vm.deal(CREATOR, 1_000 ether);
        vm.deal(FEE_RECEIVER, 1_000 ether);
        vm.deal(TRADER, 1_000 ether);
        vm.deal(OTHER_TRADER, 1_000 ether);

        AgenFactory.Manifest memory manifest = _marketManifest();
        vm.prank(CREATOR);
        uint256 marketIndex = factory.deployMarket(manifest);

        launchedMarket = registry.marketAt(marketIndex);
        AgenMarketRegistry.Component[] memory deployed = registry.componentsAt(marketIndex);
${assignments.join("\n")}
        key = factory.poolKeyFor(address(0), launchedMarket.token, MARKET_LP_FEE, launchedMarket.hook);

        _approveRouter(CREATOR);
        _approveRouter(FEE_RECEIVER);
        _approveRouter(TRADER);
        _approveRouter(OTHER_TRADER);
    }

    function _marketManifest() private view returns (AgenFactory.Manifest memory manifest) {
        AgenFactory.Component[] memory components = new AgenFactory.Component[](${String(ordered.length)});
${componentBuilders.join("\n")}
${poolWiring ? `        PoolKey memory predictedKey = factory.poolKeyFor(address(0), components[${String(tokenIndex)}].expected, MARKET_LP_FEE, components[${String(hookIndex)}].expected);\n        bytes32 predictedPoolId = PoolId.unwrap(predictedKey.toId());\n` : ""}
        AgenFactory.WiringCall[] memory wiring = new AgenFactory.WiringCall[](${String(resolved.wiring.length)});
${wiring.join("\n")}
        manifest = AgenFactory.Manifest({
            specificationHash: keccak256("canonical test specification"),
            implementationHash: keccak256("canonical test implementation"),
            metadataURI: "agen://canonical-test",
            quoteAsset: address(0),
            lpFee: MARKET_LP_FEE,
            initialTick: MARKET_INITIAL_TICK,
            feeReceiver: FEE_RECEIVER,
            devBuyAmount: 0,
            devBuyMinTokens: 0,
            hookIndex: ${String(hookIndex)},
            tokenIndex: ${String(tokenIndex)},
            components: components,
            wiring: wiring
        });
    }

    function buy(uint128 amountIn) internal returns (uint256 amountOut) {
        return buyAsWith(TRADER, amountIn, 0, "");
    }

    function buyWith(uint128 amountIn, uint128 minAmountOut, bytes memory hookData)
        internal
        returns (uint256 amountOut)
    {
        return buyAsWith(TRADER, amountIn, minAmountOut, hookData);
    }

    function buyAs(address trader, uint128 amountIn) internal returns (uint256 amountOut) {
        return buyAsWith(trader, amountIn, 0, "");
    }

    /**
     * Every buy goes through here, and every buy is a tradable size by the time it does.
     *
     * The clamp is the point. A fuzzed uint128 is zero or dust far more often than it is
     * a trade, and both outcomes fail a correct test of a correct market — the router
     * rejects a zero and dust rounds to nothing out. Doing it in the caller would be the
     * generated test doing arithmetic on its own inputs, which is exactly the plumbing
     * this base exists to own, so it happens once, here, for fuzzed and fixed amounts
     * alike. An amount already inside the band is passed through untouched.
     */
    function buyAsWith(
        address trader,
        uint128 amountIn,
        uint128 minAmountOut,
        bytes memory hookData
    ) internal returns (uint256 amountOut) {
        uint128 spend = _tradeSize(amountIn, MIN_TRADE, MAX_TRADE);

        vm.deal(trader, trader.balance + spend);
        vm.prank(trader);
        amountOut = agenRouter.swap{value: spend}(key, true, spend, minAmountOut, hookData);
        _approveRouter(trader);
    }

    function sell(uint128 amountIn) internal returns (uint256 amountOut) {
        return sellAsWith(TRADER, amountIn, 0, "");
    }

    function sellWith(uint128 amountIn, uint128 minAmountOut, bytes memory hookData)
        internal
        returns (uint256 amountOut)
    {
        return sellAsWith(TRADER, amountIn, minAmountOut, hookData);
    }

    function sellAs(address trader, uint128 amountIn) internal returns (uint256 amountOut) {
        return sellAsWith(trader, amountIn, 0, "");
    }

    /**
     * Sell the amount that was asked for, having first made the seller hold it.
     *
     * The seller is funded, rather than the sale being shrunk to fit. This is the whole
     * difference between a helper and a trap: shrinking is silent, and a test that says
     * 'sell(1e18)' and then asserts a 1% fee of 1e16 is correct arithmetic about a trade
     * that never happened. That exact suite failed with '0 != 10000000000000000' — the
     * market was charging its fee properly, on the dust the seller had been left with.
     *
     * So the shortfall is bought first, escalating because the price moves as it does.
     * Every attainable amount, which is every amount a market's rules are actually about,
     * sells exactly — and an unattainable one now fails here rather than selling something
     * else, which is the last place this trap was still open. See _acquireForSale.
     */
    function sellAsWith(
        address trader,
        uint128 amountIn,
        uint128 minAmountOut,
        bytes memory hookData
    ) internal returns (uint256 amountOut) {
        uint128 size = _acquireForSale(trader, amountIn);
        lastSellTokens = size;

        vm.prank(trader);
        return agenRouter.swap(key, false, size, minAmountOut, hookData);
    }

    /**
     * Buy until the seller holds what it is about to be asked to sell.
     *
     * A request this market cannot supply stops the test instead of selling a smaller amount.
     * Silently shrinking it is how HRBR was lost — "1% fee on every sell, buys are free", a
     * market that charged exactly that. Its suite fuzzed an unbounded uint128, asked to sell
     * 1.9e36 tokens of a market that does not contain them, and asserted the fee was 1% of
     * that. The fee it got was 1% of what could actually be sold, the assertion failed, and
     * deep validation reported that the market breaks under search. The market was right; the
     * trade never happened.
     *
     * The message names the fix, because it is the one a repair has to make: clamp the fuzzed
     * size before trading, the way Agen's own core suite does.
     */
    function _acquireForSale(address trader, uint128 wanted) private returns (uint128) {
        uint128 target = wanted == 0 ? 1 : wanted;
        uint128 spend = MIN_TRADE;

        while (tokenBalance(trader) < target) {
            buyAsWith(trader, spend, 0, "");
            if (spend >= MAX_TRADE) break;
            spend = spend > MAX_TRADE / 4 ? MAX_TRADE : spend * 4;
        }

        require(
            target <= tokenBalance(trader),
            "sell size exceeds what this market can supply; clamp the fuzzed amount and assert against lastSellTokens"
        );

        return target;
    }

    function tokenBalance(address account) internal view returns (uint256) {
        return IERC20(launchedMarket.token).balanceOf(account);
    }

    /// The token's immutable total supply, which a size threshold measured against
    /// supply has to be compared with.
    function tokenSupply() internal view returns (uint256) {
        return IERC20(launchedMarket.token).totalSupply();
    }

    /**
     * Every account a fee may legitimately end up in.
     *
     * This market's own contracts, minus the token and the hook, plus the parties the
     * launch names. The hook is left out deliberately: a hook holding value is a finding
     * rather than a destination, and a sum that included it would report a market that
     * cannot pay anybody as one that collected correctly.
     *
     * Summing rather than naming one address is what makes a test of "the fee was taken"
     * survive a change of architecture. Whether a sell fee lands in a vault, in an
     * accounting contract or straight in the receiver's wallet is the design's business;
     * that it left the trader and arrived somewhere this market controls is not.
     */
    function _marketAccounts() internal view returns (address[] memory accounts) {
        accounts = new address[](${String(accountExpressions.length)});
${accountExpressions.map((expression, at) => `        accounts[${String(at)}] = ${expression};`).join("\n")}
    }

    /// This market's total token holdings, across every account a fee can reach.
    function _collectedTokens() internal view returns (uint256 total) {
        address[] memory accounts = _marketAccounts();
        for (uint256 at = 0; at < accounts.length; at++) total += tokenBalance(accounts[at]);
    }

    /// The same, in ether, for a market that takes its fee on the currency in.
    function _collectedEther() internal view returns (uint256 total) {
        address[] memory accounts = _marketAccounts();
        for (uint256 at = 0; at < accounts.length; at++) total += accounts[at].balance;
    }

    function _approveRouter(address account) private {
        vm.prank(account);
        IERC20(launchedMarket.token).approve(address(agenRouter), type(uint256).max);
    }
}
`;

  const componentApi = ordered.map(
    (component) =>
      `  ${fields.get(component.id)!}: ${component.contractName} (${component.role}, already deployed and wired)`,
  );

  return {
    source: { path: CANONICAL_TEST_BASE, content: source },
    smoke: canonicalSmokeSource(),
    componentSalts: ordered.map((component) => ({
      componentId: component.id,
      contractName: component.contractName,
      salt: componentSaltFor(input.marketSalt, component.id),
    })),
    placement: describePlacement({
      ordered,
      deployment,
      wiring: resolved.wiring,
      artifacts,
    }),
    guidance: `THE MARKET IS ALREADY DEPLOYED. Import and inherit the deterministic base:

    import {MarketTestBase} from "./MarketTestBase.sol";

    contract MyMarketBehaviorTest is MarketTestBase {
        function test_theRule() public {
            // call buy, sell or the generated component, then assert behavior
        }
    }

Do not declare setUp and do not deploy, initialize, wire, fund or approve anything. The
base launches the bundle through the real AgenFactory using the settled deployment plan,
the production PoolKey fee mode and opening tick, the production three-band liquidity,
and the canonical AgenRouter. Constructor roles are deterministic and non-zero.

Available actors:
  CREATOR, FEE_RECEIVER, TREASURY, BENEFICIARY, RECIPIENT, TRADER, OTHER_TRADER

Fee money arrives at FEE_RECEIVER, never at CREATOR. A specification that says fees go
"to the creator" still means FEE_RECEIVER here: the launch binds every fee destination
to it, and it is a different account from CREATOR on purpose, so that a market which
confuses the two is caught by a test instead of by whoever was owed the money. Assert
against FEE_RECEIVER, or against the component the deployment actually pays.

Available market state:
  key, launchedMarket, factory, registry, agenRouter
${componentApi.join("\n")}

Behavior helpers:
  buy(uint128 amountIn) -> uint256 amountOut
  buyWith(uint128 amountIn, uint128 minAmountOut, bytes hookData) -> uint256 amountOut
  buyAs(address trader, uint128 amountIn) -> uint256 amountOut
  buyAsWith(address trader, uint128 amountIn, uint128 minAmountOut, bytes hookData) -> uint256 amountOut
  sell(uint128 amountIn) -> uint256 amountOut
  sellWith(uint128 amountIn, uint128 minAmountOut, bytes hookData) -> uint256 amountOut
  sellAs(address trader, uint128 amountIn) -> uint256 amountOut
  sellAsWith(address trader, uint128 amountIn, uint128 minAmountOut, bytes hookData) -> uint256 amountOut
  tokenBalance(address account) -> uint256
  tokenSupply() -> uint256

The helpers own trader funding, router identity, approvals, settlement and trade size.
Generated tests own only the sequence and the assertions that prove this market's rules.

sell(n) sells exactly n tokens. The seller is bought into the position first, so a sell
needs no set-up and no prior buy, and arithmetic about the amount sold is arithmetic
about n — assert a 1% fee on sell(1e18) as 1e16 and it holds.

buy(n) spends exactly n of the quote asset for any n between 0.000001 and 10 ether, and
the trader is funded for it. Outside that band the amount is moved to the nearest edge,
so do not compute an expected result from an n you did not keep inside it; a buy of one
wei is not a trade any market has an opinion about.

Fuzz freely on the buy side. A raw uint128 can go straight into buy: it is never zero and
never dust by the time it trades.

A sell is different, because tokens have to exist before they can be sold. Sell what a buy
produced — sell(uint128(buy(_tradeSize(size, MIN_TRADE, MAX_TRADE)))) — and compute what
you expect from lastSellTokens, which is the number of tokens that sell put into the pool —
its input, not the ether the trader received back. Asking to sell more
than this market can supply stops the test rather than selling a smaller amount, so a raw
uint128 passed straight to sell will fail: 3.4e38 tokens is more than any market holds, and
nothing can be asserted about a fee on a trade that cannot happen.

Never reject a fuzz input. Do not use vm.assume and do not skip a case with an early
return — a fuzz test that throws inputs away either exhausts the fuzzer's rejection
budget and fails outright, or quietly stops testing the market. Anything that is not a
trade amount, a loop count for instance, is yours to bound with bound(x, min, max).`,
  };
}

function artifactsFor(artifacts: readonly ContractArtifact[]): ReadonlyMap<string, ContractArtifact> {
  return new Map(artifacts.map((artifact) => [artifact.contractName, artifact]));
}

function roleIndex(components: readonly MarketComponent[], role: string): number {
  const index = components.findIndex((component) => component.role === role);
  if (index < 0) throw new Error(`cannot build the canonical test environment without a ${role}`);
  return index;
}

function componentFields(components: readonly MarketComponent[]): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const component of components) {
    const field =
      component.role === "token"
        ? "token"
        : component.role === "hook"
          ? "hook"
          : `component_${component.id}`;
    fields.set(component.id, field);
  }
  return fields;
}

function solidityArgument(
  argument: ConstructorArgument,
  type: string,
  indices: ReadonlyMap<string, number>,
): string {
  if (argument.kind === "component") {
    const index = indices.get(argument.componentId);
    if (index === undefined) throw new Error(`constructor references unknown component ${argument.componentId}`);
    return `components[${String(index)}].expected`;
  }

  if (argument.kind === "external") {
    const address = argument.address.toLowerCase();
    if (address === EXTERNAL.poolManager) return "address(manager)";
    if (address === EXTERNAL.installer) return "address(factory)";
    if (address === EXTERNAL.creator) return "CREATOR";
    if (address === EXTERNAL.feeReceiver) return "FEE_RECEIVER";
    if (address === EXTERNAL.agenRouter) return "address(agenRouter)";
    throw new Error(`deployment resolver returned an unknown external address ${argument.address}`);
  }

  if (typeof argument.value === "string") {
    if (type === "address") return argument.value;
    return `string(hex"${Buffer.from(argument.value, "utf8").toString("hex")}")`;
  }
  return String(argument.value);
}

/**
 * The launch, as a handful of sentences a repair round can check its assumptions against.
 *
 * Deliberately not Solidity. A model handed the fixture would read it as code to fix; the
 * fixture is Agen's and is not the model's to change. What it needs is the settled fact —
 * this argument gets that address — stated once, so it can see whether the contract's own
 * expectation matches.
 */
function describePlacement({
  ordered,
  deployment,
  wiring,
  artifacts,
}: {
  readonly ordered: readonly MarketComponent[];
  readonly deployment: ReadonlyMap<string, ComponentDeployment>;
  readonly wiring: readonly WiringIntent[];
  readonly artifacts: ReadonlyMap<string, ContractArtifact>;
}): readonly string[] {
  const names = new Map(ordered.map((component) => [component.id, component.contractName]));

  const lines = ordered.map((component) => {
    const placed = deployment.get(component.id);
    if (placed === undefined || placed.argumentValues.length === 0) {
      return `${component.contractName} is deployed with no constructor arguments.`;
    }

    const parameters =
      (
        (artifacts.get(component.contractName)?.abi as
          | readonly { type?: string; inputs?: { name?: string }[] }[]
          | undefined) ?? []
      ).find((entry) => entry.type === "constructor")?.inputs ?? [];

    const given = placed.argumentValues.map((argument, position) => {
      const parameter = parameters[position]?.name ?? `argument ${String(position + 1)}`;
      return `${parameter} = ${describeArgument(argument, names)}`;
    });

    return `${component.contractName} is deployed with ${given.join(", ")}.`;
  });

  const calls = wiring.map((intent) => {
    const on = `The launch then calls ${names.get(intent.componentId) ?? intent.componentId}.${intent.functionName}`;

    if ("poolId" in intent) return `${on} with the pool's id.`;
    if ("address" in intent) {
      return `${on} with ${describeArgument({ kind: "external", address: intent.address }, names)}.`;
    }
    return `${on} with the address of ${names.get(intent.targetComponentId) ?? intent.targetComponentId}.`;
  });

  return [...lines, ...calls];
}

function describeArgument(
  argument: ConstructorArgument,
  names: ReadonlyMap<string, string>,
): string {
  if (argument.kind === "component") {
    return `the address of ${names.get(argument.componentId) ?? argument.componentId}`;
  }

  if (argument.kind === "external") {
    const address = argument.address.toLowerCase();
    if (address === EXTERNAL.poolManager) return "the pool manager";
    if (address === EXTERNAL.installer) return "the factory, which is the installer";
    if (address === EXTERNAL.creator) return "the creator's wallet";
    if (address === EXTERNAL.feeReceiver) return "the fee receiver, a different wallet from the creator";
    if (address === EXTERNAL.agenRouter) return "the Agen router";
    return argument.address;
  }

  return typeof argument.value === "string" ? `"${argument.value}"` : String(argument.value);
}

/** A resolved launch address, as the name the fixture already declares for it. */
function solidityAddress(address: Address): string {
  const lowered = address.toLowerCase();
  if (lowered === EXTERNAL.poolManager) return "address(manager)";
  if (lowered === EXTERNAL.installer) return "address(factory)";
  if (lowered === EXTERNAL.creator) return "CREATOR";
  if (lowered === EXTERNAL.feeReceiver) return "FEE_RECEIVER";
  if (lowered === EXTERNAL.agenRouter) return "address(agenRouter)";
  throw new Error(`the deployment resolved an address the fixture cannot name: ${address}`);
}

function renderWiring(
  intent: WiringIntent,
  wiringIndex: number,
  indices: ReadonlyMap<string, number>,
): readonly string[] {
  const componentIndex = indices.get(intent.componentId);
  if (componentIndex === undefined) throw new Error(`wiring references unknown component ${intent.componentId}`);

  let type: string;
  let value: string;
  if ("poolId" in intent) {
    type = "bytes32";
    value = "predictedPoolId";
  } else if ("address" in intent) {
    // A launch address rather than a sibling: the fee receiver told to the accounting
    // contract after deployment, for instance. Rendered as the fixture's own constant so
    // the Solidity reads the way the deployment does.
    type = "address";
    value = solidityAddress(intent.address);
  } else {
    const targetIndex = indices.get(intent.targetComponentId);
    if (targetIndex === undefined) {
      throw new Error(`wiring references unknown component ${intent.targetComponentId}`);
    }
    type = "address";
    value = `components[${String(targetIndex)}].expected`;
  }

  return [
    `        wiring[${String(wiringIndex)}] = AgenFactory.WiringCall({`,
    `            componentIndex: uint16(${String(componentIndex)}),`,
    `            data: abi.encodeWithSignature("${intent.functionName}(${type})", ${value})`,
    "        });",
  ];
}

/**
 * One forbidden shape, and whether a revert expectation excuses it.
 *
 * `provable` marks the actions a test legitimately performs in order to prove it is not
 * allowed to. A suite standing behind "the fee receiver is never the zero address" writes
 * `vm.expectRevert(); hook.setFeeReceiver(address(0));` — that call is the proof the guard
 * exists, and reading it as an attempt to wire the market by hand refused SIMPLE's entire
 * suite twice over the only test covering that invariant. The same is true of the ordinary
 * security test that a hook callback rejects every caller but the pool manager.
 *
 * Nothing else is excused. Deploying a PoolManager or mining an address is not made sensible
 * by expecting it to revert, so those keep matching wherever they appear.
 */
interface ForbiddenShape {
  readonly pattern: RegExp;
  readonly message: string;
  /** Whether the same call under a revert expectation is a proof rather than a misuse. */
  readonly provable?: boolean;
}

const MANUAL_INFRASTRUCTURE: readonly ForbiddenShape[] = [
  { pattern: /\bfunction\s+setUp\s*\(/, message: "declares setUp instead of inheriting the canonical launch" },
  { pattern: /\bconstructor\s*\(/, message: "declares constructor setup in a generated test" },
  { pattern: /\bis\b[^{]*\bAgenTest\b/, message: "inherits AgenTest directly instead of MarketTestBase" },
  { pattern: /\bnew\s+[A-Z_]/, message: "deploys a contract manually" },
  { pattern: /\bdeployPoolManager\s*\(/, message: "deploys the PoolManager manually" },
  { pattern: /\bdeployToken\s*\(/, message: "deploys the token manually" },
  { pattern: /\bdeployHook\s*\(/, message: "deploys the hook manually" },
  { pattern: /\bdeployCode(?:To)?\s*\(/, message: "deploys bytecode manually" },
  { pattern: /\bcreate2?\s*\(/, message: "deploys bytecode manually" },
  { pattern: /\bopenMarket\s*\(/, message: "opens the pool manually" },
  { pattern: /\bswapExactIn\s*\(/, message: "bypasses the canonical AgenRouter helpers" },
  { pattern: /\bmarketKey\s*\(/, message: "constructs the market key manually" },
  { pattern: /\bagenPoolKey\s*\(/, message: "constructs a PoolKey manually" },
  { pattern: /\bPoolKey\s*\(\s*\{/, message: "constructs a PoolKey manually" },
  {
    pattern: /\bPoolKey\s+(?:memory|storage|calldata)\b/,
    message: "declares a separate PoolKey instead of using the canonical key",
  },
  { pattern: /\b(?:DYNAMIC_FEE_FLAG|OVERRIDE_FEE_FLAG)\b/, message: "selects a pool fee mode manually" },
  { pattern: /\bLPFeeLibrary\s*\./, message: "selects a pool fee mode manually" },
  { pattern: /\bTickMath\s*\./, message: "chooses launch-price geometry manually" },
  {
    pattern: /\b(?:LiquidityAmounts|SqrtPriceMath)\s*\./,
    message: "calculates launch liquidity or price geometry manually",
  },
  { pattern: /\bmanager\s*\.\s*initialize\s*\(/, message: "initializes the pool manually" },
  { pattern: /\bmanager\s*\.\s*(?:unlock|swap)\s*\(/, message: "bypasses the canonical router" },
  { pattern: /\bagenRouter\s*\.\s*swap(?:\s*\{|\s*\()/, message: "bypasses the canonical behavior helpers" },
  { pattern: /\b(?:swapRouter|liquidityRouter)\s*\./, message: "uses a non-canonical test router" },
  { pattern: /\bpositionManager\s*\./, message: "changes canonical launch liquidity manually" },
  { pattern: /\baddLiquidity\s*\(/, message: "seeds liquidity manually" },
  {
    pattern:
      /\.\s*(?:set|bind)(?:Hook|Vault|PoolId|Controller|Accounting|Router|FeeReceiver|Owner|Treasury|Beneficiary|Recipient|Installer)\s*\(/,
    message: "wires a deployment component manually",
    provable: true,
  },
  {
    pattern: /\bvm\s*\.\s*assume\s*\(/,
    message:
      "filters its own fuzz inputs with vm.assume; the trade helpers already bound them, " +
      "and assuming instead rejects runs until the fuzzer gives up",
  },
  { pattern: /\bvm\s*\.\s*deal\s*\(/, message: "funds an actor manually" },
  { pattern: /\b(?:deal|hoax|startHoax)\s*\(/, message: "funds or impersonates an actor manually" },
  { pattern: /\bVm\s+(?:internal\s+|private\s+|public\s+)?[A-Za-z_]\w*/, message: "aliases Foundry cheatcodes" },
  {
    pattern: /\bvm\s*\.\s*(?:etch|addr|computeCreate2?Address|getNonce)\s*\(/,
    message: "constructs deployment state or actor addresses manually",
  },
  { pattern: /\b(?:makeAddr|makeAddrAndKey)\s*\(/, message: "constructs an actor address manually" },
  { pattern: /\b(?:Create2|HookMiner)\s*\./, message: "mines or predicts a deployment address manually" },
  { pattern: /\.\s*approve\s*\(/, message: "manages a router allowance manually", provable: true },
  {
    pattern: /\btoken\s*\.\s*transfer(?:From)?\s*\(/,
    message: "moves launch supply manually",
    provable: true,
  },
  {
    pattern: /\.\s*(?:transferOwnership|renounceOwnership)\s*\(/,
    message: "changes launch ownership manually",
    provable: true,
  },
  {
    pattern: /\.\s*(?:before|after)Swap\s*\(/,
    message: "calls a hook callback directly",
    provable: true,
  },
  {
    pattern: /\b(?:factory|agenDeployer)\s*\.\s*(?:deployMarket|deploy|computeAddress|poolKeyFor)\s*\(/,
    message: "reconstructs canonical component deployment manually",
  },
];

/** Refuse model-authored launch plumbing before it reaches a compiler or repair budget. */
export function manualTestInfrastructureProblems(
  tests: readonly GeneratedSource[],
): readonly string[] {
  const problems: string[] = [];
  const combined = tests.map((test) => solidityCode(test.content)).join("\n");

  if (!/\bis\s+MarketTestBase\b/.test(combined)) {
    problems.push("no generated test contract inherits MarketTestBase");
  }
  if (!/\bfunction\s+(?:test\w*|invariant\w*)\s*\(/.test(combined)) {
    problems.push("generated test sources contain no executable behavior test");
  }

  for (const [path, found] of manualInfrastructureByFile(tests)) {
    problems.push(...found.map((problem) => `${path}: ${problem}`));
  }

  return problems;
}

/**
 * The same judgement, kept per file.
 *
 * Because one bad file in a suite of four is not a reason to lose a market. EMBR's suite was
 * refused entirely — twice, once per retry — because a single security test declared its own
 * `PoolKey` and poked the hook's callback directly. The other files were fine, Agen's core
 * suite was authoritative, and the market itself was never in question.
 *
 * The suite-wide checks stay in `manualTestInfrastructureProblems`: "nothing here inherits
 * MarketTestBase" is a property of the whole answer and has no file to blame.
 */
export function manualInfrastructureByFile(
  tests: readonly GeneratedSource[],
): ReadonlyMap<string, readonly string[]> {
  const byFile = new Map<string, readonly string[]>();

  for (const test of tests) {
    const problems: string[] = [];
    const normalizedPath = test.path.replaceAll("\\", "/").toLowerCase();

    if (
      normalizedPath === CANONICAL_TEST_BASE.toLowerCase() ||
      normalizedPath === CANONICAL_TEST_SMOKE.toLowerCase() ||
      normalizedPath === "test/agentest.sol"
    ) {
      byFile.set(test.path, ["attempts to replace canonical test infrastructure"]);
      continue;
    }

    const code = solidityCode(test.content);
    for (const header of code.matchAll(/\bcontract\s+([A-Za-z_]\w*)\s*([^{};]*)\{/g)) {
      const [, contractName, inheritance = ""] = header;
      if (contractName === "MarketTestBase") {
        problems.push("shadows the canonical MarketTestBase contract");
      } else if (!/\bis\b[^{};]*\bMarketTestBase\b/.test(inheritance)) {
        problems.push(`contract ${contractName ?? "unknown"} does not inherit MarketTestBase`);
      }
    }

    // A call a revert expectation covers is an assertion about a guard, not an attempt to
    // build infrastructure; see `ForbiddenShape.provable`.
    const proving = withoutGuardedCalls(code);
    for (const forbidden of MANUAL_INFRASTRUCTURE) {
      const subject = forbidden.provable === true ? proving : code;
      if (forbidden.pattern.test(subject)) problems.push(forbidden.message);
    }

    if (problems.length > 0) byFile.set(test.path, problems);
  }

  return byFile;
}

/**
 * The code with every call a revert expectation covers removed.
 *
 * Foundry's `vm.expectRevert` applies to the next call, so the line carrying the expectation
 * and the line after it are what a negative test is made of. Removing both leaves the code a
 * test would have if it only ever did what it is allowed to do, which is what the `provable`
 * shapes are matched against.
 */
function withoutGuardedCalls(code: string): string {
  const lines = code.split("\n");
  const kept = [...lines];

  for (const [index, line] of lines.entries()) {
    if (!/\bvm\s*\.\s*expectRevert\b/.test(line)) continue;

    // The expectation itself, which may carry the call on the same line.
    kept[index] = "";

    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next]?.trim() === "") continue;
      kept[next] = "";
      break;
    }
  }

  return kept.join("\n");
}

function solidityCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}
