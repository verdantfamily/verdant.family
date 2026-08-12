// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentFixture, RejectsEther} from "./AgentFixture.sol";

import {AgentRevenueRouter} from "../../src/agents/AgentRevenueRouter.sol";
import {IAgentRevenueRouter} from "../../src/agents/IAgentRevenueRouter.sol";
import {RevenueAllocationLib} from "../../src/agents/RevenueAllocationLib.sol";

/// @title AgentRevenueRouterTest
/// @notice Money arrives, is counted, is divided, and is paid out — in four steps
/// that fail independently.
contract AgentRevenueRouterTest is AgentFixture {
    uint256 internal constant OPERATIONS = 0;
    uint256 internal constant BUYBACKS = 1;
    uint256 internal constant DEVELOPER = 2;
    uint256 internal constant PROTOCOL = 3;

    function _pay(uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        (bool ok,) = address(router).call{value: amount}("");
        require(ok, "pay");
    }

    // --- the three steps ------------------------------------------------------

    function test_receivingIsAPlainTransferThatCannotFail() public {
        // The market's fee stream arrives from `FeeSplitter.claim`, which anybody
        // may call. Nothing about that transfer may depend on this contract's logic.
        _pay(1 ether);

        assertEq(address(router).balance, 1 ether, "balance");
        assertEq(router.totalReceived(NATIVE), 0, "counted without being asked");
        assertEq(router.unrecognised(NATIVE), 1 ether, "unrecognised");
    }

    function test_anybodyMayCountAndDivideAndPay() public {
        _pay(1000);

        vm.startPrank(stranger);
        router.recognise(NATIVE);
        router.allocate(NATIVE);
        router.settle(NATIVE, DEVELOPER);
        vm.stopPrank();

        assertEq(developer.balance, 300, "developer leg");
    }

    function test_theSplitIsTheSplit() public {
        _pay(1000);
        router.recognise(NATIVE);
        router.allocate(NATIVE);

        // 60 / 0 / 30 / 10, on a total that divides exactly.
        assertEq(router.pending(NATIVE, OPERATIONS), 600, "operations");
        assertEq(router.pending(NATIVE, BUYBACKS), 0, "buybacks");
        assertEq(router.pending(NATIVE, DEVELOPER), 300, "developer");
        assertEq(router.pending(NATIVE, PROTOCOL), 100, "protocol");
    }

    function test_theOperationsLegFundsTheAgentsOwnTreasury() public {
        _pay(1000);
        router.recognise(NATIVE);
        router.allocate(NATIVE);
        router.settle(NATIVE, OPERATIONS);

        assertEq(address(treasury).balance, 600, "treasury");

        // And the treasury counts it as revenue when somebody asks it to.
        treasury.recognise(NATIVE);
        assertEq(treasury.totalRecognised(NATIVE), 600, "treasury did not count it");
    }

    function test_settlingIsPerLegSoOneBadRecipientCannotHoldTheOthers() public {
        // An agent whose developer address rejects ether: the developer's own leg
        // is stuck, and the protocol's and the treasury's are not.
        address hostile = address(new RejectsEther());
        AgentRevenueRouter stuck = new AgentRevenueRouter(
            agentId, address(treasury), hostile, protocolTreasury, address(identity), _allocation()
        );

        vm.deal(address(this), address(this).balance + 1000);
        (bool ok,) = address(stuck).call{value: 1000}("");
        require(ok, "pay");

        stuck.recognise(NATIVE);
        stuck.allocate(NATIVE);

        vm.expectRevert(abi.encodeWithSelector(IAgentRevenueRouter.NativeTransferFailed.selector, hostile, 300));
        stuck.settle(NATIVE, DEVELOPER);

        stuck.settle(NATIVE, OPERATIONS);
        stuck.settle(NATIVE, PROTOCOL);

        assertEq(stuck.pending(NATIVE, DEVELOPER), 300, "the stuck leg moved");
        assertEq(stuck.pending(NATIVE, OPERATIONS), 0, "operations blocked");
        assertEq(stuck.pending(NATIVE, PROTOCOL), 0, "protocol blocked");
    }

    // --- the cumulative rule ---------------------------------------------------

    function test_aDripAndOneLumpLandInTheSamePlace() public {
        // The property the cumulative rule exists for. Under a per-arrival split
        // each of these thousand payments floors to nothing for three legs.
        for (uint256 i = 0; i < 1000; i++) {
            _pay(1);
            router.recognise(NATIVE);
            if (RevenueAllocationLib.totalOf(RevenueAllocationLib.entitlements(i + 1, _allocation())) > _allocated()) {
                router.allocate(NATIVE);
            }
        }

        assertEq(router.totalAllocated(NATIVE, OPERATIONS), 600, "operations");
        assertEq(router.totalAllocated(NATIVE, DEVELOPER), 300, "developer");
        assertEq(router.totalAllocated(NATIVE, PROTOCOL), 100, "protocol");
    }

    function _allocated() internal view returns (uint256 total) {
        for (uint256 leg = 0; leg < 4; leg++) {
            total += router.totalAllocated(NATIVE, leg);
        }
    }

    function test_dustIsHeldRatherThanGivenToAnybody() public {
        _pay(9);
        router.recognise(NATIVE);
        router.allocate(NATIVE);

        // 60 / 30 / 10 of 9 is 5.4 / 2.7 / 0.9, floored to 5 / 2 / 0. Two units are
        // owed to nobody yet, and are not handed to a nominated leg.
        assertEq(router.pending(NATIVE, OPERATIONS), 5, "operations");
        assertEq(router.pending(NATIVE, DEVELOPER), 2, "developer");
        assertEq(router.pending(NATIVE, PROTOCOL), 0, "protocol");
        assertEq(router.unallocated(NATIVE), 2, "dust");

        // And it is not lost: the next arrival makes it whole.
        _pay(1);
        router.recognise(NATIVE);
        router.allocate(NATIVE);
        assertEq(router.pending(NATIVE, OPERATIONS), 6, "operations after");
        assertEq(router.pending(NATIVE, DEVELOPER), 3, "developer after");
        assertEq(router.pending(NATIVE, PROTOCOL), 1, "protocol after");
        assertEq(router.unallocated(NATIVE), 0, "dust after");
    }

    function test_aLegWithNoShareIsNeverPaid() public {
        _pay(1 ether);
        router.recognise(NATIVE);
        router.allocate(NATIVE);

        assertEq(router.totalAllocated(NATIVE, BUYBACKS), 0, "buybacks were paid");

        vm.expectRevert(abi.encodeWithSelector(IAgentRevenueRouter.NothingToSettle.selector, NATIVE, BUYBACKS));
        router.settle(NATIVE, BUYBACKS);
    }

    // --- refusing to do nothing ------------------------------------------------

    function test_eachStepFailsRatherThanSucceedingWithAZero() public {
        // A zero-value success is worse than a failure: a keeper reads it as
        // confirmation that work happened.
        vm.expectRevert(abi.encodeWithSelector(IAgentRevenueRouter.NothingToRecognise.selector, NATIVE));
        router.recognise(NATIVE);

        vm.expectRevert(abi.encodeWithSelector(IAgentRevenueRouter.NothingToAllocate.selector, NATIVE));
        router.allocate(NATIVE);

        vm.expectRevert(abi.encodeWithSelector(IAgentRevenueRouter.NothingToSettle.selector, NATIVE, OPERATIONS));
        router.settle(NATIVE, OPERATIONS);
    }

    function test_anUnknownLegIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(IAgentRevenueRouter.UnknownLeg.selector, 4));
        router.settle(NATIVE, 4);

        vm.expectRevert(abi.encodeWithSelector(IAgentRevenueRouter.UnknownLeg.selector, 4));
        router.pending(NATIVE, 4);
    }

    // --- erc-20 ----------------------------------------------------------------

    function test_anErc20FollowsTheSamePath() public {
        token.mint(address(router), 1000);

        router.recognise(address(token));
        router.allocate(address(token));
        router.settle(address(token), DEVELOPER);
        router.settle(address(token), PROTOCOL);

        assertEq(token.balanceOf(developer), 300, "developer");
        assertEq(token.balanceOf(protocolTreasury), 100, "protocol");
    }

    // --- properties -------------------------------------------------------------

    function testFuzz_theRouterNeverPaysOutMoreThanArrived(uint96 first, uint96 second) public {
        vm.assume(uint256(first) + second > 0);

        if (first > 0) {
            _pay(first);
            router.recognise(NATIVE);
            if (_allocatable() > 0) router.allocate(NATIVE);
        }
        if (second > 0) {
            _pay(second);
            router.recognise(NATIVE);
            if (_allocatable() > 0) router.allocate(NATIVE);
        }

        uint256 received = uint256(first) + second;

        assertEq(router.totalReceived(NATIVE), received, "received");
        assertLe(_allocated(), received, "allocated more than arrived");
        assertLe(router.unallocated(NATIVE), RevenueAllocationLib.MAX_UNALLOCATED_DUST, "dust bound");

        // Everything allocated is still held, because nothing has been settled.
        assertEq(address(router).balance, received, "balance");
    }

    function _allocatable() internal view returns (uint256 total) {
        RevenueAllocationLib.Legs memory owed =
            RevenueAllocationLib.entitlements(router.totalReceived(NATIVE), _allocation());

        for (uint256 leg = 0; leg < 4; leg++) {
            total += RevenueAllocationLib.legAt(owed, leg) - router.totalAllocated(NATIVE, leg);
        }
    }

    function testFuzz_settlingPaysExactlyWhatWasAllocated(uint96 amount) public {
        amount = uint96(bound(amount, 10, type(uint96).max));

        _pay(amount);
        router.recognise(NATIVE);
        router.allocate(NATIVE);

        uint256 owedToDeveloper = router.pending(NATIVE, DEVELOPER);
        uint256 before = developer.balance;

        if (owedToDeveloper == 0) return;

        router.settle(NATIVE, DEVELOPER);

        assertEq(developer.balance - before, owedToDeveloper, "paid something else");
        assertEq(router.pending(NATIVE, DEVELOPER), 0, "bucket not emptied");
        assertEq(router.totalSettled(NATIVE, DEVELOPER), owedToDeveloper, "settled total");
    }
}
