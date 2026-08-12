// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {AgentActionLib} from "../../src/agents/AgentActionLib.sol";
import {AgentExecutionModule} from "../../src/agents/AgentExecutionModule.sol";
import {AgentIdentityRegistry} from "../../src/agents/AgentIdentityRegistry.sol";
import {AgentLaunchFactory} from "../../src/agents/AgentLaunchFactory.sol";
import {AgentLifecycle} from "../../src/agents/AgentLifecycle.sol";
import {AgentMandate} from "../../src/agents/AgentMandate.sol";
import {AgentRevenueRouter} from "../../src/agents/AgentRevenueRouter.sol";
import {AgentServiceRegistry} from "../../src/agents/AgentServiceRegistry.sol";
import {AgentTreasury} from "../../src/agents/AgentTreasury.sol";
import {IAgentIdentityRegistry} from "../../src/agents/IAgentIdentityRegistry.sol";
import {IAgentLaunchFactory} from "../../src/agents/IAgentLaunchFactory.sol";
import {IAgentMandate} from "../../src/agents/IAgentMandate.sol";
import {RevenueAllocationLib} from "../../src/agents/RevenueAllocationLib.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";

contract InvariantToken is ERC20 {
    constructor(uint256 supply) ERC20("Agent", "AGENT") {
        _mint(msg.sender, supply);
    }
}

/// @notice Drives one agent through arbitrary sequences of everything anybody may do
/// to it, so the invariants below are asserted against states nobody wrote a test
/// for.
///
/// @dev Every handler swallows the reverts that are correct behaviour — a limit
/// being hit, a lifecycle transition that is not permitted, a period that has not
/// rolled — because the invariant suite is asking "can the contracts reach a bad
/// state", not "does every call succeed".
contract AgentHandler is Test {
    AgentRevenueRouter public immutable router;
    AgentTreasury public immutable treasury;
    AgentExecutionModule public immutable module;
    AgentMandate public immutable mandate;
    AgentIdentityRegistry public immutable identity;
    AgentServiceRegistry public immutable services;

    address public immutable operator;
    address public immutable guardian;
    address public immutable developer;
    bytes32 public immutable agentId;

    address internal constant NATIVE = address(0);

    /// @notice Everything ever sent to the router, so the invariants can compare
    /// against a number this contract computed rather than one the router did.
    uint256 public paidIn;

    uint256 public actionsExecuted;

    /// @notice True once the agent has ever been revoked, so the terminality of that
    /// state can be asserted rather than assumed.
    bool public everRevoked;

    constructor(
        AgentRevenueRouter router_,
        AgentTreasury treasury_,
        AgentExecutionModule module_,
        AgentMandate mandate_,
        AgentIdentityRegistry identity_,
        AgentServiceRegistry services_,
        address operator_,
        address guardian_,
        address developer_,
        bytes32 agentId_
    ) {
        router = router_;
        treasury = treasury_;
        module = module_;
        mandate = mandate_;
        identity = identity_;
        services = services_;
        operator = operator_;
        guardian = guardian_;
        developer = developer_;
        agentId = agentId_;
    }

    receive() external payable {}

    function _noteState() internal {
        if (identity.stateOf(agentId) == AgentLifecycle.State.Revoked) everRevoked = true;
    }

    // --- money in -------------------------------------------------------------

    function payRouter(uint96 amount) external {
        amount = uint96(bound(amount, 1, 100 ether));
        vm.deal(address(this), address(this).balance + amount);

        (bool ok,) = address(router).call{value: amount}("");
        if (ok) paidIn += amount;
    }

    function recognise() external {
        try router.recognise(NATIVE) {} catch {}
    }

    function allocate() external {
        try router.allocate(NATIVE) {} catch {}
    }

    function settle(uint256 leg) external {
        try router.settle(NATIVE, leg % 4) {} catch {}
    }

    function claimDeveloper() external {
        try router.claimDeveloperEntitlement(NATIVE) {} catch {}
    }

    function claimProtocol() external {
        try router.claimProtocolEntitlement(NATIVE) {} catch {}
    }

    function recogniseTreasury() external {
        try treasury.recognise(NATIVE) {} catch {}
    }

    // --- lifecycle ------------------------------------------------------------

    function activate() external {
        vm.prank(developer);
        try identity.activate(agentId) {} catch {}
        _noteState();
    }

    function pauseOrResume(bool pause) external {
        vm.prank(guardian);
        if (pause) {
            try identity.pause(agentId) {} catch {}
        } else {
            try identity.resume(agentId) {} catch {}
        }
        _noteState();
    }

    function revoke() external {
        vm.prank(guardian);
        try identity.revoke(agentId) {} catch {}
        _noteState();
    }

    function pauseTreasury(bool pause) external {
        vm.prank(guardian);
        if (pause) {
            try treasury.pause() {} catch {}
        } else {
            try treasury.unpause() {} catch {}
        }
    }

    // --- money out ------------------------------------------------------------

    /// @dev Every field is taken from the registry, as the real path does, so a
    /// successful call here is a genuinely well-formed action rather than one the
    /// handler contrived.
    function payService(uint32 skipSeconds, bytes32 requestId) external {
        vm.warp(block.timestamp + (skipSeconds % 3 days));

        bytes32[] memory owned = services.servicesOf(agentId);
        if (owned.length == 0) return;

        AgentActionLib.ServiceQuote memory quote = AgentActionLib.ServiceQuote({
            agentId: agentId,
            providerAgentId: agentId,
            serviceId: owned[0],
            serviceVersion: services.serviceOf(owned[0]).version,
            provider: services.payeeOf(owned[0]),
            asset: NATIVE,
            exactAmount: services.serviceOf(owned[0]).price,
            requestId: requestId,
            deadline: block.timestamp + 1,
            nonce: module.nextNonce()
        });

        vm.prank(operator);
        try module.payService(quote) {
            actionsExecuted++;
        } catch {}
    }
}

/// @title AgentInvariantsTest
/// @notice The claims that must hold in every state, not merely the ones a unit test
/// happened to construct.
contract AgentInvariantsTest is Test {
    address internal constant NATIVE = address(0);

    AgentLaunchFactory internal factory;
    AgentIdentityRegistry internal identity;
    AgentServiceRegistry internal serviceRegistry;
    AgentHandler internal handler;
    MarketRegistry internal markets;
    InvariantToken internal marketToken;

    AgentRevenueRouter internal router;
    AgentTreasury internal treasury;
    AgentExecutionModule internal module;
    AgentMandate internal mandate;

    address internal developer = makeAddr("developer");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal protocolTreasury = makeAddr("protocolTreasury");

    uint256 internal constant SUPPLY = 1_000_000e18;

    bytes32 internal agentId;

    function setUp() public {
        vm.warp(1_800_000_000);

        markets = new MarketRegistry(address(this));
        marketToken = new InvariantToken(SUPPLY);
        factory = new AgentLaunchFactory(address(markets), protocolTreasury);
        identity = factory.identityRegistry();
        serviceRegistry = factory.serviceRegistry();

        IAgentMandate.AssetLimit[] memory limits = new IAgentMandate.AssetLimit[](1);
        limits[0] = IAgentMandate.AssetLimit({asset: NATIVE, maxActionValue: 2 ether, periodLimit: 5 ether});

        // The agent buys from itself, which keeps the handler to one agent while
        // still exercising a real, registry-resolved payment.
        //
        // The placeholder is there because the prediction below actually deploys a
        // mandate, and `AgentMandate` refuses a zero target. Which address it is
        // does not matter: a router's address depends on the deployer's nonce, not
        // on what the mandate approves.
        address[] memory targets = new address[](1);
        targets[0] = address(0xdead);

        bytes32 salt = keccak256("invariant");
        address predictedRouter = _predictRouter(salt, limits, targets);
        targets[0] = predictedRouter;

        vm.prank(developer);
        IAgentLaunchFactory.AgentAddresses memory created = factory.createAgent(_params(salt, limits, targets));

        agentId = created.agentId;
        mandate = AgentMandate(created.mandate);
        treasury = AgentTreasury(payable(created.treasury));
        router = AgentRevenueRouter(payable(created.router));
        module = AgentExecutionModule(created.executionModule);

        _bind(agentId, bytes32(uint256(0xa11ce)));

        vm.prank(developer);
        identity.activate(agentId);

        vm.prank(developer);
        serviceRegistry.register(agentId, keccak256("svc"), "https://example.test", keccak256("s"), NATIVE, 0.5 ether);

        handler = new AgentHandler(
            router, treasury, module, mandate, identity, serviceRegistry, operator, guardian, developer, agentId
        );
        targetContract(address(handler));
    }

    function _params(bytes32 salt, IAgentMandate.AssetLimit[] memory limits, address[] memory targets)
        internal
        view
        returns (IAgentLaunchFactory.AgentParams memory)
    {
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
            metadataURI: "",
            expectation: IAgentIdentityRegistry.MarketExpectation({
                token: address(marketToken), quoteAsset: NATIVE, model: 0, expectedSupply: SUPPLY, launchNonce: 1
            })
        });
    }

    /// @dev The router's address is needed before it exists, so the agent's own
    /// mandate can approve it. Created on a throwaway factory at the same nonce
    /// sequence rather than predicted arithmetically, which would encode the
    /// deployer's internals into a test.
    function _predictRouter(bytes32 salt, IAgentMandate.AssetLimit[] memory limits, address[] memory targets)
        internal
        returns (address)
    {
        uint256 snapshot = vm.snapshotState();

        vm.prank(developer);
        IAgentLaunchFactory.AgentAddresses memory trial = factory.createAgent(_params(salt, limits, targets));
        address predicted = trial.router;

        vm.revertToState(snapshot);
        return predicted;
    }

    function _bind(bytes32 id, bytes32 poolId) internal {
        IAgentIdentityRegistry.Agent memory agent = identity.agentOf(id);
        address splitter = address(new FeeSplitter(agent.router, protocolTreasury, NATIVE, address(marketToken), 1000));

        markets.register(
            MarketRegistry.Market({
                poolId: poolId,
                token: address(marketToken),
                quoteAsset: NATIVE,
                creator: agent.developer,
                model: 0,
                createdAt: uint40(block.timestamp),
                creatorBps: 8000,
                protocolBps: 1000,
                reserveBps: 1000,
                positionTokenId: 1,
                locker: makeAddr("locker"),
                splitter: splitter,
                vesting: address(0)
            })
        );

        identity.bindMarket(id, poolId);
    }

    // --- the money -------------------------------------------------------------

    /// @notice The router never owes more than it holds.
    function invariant_theRouterCanPayWhatItHasPromised() public view {
        uint256 owed;
        for (uint256 leg = 0; leg < 4; leg++) {
            owed += router.pending(NATIVE, leg);
        }

        assertLe(owed, address(router).balance, "the router promised more than it holds");
    }

    /// @notice claimed <= entitled <= received, per asset. Nothing is created and
    /// nothing is destroyed.
    function invariant_claimedNeverExceedsEntitledNeverExceedsReceived() public view {
        uint256 received = router.totalReceived(NATIVE);
        RevenueAllocationLib.Legs memory owed = RevenueAllocationLib.entitlements(received, router.allocation());

        uint256 allocated;
        uint256 settled;

        for (uint256 leg = 0; leg < 4; leg++) {
            uint256 entitled = RevenueAllocationLib.legAt(owed, leg);

            assertLe(router.totalSettled(NATIVE, leg), router.totalAllocated(NATIVE, leg), "claimed > allocated");
            assertLe(router.totalAllocated(NATIVE, leg), entitled, "allocated > entitled");
            assertLe(entitled, received, "entitled > received");

            allocated += router.totalAllocated(NATIVE, leg);
            settled += router.totalSettled(NATIVE, leg);
        }

        assertLe(allocated, received, "allocated more than arrived");
        assertLe(settled, allocated, "settled more than allocated");
        assertEq(received, allocated + router.unallocated(NATIVE), "the books do not balance");
    }

    /// @notice At most three units of an agent's revenue can ever be stranded.
    ///
    /// @dev Stated carefully, because the obvious phrasing is wrong: `unallocated`
    /// counts revenue nobody has got round to allocating as well as the dust, and
    /// immediately after `recognise` that is the whole payment. The claim worth
    /// making is about what no leg will ever be entitled to.
    function invariant_nothingIsPermanentlyStranded() public view {
        uint256 received = router.totalReceived(NATIVE);
        RevenueAllocationLib.Legs memory owed = RevenueAllocationLib.entitlements(received, router.allocation());

        assertLe(
            received - RevenueAllocationLib.totalOf(owed),
            RevenueAllocationLib.MAX_UNALLOCATED_DUST,
            "more than three units can never be allocated"
        );
    }

    /// @notice A leg with no share is never owed anything.
    function invariant_aLegWithNoShareIsNeverOwedAnything() public view {
        assertEq(router.totalAllocated(NATIVE, 1), 0, "buybacks were allocated");
        assertEq(router.pending(NATIVE, 1), 0, "buybacks are owed");
    }

    /// @notice Spending never passes the mandate, whatever order things happened in.
    function invariant_theTreasuryNeverOutspendsItsMandate() public view {
        IAgentMandate.AssetLimit memory limit = mandate.limitFor(NATIVE);

        assertLe(
            treasury.spentInPeriod(NATIVE, uint64(block.timestamp)), limit.periodLimit, "the period limit was passed"
        );
    }

    /// @notice The nonce counts executions and nothing else.
    function invariant_theNonceMatchesTheNumberOfExecutedActions() public view {
        assertEq(module.nextNonce(), handler.actionsExecuted(), "the nonce and the action count disagree");
    }

    // --- the lifecycle ------------------------------------------------------------

    /// @notice Revocation is terminal, however the handler got there.
    function invariant_aRevokedAgentStaysRevoked() public view {
        if (!handler.everRevoked()) return;

        assertEq(
            uint8(identity.stateOf(agentId)), uint8(AgentLifecycle.State.Revoked), "a revoked agent left that state"
        );
        assertFalse(identity.isActive(agentId), "a revoked agent is active");
    }

    /// @notice An agent that is not `Active` has never executed anything from that state.
    function invariant_onlyAnActiveAgentCouldHaveExecuted() public view {
        if (module.nextNonce() == 0) return;

        // Something executed, so the agent must have reached `Active` at some point.
        assertTrue(identity.agentOf(agentId).activatedAt != 0, "executed without ever activating");
    }

    /// @notice Nothing anybody can do reaches the mandate.
    function invariant_theMandateNeverChanges() public view {
        IAgentMandate.AssetLimit memory limit = mandate.limitFor(NATIVE);

        assertEq(limit.maxActionValue, 2 ether, "per-action cap moved");
        assertEq(limit.periodLimit, 5 ether, "period cap moved");
        assertEq(mandate.periodLength(), 1 days, "period length moved");
        assertEq(mandate.minActionInterval(), 1 minutes, "interval moved");
        assertEq(mandate.expiry(), 0, "expiry moved");
        assertEq(mandate.guardian(), guardian, "guardian moved");
    }

    /// @notice Nothing anybody can do reaches the split or its destinations.
    function invariant_theSplitNeverChanges() public view {
        RevenueAllocationLib.Allocation memory allocation = router.allocation();

        assertEq(allocation.operationsBps, 6000, "operations");
        assertEq(allocation.buybacksBps, 0, "buybacks");
        assertEq(allocation.developerBps, 3000, "developer");
        assertEq(allocation.protocolBps, 1000, "protocol");

        assertEq(router.destinationOf(0), address(treasury), "operations destination");
        assertEq(router.destinationOf(2), developer, "developer destination");
        assertEq(router.destinationOf(3), protocolTreasury, "protocol destination");
    }

    /// @notice The market an agent proved is the market it keeps.
    function invariant_theBoundMarketNeverMoves() public view {
        IAgentIdentityRegistry.Agent memory agent = identity.agentOf(agentId);

        assertEq(agent.poolId, bytes32(uint256(0xa11ce)), "poolId moved");
        assertEq(agent.token, address(marketToken), "token moved");
        assertEq(identity.agentByPool(bytes32(uint256(0xa11ce))), agentId, "reverse lookup moved");
    }

    /// @notice The wiring an agent was launched with is the wiring it dies with.
    function invariant_theComponentsStayBoundToEachOther() public view {
        assertEq(treasury.executionModule(), address(module), "treasury's module");
        assertEq(module.treasury(), address(treasury), "module's treasury");
        assertEq(treasury.mandate(), address(mandate), "treasury's mandate");
        assertEq(module.mandate(), address(mandate), "module's mandate");
    }

    /// @notice The guardian moves no money, in any state, ever.
    function invariant_theGuardianHoldsNothing() public view {
        assertEq(guardian.balance, 0, "the guardian was paid");
    }
}
