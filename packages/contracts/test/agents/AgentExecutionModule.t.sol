// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentFixture} from "./AgentFixture.sol";

import {AgentActionLib} from "../../src/agents/AgentActionLib.sol";
import {AgentExecutionModule} from "../../src/agents/AgentExecutionModule.sol";
import {AgentLifecycle} from "../../src/agents/AgentLifecycle.sol";
import {AgentMandate} from "../../src/agents/AgentMandate.sol";
import {AgentRevenueRouter} from "../../src/agents/AgentRevenueRouter.sol";
import {AgentTreasury} from "../../src/agents/AgentTreasury.sol";
import {IAgentExecutionModule} from "../../src/agents/IAgentExecutionModule.sol";
import {IAgentLaunchFactory} from "../../src/agents/IAgentLaunchFactory.sol";
import {IAgentMandate} from "../../src/agents/IAgentMandate.sol";
import {IAgentServiceRegistry} from "../../src/agents/IAgentServiceRegistry.sol";
import {IAgentTreasury} from "../../src/agents/IAgentTreasury.sol";

/// @title AgentExecutionModuleTest
/// @notice The one thing an agent can do, and everything that refuses it.
contract AgentExecutionModuleTest is AgentFixture {
    bytes32 internal providerAgentId;
    AgentRevenueRouter internal providerRouter;
    bytes32 internal serviceId;
    uint32 internal serviceVersion;

    uint256 internal constant PRICE = 0.25 ether;

    function setUp() public override {
        super.setUp();

        // The provider first, because the buying agent's mandate must approve the
        // provider's router and that address is only known once it exists.
        IAgentLaunchFactory.AgentAddresses memory p = _createAgent(provider, _label("provider"), new address[](0));
        providerAgentId = p.agentId;
        providerRouter = AgentRevenueRouter(payable(p.router));

        _bind(providerAgentId, bytes32(uint256(0xf00d)));
        _activate(providerAgentId);

        address[] memory targets = new address[](1);
        targets[0] = address(providerRouter);

        IAgentLaunchFactory.AgentAddresses memory buyer = _createAgent(developer, _label("buyer"), targets);
        agentId = buyer.agentId;
        mandate = AgentMandate(buyer.mandate);
        treasury = AgentTreasury(payable(buyer.treasury));
        router = AgentRevenueRouter(payable(buyer.router));
        module = AgentExecutionModule(buyer.executionModule);

        _bind(agentId, bytes32(uint256(0xbeef)));
        _activate(agentId);

        vm.prank(provider);
        (serviceId, serviceVersion) = serviceRegistry.register(
            providerAgentId, _label("market-data"), "https://example.test/data", keccak256("schema"), NATIVE, PRICE
        );

        _fundTreasury(10 ether, 100_000e18);
    }

    // --- building quotes ------------------------------------------------------
    // Each of these reads `nextNonce`, which is an external call. Build the quote
    // into a local *before* `vm.prank`, or the prank is spent on the nonce read and
    // the action arrives from the test contract.

    function _quote(bytes32 requestId) internal view returns (AgentActionLib.ServiceQuote memory) {
        return AgentActionLib.ServiceQuote({
            agentId: agentId,
            providerAgentId: providerAgentId,
            serviceId: serviceId,
            serviceVersion: serviceVersion,
            provider: address(providerRouter),
            asset: NATIVE,
            exactAmount: PRICE,
            requestId: requestId,
            deadline: block.timestamp + 1 hours,
            nonce: module.nextNonce()
        });
    }

    // --- the happy path --------------------------------------------------------

    function test_payingForAServiceSendsTheListedPriceToTheProvidersRouter() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req-1"));

        vm.prank(operator);
        bytes32 actionHash = module.payService(quote);

        // Buying a service and funding an agent are the same act: payment lands in
        // the provider's revenue router, where it divides by the provider's split.
        assertEq(address(providerRouter).balance, PRICE, "provider router");
        assertEq(module.nextNonce(), 1, "nonce");
        assertTrue(module.isRequestSettled(_label("req-1")), "request not recorded");
        assertEq(actionHash, AgentActionLib.hash(quote), "hash");
    }

    function test_theOnlyActionIsPayingForAService() public view {
        // `PayDeveloper` and `PayProtocol` were removed: fixed entitlements are
        // settled permissionlessly on the router and are not the agent's to decide.
        assertEq(uint8(type(AgentActionLib.ActionType).max), 0, "more than one action type exists");
    }

    // --- who may act ------------------------------------------------------------

    function test_onlyTheOperatorMayAct() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
        address[3] memory nobody = [developer, guardian, stranger];

        for (uint256 i = 0; i < nobody.length; i++) {
            vm.prank(nobody[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgentExecutionModule.NotOperator.selector, nobody[i]));
            module.payService(quote);
        }
    }

    function test_aQuoteForAnotherAgentIsRefused() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
        quote.agentId = _label("somebody else");

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IAgentExecutionModule.WrongAgent.selector, agentId, quote.agentId));
        module.payService(quote);
    }

    // --- the lifecycle gates -----------------------------------------------------

    function test_onlyAnActiveAgentExecutes() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));

        vm.prank(guardian);
        identity.pause(agentId);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IAgentExecutionModule.AgentNotActive.selector, agentId));
        module.payService(quote);
    }

    function test_aBoundButUnactivatedAgentCannotExecute() public {
        IAgentLaunchFactory.AgentAddresses memory fresh = _createAgent(developer, _label("fresh"), _targets());
        _bind(fresh.agentId, bytes32(uint256(0xcafe)));

        AgentExecutionModule freshModule = AgentExecutionModule(fresh.executionModule);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IAgentExecutionModule.AgentNotActive.selector, fresh.agentId));
        freshModule.payService(
            AgentActionLib.ServiceQuote({
                agentId: fresh.agentId,
                providerAgentId: providerAgentId,
                serviceId: serviceId,
                serviceVersion: serviceVersion,
                provider: address(providerRouter),
                asset: NATIVE,
                exactAmount: PRICE,
                requestId: _label("req"),
                deadline: block.timestamp + 1 hours,
                nonce: 0
            })
        );
    }

    function test_aRevokedAgentNeverExecutesAgain() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));

        vm.prank(guardian);
        identity.revoke(agentId);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IAgentExecutionModule.AgentNotActive.selector, agentId));
        module.payService(quote);
    }

    function test_aRevokedMandateStopsTheAgentEvenIfTheRegistrySaysActive() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));

        vm.prank(guardian);
        mandate.revoke();

        assertTrue(identity.isActive(agentId), "the registry should still say active");

        vm.prank(operator);
        vm.expectRevert(IAgentExecutionModule.MandateIsRevoked.selector);
        module.payService(quote);
    }

    function test_onlyTheGuardianMayRevokeTheMandate() public {
        vm.prank(developer);
        vm.expectRevert(abi.encodeWithSelector(IAgentMandate.NotGuardian.selector, developer));
        mandate.revoke();
    }

    // --- replay, staleness, ordering ---------------------------------------------

    function test_aQuoteExecutesOnce() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));

        vm.prank(operator);
        module.payService(quote);

        vm.warp(block.timestamp + INTERVAL);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IAgentExecutionModule.NonceOutOfOrder.selector, 1, 0));
        module.payService(quote);
    }

    function test_aRequestIsPaidOnceEvenUnderANewNonce() public {
        AgentActionLib.ServiceQuote memory first = _quote(_label("invoice-7"));

        vm.prank(operator);
        module.payService(first);

        vm.warp(block.timestamp + INTERVAL);

        // A fresh nonce, the same invoice. The nonce alone would let this through.
        AgentActionLib.ServiceQuote memory again = _quote(_label("invoice-7"));

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentExecutionModule.RequestAlreadySettled.selector, _label("invoice-7"))
        );
        module.payService(again);
    }

    function test_anExpiredQuoteIsRefused() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
        quote.deadline = block.timestamp;

        vm.warp(block.timestamp + 1);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentExecutionModule.QuoteExpired.selector, quote.deadline, uint64(block.timestamp))
        );
        module.payService(quote);
    }

    function test_aQuoteIsGoodInTheSecondItExpires() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
        quote.deadline = block.timestamp;

        vm.prank(operator);
        module.payService(quote);
    }

    function test_actionsAreRateLimited() public {
        AgentActionLib.ServiceQuote memory first = _quote(_label("a"));
        vm.prank(operator);
        module.payService(first);

        uint64 earliest = uint64(block.timestamp) + INTERVAL;

        AgentActionLib.ServiceQuote memory tooSoon = _quote(_label("b"));
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentExecutionModule.ActionTooSoon.selector, earliest, uint64(block.timestamp))
        );
        module.payService(tooSoon);

        vm.warp(earliest);
        AgentActionLib.ServiceQuote memory onTime = _quote(_label("c"));
        vm.prank(operator);
        module.payService(onTime);
    }

    // --- versioning ---------------------------------------------------------------

    function test_aQuotePricedBeforeARepriceIsRefused() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));

        // The provider reprices between the human approving and the transaction
        // landing. Without versioning this would pay the new number silently.
        vm.prank(provider);
        uint32 newVersion =
            serviceRegistry.update(serviceId, "https://example.test/data", keccak256("schema"), PRICE * 2, true);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentExecutionModule.ServiceVersionStale.selector, serviceId, newVersion, serviceVersion
            )
        );
        module.payService(quote);
    }

    function test_aRequoteAtTheNewVersionSucceeds() public {
        vm.prank(provider);
        uint32 newVersion =
            serviceRegistry.update(serviceId, "https://example.test/v2", keccak256("schema"), 0.5 ether, true);

        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
        quote.serviceVersion = newVersion;
        quote.exactAmount = 0.5 ether;

        vm.prank(operator);
        module.payService(quote);

        assertEq(address(providerRouter).balance, 0.5 ether, "paid the new price");
    }

    function test_aQuoteCarryingAFutureVersionIsRefused() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
        quote.serviceVersion = serviceVersion + 5;

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentExecutionModule.ServiceVersionStale.selector, serviceId, serviceVersion, quote.serviceVersion
            )
        );
        module.payService(quote);
    }

    // --- what a quote cannot say ----------------------------------------------------

    function test_anAgentCannotOverpayOrUnderpay() public {
        for (uint256 i = 0; i < 2; i++) {
            AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
            quote.exactAmount = i == 0 ? PRICE + 1 : PRICE - 1;

            vm.prank(operator);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAgentExecutionModule.ServicePriceMismatch.selector, serviceId, PRICE, quote.exactAmount
                )
            );
            module.payService(quote);
        }
    }

    function test_anAgentCannotPayInADifferentAsset() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
        quote.asset = address(token);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentExecutionModule.ServiceAssetMismatch.selector, serviceId, NATIVE, address(token)
            )
        );
        module.payService(quote);
    }

    function test_anAgentCannotRedirectPaymentByNamingADifferentProvider() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
        quote.provider = stranger;

        // The registry is the source of truth. The quote's copy is compared, never
        // used, so naming a different address is refused rather than honoured.
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentExecutionModule.ProviderMismatch.selector, serviceId, address(providerRouter), stranger
            )
        );
        module.payService(quote);
    }

    function test_anAgentCannotNameTheWrongProviderForAService() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
        quote.providerAgentId = agentId;

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IAgentExecutionModule.ServiceNotOwnedBy.selector, serviceId, agentId));
        module.payService(quote);
    }

    function test_anUnknownServiceCannotBePaid() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
        quote.serviceId = _label("nothing");

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IAgentServiceRegistry.UnknownService.selector, quote.serviceId));
        module.payService(quote);
    }

    function test_aRetiredServiceCannotBePaid() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));

        vm.prank(provider);
        serviceRegistry.retire(serviceId);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IAgentExecutionModule.ServiceInactive.selector, serviceId));
        module.payService(quote);
    }

    function test_aServiceWhoseProviderWasStoppedCannotBePaid() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));

        vm.prank(guardian);
        identity.pause(providerAgentId);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IAgentExecutionModule.ServiceInactive.selector, serviceId));
        module.payService(quote);
    }

    function test_aServiceWhosePayeeIsNotApprovedCannotBePaid() public {
        // A third agent's service: real, active, correctly priced, and paying an
        // address this agent's mandate never approved.
        IAgentLaunchFactory.AgentAddresses memory outsider =
            _createAgent(stranger, _label("outsider"), new address[](0));
        _bind(outsider.agentId, bytes32(uint256(0xd00d)));
        _activate(outsider.agentId);

        vm.prank(stranger);
        (bytes32 outsideService, uint32 outsideVersion) = serviceRegistry.register(
            outsider.agentId, _label("x"), "https://example.test/x", keccak256("s"), NATIVE, PRICE
        );

        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
        quote.providerAgentId = outsider.agentId;
        quote.serviceId = outsideService;
        quote.serviceVersion = outsideVersion;
        quote.provider = outsider.router;

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IAgentExecutionModule.TargetNotApproved.selector, outsider.router));
        module.payService(quote);
    }

    // --- the treasury's rules still apply ---------------------------------------------

    function test_theTreasurysLimitsBindTheModuleToo() public {
        vm.prank(provider);
        uint32 v = serviceRegistry.update(
            serviceId, "https://example.test/data", keccak256("schema"), MAX_ACTION_NATIVE + 1, true
        );

        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
        quote.serviceVersion = v;
        quote.exactAmount = MAX_ACTION_NATIVE + 1;

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentTreasury.ActionValueExceeded.selector, NATIVE, MAX_ACTION_NATIVE + 1, MAX_ACTION_NATIVE
            )
        );
        module.payService(quote);
    }

    function test_aFailedActionConsumesNoNonce() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req"));
        quote.exactAmount = PRICE + 1;

        vm.prank(operator);
        vm.expectRevert();
        module.payService(quote);

        assertEq(module.nextNonce(), 0, "a rejected action moved the nonce");
        assertFalse(module.isRequestSettled(_label("req")), "a rejected action settled its request");
    }
}
