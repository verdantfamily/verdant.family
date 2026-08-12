// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

import {AgentFixture} from "./AgentFixture.sol";
import {Abi} from "../utils/Abi.sol";

import {AgentDeployer} from "../../src/agents/AgentDeployer.sol";
import {AgentExecutionDeployer} from "../../src/agents/AgentExecutionDeployer.sol";
import {AgentLaunchFactory} from "../../src/agents/AgentLaunchFactory.sol";
import {AgentLifecycle} from "../../src/agents/AgentLifecycle.sol";
import {AgentMandate} from "../../src/agents/AgentMandate.sol";
import {IAgentIdentityRegistry} from "../../src/agents/IAgentIdentityRegistry.sol";
import {IAgentLaunchFactory} from "../../src/agents/IAgentLaunchFactory.sol";
import {IAgentMandate} from "../../src/agents/IAgentMandate.sol";
import {RevenueAllocationLib} from "../../src/agents/RevenueAllocationLib.sol";

/// @title AgentLaunchTest
/// @notice One transaction produces one agent, wired the way the record says it is.
contract AgentLaunchTest is AgentFixture {
    using Abi for string;

    function test_everyComponentKnowsItsAgent() public view {
        assertEq(mandate.agentId(), agentId, "mandate");
        assertEq(treasury.agentId(), agentId, "treasury");
        assertEq(router.agentId(), agentId, "router");
        assertEq(module.agentId(), agentId, "module");
    }

    function test_theRecordMatchesTheContractsItNames() public view {
        IAgentIdentityRegistry.Agent memory agent = identity.agentOf(agentId);

        assertEq(agent.developer, developer, "developer");
        assertEq(agent.guardian, guardian, "guardian");
        assertEq(agent.mandate, address(mandate), "mandate");
        assertEq(agent.treasury, address(treasury), "treasury");
        assertEq(agent.router, address(router), "router");
        assertEq(agent.executionModule, address(module), "module");
        assertEq(agent.serviceRegistry, address(serviceRegistry), "services");
        assertEq(uint8(agent.state), uint8(AgentLifecycle.State.Created), "state");
        assertEq(agent.metadataURI, "ipfs://agent", "metadata");
    }

    function test_theModuleAndItsTreasuryPointAtEachOther() public view {
        assertEq(module.treasury(), address(treasury), "module knows treasury");
        assertEq(treasury.executionModule(), address(module), "treasury knows module");
    }

    function test_theDeveloperIsTheCallerAndNotAParameter() public {
        IAgentLaunchFactory.AgentAddresses memory other = _createAgent(stranger, _label("other"), _targets());

        assertEq(identity.agentOf(other.agentId).developer, stranger, "the caller is the developer");
    }

    function test_theDeveloperCannotNameTheProtocolsAddress() public view {
        // Absent from the parameter struct entirely. A developer who could name it
        // would be naming their own, and the protocol leg would be a second developer
        // leg wearing a different label.
        assertEq(router.protocolTreasury(), protocolTreasury, "router");
    }

    function test_theSplitIsWhatTheDeveloperChose() public view {
        RevenueAllocationLib.Allocation memory allocation = router.allocation();

        assertEq(allocation.operationsBps, 6000, "operations");
        assertEq(allocation.buybacksBps, 0, "buybacks");
        assertEq(allocation.developerBps, 3000, "developer");
        assertEq(allocation.protocolBps, 1000, "protocol");
    }

    function test_agentIdsAreNamespacedByDeveloper() public view {
        assertTrue(
            identity.agentIdFor(developer, _label("s")) != identity.agentIdFor(stranger, _label("s")),
            "ids collide across developers"
        );
    }

    function test_oneDeveloperCannotReuseASalt() public {
        vm.prank(developer);
        vm.expectRevert();
        factory.createAgent(_params(_label("agent-1"), _targets()));
    }

    function test_launchEmitsEverythingAnIndexerNeeds() public {
        bytes32 expectedId = identity.agentIdFor(developer, _label("emit"));

        vm.recordLogs();
        vm.prank(developer);
        IAgentLaunchFactory.AgentAddresses memory created = factory.createAgent(_params(_label("emit"), _targets()));

        bool found;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != IAgentLaunchFactory.AgentLaunched.selector) continue;

            assertEq(logs[i].topics[1], expectedId, "agentId");
            assertEq(address(uint160(uint256(logs[i].topics[2]))), developer, "developer");
            assertEq(address(uint160(uint256(logs[i].topics[3]))), operator, "operator");

            _assertLaunchedBody(logs[i].data, created);
            found = true;
        }

        assertTrue(found, "AgentLaunched was not emitted");
    }

    /// @dev The unindexed half of `AgentLaunched`, checked against what the launch
    /// returned. Its own frame: ten decoded fields do not fit alongside the log
    /// array and the loop the caller is holding.
    function _assertLaunchedBody(bytes memory data, IAgentLaunchFactory.AgentAddresses memory created) private view {
        (
            address emittedGuardian,
            address emittedMandate,
            address emittedTreasury,
            address emittedRouter,
            address emittedModule,
            uint16 operationsBps,
            uint16 buybacksBps,
            uint16 developerBps,
            uint16 protocolBps,
            bytes32 commitment
        ) = abi.decode(data, (address, address, address, address, address, uint16, uint16, uint16, uint16, bytes32));

        assertEq(emittedGuardian, guardian, "guardian");
        assertEq(emittedMandate, created.mandate, "mandate");
        assertEq(emittedTreasury, created.treasury, "treasury");
        assertEq(emittedRouter, created.router, "router");
        assertEq(emittedModule, created.executionModule, "module");
        assertEq(operationsBps + buybacksBps + developerBps + protocolBps, 10_000, "shares");
        assertEq(commitment, _storedCommitment(created.agentId), "commitment");
    }

    /// @dev Its own frame. `agentOf` returns the whole `Agent` record, and putting
    /// that in memory beside the ten decoded event fields is stack-too-deep.
    function _storedCommitment(bytes32 id) private view returns (bytes32) {
        return identity.agentOf(id).marketCommitment;
    }

    // --- the deployers ------------------------------------------------------

    function test_onlyTheFactoryMayDeployAnything() public {
        AgentDeployer deployer = factory.deployer();
        AgentExecutionDeployer executionDeployer = factory.executionDeployer();

        assertEq(deployer.factory(), address(factory), "deployer's factory");
        assertEq(executionDeployer.factory(), address(factory), "execution deployer's factory");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentDeployer.NotFactory.selector, stranger));
        deployer.deployRouter(agentId, address(treasury), developer, protocolTreasury, address(identity), _allocation());

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentExecutionDeployer.NotFactory.selector, stranger));
        executionDeployer.deployExecution(
            agentId, operator, address(mandate), guardian, address(serviceRegistry), address(identity)
        );
    }

    function test_onlyTheFactoryMayRegisterAnAgent() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgentIdentityRegistry.NotFactory.selector, stranger));
        identity.register(
            stranger,
            _label("forged"),
            IAgentIdentityRegistry.Registration({
                developer: stranger,
                guardian: stranger,
                mandate: address(mandate),
                treasury: address(treasury),
                router: address(router),
                executionModule: address(module),
                serviceRegistry: address(serviceRegistry),
                metadataURI: "",
                expectation: _expectation()
            })
        );
    }

    function test_theFactoryRejectsAZeroMarketRegistryOrProtocolTreasury() public {
        vm.expectRevert(AgentLaunchFactory.ZeroMarketRegistry.selector);
        new AgentLaunchFactory(address(0), protocolTreasury);

        vm.expectRevert(AgentLaunchFactory.ZeroProtocolTreasury.selector);
        new AgentLaunchFactory(address(markets), address(0));
    }

    // --- claims about the ABI rather than about behaviour -------------------

    function test_theExecutionModuleAcceptsNoRawCalldata() public view {
        // ADR-011's central claim, and an absence claim: it cannot be tested by
        // calling things, only by reading what the ABI declares.
        string memory abiSection = Abi.section("out/AgentExecutionModule.sol/AgentExecutionModule.json");

        assertFalse(abiSection.mentionsType("bytes"), "the module takes or returns raw bytes");
        assertFalse(abiSection.declaresFunction("execute"), "a generic executor exists");
        assertFalse(abiSection.declaresFunction("call"), "a call forwarder exists");
        assertFalse(abiSection.declaresFunction("multicall"), "a multicall exists");

        // The one action. `payDeveloper` and `payProtocol` were removed in Phase 2:
        // fixed entitlements are settled on the router and are not the agent's to
        // decide, so their absence here is a security property.
        assertTrue(abiSection.declaresFunction("payService"), "payService is missing");
        assertFalse(abiSection.declaresFunction("payDeveloper"), "payDeveloper is still an agent action");
        assertFalse(abiSection.declaresFunction("payProtocol"), "payProtocol is still an agent action");
    }

    function test_theTreasuryHasNoWayOutExceptSpend() public view {
        string memory abiSection = Abi.section("out/AgentTreasury.sol/AgentTreasury.json");

        assertFalse(abiSection.declaresFunction("withdraw"), "withdraw exists");
        assertFalse(abiSection.declaresFunction("sweep"), "sweep exists");
        assertFalse(abiSection.declaresFunction("rescue"), "rescue exists");
        assertFalse(abiSection.declaresFunction("transferOwnership"), "an owner exists");
        assertFalse(abiSection.declaresFunction("owner"), "an owner exists");
        assertFalse(abiSection.mentionsType("bytes"), "the treasury takes raw bytes");

        assertTrue(abiSection.declaresFunction("spend"), "spend is missing");
    }

    function test_theMandateHasNoSetters() public view {
        string memory abiSection = Abi.section("out/AgentMandate.sol/AgentMandate.json");

        assertFalse(abiSection.declaresFunction("setExpiry"), "expiry can be changed");
        assertFalse(abiSection.declaresFunction("setLimit"), "a limit can be changed");
        assertFalse(abiSection.declaresFunction("addAsset"), "an asset can be added");
        assertFalse(abiSection.declaresFunction("addTarget"), "a target can be added");
        assertFalse(abiSection.declaresFunction("setGuardian"), "the guardian can be changed");

        assertTrue(abiSection.declaresFunction("revoke"), "revoke is missing");
    }

    function test_theRouterCannotBeRepointedAndSettlesWithoutTheAgent() public view {
        string memory abiSection = Abi.section("out/AgentRevenueRouter.sol/AgentRevenueRouter.json");

        assertFalse(abiSection.declaresFunction("setAllocation"), "the split can be changed");
        assertFalse(abiSection.declaresFunction("setDeveloper"), "the developer leg can be repointed");
        assertFalse(abiSection.declaresFunction("setTreasury"), "the operations leg can be repointed");
        assertFalse(abiSection.declaresFunction("sweep"), "sweep exists");

        // Fixed entitlements are claimable here, by anybody, rather than paid by an
        // agent action.
        assertTrue(abiSection.declaresFunction("claimDeveloperEntitlement"), "developer claim is missing");
        assertTrue(abiSection.declaresFunction("claimProtocolEntitlement"), "protocol claim is missing");
    }

    function test_theIdentityRegistryCannotBeMadeToForgetAnAgent() public view {
        string memory abiSection = Abi.section("out/AgentIdentityRegistry.sol/AgentIdentityRegistry.json");

        assertFalse(abiSection.declaresFunction("unbindMarket"), "a market can be unbound");
        assertFalse(abiSection.declaresFunction("unrevoke"), "revocation can be undone");
        assertFalse(abiSection.declaresFunction("setState"), "state can be set directly");
        assertFalse(abiSection.declaresFunction("remove"), "an agent can be removed");

        assertTrue(abiSection.declaresFunction("bindMarket"), "bindMarket is missing");
        assertTrue(abiSection.declaresFunction("activate"), "activate is missing");
    }

    // --- the mandate's bounds ------------------------------------------------

    function test_aMandateNeedsAtLeastOneAsset() public {
        IAgentLaunchFactory.AgentParams memory params = _params(_label("empty"), _targets());
        params.limits = new IAgentMandate.AssetLimit[](0);

        vm.prank(developer);
        vm.expectRevert(IAgentMandate.NoApprovedAssets.selector);
        factory.createAgent(params);
    }

    function test_aMandateRejectsAZeroLimit() public {
        IAgentLaunchFactory.AgentParams memory params = _params(_label("zero"), _targets());
        params.limits[0].periodLimit = 0;

        vm.prank(developer);
        vm.expectRevert(abi.encodeWithSelector(IAgentMandate.ZeroLimit.selector, NATIVE));
        factory.createAgent(params);
    }

    function test_aMandateRejectsAPerActionCapAboveThePeriodCap() public {
        IAgentLaunchFactory.AgentParams memory params = _params(_label("inverted"), _targets());
        params.limits[0].maxActionValue = params.limits[0].periodLimit + 1;

        vm.prank(developer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentMandate.MaxActionValueAbovePeriodLimit.selector,
                NATIVE,
                params.limits[0].maxActionValue,
                params.limits[0].periodLimit
            )
        );
        factory.createAgent(params);
    }

    function test_aMandateRejectsADuplicateAsset() public {
        IAgentLaunchFactory.AgentParams memory params = _params(_label("dup"), _targets());
        params.limits[1].asset = NATIVE;

        vm.prank(developer);
        vm.expectRevert(abi.encodeWithSelector(IAgentMandate.DuplicateAsset.selector, NATIVE));
        factory.createAgent(params);
    }

    function test_aMandateRejectsAnExpiryThatHasAlreadyPassed() public {
        IAgentLaunchFactory.AgentParams memory params = _params(_label("stale"), _targets());
        params.expiry = uint64(block.timestamp);

        vm.prank(developer);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentMandate.ExpiryInThePast.selector, params.expiry, uint64(block.timestamp))
        );
        factory.createAgent(params);
    }

    function test_aMandateRejectsAPeriodOutsideItsBounds() public {
        IAgentLaunchFactory.AgentParams memory tooShort = _params(_label("short"), _targets());
        tooShort.periodLength = 59 minutes;

        vm.prank(developer);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.PeriodTooShort.selector, 59 minutes));
        factory.createAgent(tooShort);

        IAgentLaunchFactory.AgentParams memory tooLong = _params(_label("long"), _targets());
        tooLong.periodLength = 31 days;

        vm.prank(developer);
        vm.expectRevert(abi.encodeWithSelector(IAgentMandate.PeriodTooLong.selector, 31 days));
        factory.createAgent(tooLong);
    }

    // --- the buyback bucket ----------------------------------------------------

    function test_aBuybackShareIsRefusedUntilBuybacksExist() public {
        IAgentLaunchFactory.AgentParams memory params = _params(_label("buyback"), _targets());
        params.allocation = RevenueAllocationLib.Allocation({
            operationsBps: 5000, buybacksBps: 1000, developerBps: 3000, protocolBps: 1000
        });

        // A leg with a share and no destination would accumulate revenue nobody can
        // ever take. The preferred design of the two the spec allows: refuse the
        // configuration rather than build a reserved bucket for a module that does
        // not exist.
        vm.prank(developer);
        vm.expectRevert();
        factory.createAgent(params);
    }

    function test_theFourLegSchemaSurvivesEvenWithBuybacksOff() public view {
        // Kept for forward compatibility: the leg exists, is addressable, and is
        // simply held at zero until there is something to spend it on.
        assertEq(RevenueAllocationLib.LEG_COUNT, 4, "leg count");
        assertEq(router.destinationOf(1), address(0), "buybacks have no destination yet");
        assertEq(router.allocation().buybacksBps, 0, "buybacks must be zero");
    }
}
