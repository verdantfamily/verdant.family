// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentFixture, TestToken} from "./AgentFixture.sol";

import {AgentIdentityRegistry} from "../../src/agents/AgentIdentityRegistry.sol";
import {AgentLifecycle} from "../../src/agents/AgentLifecycle.sol";
import {IAgentIdentityRegistry} from "../../src/agents/IAgentIdentityRegistry.sol";
import {IAgentLaunchFactory} from "../../src/agents/IAgentLaunchFactory.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";

/// @title AgentIdentityRegistryTest
/// @notice Binding is a proof against a commitment, and the guardian's power is
/// exactly two things.
contract AgentIdentityRegistryTest is AgentFixture {
    bytes32 internal constant POOL = bytes32(uint256(0xa11ce));

    // --- the commitment ------------------------------------------------------

    function test_anAgentIsCreatedUnboundAndInert() public view {
        IAgentIdentityRegistry.Agent memory agent = identity.agentOf(agentId);

        assertEq(uint8(agent.state), uint8(AgentLifecycle.State.Created), "state");
        assertEq(agent.poolId, bytes32(0), "poolId");
        assertEq(agent.token, address(0), "token");
        assertEq(agent.marketBoundAt, 0, "marketBoundAt");
        assertEq(agent.activatedAt, 0, "activatedAt");
        assertFalse(identity.isActive(agentId), "a fresh agent is active");
        assertFalse(identity.mayConfigureServices(agentId), "a fresh agent can sell");
    }

    function test_theCommitmentIsRecordedAndReproducible() public view {
        IAgentIdentityRegistry.Agent memory agent = identity.agentOf(agentId);

        assertEq(
            agent.marketCommitment,
            identity.commitmentFor(developer, agent.router, _expectation()),
            "the SDK could not reproduce the commitment"
        );
        assertEq(agent.expectation.token, address(marketToken), "expected token");
        assertEq(agent.expectation.expectedSupply, MARKET_SUPPLY, "expected supply");
    }

    function test_aCommitmentDoesNotTravelBetweenAgents() public {
        IAgentLaunchFactory.AgentAddresses memory other = _createAgent(stranger, _label("other"), _targets());

        // Same expectation, different developer and different router, so a different
        // commitment. Otherwise one agent's proof would satisfy another's.
        assertTrue(
            identity.agentOf(agentId).marketCommitment != identity.agentOf(other.agentId).marketCommitment,
            "commitments collide across agents"
        );
    }

    // --- binding -------------------------------------------------------------

    function test_anyoneMayBindAMarketThatSatisfiesTheCommitment() public {
        address splitter = _registerMarket(POOL, address(marketToken), address(router), developer);

        vm.expectEmit(true, true, false, true, address(identity));
        emit IAgentIdentityRegistry.MarketBound(agentId, POOL, address(marketToken), splitter);

        // A stranger, not the developer. The check is a proof rather than a
        // permission, so restricting the caller would add a failure mode and remove
        // none.
        vm.prank(stranger);
        identity.bindMarket(agentId, POOL);

        IAgentIdentityRegistry.Agent memory agent = identity.agentOf(agentId);
        assertEq(uint8(agent.state), uint8(AgentLifecycle.State.MarketBound), "state");
        assertEq(agent.poolId, POOL, "poolId");
        assertEq(agent.token, address(marketToken), "token");
        assertEq(agent.marketBoundAt, uint64(block.timestamp), "marketBoundAt");
        assertEq(identity.agentByPool(POOL), agentId, "reverse lookup");
    }

    function test_bindingDoesNotSwitchExecutionOn() public {
        _bind(agentId, POOL);

        // Binding is permissionless. If it also activated, a stranger would decide
        // when an agent starts spending.
        assertFalse(identity.isActive(agentId), "binding activated the agent");
        assertTrue(identity.mayConfigureServices(agentId), "a bound agent cannot be configured");
    }

    function test_aMarketPayingSomebodyElseCannotBeBound() public {
        // The splitter pays a person rather than this agent's router, which is what
        // every ordinary Verdant market looks like.
        _registerMarket(POOL, address(marketToken), developer, developer);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentIdentityRegistry.MarketNotOwnedByAgent.selector, POOL, developer, address(router)
            )
        );
        identity.bindMarket(agentId, POOL);
    }

    function test_aMarketLaunchedBySomebodyElseCannotBeBound() public {
        // Pays the right router, created by the wrong person. `market.creator` is
        // `msg.sender` on the unmodified launch path, so this asserts the developer
        // launched their own agent's market.
        _registerMarket(POOL, address(marketToken), address(router), stranger);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentIdentityRegistry.MarketNotCreatedByDeveloper.selector, POOL, stranger, developer
            )
        );
        identity.bindMarket(agentId, POOL);
    }

    function test_aMarketWithTheWrongTokenCannotBeBound() public {
        TestToken other = new TestToken("Other", "OTHER", MARKET_SUPPLY);
        _registerMarket(POOL, address(other), address(router), developer);

        // Pays the right router, launched by the right developer, wrong token. Only
        // the commitment catches this.
        vm.expectRevert();
        identity.bindMarket(agentId, POOL);
    }

    function test_aMarketWithTheWrongSupplyCannotBeBound() public {
        TestToken wrongSupply = new TestToken("Agent Token", "AGENT", MARKET_SUPPLY + 1);
        _registerMarket(POOL, address(wrongSupply), address(router), developer);

        vm.expectRevert();
        identity.bindMarket(agentId, POOL);
    }

    function test_theCommitmentMismatchNamesBothHashes() public {
        TestToken other = new TestToken("Other", "OTHER", MARKET_SUPPLY);
        _registerMarket(POOL, address(other), address(router), developer);

        IAgentIdentityRegistry.Agent memory agent = identity.agentOf(agentId);
        bytes32 actual = identity.commitmentFor(
            developer,
            agent.router,
            IAgentIdentityRegistry.MarketExpectation({
                token: address(other),
                quoteAsset: NATIVE,
                model: MARKET_MODEL,
                expectedSupply: MARKET_SUPPLY,
                launchNonce: LAUNCH_NONCE
            })
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentIdentityRegistry.MarketCommitmentMismatch.selector, agent.marketCommitment, actual
            )
        );
        identity.bindMarket(agentId, POOL);
    }

    function test_aMarketTheFactoryNeverCreatedCannotBeBound() public {
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.UnknownMarket.selector, POOL));
        identity.bindMarket(agentId, POOL);
    }

    function test_anAgentBindsOnce() public {
        _bind(agentId, POOL);

        // A second market, and a second token for it: `MarketRegistry` maps a token
        // to one pool, so reusing the first market's token would fail there instead
        // of reaching the lifecycle check this test is about.
        bytes32 second = bytes32(uint256(0xb0b));
        TestToken secondToken = new TestToken("Agent Token", "AGENT", MARKET_SUPPLY);
        _registerMarket(second, address(secondToken), address(router), developer);

        // The lifecycle refuses it before the pool index does: `MarketBound` has no
        // transition back to `MarketBound`.
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentLifecycle.IllegalTransition.selector,
                AgentLifecycle.State.MarketBound,
                AgentLifecycle.State.MarketBound
            )
        );
        identity.bindMarket(agentId, second);
    }

    function test_aMarketBindsOnce() public {
        _bind(agentId, POOL);

        IAgentLaunchFactory.AgentAddresses memory other = _createAgent(stranger, _label("other"), _targets());

        vm.expectRevert(abi.encodeWithSelector(IAgentIdentityRegistry.MarketAlreadyBound.selector, POOL, agentId));
        identity.bindMarket(other.agentId, POOL);
    }

    function test_aRevokedAgentCannotBind() public {
        _registerMarket(POOL, address(marketToken), address(router), developer);

        vm.prank(guardian);
        identity.revoke(agentId);

        vm.expectRevert(
            abi.encodeWithSelector(
                AgentLifecycle.IllegalTransition.selector,
                AgentLifecycle.State.Revoked,
                AgentLifecycle.State.MarketBound
            )
        );
        identity.bindMarket(agentId, POOL);
    }

    function test_anUnknownAgentCannotBind() public {
        bytes32 ghost = _label("ghost");
        vm.expectRevert(abi.encodeWithSelector(IAgentIdentityRegistry.UnknownAgent.selector, ghost));
        identity.bindMarket(ghost, POOL);
    }

    // --- activation ----------------------------------------------------------

    function test_theDeveloperActivates() public {
        _bind(agentId, POOL);

        vm.prank(developer);
        identity.activate(agentId);

        IAgentIdentityRegistry.Agent memory agent = identity.agentOf(agentId);
        assertEq(uint8(agent.state), uint8(AgentLifecycle.State.Active), "state");
        assertEq(agent.activatedAt, uint64(block.timestamp), "activatedAt");
        assertTrue(identity.isActive(agentId), "not active");
    }

    function test_nobodyElseMayActivate() public {
        _bind(agentId, POOL);

        address[3] memory nobody = [guardian, operator, stranger];
        for (uint256 i = 0; i < nobody.length; i++) {
            vm.prank(nobody[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgentIdentityRegistry.NotDeveloper.selector, nobody[i]));
            identity.activate(agentId);
        }
    }

    function test_anUnboundAgentCannotBeActivated() public {
        vm.prank(developer);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentLifecycle.IllegalTransition.selector, AgentLifecycle.State.Created, AgentLifecycle.State.Active
            )
        );
        identity.activate(agentId);
    }

    // --- the guardian --------------------------------------------------------

    function test_theGuardianMayPauseAndResumeAnActiveAgent() public {
        _bindAndActivate();

        vm.prank(guardian);
        identity.pause(agentId);
        assertEq(uint8(_state(agentId)), uint8(AgentLifecycle.State.Paused), "paused");
        assertFalse(identity.isActive(agentId), "paused agent is active");

        vm.prank(guardian);
        identity.resume(agentId);
        assertEq(uint8(_state(agentId)), uint8(AgentLifecycle.State.Active), "resumed");
    }

    function test_anAgentThatHasNotStartedCannotBePaused() public {
        // Pausing something that cannot execute would be a state meaning nothing and
        // a resume with an ambiguous destination. The answer for an agent that has
        // not started is revocation, which works from anywhere.
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentLifecycle.IllegalTransition.selector, AgentLifecycle.State.Created, AgentLifecycle.State.Paused
            )
        );
        identity.pause(agentId);
    }

    function test_revocationWorksFromEveryLiveState() public {
        // Created
        vm.prank(guardian);
        identity.revoke(agentId);
        assertEq(uint8(_state(agentId)), uint8(AgentLifecycle.State.Revoked), "from Created");

        // MarketBound
        IAgentLaunchFactory.AgentAddresses memory bound = _createAgent(developer, _label("bound"), _targets());
        _bind(bound.agentId, bytes32(uint256(0xb1)));
        vm.prank(guardian);
        identity.revoke(bound.agentId);
        assertEq(uint8(_state(bound.agentId)), uint8(AgentLifecycle.State.Revoked), "from MarketBound");

        // Active
        IAgentLaunchFactory.AgentAddresses memory active = _createAgent(developer, _label("active"), _targets());
        _bind(active.agentId, bytes32(uint256(0xb2)));
        _activate(active.agentId);
        vm.prank(guardian);
        identity.revoke(active.agentId);
        assertEq(uint8(_state(active.agentId)), uint8(AgentLifecycle.State.Revoked), "from Active");

        // Paused
        IAgentLaunchFactory.AgentAddresses memory paused = _createAgent(developer, _label("paused"), _targets());
        _bind(paused.agentId, bytes32(uint256(0xb3)));
        _activate(paused.agentId);
        vm.startPrank(guardian);
        identity.pause(paused.agentId);
        identity.revoke(paused.agentId);
        vm.stopPrank();
        assertEq(uint8(_state(paused.agentId)), uint8(AgentLifecycle.State.Revoked), "from Paused");
    }

    function test_revocationIsTerminalForEveryone() public {
        _bindAndActivate();

        vm.prank(guardian);
        identity.revoke(agentId);

        address[4] memory everyone = [guardian, developer, operator, address(factory)];
        for (uint256 i = 0; i < everyone.length; i++) {
            vm.prank(everyone[i]);
            vm.expectRevert();
            identity.resume(agentId);

            vm.prank(everyone[i]);
            vm.expectRevert();
            identity.activate(agentId);
        }

        assertFalse(identity.isActive(agentId), "a revoked agent came back");
    }

    function test_onlyTheGuardianMayStopAnAgent() public {
        _bindAndActivate();

        address[3] memory nobody = [developer, operator, stranger];
        for (uint256 i = 0; i < nobody.length; i++) {
            vm.prank(nobody[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgentIdentityRegistry.NotGuardian.selector, nobody[i]));
            identity.pause(agentId);

            vm.prank(nobody[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgentIdentityRegistry.NotGuardian.selector, nobody[i]));
            identity.revoke(agentId);
        }
    }

    function test_everyStateChangeIsAnnounced() public {
        _bind(agentId, POOL);

        vm.expectEmit(true, true, true, true, address(identity));
        emit IAgentIdentityRegistry.AgentStateChanged(
            agentId, AgentLifecycle.State.MarketBound, AgentLifecycle.State.Active, developer
        );

        vm.prank(developer);
        identity.activate(agentId);
    }

    // --- metadata ------------------------------------------------------------

    function test_theDeveloperMayRepointMetadataAndNobodyElseMay() public {
        vm.prank(developer);
        identity.setMetadataURI(agentId, "ipfs://new");
        assertEq(identity.agentOf(agentId).metadataURI, "ipfs://new", "metadata");

        address[3] memory nobody = [guardian, operator, stranger];
        for (uint256 i = 0; i < nobody.length; i++) {
            vm.prank(nobody[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgentIdentityRegistry.NotDeveloper.selector, nobody[i]));
            identity.setMetadataURI(agentId, "ipfs://theirs");
        }
    }

    function test_metadataCannotBeChangedAfterRevocation() public {
        vm.prank(guardian);
        identity.revoke(agentId);

        vm.prank(developer);
        vm.expectRevert();
        identity.setMetadataURI(agentId, "ipfs://after");
    }

    // --- reading -------------------------------------------------------------

    function test_readingAnUnknownAgentRevertsRatherThanReturningZeros() public {
        bytes32 ghost = _label("ghost");

        vm.expectRevert(abi.encodeWithSelector(IAgentIdentityRegistry.UnknownAgent.selector, ghost));
        identity.agentOf(ghost);

        vm.expectRevert(abi.encodeWithSelector(IAgentIdentityRegistry.UnknownAgent.selector, ghost));
        identity.stateOf(ghost);

        assertFalse(identity.isActive(ghost), "an unknown agent is active");
        assertFalse(identity.mayConfigureServices(ghost), "an unknown agent can sell");
    }

    function test_theRegistryIndexesAgentsInCreationOrder() public {
        IAgentLaunchFactory.AgentAddresses memory second = _createAgent(stranger, _label("second"), _targets());

        assertEq(identity.agentCount(), 2, "count");
        assertEq(identity.agentAt(0).treasury, address(treasury), "first");
        assertEq(identity.agentAt(1).treasury, second.treasury, "second");
        assertEq(identity.agentByTreasury(second.treasury), second.agentId, "by treasury");
    }

    function test_theRegistryRejectsAnIncompleteRegistration() public {
        vm.prank(address(factory));
        vm.expectRevert(AgentIdentityRegistry.ZeroAddressInRegistration.selector);
        identity.register(
            developer,
            _label("incomplete"),
            IAgentIdentityRegistry.Registration({
                developer: developer,
                guardian: guardian,
                mandate: address(0),
                treasury: makeAddr("t"),
                router: makeAddr("r"),
                executionModule: makeAddr("m"),
                serviceRegistry: address(serviceRegistry),
                metadataURI: "",
                expectation: _expectation()
            })
        );
    }

    function test_theRegistryRejectsAnUnsatisfiableExpectation() public {
        IAgentIdentityRegistry.MarketExpectation memory empty = _expectation();
        empty.token = address(0);

        // A commitment nothing can ever satisfy would leave an agent stuck in
        // `Created` while reading as a launch that worked.
        vm.prank(address(factory));
        vm.expectRevert(AgentIdentityRegistry.ZeroExpectedToken.selector);
        identity.register(
            developer,
            _label("no-token"),
            IAgentIdentityRegistry.Registration({
                developer: developer,
                guardian: guardian,
                mandate: makeAddr("mandate"),
                treasury: makeAddr("t"),
                router: makeAddr("r"),
                executionModule: makeAddr("m"),
                serviceRegistry: address(serviceRegistry),
                metadataURI: "",
                expectation: empty
            })
        );
    }
}
