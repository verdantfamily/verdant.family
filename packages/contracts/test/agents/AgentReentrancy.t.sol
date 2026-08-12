// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentFixture} from "./AgentFixture.sol";

import {AgentRevenueRouter} from "../../src/agents/AgentRevenueRouter.sol";
import {AgentTreasury} from "../../src/agents/AgentTreasury.sol";
import {IAgentRevenueRouter} from "../../src/agents/IAgentRevenueRouter.sol";
import {IAgentTreasury} from "../../src/agents/IAgentTreasury.sol";

/// @notice A payee that calls back into the treasury while it is being paid.
///
/// @dev It records what the treasury said about itself mid-payment, which is how the
/// "effects before interactions" claim is checked as a fact rather than read as a
/// comment.
contract ReentersTreasury {
    AgentTreasury public treasury;
    address public asset;

    bool public entered;
    uint256 public spentInPeriodDuringCall;
    uint256 public balanceDuringCall;
    bytes public spendFailure;

    function arm(AgentTreasury treasury_, address asset_) external {
        treasury = treasury_;
        asset = asset_;
    }

    receive() external payable {
        if (entered) return;
        entered = true;

        spentInPeriodDuringCall = treasury.spentInPeriod(asset, uint64(block.timestamp));
        balanceDuringCall = treasury.balanceOf(asset);

        // The second spend, from inside the first. The treasury's own caller check
        // is what refuses it, and the counters above are what would matter if it
        // did not.
        try treasury.spend(asset, address(this), 1, keccak256("reentrant")) {
            spendFailure = hex"";
        } catch (bytes memory err) {
            spendFailure = err;
        }
    }
}

/// @notice A revenue destination that calls back into the router while being settled.
contract ReentersRouter {
    AgentRevenueRouter public router;
    address public asset;
    uint256 public leg;

    bool public entered;
    uint256 public unrecognisedDuringCall;
    uint256 public pendingDuringCall;
    bytes public settleFailure;
    bytes public recogniseFailure;

    function arm(AgentRevenueRouter router_, address asset_, uint256 leg_) external {
        router = router_;
        asset = asset_;
        leg = leg_;
    }

    receive() external payable {
        if (entered) return;
        entered = true;

        unrecognisedDuringCall = router.unrecognised(asset);
        pendingDuringCall = router.pending(asset, leg);

        try router.settle(asset, leg) {
            settleFailure = hex"";
        } catch (bytes memory err) {
            settleFailure = err;
        }

        try router.recognise(asset) {
            recogniseFailure = hex"";
        } catch (bytes memory err) {
            recogniseFailure = err;
        }
    }
}

/// @title AgentReentrancyTest
/// @notice What a recipient can do to an agent from inside a payment it is receiving.
///
/// @dev Both contracts that move value out of an agent pay a bare `.call{value:}`
/// rather than `transfer`, deliberately — a 2 300 gas stipend is a liveness bug, and
/// one of the destinations is a contract. That choice hands the recipient a full call
/// frame, so "effects before interactions" stops being a style preference and becomes
/// the thing standing between an approved provider and the whole treasury.
///
/// The comments in `AgentTreasury.spend` and `AgentRevenueRouter._settle` both claim
/// the ordering is right. These tests are the claim, executed.
contract AgentReentrancyTest is AgentFixture {
    /// @dev The developer leg's index, in `RevenueAllocationLib`'s canonical order.
    uint256 internal constant LEG_DEVELOPER = 2;

    function setUp() public override {
        super.setUp();
        _fundTreasury(10 ether, 0);
    }

    // --- the treasury ---------------------------------------------------------

    /// @dev The property that makes the per-period cap a cap. If the counter were
    /// written after the transfer, a recipient that reentered would be measured
    /// against a period in which its own payment had not happened, and one approved
    /// provider could drain the period limit in a single call.
    function test_aRecipientReenteringASpendFindsTheCountersAlreadyWritten() public {
        ReentersTreasury payee = new ReentersTreasury();
        payee.arm(treasury, NATIVE);

        uint256 amount = 0.75 ether;

        vm.prank(address(module));
        treasury.spend(NATIVE, address(payee), amount, _label("action"));

        assertTrue(payee.entered(), "the recipient never got a call frame, so this proved nothing");

        // Mid-payment, the treasury already counted this spend against the period.
        assertEq(payee.spentInPeriodDuringCall(), amount, "the period counter was written after the transfer");

        // And the balance had already left, so nothing could be spent twice.
        assertEq(payee.balanceDuringCall(), 10 ether - amount, "the balance was still unreduced mid-call");

        // The reentrant spend was refused outright: the treasury has one caller.
        assertEq(
            payee.spendFailure(),
            abi.encodeWithSelector(IAgentTreasury.NotExecutionModule.selector, address(payee)),
            "a payee reentered the treasury and was not refused as a stranger"
        );

        assertEq(treasury.totalSpent(NATIVE), amount, "the books recorded a second spend");
        assertEq(address(payee).balance, amount, "the payee received something other than the amount");
    }

    /// @dev The same, at the boundary. A recipient reentering on the call that
    /// exhausts the period must not find room left in it.
    function test_reenteringOnTheLastSpendOfAPeriodFindsThePeriodFull() public {
        ReentersTreasury payee = new ReentersTreasury();
        payee.arm(treasury, NATIVE);

        uint256 rounds = PERIOD_LIMIT_NATIVE / MAX_ACTION_NATIVE;
        for (uint256 i = 0; i < rounds - 1; i++) {
            vm.prank(address(module));
            treasury.spend(NATIVE, provider, MAX_ACTION_NATIVE, _label("filler"));
        }

        vm.prank(address(module));
        treasury.spend(NATIVE, address(payee), MAX_ACTION_NATIVE, _label("last"));

        assertEq(payee.spentInPeriodDuringCall(), PERIOD_LIMIT_NATIVE, "the period was not full mid-call");
        assertEq(treasury.remainingInPeriod(NATIVE, uint64(block.timestamp)), 0, "and is not full afterwards");
    }

    // --- the revenue router ---------------------------------------------------

    /// @dev A destination that reenters `settle` for its own leg must find its bucket
    /// already emptied. If `_settled` were written after the transfer, the leg would
    /// pay out repeatedly until the router was drained — and the developer leg's
    /// destination is an address the developer chose, so this is reachable by
    /// choosing it.
    function test_aDestinationReenteringSettlementFindsItsBucketAlreadyEmptied() public {
        ReentersRouter destination = new ReentersRouter();

        AgentRevenueRouter hostileRouter = new AgentRevenueRouter(
            agentId, address(treasury), address(destination), protocolTreasury, address(identity), _allocation()
        );
        destination.arm(hostileRouter, NATIVE, LEG_DEVELOPER);

        uint256 paid = 10 ether;
        vm.deal(address(this), address(this).balance + paid);
        (bool ok,) = address(hostileRouter).call{value: paid}("");
        require(ok, "pay the router");

        hostileRouter.recognise(NATIVE);
        hostileRouter.allocate(NATIVE);

        uint256 owed = hostileRouter.pending(NATIVE, LEG_DEVELOPER);
        assertGt(owed, 0, "nothing was owed, so this proved nothing");

        hostileRouter.settle(NATIVE, LEG_DEVELOPER);

        assertTrue(destination.entered(), "the destination never got a call frame");

        // Mid-settlement its bucket already read as empty.
        assertEq(destination.pendingDuringCall(), 0, "the bucket was not emptied before the transfer");
        assertEq(
            destination.settleFailure(),
            abi.encodeWithSelector(IAgentRevenueRouter.NothingToSettle.selector, NATIVE, LEG_DEVELOPER),
            "a reentrant settlement was not refused"
        );

        assertEq(address(destination).balance, owed, "the destination was paid more than once");
        assertEq(hostileRouter.totalSettled(NATIVE, LEG_DEVELOPER), owed, "the books recorded more than one payment");
    }

    /// @dev The subtler one. `unrecognised` is derived from the balance, and during a
    /// settlement the balance is mid-flight — so a destination that reenters
    /// `recognise` could, if the arithmetic were wrong, book the money leaving as
    /// revenue arriving and inflate every leg's entitlement out of nothing.
    ///
    /// It cannot, because `_settled` is incremented before the transfer: the amount
    /// leaves the balance and the expected balance in the same step, and the
    /// difference between them does not move.
    function test_aDestinationCannotBookMoneyLeavingAsRevenueArriving() public {
        ReentersRouter destination = new ReentersRouter();

        AgentRevenueRouter hostileRouter = new AgentRevenueRouter(
            agentId, address(treasury), address(destination), protocolTreasury, address(identity), _allocation()
        );
        destination.arm(hostileRouter, NATIVE, LEG_DEVELOPER);

        uint256 paid = 10 ether;
        vm.deal(address(this), address(this).balance + paid);
        (bool ok,) = address(hostileRouter).call{value: paid}("");
        require(ok, "pay the router");

        hostileRouter.recognise(NATIVE);
        hostileRouter.allocate(NATIVE);

        uint256 receivedBefore = hostileRouter.totalReceived(NATIVE);
        hostileRouter.settle(NATIVE, LEG_DEVELOPER);

        assertEq(destination.unrecognisedDuringCall(), 0, "money leaving looked like money arriving");
        assertEq(
            destination.recogniseFailure(),
            abi.encodeWithSelector(IAgentRevenueRouter.NothingToRecognise.selector, NATIVE),
            "a reentrant recognise found something to count"
        );
        assertEq(hostileRouter.totalReceived(NATIVE), receivedBefore, "the lifetime total moved during a payout");
    }

    /// @dev And the whole of it, as an accounting identity: however the destination
    /// behaves, the router never pays out more than it took in.
    function test_theRouterStillCannotOverpayADestinationThatFightsBack() public {
        ReentersRouter destination = new ReentersRouter();

        AgentRevenueRouter hostileRouter = new AgentRevenueRouter(
            agentId, address(treasury), address(destination), protocolTreasury, address(identity), _allocation()
        );
        destination.arm(hostileRouter, NATIVE, LEG_DEVELOPER);

        uint256 paid = 7 ether;
        vm.deal(address(this), address(this).balance + paid);
        (bool ok,) = address(hostileRouter).call{value: paid}("");
        require(ok, "pay the router");

        hostileRouter.recognise(NATIVE);
        hostileRouter.allocate(NATIVE);

        hostileRouter.settle(NATIVE, LEG_DEVELOPER);
        hostileRouter.settle(NATIVE, 0);
        hostileRouter.settle(NATIVE, 3);

        uint256 paidOut = address(destination).balance + address(treasury).balance - 10 ether + protocolTreasury.balance;

        assertLe(paidOut, paid, "the router paid out more than arrived");
        assertLe(paid - paidOut, 3, "and stranded more than the dust bound allows");
    }
}
