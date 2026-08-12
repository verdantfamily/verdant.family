// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentFixture} from "./AgentFixture.sol";

import {AgentActionLib} from "../../src/agents/AgentActionLib.sol";
import {AgentExecutionModule} from "../../src/agents/AgentExecutionModule.sol";
import {AgentMandate} from "../../src/agents/AgentMandate.sol";
import {AgentRevenueRouter} from "../../src/agents/AgentRevenueRouter.sol";
import {AgentTreasury} from "../../src/agents/AgentTreasury.sol";
import {IAgentLaunchFactory} from "../../src/agents/IAgentLaunchFactory.sol";

/// @title The agent layer — what it costs to run one
///
/// @notice Six figures, chosen because each is paid repeatedly by somebody who did
/// not choose to pay it. A launch is paid once by a developer and is a fair cost of
/// entry; an action is paid on every decision an agent makes; settlement and
/// entitlement claims are paid by whoever is kind enough to move somebody else's
/// money. A permissionless function that becomes expensive is a permissionless
/// function nobody calls, which is how a "trustless" settlement path quietly becomes
/// a keeper the protocol depends on.
///
/// @dev The `assertLt` budgets are deliberately loose; the committed snapshot is the
/// tight check. A budget catches a collapse, a snapshot diff catches a drift.
///
/// Named `...GasTest` because CI's snapshot check is scoped to that suffix — a
/// whole-project snapshot would include fuzz averages, which move with the seed, and
/// the vector suites, whose cost is dominated by JSON parsing.
contract AgentGasTest is AgentFixture {
    bytes32 internal providerAgentId;
    AgentRevenueRouter internal providerRouter;
    bytes32 internal serviceId;
    uint32 internal serviceVersion;

    uint256 internal constant PRICE = 0.25 ether;

    function setUp() public override {
        super.setUp();

        IAgentLaunchFactory.AgentAddresses memory p = _createAgent(provider, _label("provider"), new address[](0));
        providerAgentId = p.agentId;
        providerRouter = AgentRevenueRouter(payable(p.router));
        _bind(providerAgentId, bytes32(uint256(0xf00d)));
        _activate(providerAgentId);

        vm.prank(provider);
        (serviceId, serviceVersion) = serviceRegistry.register(
            providerAgentId, _label("data"), "https://example.test/data", keccak256("s"), NATIVE, PRICE
        );

        // The buying agent is rebuilt so its mandate approves the provider's router,
        // which is only knowable once the provider exists.
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

        _fundTreasury(10 ether, 0);
    }

    /// @notice Creating an agent: four contracts, one record, one event.
    ///
    /// @dev Paid once, by the developer, before anybody else is involved. It is
    /// large because it is four deployments, and it is measured so that it stays
    /// four deployments rather than quietly becoming six.
    function test_gas_createAgent() public {
        IAgentLaunchFactory.AgentParams memory params = _params(_label("gas"), _targets());

        vm.prank(developer);
        uint256 before = gasleft();
        factory.createAgent(params);
        uint256 used = before - gasleft();

        assertLt(used, 6_500_000, "creating an agent has become far more expensive");
    }

    /// @notice Proving a market belongs to an agent.
    ///
    /// @dev Permissionless, so it has to stay cheap enough that a stranger will pay
    /// it. It reads the market record, the splitter and the token's supply, then
    /// rebuilds one hash.
    function test_gas_bindMarket() public {
        bytes32 pool = bytes32(uint256(0xb17d));
        bytes32 id = _createAgent(developer, _label("bind-gas"), _targets()).agentId;
        _registerMarket(pool, address(_marketTokenFor(id)), identity.agentOf(id).router, developer);

        uint256 before = gasleft();
        identity.bindMarket(id, pool);
        uint256 used = before - gasleft();

        assertLt(used, 250_000, "binding has become far more expensive");
    }

    /// @notice One action: the whole authorisation path, then a transfer.
    ///
    /// @dev The figure an operator pays on every decision the agent makes. It
    /// crosses the module, the identity registry, the mandate, the service registry
    /// and the treasury, so it is the number that would move if any of those grew a
    /// storage read.
    function test_gas_payService() public {
        AgentActionLib.ServiceQuote memory quote = _quote(_label("req-1"));

        vm.prank(operator);
        uint256 before = gasleft();
        module.payService(quote);
        uint256 used = before - gasleft();

        assertLt(used, 400_000, "an action has become far more expensive");
    }

    /// @notice The second action, once every slot it touches is warm.
    ///
    /// @dev The honest steady-state cost. The first action of an agent's life pays
    /// for cold slots and for starting a period, and quoting that number as "what an
    /// action costs" would overstate it for every action after the first.
    function test_gas_payService_warm() public {
        AgentActionLib.ServiceQuote memory first = _quote(_label("req-1"));
        vm.prank(operator);
        module.payService(first);

        vm.warp(block.timestamp + INTERVAL);

        AgentActionLib.ServiceQuote memory second = _quote(_label("req-2"));
        vm.prank(operator);
        uint256 before = gasleft();
        module.payService(second);
        uint256 used = before - gasleft();

        assertLt(used, 250_000, "a warm action has become far more expensive");
    }

    /// @notice Dividing revenue across four legs.
    ///
    /// @dev Permissionless. It recomputes every leg's lifetime entitlement rather
    /// than splitting the increment, which is the design's one deliberate extra cost
    /// — four `mulDiv`s to make the split independent of how the money arrived.
    function test_gas_allocate() public {
        _payRouter(1 ether);
        router.recognise(NATIVE);

        uint256 before = gasleft();
        router.allocate(NATIVE);
        uint256 used = before - gasleft();

        assertLt(used, 250_000, "allocation has become far more expensive");
    }

    /// @notice Claiming a fixed entitlement.
    ///
    /// @dev The developer's share, settled by anybody, in any lifecycle state. Not
    /// an agent action and priced like one: this is the number that decides whether
    /// a developer can afford to collect a small balance.
    function test_gas_claimDeveloperEntitlement() public {
        _payRouter(1 ether);
        router.recognise(NATIVE);
        router.allocate(NATIVE);

        uint256 before = gasleft();
        router.claimDeveloperEntitlement(NATIVE);
        uint256 used = before - gasleft();

        assertLt(used, 100_000, "claiming an entitlement has become far more expensive");
    }

    function _payRouter(uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        (bool ok,) = address(router).call{value: amount}("");
        require(ok, "pay");
    }

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
}
