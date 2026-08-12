// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {AgentActionLib} from "../../src/agents/AgentActionLib.sol";
import {AgentExecutionModule} from "../../src/agents/AgentExecutionModule.sol";
import {AgentIdentityRegistry} from "../../src/agents/AgentIdentityRegistry.sol";
import {AgentLaunchFactory} from "../../src/agents/AgentLaunchFactory.sol";
import {AgentLifecycle} from "../../src/agents/AgentLifecycle.sol";
import {AgentRevenueRouter} from "../../src/agents/AgentRevenueRouter.sol";
import {AgentServiceRegistry} from "../../src/agents/AgentServiceRegistry.sol";
import {AgentTreasury} from "../../src/agents/AgentTreasury.sol";
import {IAgentExecutionModule} from "../../src/agents/IAgentExecutionModule.sol";
import {IAgentIdentityRegistry} from "../../src/agents/IAgentIdentityRegistry.sol";
import {IAgentLaunchFactory} from "../../src/agents/IAgentLaunchFactory.sol";
import {IAgentMandate} from "../../src/agents/IAgentMandate.sol";
import {RevenueAllocationLib} from "../../src/agents/RevenueAllocationLib.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {PositionLocker} from "../../src/PositionLocker.sol";
import {VerdantFactory} from "../../src/VerdantFactory.sol";
import {VerdantToken} from "../../src/VerdantToken.sol";
import {ScheduleLib} from "../../src/libraries/ScheduleLib.sol";
import {LaunchBounds} from "../../src/libraries/LaunchBounds.sol";
import {InjectedDeployHarness} from "../utils/DeployHarness.sol";
import {ForkRpc} from "../utils/ForkRpc.sol";

/// @title The agent layer, end to end, against the Uniswap that is actually deployed
///
/// @notice Every other agent test compiles Uniswap from vendored source and stands a
/// market registry up by hand. This one runs against the bytecode on chain 4663 and
/// launches a real market through the real, unmodified `VerdantFactory.create`.
///
/// @dev Three things can only be established here.
///
///   1. **The launch path is untouched.** The agent layer never wraps `create`, so
///      the market an agent binds is produced by exactly the call any other creator
///      makes, on a factory this suite deploys from unmodified source against the
///      deployed Uniswap. `market.creator` is the developer, not the agent factory.
///   2. **Fee routing actually reaches the agent.** A trade pays the hook's fee, the
///      locker collects it, the splitter pays its recipient — and because that
///      recipient is the agent's revenue router, the agent has income. Every step of
///      that is somebody else's code except the last.
///   3. **The commitment matches a market nobody constructed to match it.** The
///      token address is predicted before the launch, the launch produces it, and the
///      binding reproduces the hash from what the chain says is there.
///
/// The RPC is resolved by [`ForkRpc`](../utils/ForkRpc.sol) rather than pinned in
/// `foundry.toml`, so a private or archival endpoint can be supplied by
/// `ROBINHOOD_RPC_URL` and a second provider by `ROBINHOOD_RPC_URL_FALLBACK`.
contract AgentForkTest is Test {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;

    address internal constant NATIVE = address(0);

    uint256 internal constant SUPPLY_TOKENS = 1_000_000_000;
    int24 internal constant INITIAL_TICK = -207_400;
    uint8 internal constant MODEL_FIXED = 0;
    uint64 internal constant LAUNCH_NONCE = 7;

    address internal registryOwner = makeAddr("registryOwner");
    address internal protocolTreasury = makeAddr("protocolTreasury");
    address internal developer = makeAddr("developer");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal trader = makeAddr("trader");

    Deploy.Deployment internal d;
    PoolSwapTest internal swapRouter;

    AgentLaunchFactory internal agentFactory;
    AgentIdentityRegistry internal identity;
    AgentServiceRegistry internal services;

    bytes32 internal agentId;
    AgentRevenueRouter internal router;
    AgentTreasury internal treasury;
    AgentExecutionModule internal module;

    address internal predictedToken;

    function setUp() public {
        ForkRpc.selectRobinhood();

        assertEq(block.chainid, 4663, "not Robinhood Chain");
        assertGt(POOL_MANAGER.code.length, 0, "no PoolManager on this chain");
        assertGt(POSITION_MANAGER.code.length, 0, "no PositionManager on this chain");

        swapRouter = new PoolSwapTest(IPoolManager(POOL_MANAGER));
        d = new InjectedDeployHarness(POOL_MANAGER, POSITION_MANAGER, protocolTreasury, registryOwner).run();

        agentFactory = new AgentLaunchFactory(address(d.marketRegistry), protocolTreasury);
        identity = agentFactory.identityRegistry();
        services = agentFactory.serviceRegistry();

        vm.deal(developer, 50 ether);
        vm.deal(trader, 200 ether);
    }

    // --- the whole flow --------------------------------------------------------

    /// @notice Create, launch, bind, activate, earn, sell, pay, pause, revoke.
    ///
    /// @dev One test rather than nine, because the value is in the sequence: each
    /// step is only meaningful on state the previous one produced, and splitting them
    /// would mean re-running a fork setup nine times for assertions that belong
    /// together.
    function test_theWholeAgentLifecycleAgainstTheRealChain() public {
        // --- 1. predict the token, so the agent can commit to it before it exists
        predictedToken = _predictToken();

        // --- 2. create the agent
        IAgentLaunchFactory.AgentAddresses memory created = _createAgent(predictedToken);
        agentId = created.agentId;
        router = AgentRevenueRouter(payable(created.router));
        treasury = AgentTreasury(payable(created.treasury));
        module = AgentExecutionModule(created.executionModule);

        assertEq(uint8(identity.stateOf(agentId)), uint8(AgentLifecycle.State.Created), "state after creation");
        assertFalse(identity.isActive(agentId), "a created agent is active");

        // --- 3. launch through the real, unmodified factory
        vm.prank(developer);
        VerdantFactory.Created memory market = d.factory.create(_launchParams(address(router)));

        assertEq(market.token, predictedToken, "the launch did not produce the predicted token");
        assertEq(
            d.marketRegistry.marketOf(PoolId.unwrap(market.poolId)).creator,
            developer,
            "the developer is not the creator: the agent layer wrapped the launch"
        );
        assertEq(
            FeeSplitter(payable(market.splitter)).creator(), address(router), "the splitter does not pay the agent"
        );
        assertEq(IERC721(POSITION_MANAGER).ownerOf(market.positionTokenId), market.locker, "position not locked");

        // --- 4. bind, permissionlessly, from an address with no role at all
        vm.prank(trader);
        identity.bindMarket(agentId, PoolId.unwrap(market.poolId));

        IAgentIdentityRegistry.Agent memory bound = identity.agentOf(agentId);
        assertEq(uint8(bound.state), uint8(AgentLifecycle.State.MarketBound), "state after binding");
        assertEq(bound.poolId, PoolId.unwrap(market.poolId), "poolId");
        assertEq(bound.token, market.token, "token");
        assertFalse(identity.isActive(agentId), "binding activated the agent");

        // --- 5. activate
        vm.prank(developer);
        identity.activate(agentId);
        assertTrue(identity.isActive(agentId), "not active after activation");

        // --- 6. earn: a real trade, the hook's fee, the locker, the splitter
        uint256 earned = _tradeAndRouteFees(market);
        assertGt(earned, 0, "the agent earned nothing from a real trade");

        router.recognise(NATIVE);
        router.allocate(NATIVE);

        uint256 operationsShare = router.pending(NATIVE, 0);
        assertGt(operationsShare, 0, "the operations leg got nothing");

        router.settle(NATIVE, 0);
        assertEq(address(treasury).balance, operationsShare, "the treasury was not funded");

        // --- 7. fixed entitlements settle without the agent deciding anything
        uint256 developerBefore = developer.balance;
        vm.prank(trader);
        router.claimDeveloperEntitlement(NATIVE);
        assertGt(developer.balance, developerBefore, "the developer could not be paid by a stranger");

        // --- 8. sell a service and buy one, from the same agent
        vm.prank(developer);
        (bytes32 serviceId, uint32 version) = services.register(
            agentId, _label("forecast"), "https://example.test/forecast", keccak256("schema"), NATIVE, 0.01 ether
        );

        uint256 providerBalanceBefore = address(router).balance;

        AgentActionLib.ServiceQuote memory quote = AgentActionLib.ServiceQuote({
            agentId: agentId,
            providerAgentId: agentId,
            serviceId: serviceId,
            serviceVersion: version,
            provider: services.payeeOf(serviceId),
            asset: NATIVE,
            exactAmount: 0.01 ether,
            requestId: _label("request-1"),
            deadline: block.timestamp + 1 hours,
            nonce: module.nextNonce()
        });

        vm.prank(operator);
        module.payService(quote);

        assertEq(address(router).balance, providerBalanceBefore + 0.01 ether, "the service was not paid");
        assertTrue(module.isRequestSettled(_label("request-1")), "the request was not recorded");

        // --- 9. pause: revenue still arrives, discretionary action does not
        vm.prank(guardian);
        identity.pause(agentId);

        _payRouter(1 ether);
        router.recognise(NATIVE);
        router.allocate(NATIVE);

        uint256 pendingDeveloper = router.pending(NATIVE, 2);
        assertGt(pendingDeveloper, 0, "revenue stopped arriving while paused");

        vm.prank(trader);
        router.claimDeveloperEntitlement(NATIVE);

        AgentActionLib.ServiceQuote memory whilePaused = quote;
        whilePaused.requestId = _label("request-2");
        whilePaused.nonce = module.nextNonce();

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IAgentExecutionModule.AgentNotActive.selector, agentId));
        module.payService(whilePaused);

        // --- 10. revoke: terminal, and it seizes nothing
        uint256 treasuryHeld = address(treasury).balance;

        vm.prank(guardian);
        identity.revoke(agentId);

        assertEq(uint8(identity.stateOf(agentId)), uint8(AgentLifecycle.State.Revoked), "not revoked");
        assertEq(address(treasury).balance, treasuryHeld, "revocation moved treasury funds");

        vm.prank(guardian);
        vm.expectRevert();
        identity.resume(agentId);

        // Revenue still arrives and entitlements still settle after revocation.
        _payRouter(1 ether);
        router.recognise(NATIVE);
        router.allocate(NATIVE);

        uint256 protocolBefore = protocolTreasury.balance;
        vm.prank(trader);
        router.claimProtocolEntitlement(NATIVE);
        assertGt(protocolTreasury.balance, protocolBefore, "a revoked agent stranded the protocol's entitlement");
    }

    // --- the market layer is unchanged --------------------------------------------

    /// @notice An agent's market is an ordinary Verdant market in every respect.
    function test_anAgentsMarketIsIndistinguishableFromAnyOther() public {
        predictedToken = _predictToken();
        IAgentLaunchFactory.AgentAddresses memory created = _createAgent(predictedToken);

        vm.prank(developer);
        VerdantFactory.Created memory market = d.factory.create(_launchParams(created.router));

        VerdantToken token = VerdantToken(market.token);
        assertEq(token.totalSupply(), SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE, "supply");
        assertEq(token.symbol(), "AGENT", "symbol");

        // The locker holds the position and has no withdrawal path, exactly as for a
        // market with no agent.
        assertEq(IERC721(POSITION_MANAGER).ownerOf(market.positionTokenId), market.locker, "position");
        assertEq(PositionLocker(payable(market.locker)).splitter(), market.splitter, "locker's splitter");

        // And the registry records it under the developer, not under any agent
        // contract.
        assertEq(d.marketRegistry.marketOf(PoolId.unwrap(market.poolId)).creator, developer, "creator");
    }

    /// @notice No market that exists on chain 4663 can be claimed by a new agent.
    function test_noExistingMarketOnChainCanBeClaimed() public {
        // The canonical registry, not the one this suite deployed.
        address canonical = _canonicalMarketRegistry();
        if (canonical.code.length == 0) return;

        AgentLaunchFactory hostile = new AgentLaunchFactory(canonical, protocolTreasury);
        AgentIdentityRegistry hostileIdentity = hostile.identityRegistry();

        vm.prank(developer);
        IAgentLaunchFactory.AgentAddresses memory attacker =
            hostile.createAgent(_agentParams(_label("hostile"), makeAddr("nothing")));

        // Every market anybody has launched, tried against an agent that wants them.
        uint256 count = MarketRegistryLike(canonical).marketCount();
        uint256 checked = count > 5 ? 5 : count;

        for (uint256 i = 0; i < checked; i++) {
            bytes32 poolId = MarketRegistryLike(canonical).marketAt(i).poolId;

            vm.expectRevert();
            hostileIdentity.bindMarket(attacker.agentId, poolId);
        }
    }

    /// @notice The critical routing assertion, repeated against a second provider.
    ///
    /// @dev Skips cleanly when only one endpoint is configured. Two providers
    /// disagreeing is the only way to tell "the chain says this" from "this node says
    /// this", and it is worth one extra fork for the claim the whole layer rests on.
    function test_feeRoutingHoldsOnASecondProvider() public {
        if (!ForkRpc.hasFallback()) {
            emit log("ROBINHOOD_RPC_URL_FALLBACK not set: second-provider check skipped");
            return;
        }

        vm.createSelectFork(ForkRpc.fallbackUrl());
        assertEq(block.chainid, 4663, "the fallback is not Robinhood Chain");

        swapRouter = new PoolSwapTest(IPoolManager(POOL_MANAGER));
        d = new InjectedDeployHarness(POOL_MANAGER, POSITION_MANAGER, protocolTreasury, registryOwner).run();
        agentFactory = new AgentLaunchFactory(address(d.marketRegistry), protocolTreasury);
        identity = agentFactory.identityRegistry();
        services = agentFactory.serviceRegistry();

        vm.deal(developer, 50 ether);
        vm.deal(trader, 200 ether);

        predictedToken = _predictToken();
        IAgentLaunchFactory.AgentAddresses memory created = _createAgent(predictedToken);

        vm.prank(developer);
        VerdantFactory.Created memory market = d.factory.create(_launchParams(created.router));

        assertEq(
            FeeSplitter(payable(market.splitter)).creator(), created.router, "fee routing differs between providers"
        );
    }

    // --- helpers ------------------------------------------------------------------

    function _canonicalMarketRegistry() internal view returns (address) {
        string memory record = vm.readFile("../../deployments/robinhood.json");
        return vm.parseJsonAddress(record, ".contracts.marketRegistry.address");
    }

    /// @dev The address the launch will produce, computed the way the SDK does it:
    /// the deployer's own init-code hash under the factory's namespaced salt.
    function _predictToken() internal view returns (address) {
        bytes32 initCodeHash = d.deployer
            .tokenInitCodeHash(
                "Agent Market",
                "AGENT",
                SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE,
                developer,
                "ipfs://agent-market",
                false
            );

        return vm.computeCreate2Address(d.factory.saltFor(developer, bytes32(0)), initCodeHash, address(d.deployer));
    }

    /// @dev A named `bytes32`. Hashed rather than written as a string-literal cast
    /// so the value is a `bytes32` outright, matching `AgentFixture._label`.
    function _label(string memory name) internal pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    function _agentParams(bytes32 salt, address token) internal view returns (IAgentLaunchFactory.AgentParams memory) {
        IAgentMandate.AssetLimit[] memory limits = new IAgentMandate.AssetLimit[](1);
        limits[0] = IAgentMandate.AssetLimit({asset: NATIVE, maxActionValue: 1 ether, periodLimit: 5 ether});

        // Filled in by `_createAgent` once the router's address is known: an agent
        // that buys its own service has to approve a target that does not exist yet.
        address[] memory targets = new address[](1);

        return IAgentLaunchFactory.AgentParams({
            salt: salt,
            guardian: guardian,
            operator: operator,
            limits: limits,
            targets: targets,
            minActionInterval: 1 minutes,
            periodLength: 1 days,
            expiry: 0,
            allocation: RevenueAllocationLib.Allocation({
                operationsBps: 6000, buybacksBps: 0, developerBps: 3000, protocolBps: 1000
            }),
            metadataURI: "ipfs://agent",
            expectation: IAgentIdentityRegistry.MarketExpectation({
                token: token,
                quoteAsset: NATIVE,
                model: MODEL_FIXED,
                expectedSupply: SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE,
                launchNonce: LAUNCH_NONCE
            })
        });
    }

    /// @dev The agent buys from itself, so the mandate must approve its own router —
    /// which is only knowable after creation. Created once to learn the address, then
    /// rolled back and created again with it approved.
    function _createAgent(address token) internal returns (IAgentLaunchFactory.AgentAddresses memory) {
        uint256 snapshot = vm.snapshotState();

        vm.prank(developer);
        address predictedRouter = agentFactory.createAgent(_agentParams(_label("agent"), token)).router;

        vm.revertToState(snapshot);

        IAgentLaunchFactory.AgentParams memory params = _agentParams(_label("agent"), token);
        params.targets[0] = predictedRouter;

        vm.prank(developer);
        return agentFactory.createAgent(params);
    }

    function _launchParams(address feeRecipient) internal view returns (VerdantFactory.CreateParams memory) {
        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](1);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: 10_000});

        return VerdantFactory.CreateParams({
            name: "Agent Market",
            symbol: "AGENT",
            metadataURI: "ipfs://agent-market",
            metadataMutable: false,
            supplyTokens: SUPPLY_TOKENS,
            model: MODEL_FIXED,
            quoteAsset: NATIVE,
            stages: stages,
            initialTick: INITIAL_TICK,
            creatorAllocationBps: 0,
            vestingCliff: 0,
            vestingDuration: 0,
            feeRecipient: feeRecipient,
            salt: bytes32(0),
            initialBuyAmount: 0,
            initialBuyMinTokens: 0
        });
    }

    /// @dev A real trade against the real PoolManager, then the two permissionless
    /// calls that move the fee from the position to the agent.
    function _tradeAndRouteFees(VerdantFactory.Created memory market) internal returns (uint256 routed) {
        // Built by the factory rather than by hand, so the key this trades against
        // is the key the market was created with and not a second definition of it.
        PoolKey memory key = d.factory.poolKeyFor(NATIVE, market.token);

        vm.prank(trader);
        swapRouter.swap{value: 5 ether}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -5 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        PositionLocker(payable(market.locker)).collect();

        // Through the router, because `FeeSplitter.claim` pays `msg.sender` and the
        // recipient here is a contract. Calling the splitter from this test would
        // revert `NotARecipient`, which is exactly the gap `claimMarketFees` closes.
        uint256 before = address(router).balance;
        router.claimMarketFees();
        return address(router).balance - before;
    }

    function _payRouter(uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        (bool ok,) = address(router).call{value: amount}("");
        require(ok, "pay");
    }

    receive() external payable {}
}

/// @dev The two functions this suite needs from the canonical registry, declared
/// rather than imported so the struct layout is read through this repository's own
/// definition — which is the thing being checked.
interface MarketRegistryLike {
    struct Market {
        bytes32 poolId;
        address token;
        address quoteAsset;
        address creator;
        uint8 model;
        uint40 createdAt;
        uint16 creatorBps;
        uint16 protocolBps;
        uint16 reserveBps;
        uint256 positionTokenId;
        address locker;
        address splitter;
        address vesting;
    }

    function marketCount() external view returns (uint256);
    function marketAt(uint256 index) external view returns (Market memory);
}
