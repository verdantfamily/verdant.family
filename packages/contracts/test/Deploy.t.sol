// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {FactoryOrigin} from "../src/FactoryOrigin.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {VerdantFactory} from "../src/VerdantFactory.sol";
import {VerdantToken} from "../src/VerdantToken.sol";
import {LaunchBounds} from "../src/libraries/LaunchBounds.sol";
import {ScheduleLib} from "../src/libraries/ScheduleLib.sol";
import {InjectedDeployHarness} from "./utils/DeployHarness.sol";

/// @title The deployment, as a test
/// @notice Runs `script/Deploy.s.sol` and then launches a market through what it
/// produced.
///
/// @dev A Verdant deployment cannot be corrected. The hook's address is mined and its
/// permissions are read from it by v4 on every call; the factory, the registries and
/// the deployer are wired to each other in immutables; the anchor can create once. A
/// mistake is not patched, it is abandoned and redone under new addresses, with any
/// markets created in between stranded on the wrong factory.
///
/// So the deployment script is treated as protocol code and tested like it. This is
/// the test that makes `FactoryOrigin` worth its existence: because no address in the
/// script comes from an operator's transaction count, the sequence here is the same
/// arithmetic as the sequence on mainnet, and a launch that works here is evidence
/// about the real thing rather than about a simulation of it.
contract DeployScriptTest is Deployers {
    using StateLibrary for IPoolManager;

    int24 internal constant INITIAL_TICK = 204_200;
    uint256 internal constant SUPPLY_TOKENS = 1_000_000_000;
    uint24 internal constant STAGE0_FEE = 10_000;

    PositionManager internal posm;

    address internal registryOwner = makeAddr("registry owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");

    Deploy.Deployment internal d;

    function setUp() public {
        deployFreshManagerAndRouters();
        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        // Injected rather than set in the environment: `vm.setEnv` is not rolled back
        // between test cases or between suites, so it cannot carry a value that differs
        // per test. The environment-reading path is covered by `test/ScriptEnv.t.sol`.
        d = new InjectedDeployHarness(address(manager), address(posm), treasury, registryOwner).run();

        vm.deal(trader, 100 ether);
    }

    // --- what the script produced --------------------------------------------

    function test_theDeploymentIsWiredToItself() public view {
        assertEq(address(d.factory.hook()), address(d.hook), "the factory names the hook");
        assertEq(d.hook.factory(), address(d.factory), "and the hook names the factory");
        assertEq(d.hook.positionManager(), address(posm), "the hook was mined for this PositionManager");
        assertEq(address(d.hook.poolManager()), address(manager), "and this PoolManager");
        assertEq(d.marketRegistry.writer(), address(d.factory), "only the factory may write the record");
        assertEq(d.deployer.factory(), address(d.factory), "only the factory may deploy market contracts");
        assertEq(address(d.factory.modelRegistry()), address(d.modelRegistry), "the model registry");
        assertEq(address(d.factory.marketRegistry()), address(d.marketRegistry), "the market registry");
        assertEq(d.factory.treasury(), treasury, "the treasury");
    }

    /// @dev The mined address is the deployment's most fragile artefact: v4 derives
    /// the hook's permissions from it, so an address off by one bit is a hook that
    /// silently does not run.
    function test_theMinedHookCarriesExactlyThePermissionsItImplements() public view {
        uint160 bits = uint160(address(d.hook)) & Hooks.ALL_HOOK_MASK;
        assertEq(bits, 0x3880, "beforeInitialize | afterInitialize | beforeAddLiquidity | beforeSwap");

        assertTrue(uint160(address(d.hook)) & Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG == 0, "no swap delta");
        assertTrue(uint160(address(d.hook)) & Hooks.AFTER_SWAP_FLAG == 0, "no afterSwap");
        assertTrue(uint160(address(d.hook)) & Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG == 0, "no beforeRemoveLiquidity");
    }

    function test_theAnchorIsSpentAndTheFactoryIsWhereItSaidItWouldBe() public {
        assertEq(d.origin.factory(), address(d.factory), "the address the anchor published");
        assertTrue(d.origin.used(), "and it can never be used again");
        // Not even the operator gets a second factory at that address, which is what
        // stops a deployment being quietly replaced.
        vm.prank(d.origin.operator());
        vm.expectRevert(abi.encodeWithSelector(FactoryOrigin.AlreadyUsed.selector, address(d.factory)));
        d.origin.deployFactory(hex"600a600c600039600a6000f3600a80600080f0");
    }

    function test_theRegistryWasSeededFromTheParameterRegister() public view {
        string memory json = vm.readFile("../config/generated/bounds.json");

        assertEq(d.modelRegistry.owner(), registryOwner, "owner");
        assertEq(d.modelRegistry.protocolBps(), _u16(json, ".splits.defaultProtocolBps"), "protocol share");
        assertEq(d.modelRegistry.maxProtocolBps(), _u16(json, ".splits.maxProtocolBps"), "the cap it cannot exceed");
        assertEq(uint256(d.modelRegistry.modelCount()), vm.parseJsonUint(json, ".modelCount"), "model count");
        assertFalse(d.modelRegistry.creationPaused(), "a deployment that cannot create anything is not a deployment");

        uint256 count = vm.parseJsonUint(json, ".modelCount");
        uint256[] memory minStages = vm.parseJsonUintArray(json, ".modelMinStages");
        uint256[] memory maxReserve = vm.parseJsonUintArray(json, ".modelMaxReserveBps");
        bool[] memory enabled = vm.parseJsonBoolArray(json, ".modelEnabled");
        for (uint256 i = 0; i < count; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) -- count is bounded by uint8 in the registry
            uint8 model = uint8(i);
            assertEq(uint256(d.modelRegistry.boundsOf(model).minStages), minStages[i], "minStages");
            assertEq(uint256(d.modelRegistry.boundsOf(model).maxReserveBps), maxReserve[i], "maxReserveBps");
            // Equality rather than `assertTrue`: a deployment must offer exactly the
            // models the register enables, and Evergreen is deliberately not one of
            // them in v1. Whether an enabled model is *creatable* is asserted in
            // BoundsParity.t.sol.
            assertEq(d.modelRegistry.boundsOf(model).enabled, enabled[i], "enabled matches the register");
        }
    }

    // --- and then a market ---------------------------------------------------

    /// @dev The only test of the deployment that matters. Everything above could hold
    /// while the system was still unable to do the one thing it exists for.
    function test_aMarketCanBeLaunchedAndTradedOnTheDeployedSystem() public {
        vm.prank(creator);
        VerdantFactory.Created memory created = d.factory.create(_params());

        uint256 supply = SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE;
        VerdantToken token = VerdantToken(created.token);

        assertEq(token.totalSupply(), supply, "the supply the creator asked for");
        assertEq(IERC721(address(posm)).ownerOf(created.positionTokenId), created.locker, "the position is locked");

        (uint160 sqrtPriceX96, int24 tick,, uint24 lpFee) = manager.getSlot0(created.poolId);
        assertEq(sqrtPriceX96, TickMath.getSqrtPriceAtTick(INITIAL_TICK), "opening price");
        assertEq(tick, INITIAL_TICK, "opening tick");
        assertEq(lpFee, STAGE0_FEE, "the first stage's fee");

        MarketRegistry.Market memory market = d.marketRegistry.marketOf(PoolId.unwrap(created.poolId));
        assertEq(market.token, created.token, "the record names the token");
        assertEq(market.creator, creator, "and the creator");

        // A buy, through the hook, at the scheduled fee.
        PoolKey memory key = d.factory.poolKeyFor(address(0), created.token);
        uint256 before = token.balanceOf(trader);

        vm.prank(trader);
        swapRouter.swap{value: 1 ether}(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- 1 ether, far below int256
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(1 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        assertGt(token.balanceOf(trader) - before, 0, "the trader got tokens");
        assertEq(address(manager).balance, 1 ether, "and the ETH is in the pool");
    }

    // --- fixtures ------------------------------------------------------------

    function _params() internal view returns (VerdantFactory.CreateParams memory) {
        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](1);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: STAGE0_FEE});

        return VerdantFactory.CreateParams({
            name: "Deployed Market",
            symbol: "DEPL",
            metadataURI: "ipfs://deployed",
            metadataMutable: false,
            supplyTokens: SUPPLY_TOKENS,
            model: 0,
            quoteAsset: address(0),
            stages: stages,
            initialTick: INITIAL_TICK,
            creatorAllocationBps: 500,
            vestingCliff: 0,
            vestingDuration: 0,
            feeRecipient: creator,
            salt: bytes32(0),
            // No first buy: this test is about the deployment being able to open a
            // market at all, and the buy below is deliberately a separate trader's.
            initialBuyAmount: 0,
            initialBuyMinTokens: 0
        });
    }

    function _u16(string memory json, string memory key) internal pure returns (uint16) {
        // forge-lint: disable-next-line(unsafe-typecast) -- register values are bps
        return uint16(vm.parseJsonUint(json, key));
    }
}
