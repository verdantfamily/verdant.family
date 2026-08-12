// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

import {AgentExecutionModule} from "../../src/agents/AgentExecutionModule.sol";
import {AgentIdentityRegistry} from "../../src/agents/AgentIdentityRegistry.sol";
import {AgentLaunchFactory} from "../../src/agents/AgentLaunchFactory.sol";
import {AgentLifecycle} from "../../src/agents/AgentLifecycle.sol";
import {AgentMandate} from "../../src/agents/AgentMandate.sol";
import {AgentRevenueRouter} from "../../src/agents/AgentRevenueRouter.sol";
import {AgentTreasury} from "../../src/agents/AgentTreasury.sol";
import {IAgentIdentityRegistry} from "../../src/agents/IAgentIdentityRegistry.sol";
import {IAgentLaunchFactory} from "../../src/agents/IAgentLaunchFactory.sol";
import {IAgentMandate} from "../../src/agents/IAgentMandate.sol";
import {IAgentRevenueRouter} from "../../src/agents/IAgentRevenueRouter.sol";
import {RevenueAllocationLib} from "../../src/agents/RevenueAllocationLib.sol";

import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {ModelRegistry} from "../../src/ModelRegistry.sol";
import {PositionLocker} from "../../src/PositionLocker.sol";
import {VerdantDeployer} from "../../src/VerdantDeployer.sol";
import {VerdantFactory} from "../../src/VerdantFactory.sol";
import {VerdantHook} from "../../src/VerdantHook.sol";
import {VerdantToken} from "../../src/VerdantToken.sol";
import {LaunchBounds} from "../../src/libraries/LaunchBounds.sol";
import {ScheduleLib} from "../../src/libraries/ScheduleLib.sol";
import {VerdantConstants} from "../../src/libraries/VerdantConstants.sol";

/// @title An agent launch, end to end, against a real market
///
/// @notice The test that decides whether the agent layer works. `AgentFixture` stands
/// the market layer up by hand, which is right for testing an agent's own rules and
/// wrong for testing the seam between the two layers — a hand-built `MarketRegistry`
/// entry will agree with whatever the agent code expects, including when the agent
/// code is wrong.
///
/// This one runs a real launch through the real, unmodified `VerdantFactory` against
/// the real `PoolManager` and `PositionManager`, then trades against the market it
/// produced and follows the money all the way into the agent's treasury.
///
/// `test/fork/Agent.fork.t.sol` does the same against the bytecode deployed on chain
/// 4663. This one exists because that one needs an RPC and is excluded from the
/// default profile, so without it none of the properties below are checked in CI.
///
/// The properties, in the order somebody deciding whether to trust an agent would
/// ask for them:
///
///   1. **An agent launch is an ordinary Verdant launch.** The market is created by
///      the developer calling `create` themselves, so `market.creator` is the
///      developer and every `msg.sender` semantic in the factory is untouched.
///   2. **The market is provably the agent's.** Binding reproduces the commitment
///      from what the chain says exists, and attribution is readable from the
///      registry afterwards.
///   3. **The agent actually earns.** A trade pays the hook's fee, the locker
///      collects it, the splitter holds it, and the router pulls it out and divides
///      it. That last step is the one the layer would silently lack a path for.
///   4. **The agent cannot add liquidity to its own market.** Nor can anybody else,
///      which is the stronger property Verdant already had and the agent layer must
///      not weaken.
///   5. **Markets without agents are unaffected.**
contract AgentMarketTest is Deployers {
    using StateLibrary for IPoolManager;

    /// @dev Any address whose low 14 bits are 0x3880, which is what v4 reads to
    /// decide which callbacks the hook has. Mined for real in the permissions suite.
    address internal constant HOOK_ADDRESS = address(uint160(0xC0FFEE0000 | 0x3880));

    int24 internal constant INITIAL_TICK = 204_200;
    uint256 internal constant SUPPLY_TOKENS = 1_000_000_000;
    uint256 internal constant SUPPLY = SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE;
    uint16 internal constant PROTOCOL_BPS = 1_000;
    uint24 internal constant STAGE0_FEE = 10_000; // 1%

    string internal constant NAME = "Agen Market";
    string internal constant SYMBOL = "AGEN";
    string internal constant METADATA_URI = "ipfs://market";

    address internal constant NATIVE = address(0);

    uint64 internal constant PERIOD = 1 days;
    uint64 internal constant INTERVAL = 1 minutes;

    PositionManager internal posm;
    VerdantHook internal hook;
    VerdantDeployer internal deployer;
    VerdantFactory internal verdant;
    ModelRegistry internal modelRegistry;
    MarketRegistry internal marketRegistry;

    AgentLaunchFactory internal agents;
    AgentIdentityRegistry internal identity;

    address internal registryOwner = makeAddr("registry owner");
    address internal protocolTreasury = makeAddr("protocol treasury");
    address internal developer = makeAddr("developer");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal trader = makeAddr("trader");
    address internal stranger = makeAddr("stranger");

    /// @notice One agent and the market it launched, as a caller sees them.
    struct Launched {
        bytes32 agentId;
        AgentRevenueRouter router;
        AgentTreasury treasury;
        AgentExecutionModule module;
        AgentMandate mandate;
        VerdantFactory.Created market;
    }

    function setUp() public {
        deployFreshManagerAndRouters();

        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        modelRegistry = new ModelRegistry(registryOwner, 2_000, PROTOCOL_BPS, _modelBounds(), new address[](0));

        // The factory is deployed last but referenced first, so its address is
        // predicted here. Two `new` calls happen in between, so the offset is two;
        // `deployCodeTo` does not create from this account and does not move the
        // nonce. The assertion below is what turns a wrong prediction into a failed
        // setup rather than an inert deployment.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);

        marketRegistry = new MarketRegistry(predicted);
        deployer = new VerdantDeployer(predicted);

        deployCodeTo("VerdantHook.sol:VerdantHook", abi.encode(manager, predicted, posm), HOOK_ADDRESS);
        hook = VerdantHook(HOOK_ADDRESS);

        verdant = new VerdantFactory(manager, posm, hook, deployer, modelRegistry, marketRegistry, protocolTreasury);
        assertEq(address(verdant), predicted, "the prediction the whole deployment rests on");

        // The agent layer, deployed against the market layer's registry and touching
        // nothing else in it.
        agents = new AgentLaunchFactory(address(marketRegistry), protocolTreasury);
        identity = agents.identityRegistry();

        vm.warp(1_800_000_000);
        vm.deal(trader, 1_000 ether);
        vm.deal(developer, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    // --- 1. an agent launch is an ordinary launch -----------------------------

    function test_anAgentMarketIsCreatedByTheDeveloperAndNotByAnyAgentContract() public {
        Launched memory it = _launchAgentWithMarket(_salt("one"));

        MarketRegistry.Market memory market = marketRegistry.marketOf(PoolId.unwrap(it.market.poolId));

        // The six identities `create` reads from `msg.sender`. If the agent layer
        // ever wrapped the launch, every one of these would name a contract.
        assertEq(market.creator, developer, "the registry attributes the market to the developer");
        assertEq(VerdantToken(it.market.token).creator(), developer, "the token's creator");
        assertEq(marketRegistry.marketsByCreator(developer).length, 1, "the developer's profile lists their own market");
        assertEq(marketRegistry.marketsByCreator(address(agents)).length, 0, "the agent factory created nothing");
        assertEq(marketRegistry.marketsByCreator(address(it.router)).length, 0, "nor did the router");

        // The creator allocation went to the developer, not to an agent contract
        // that would have no function to release it.
        assertGt(IERC20(it.market.token).balanceOf(developer), 0, "the developer holds their allocation");
        assertEq(IERC20(it.market.token).balanceOf(address(it.router)), 0, "the router took custody of nothing");
        assertEq(IERC20(it.market.token).balanceOf(address(it.treasury)), 0, "and neither did the treasury");

        // And it is an ordinary market in every other respect.
        assertEq(IERC721(address(posm)).ownerOf(it.market.positionTokenId), it.market.locker, "position locked");
        assertGt(it.market.liquidity, 0, "a market with no liquidity is not a market");
        assertEq(hook.feeAt(it.market.poolId, block.timestamp), STAGE0_FEE, "the schedule applies as usual");
    }

    // --- 2. the market is provably the agent's --------------------------------

    function test_bindingProvesTheMarketAndAttributesItToTheAgent() public {
        Launched memory it = _launchAgentWithMarket(_salt("two"));
        bytes32 poolId = PoolId.unwrap(it.market.poolId);

        assertEq(identity.agentByPool(poolId), it.agentId, "the pool resolves to the agent");

        IAgentIdentityRegistry.Agent memory agent = identity.agentOf(it.agentId);
        assertEq(agent.poolId, poolId, "the agent records its market");
        assertEq(agent.token, it.market.token, "and its token");
        assertEq(agent.developer, developer, "and its developer");
        assertEq(uint8(agent.state), uint8(AgentLifecycle.State.Active), "active after the developer activated");

        // The splitter pays the router, which is what made the binding provable, and
        // the router now knows the splitter so it can collect.
        assertEq(FeeSplitter(payable(it.market.splitter)).creator(), address(it.router), "splitter pays the agent");
        assertEq(it.router.marketSplitter(), it.market.splitter, "the router was handed its splitter");
    }

    function test_anotherAgentCannotClaimAMarketItDidNotLaunch() public {
        Launched memory it = _launchAgentWithMarket(_salt("mine"));

        // A second agent, created by somebody else, pointing at the first one's pool.
        // Its commitment names a different router, so the market's own splitter
        // refuses it — a fact decided when that market was created and unrevisable.
        IAgentLaunchFactory.AgentAddresses memory thief =
            _createAgent(stranger, _salt("thief"), _predictToken(stranger, _salt("thief")));

        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentIdentityRegistry.MarketAlreadyBound.selector, PoolId.unwrap(it.market.poolId), it.agentId
            )
        );
        identity.bindMarket(thief.agentId, PoolId.unwrap(it.market.poolId));
    }

    // --- 3. the agent actually earns ------------------------------------------

    /// @dev The path the whole layer rests on, and the one that had no code:
    /// `FeeSplitter.claim` pays `msg.sender`, so a contract named as `feeRecipient`
    /// has to be able to make that call itself. Every step here is somebody else's
    /// code except the last two.
    function test_aTradeOnAnAgentsMarketBecomesRevenueInTheAgentsTreasury() public {
        Launched memory it = _launchAgentWithMarket(_salt("earn"));

        _buy(it.market, 50 ether);

        // Collection is permissionless and pushes the fee to the splitter.
        vm.prank(makeAddr("a passer-by"));
        PositionLocker(it.market.locker).collect();

        uint256 held = it.market.splitter.balance;
        assertGt(held, 0, "the trade left no fee in the position");

        (uint256 owedToAgent,) = FeeSplitter(payable(it.market.splitter)).claimable(address(it.router));
        assertEq(owedToAgent, held - (held * PROTOCOL_BPS) / 10_000, "the agent is owed the creator share");

        // The claim. Permissionless, and the only thing it can do is move this
        // market's creator share into this router.
        vm.prank(stranger);
        (uint256 claimedQuote,) = it.router.claimMarketFees();
        assertEq(claimedQuote, owedToAgent, "the router claimed what it was owed");
        assertEq(address(it.router).balance, owedToAgent, "and is holding it");

        // From here it is the router's ordinary three steps.
        it.router.recognise(NATIVE);
        assertEq(it.router.totalReceived(NATIVE), owedToAgent, "recognised as revenue");

        it.router.allocate(NATIVE);

        uint256 operations = it.router.pending(NATIVE, 0);
        uint256 developerLeg = it.router.pending(NATIVE, 2);
        uint256 protocolLeg = it.router.pending(NATIVE, 3);

        assertEq(operations, (owedToAgent * 6000) / 10_000, "the operations leg is 60%");
        assertEq(developerLeg, (owedToAgent * 3000) / 10_000, "the developer's is 30%");
        assertEq(protocolLeg, (owedToAgent * 1000) / 10_000, "the protocol's is 10%");

        uint256 developerBefore = developer.balance;
        uint256 protocolBefore = protocolTreasury.balance;

        it.router.settle(NATIVE, 0);
        it.router.claimDeveloperEntitlement(NATIVE);
        it.router.claimProtocolEntitlement(NATIVE);

        assertEq(address(it.treasury).balance, operations, "the agent's treasury was funded by its own market");
        assertEq(developer.balance - developerBefore, developerLeg, "the developer was paid");
        assertEq(protocolTreasury.balance - protocolBefore, protocolLeg, "and the protocol");

        // Nothing but dust is left anywhere on the way.
        assertLe(address(it.router).balance, RevenueAllocationLib.MAX_UNALLOCATED_DUST, "only dust remains");
    }

    function test_theRouterCannotClaimBeforeItHasAMarket() public {
        IAgentLaunchFactory.AgentAddresses memory created =
            _createAgent(developer, _salt("unbound"), _predictToken(developer, _salt("unbound")));

        vm.expectRevert(IAgentRevenueRouter.NoMarketBound.selector);
        AgentRevenueRouter(payable(created.router)).claimMarketFees();
    }

    function test_nobodyButTheRegistryCanTellARouterWhichSplitterIsIts() public {
        Launched memory it = _launchAgentWithMarket(_salt("bindings"));

        address[4] memory nobody = [developer, guardian, operator, stranger];
        for (uint256 i = 0; i < nobody.length; i++) {
            vm.prank(nobody[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgentRevenueRouter.NotIdentityRegistry.selector, nobody[i]));
            it.router.bindSplitter(makeAddr("a splitter that pays somebody else"));
        }

        // Not even the registry, twice. The market an agent is bound to never moves.
        vm.prank(address(identity));
        vm.expectRevert(abi.encodeWithSelector(IAgentRevenueRouter.SplitterAlreadyBound.selector, it.market.splitter));
        it.router.bindSplitter(makeAddr("a second splitter"));
    }

    /// @dev Revenue is not the agent's to withhold. A stopped agent still owes what
    /// its market has already earned, which is ADR-012's claim and this is the
    /// version of it that goes through a real market.
    function test_aRevokedAgentsMarketStillPaysTheDeveloperAndTheProtocol() public {
        Launched memory it = _launchAgentWithMarket(_salt("revoked"));

        vm.prank(guardian);
        identity.revoke(it.agentId);

        _buy(it.market, 50 ether);
        PositionLocker(it.market.locker).collect();

        vm.prank(stranger);
        it.router.claimMarketFees();

        it.router.recognise(NATIVE);
        it.router.allocate(NATIVE);

        uint256 developerBefore = developer.balance;
        uint256 protocolBefore = protocolTreasury.balance;

        it.router.claimDeveloperEntitlement(NATIVE);
        it.router.claimProtocolEntitlement(NATIVE);

        assertGt(developer.balance, developerBefore, "a revoked agent stranded the developer");
        assertGt(protocolTreasury.balance, protocolBefore, "a revoked agent stranded the protocol");
    }

    // --- 4. no self-liquidity -------------------------------------------------

    /// @dev The invariant stated as the product needs it: an agent cannot deepen its
    /// own market. It holds for the strongest possible reason — `VerdantHook`
    /// refuses every mint whose initiator is not the factory, and after creation
    /// that is true of everybody — so it is asserted from every address the agent
    /// could possibly act through rather than from one.
    function test_anAgentCannotAddLiquidityToItsOwnMarket() public {
        Launched memory it = _launchAgentWithMarket(_salt("liquidity"));

        address[5] memory asTheAgent =
            [address(it.treasury), address(it.module), address(it.router), operator, developer];

        for (uint256 i = 0; i < asTheAgent.length; i++) {
            _expectMintRefused(it.market, asTheAgent[i]);
        }
    }

    function test_nobodyElseCanAddLiquidityToAnAgentsMarketEither() public {
        Launched memory it = _launchAgentWithMarket(_salt("closed"));

        // A second agent, a plain trader, the guardian, and the protocol. The rule is
        // not about agents: after creation the pool is closed to everyone, so an
        // agent is refused as a member of that set rather than as a special case.
        Launched memory other = _launchAgentWithMarket(_salt("other"));

        _expectMintRefused(it.market, address(other.treasury));
        _expectMintRefused(it.market, trader);
        _expectMintRefused(it.market, guardian);
        _expectMintRefused(it.market, protocolTreasury);
    }

    function test_theLockedPositionOfAnAgentMarketCannotBeWithdrawn() public {
        Launched memory it = _launchAgentWithMarket(_salt("locked"));

        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] =
            abi.encode(it.market.positionTokenId, uint256(it.market.liquidity), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(Currency.wrap(NATIVE), Currency.wrap(it.market.token), developer);

        vm.prank(developer);
        vm.expectRevert();
        posm.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        assertEq(posm.getPositionLiquidity(it.market.positionTokenId), it.market.liquidity, "liquidity is intact");
        assertEq(IERC721(address(posm)).ownerOf(it.market.positionTokenId), it.market.locker, "and still locked");
    }

    // --- 5. markets without agents are unaffected -----------------------------

    function test_aLaunchWithNoAgentWorksExactlyAsBefore() public {
        address human = makeAddr("a creator with no agent");
        vm.deal(human, 10 ether);

        VerdantFactory.CreateParams memory params = _launchParams(human);
        params.feeRecipient = human;

        vm.prank(human);
        VerdantFactory.Created memory market = verdant.create(params);

        MarketRegistry.Market memory record = marketRegistry.marketOf(PoolId.unwrap(market.poolId));
        assertEq(record.creator, human, "an ordinary launch is attributed to its creator");
        assertEq(identity.agentByPool(PoolId.unwrap(market.poolId)), bytes32(0), "and belongs to no agent");

        // It trades and pays exactly as it did before the agent layer existed.
        _buy(market, 10 ether);
        PositionLocker(market.locker).collect();

        FeeSplitter splitter = FeeSplitter(payable(market.splitter));
        (uint256 owed,) = splitter.claimable(human);
        assertGt(owed, 0, "the creator earned nothing");

        uint256 before = human.balance;
        vm.prank(human);
        splitter.claim();
        assertEq(human.balance - before, owed, "and could not collect it");
    }

    function test_aMarketCannotBeBoundToAnAgentItDoesNotPay() public {
        address human = makeAddr("another creator");
        vm.deal(human, 10 ether);

        VerdantFactory.CreateParams memory params = _launchParams(human);
        params.feeRecipient = human;

        vm.prank(human);
        VerdantFactory.Created memory market = verdant.create(params);

        IAgentLaunchFactory.AgentAddresses memory created =
            _createAgent(developer, _salt("opportunist"), _predictToken(developer, _salt("opportunist")));

        // Refused on the creator before it is refused on the fee recipient. Both
        // would refuse it; the first one reached is the more useful diagnosis,
        // because "somebody else launched this" is the actual situation.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentIdentityRegistry.MarketNotCreatedByDeveloper.selector,
                PoolId.unwrap(market.poolId),
                human,
                developer
            )
        );
        identity.bindMarket(created.agentId, PoolId.unwrap(market.poolId));
    }

    /// @dev The developer's own market, launched without naming their agent's
    /// router. This is the case the fee-recipient check exists for: everything else
    /// about the market is right, and it still cannot be claimed, because being the
    /// agent's market means paying the agent.
    function test_theDevelopersOwnMarketCannotBeBoundIfItDoesNotPayTheAgent() public {
        bytes32 salt = _salt("unpaid");
        IAgentLaunchFactory.AgentAddresses memory created =
            _createAgent(developer, salt, _predictToken(developer, salt));

        VerdantFactory.CreateParams memory params = _launchParams(developer);
        params.salt = salt;
        params.feeRecipient = developer;

        vm.prank(developer);
        VerdantFactory.Created memory market = verdant.create(params);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentIdentityRegistry.MarketNotOwnedByAgent.selector,
                PoolId.unwrap(market.poolId),
                developer,
                created.router
            )
        );
        identity.bindMarket(created.agentId, PoolId.unwrap(market.poolId));
    }

    // --- 6. two agents do not share anything ----------------------------------

    function test_twoAgentsKeepSeparateMarketsTreasuriesAndBooks() public {
        Launched memory a = _launchAgentWithMarket(_salt("first"));
        Launched memory b = _launchAgentWithMarket(_salt("second"));

        assertTrue(a.agentId != b.agentId, "ids collided");
        assertTrue(address(a.treasury) != address(b.treasury), "treasuries collided");
        assertTrue(address(a.router) != address(b.router), "routers collided");
        assertTrue(a.market.token != b.market.token, "tokens collided");
        assertTrue(a.router.marketSplitter() != b.router.marketSplitter(), "splitters collided");

        // Only the first one is traded.
        _buy(a.market, 40 ether);
        PositionLocker(a.market.locker).collect();

        vm.prank(stranger);
        a.router.claimMarketFees();
        a.router.recognise(NATIVE);
        a.router.allocate(NATIVE);
        a.router.settle(NATIVE, 0);

        assertGt(address(a.treasury).balance, 0, "the traded agent earned nothing");
        assertEq(address(b.treasury).balance, 0, "the untraded agent was credited from somebody else's market");
        assertEq(b.router.totalReceived(NATIVE), 0, "and its books moved");

        // The second agent's splitter has nothing, and claiming from it says so
        // rather than paying out of the first one's.
        vm.expectRevert();
        b.router.claimMarketFees();
    }

    // --- building the pieces --------------------------------------------------

    /// @notice The whole flow a developer performs: create the agent, launch the
    /// market naming its router, bind, activate.
    function _launchAgentWithMarket(bytes32 salt) internal returns (Launched memory it) {
        address predictedToken = _predictToken(developer, salt);

        IAgentLaunchFactory.AgentAddresses memory created = _createAgent(developer, salt, predictedToken);

        it.agentId = created.agentId;
        it.router = AgentRevenueRouter(payable(created.router));
        it.treasury = AgentTreasury(payable(created.treasury));
        it.module = AgentExecutionModule(created.executionModule);
        it.mandate = AgentMandate(created.mandate);

        VerdantFactory.CreateParams memory params = _launchParams(developer);
        params.salt = salt;
        params.feeRecipient = created.router;

        vm.prank(developer);
        it.market = verdant.create(params);

        assertEq(it.market.token, predictedToken, "the token was not created where the agent expected it");

        // Permissionless, and from an address with no role in this agent at all.
        vm.prank(stranger);
        identity.bindMarket(it.agentId, PoolId.unwrap(it.market.poolId));

        vm.prank(developer);
        identity.activate(it.agentId);
    }

    function _createAgent(address as_, bytes32 salt, address expectedToken)
        internal
        returns (IAgentLaunchFactory.AgentAddresses memory)
    {
        IAgentMandate.AssetLimit[] memory limits = new IAgentMandate.AssetLimit[](1);
        limits[0] = IAgentMandate.AssetLimit({asset: NATIVE, maxActionValue: 1 ether, periodLimit: 5 ether});

        vm.prank(as_);
        return agents.createAgent(
            IAgentLaunchFactory.AgentParams({
                salt: salt,
                guardian: guardian,
                operator: operator,
                limits: limits,
                targets: new address[](0),
                minActionInterval: INTERVAL,
                periodLength: PERIOD,
                expiry: 0,
                allocation: RevenueAllocationLib.Allocation({
                    operationsBps: 6000, buybacksBps: 0, developerBps: 3000, protocolBps: 1000
                }),
                metadataURI: "ipfs://agent",
                expectation: IAgentIdentityRegistry.MarketExpectation({
                    token: expectedToken, quoteAsset: NATIVE, model: 0, expectedSupply: SUPPLY, launchNonce: 1
                })
            })
        );
    }

    /// @dev A distinct salt per test, named rather than numbered. Hashed rather
    /// than left as a string literal so the value is a `bytes32` outright: the
    /// cast would be safe, but a test file that suppresses truncation warnings
    /// teaches the habit of suppressing them.
    function _salt(string memory name) internal pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    /// @dev Where `create` will put the token, known before the launch because
    /// `VerdantDeployer` uses `CREATE2` under a salt derived from the creator. This
    /// is what lets an agent commit to a market that does not exist yet.
    function _predictToken(address creator, bytes32 salt) internal view returns (address) {
        bytes32 initCodeHash = deployer.tokenInitCodeHash(NAME, SYMBOL, SUPPLY, creator, METADATA_URI, false);
        return vm.computeCreate2Address(verdant.saltFor(creator, salt), initCodeHash, address(deployer));
    }

    function _launchParams(address creator) internal pure returns (VerdantFactory.CreateParams memory) {
        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](1);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: STAGE0_FEE});

        return VerdantFactory.CreateParams({
            name: NAME,
            symbol: SYMBOL,
            metadataURI: METADATA_URI,
            metadataMutable: false,
            supplyTokens: SUPPLY_TOKENS,
            model: 0,
            quoteAsset: NATIVE,
            stages: stages,
            initialTick: INITIAL_TICK,
            creatorAllocationBps: 500,
            vestingCliff: 0,
            vestingDuration: 0,
            feeRecipient: creator,
            salt: bytes32(0),
            initialBuyAmount: 0,
            initialBuyMinTokens: 0
        });
    }

    function _modelBounds() internal pure returns (ModelRegistry.ModelBounds[] memory bounds) {
        bounds = new ModelRegistry.ModelBounds[](3);
        bounds[0] =
            ModelRegistry.ModelBounds({enabled: true, minStages: 1, maxStages: 1, minReserveBps: 0, maxReserveBps: 0});
        bounds[1] =
            ModelRegistry.ModelBounds({enabled: true, minStages: 2, maxStages: 8, minReserveBps: 0, maxReserveBps: 0});
        bounds[2] = ModelRegistry.ModelBounds({
            enabled: true, minStages: 1, maxStages: 8, minReserveBps: 1_000, maxReserveBps: 8_000
        });
    }

    function _buy(VerdantFactory.Created memory market, uint256 ethIn) internal {
        PoolKey memory key = verdant.poolKeyFor(NATIVE, market.token);

        vm.prank(trader);
        swapRouter.swap{value: ethIn}(
            key,
            SwapParams({
                zeroForOne: true,
                // forge-lint: disable-next-line(unsafe-typecast) -- test amounts, far below int256
                amountSpecified: -int256(ethIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev A well-formed mint through the same PositionManager the factory used.
    /// It is refused because `beforeAddLiquidity` asks that contract who initiated,
    /// and the answer is not the factory — which after creation is true of every
    /// address there is.
    function _expectMintRefused(VerdantFactory.Created memory market, address who) internal {
        PoolKey memory key = verdant.poolKeyFor(NATIVE, market.token);

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            VerdantConstants.MIN_USABLE_TICK,
            INITIAL_TICK,
            uint256(1e18),
            uint128(0),
            type(uint128).max,
            who,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);

        vm.deal(who, who.balance + 1 ether);

        vm.prank(who);
        vm.expectRevert();
        posm.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }
}
