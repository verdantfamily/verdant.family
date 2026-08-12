// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentFixture} from "./AgentFixture.sol";

import {IAgentServiceRegistry} from "../../src/agents/IAgentServiceRegistry.sol";

/// @title AgentServiceRegistryTest
/// @notice The only mutable part of an agent, and the versioning that makes that
/// mutability safe for the people quoting against it.
contract AgentServiceRegistryTest is AgentFixture {
    bytes32 internal serviceId;
    uint32 internal version;

    function setUp() public override {
        super.setUp();
        _bindAndActivate();

        vm.prank(developer);
        (serviceId, version) = serviceRegistry.register(
            agentId, _label("summaries"), "https://example.test/v1", keccak256("schema-v1"), NATIVE, 0.1 ether
        );
    }

    function test_aServiceRecordsWhatIsOnOfferAndWhereToPay() public view {
        IAgentServiceRegistry.Service memory service = serviceRegistry.serviceOf(serviceId);

        assertEq(service.agentId, agentId, "agent");
        assertEq(service.version, 1, "version starts at one");
        assertEq(service.endpoint, "https://example.test/v1", "endpoint");
        assertEq(service.schemaHash, keccak256("schema-v1"), "schema");
        assertEq(service.paymentAsset, NATIVE, "asset");
        assertEq(service.price, 0.1 ether, "price");
        assertTrue(service.active, "active");
        assertEq(service.deprecatedAt, 0, "deprecatedAt");

        // Payment goes to the provider's revenue router, so buying a service and
        // funding an agent are the same act.
        assertEq(serviceRegistry.payeeOf(serviceId), address(router), "payee");

        // The seam an alternative settlement path plugs into, empty until one exists.
        assertEq(service.paymentAdapter, address(0), "adapter");
    }

    function test_versionsStartAtOneSoAZeroQuoteNeverMatches() public view {
        // Zero is what an unset field reads as. A quote carrying version 0 must not
        // match a real service.
        assertEq(version, 1, "first version");
        assertTrue(serviceRegistry.serviceOf(serviceId).version != 0, "version is zero");
    }

    // --- versioning ------------------------------------------------------------

    function test_everyChangeBumpsTheVersion() public {
        vm.startPrank(developer);

        uint32 second = serviceRegistry.update(serviceId, "https://example.test/v2", keccak256("s2"), 0.2 ether, true);
        assertEq(second, 2, "after update");

        uint32 third = serviceRegistry.update(serviceId, "https://example.test/v2", keccak256("s2"), 0.2 ether, true);

        // Unconditional, even when nothing material changed. A version that only
        // moves when the registry judges the change significant has to be trusted;
        // one that moves on every write can be compared.
        assertEq(third, 3, "an unchanged update still bumps");

        vm.stopPrank();
    }

    function test_retiringBumpsTheVersionToo() public {
        vm.prank(developer);
        uint32 retired = serviceRegistry.retire(serviceId);

        assertEq(retired, 2, "version");
        assertEq(serviceRegistry.serviceOf(serviceId).deprecatedAt, uint64(block.timestamp), "deprecatedAt");
    }

    function test_thePaymentAssetCannotBeChanged() public pure {
        // Absent from `update` entirely. A caller who approved an amount of one
        // asset and found the service repriced in another has been handed a
        // different deal under the same id.
        assertEq(
            IAgentServiceRegistry.update.selector,
            bytes4(keccak256("update(bytes32,string,bytes32,uint256,bool)")),
            "update takes an asset"
        );
    }

    // --- ids ---------------------------------------------------------------------

    function test_serviceIdsAreNamespacedByAgent() public {
        (bytes32 otherAgent, bytes32 otherService) = _registerElsewhere(_label("summaries"));

        assertTrue(otherService != serviceId, "ids collided");
        assertEq(serviceRegistry.serviceIdFor(agentId, _label("summaries")), serviceId, "derivation");
        assertEq(serviceRegistry.serviceOf(otherService).agentId, otherAgent, "owner");
    }

    function _registerElsewhere(bytes32 name) internal returns (bytes32 otherAgent, bytes32 otherService) {
        otherAgent = _createAgent(stranger, _label("other"), _targets()).agentId;
        _bind(otherAgent, bytes32(uint256(0xb0b)));
        _activate(otherAgent);

        vm.prank(stranger);
        (otherService,) =
            serviceRegistry.register(otherAgent, name, "https://example.test/other", keccak256("s"), NATIVE, 1 ether);
    }

    function test_oneAgentCannotRegisterTheSameNameTwice() public {
        vm.prank(developer);
        vm.expectRevert(abi.encodeWithSelector(IAgentServiceRegistry.ServiceExists.selector, serviceId));
        serviceRegistry.register(agentId, _label("summaries"), "https://elsewhere", keccak256("s"), NATIVE, 1);
    }

    // --- who may change what -------------------------------------------------------

    function test_onlyTheDeveloperMayRegisterOrChangeAService() public {
        address[3] memory nobody = [operator, guardian, stranger];

        for (uint256 i = 0; i < nobody.length; i++) {
            // Not the agent itself: a runtime that could rewrite its own price list
            // could sell nothing for everything, and the operator key is assumed
            // hostile.
            vm.prank(nobody[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgentServiceRegistry.NotDeveloper.selector, nobody[i]));
            serviceRegistry.update(serviceId, "https://theirs", keccak256("s"), 1, true);

            vm.prank(nobody[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgentServiceRegistry.NotDeveloper.selector, nobody[i]));
            serviceRegistry.retire(serviceId);
        }
    }

    function test_theDeveloperMayRepriceAndMove() public {
        vm.prank(developer);
        serviceRegistry.update(serviceId, "https://example.test/v2", keccak256("schema-v2"), 0.2 ether, true);

        IAgentServiceRegistry.Service memory service = serviceRegistry.serviceOf(serviceId);
        assertEq(service.endpoint, "https://example.test/v2", "endpoint");
        assertEq(service.price, 0.2 ether, "price");

        // An endpoint that cannot be moved is an agent that dies with its first
        // hosting provider. That is why this is allowed to change and the mandate is
        // not.
        assertEq(service.paymentAsset, NATIVE, "the payment asset moved");
    }

    function test_retiringDeactivatesRatherThanDeletes() public {
        vm.prank(developer);
        serviceRegistry.retire(serviceId);

        assertFalse(serviceRegistry.isActive(serviceId), "still active");

        // The record of what was on offer, and at what price, is what somebody who
        // paid for it needs afterwards.
        IAgentServiceRegistry.Service memory service = serviceRegistry.serviceOf(serviceId);
        assertEq(service.price, 0.1 ether, "price was erased");
        assertEq(service.endpoint, "https://example.test/v1", "endpoint was erased");
    }

    // --- the lifecycle gates ---------------------------------------------------------

    function test_anAgentWithoutAMarketCannotRegisterAService() public {
        bytes32 unbound = _createAgent(developer, _label("unbound"), _targets()).agentId;

        // `Created`: there is nothing to sell against yet.
        vm.prank(developer);
        vm.expectRevert(abi.encodeWithSelector(IAgentServiceRegistry.AgentCannotConfigureServices.selector, unbound));
        serviceRegistry.register(unbound, _label("early"), "https://example.test", keccak256("s"), NATIVE, 1);
    }

    function test_aBoundAgentMayConfigureServicesBeforeActivation() public {
        bytes32 bound = _createAgent(developer, _label("bound"), _targets()).agentId;
        _bind(bound, bytes32(uint256(0xb17)));

        vm.prank(developer);
        serviceRegistry.register(bound, _label("early"), "https://example.test", keccak256("s"), NATIVE, 1);
    }

    function test_aStoppedAgentsServicesAreNotActiveAndCannotBeChanged() public {
        vm.prank(guardian);
        identity.pause(agentId);

        // The check belongs here rather than only in a paying agent's module,
        // otherwise every consumer has to remember to make it.
        assertFalse(serviceRegistry.isActive(serviceId), "a paused agent is still selling");

        vm.prank(developer);
        vm.expectRevert(abi.encodeWithSelector(IAgentServiceRegistry.AgentCannotConfigureServices.selector, agentId));
        serviceRegistry.update(serviceId, "https://example.test/v2", keccak256("s"), 1, true);
    }

    function test_aRevokedAgentCannotRegisterAnything() public {
        vm.prank(guardian);
        identity.revoke(agentId);

        vm.prank(developer);
        vm.expectRevert(abi.encodeWithSelector(IAgentServiceRegistry.AgentCannotConfigureServices.selector, agentId));
        serviceRegistry.register(agentId, _label("new"), "https://example.test/new", keccak256("s"), NATIVE, 1);
    }

    // --- bad input ---------------------------------------------------------------------

    function test_aServiceNeedsANameAnEndpointAndAPrice() public {
        vm.startPrank(developer);

        vm.expectRevert(IAgentServiceRegistry.ZeroName.selector);
        serviceRegistry.register(agentId, bytes32(0), "https://example.test", keccak256("s"), NATIVE, 1);

        vm.expectRevert(IAgentServiceRegistry.ZeroEndpoint.selector);
        serviceRegistry.register(agentId, _label("a"), "", keccak256("s"), NATIVE, 1);

        // A free service is not expressible, on purpose: a price of zero makes a
        // payment of nothing, which the treasury refuses anyway.
        vm.expectRevert(IAgentServiceRegistry.ZeroPrice.selector);
        serviceRegistry.register(agentId, _label("a"), "https://example.test", keccak256("s"), NATIVE, 0);

        vm.stopPrank();
    }

    function test_readingAnUnknownServiceReverts() public {
        bytes32 ghost = _label("ghost");

        vm.expectRevert(abi.encodeWithSelector(IAgentServiceRegistry.UnknownService.selector, ghost));
        serviceRegistry.serviceOf(ghost);

        assertFalse(serviceRegistry.isActive(ghost), "an unknown service is active");
    }

    function test_servicesAreListedPerAgent() public {
        vm.prank(developer);
        serviceRegistry.register(agentId, _label("second"), "https://example.test/2", keccak256("s"), NATIVE, 1);

        bytes32[] memory listed = serviceRegistry.servicesOf(agentId);
        assertEq(listed.length, 2, "count");
        assertEq(listed[0], serviceId, "first");
    }
}
