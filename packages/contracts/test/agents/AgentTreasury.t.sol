// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentFixture, RejectsEther} from "./AgentFixture.sol";

import {AgentTreasury} from "../../src/agents/AgentTreasury.sol";
import {IAgentLaunchFactory} from "../../src/agents/IAgentLaunchFactory.sol";
import {IAgentTreasury} from "../../src/agents/IAgentTreasury.sol";

/// @title AgentTreasuryTest
/// @notice The only door out of an agent's money, and the rules on it.
contract AgentTreasuryTest is AgentFixture {
    function setUp() public override {
        super.setUp();
        _fundTreasury(10 ether, 100_000e18);
    }

    /// @dev Calls arrive from the module in production. Pranking as the module
    /// tests the treasury's own rules rather than the module's, which is the point
    /// of splitting them.
    function _spend(address asset, address to, uint256 amount) internal {
        vm.prank(address(module));
        treasury.spend(asset, to, amount, _label("action"));
    }

    /// @dev Exhausts the ether period the only way a mandate allows: in actions no
    /// larger than the per-action cap. The two limits are separate numbers and one
    /// call cannot reach the larger of them.
    function _spendOutTheNativePeriod() internal {
        for (uint256 i = 0; i < PERIOD_LIMIT_NATIVE / MAX_ACTION_NATIVE; i++) {
            _spend(NATIVE, provider, MAX_ACTION_NATIVE);
        }
    }

    // --- who may spend -------------------------------------------------------

    function test_onlyTheExecutionModuleMaySpend() public {
        address[4] memory nobody = [developer, guardian, operator, stranger];

        for (uint256 i = 0; i < nobody.length; i++) {
            vm.prank(nobody[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgentTreasury.NotExecutionModule.selector, nobody[i]));
            treasury.spend(NATIVE, nobody[i], 1, bytes32(0));
        }
    }

    function test_spendingMovesTheAssetAndRecordsIt() public {
        uint256 before = provider.balance;

        _spend(NATIVE, provider, 0.5 ether);

        assertEq(provider.balance - before, 0.5 ether, "recipient");
        assertEq(treasury.totalSpent(NATIVE), 0.5 ether, "lifetime");
        assertEq(treasury.spentInPeriod(NATIVE, uint64(block.timestamp)), 0.5 ether, "period");
    }

    function test_spendingAnErc20UsesTheSamePathAndTheSameLimits() public {
        _spend(address(token), provider, 900e18);
        assertEq(token.balanceOf(provider), 900e18, "recipient");

        // The per-action cap for this asset is 1 000e18: a separate number for a
        // separate asset, because there is no oracle here to convert between them.
        vm.prank(address(module));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentTreasury.ActionValueExceeded.selector, address(token), 1_001e18, MAX_ACTION_TOKEN
            )
        );
        treasury.spend(address(token), provider, 1_001e18, bytes32(0));
    }

    // --- the money rules -----------------------------------------------------

    function test_anUnapprovedAssetCannotBeSpentAtAll() public {
        address other = makeAddr("otherToken");

        vm.prank(address(module));
        vm.expectRevert(abi.encodeWithSelector(IAgentTreasury.AssetNotApproved.selector, other));
        treasury.spend(other, provider, 1, bytes32(0));
    }

    function test_oneActionCannotExceedThePerActionCap() public {
        vm.prank(address(module));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentTreasury.ActionValueExceeded.selector, NATIVE, MAX_ACTION_NATIVE + 1, MAX_ACTION_NATIVE
            )
        );
        treasury.spend(NATIVE, provider, MAX_ACTION_NATIVE + 1, bytes32(0));
    }

    function test_manyActionsCannotExceedThePeriodCap() public {
        // Five actions of one ether exhausts a five ether period exactly.
        for (uint256 i = 0; i < 5; i++) {
            _spend(NATIVE, provider, MAX_ACTION_NATIVE);
        }

        assertEq(treasury.remainingInPeriod(NATIVE, uint64(block.timestamp)), 0, "headroom");

        vm.prank(address(module));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentTreasury.PeriodLimitExceeded.selector, NATIVE, PERIOD_LIMIT_NATIVE + 1, PERIOD_LIMIT_NATIVE
            )
        );
        treasury.spend(NATIVE, provider, 1, bytes32(0));
    }

    function test_aPeriodRollsWithoutAnybodyTurningItOver() public {
        _spendOutTheNativePeriod();
        assertEq(treasury.remainingInPeriod(NATIVE, uint64(block.timestamp)), 0, "spent out");

        // One second short of the period: still spent out.
        vm.warp(block.timestamp + PERIOD - 1);
        assertEq(treasury.remainingInPeriod(NATIVE, uint64(block.timestamp)), 0, "rolled early");

        vm.warp(block.timestamp + 1);
        assertEq(treasury.remainingInPeriod(NATIVE, uint64(block.timestamp)), PERIOD_LIMIT_NATIVE, "did not roll");

        // And the roll is real rather than only a view: the next spend succeeds.
        _spend(NATIVE, provider, MAX_ACTION_NATIVE);
        assertEq(treasury.spentInPeriod(NATIVE, uint64(block.timestamp)), MAX_ACTION_NATIVE, "period counter");
    }

    function test_periodsAreTrackedPerAsset() public {
        _spendOutTheNativePeriod();

        // Ether is spent out; the token's period is untouched.
        assertEq(treasury.remainingInPeriod(NATIVE, uint64(block.timestamp)), 0, "native");
        assertEq(treasury.remainingInPeriod(address(token), uint64(block.timestamp)), PERIOD_LIMIT_TOKEN, "token");
    }

    function test_anIdleAgentDoesNotWakeUpMidPeriod() public {
        vm.warp(block.timestamp + 400 days);

        // A period that never started has not rolled, and the first action of an
        // agent's life is measured against a period that begins with it.
        assertEq(treasury.spentInPeriod(NATIVE, uint64(block.timestamp)), 0, "stale spending");

        _spend(NATIVE, provider, MAX_ACTION_NATIVE);
        assertEq(treasury.periodStartedAt(NATIVE), uint64(block.timestamp), "period start");
    }

    function test_spendingMoreThanIsHeldFails() public {
        // A second agent, whose treasury has never been funded, so the balance is
        // what is short rather than a limit. The treasury checks both because a
        // limit is a policy and a balance is a fact.
        IAgentLaunchFactory.AgentAddresses memory fresh = _createAgent(stranger, _label("empty"), _targets());
        AgentTreasury unfunded = AgentTreasury(payable(fresh.treasury));

        vm.prank(fresh.executionModule);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentTreasury.InsufficientBalance.selector, NATIVE, MAX_ACTION_NATIVE, 0)
        );
        unfunded.spend(NATIVE, provider, MAX_ACTION_NATIVE, bytes32(0));
    }

    function test_zeroAmountsAndZeroRecipientsAreRefused() public {
        vm.prank(address(module));
        vm.expectRevert(IAgentTreasury.ZeroAmount.selector);
        treasury.spend(NATIVE, provider, 0, bytes32(0));

        vm.prank(address(module));
        vm.expectRevert(IAgentTreasury.ZeroRecipient.selector);
        treasury.spend(NATIVE, address(0), 1, bytes32(0));
    }

    function test_aRecipientThatRejectsEtherFailsTheWholeAction() public {
        address hostile = address(new RejectsEther());

        vm.prank(address(module));
        vm.expectRevert(abi.encodeWithSelector(IAgentTreasury.NativeTransferFailed.selector, hostile, 1 ether));
        treasury.spend(NATIVE, hostile, 1 ether, bytes32(0));

        // Nothing was written: the revert unwinds the counters with the transfer.
        assertEq(treasury.spentInPeriod(NATIVE, uint64(block.timestamp)), 0, "counter moved");
    }

    // --- pausing --------------------------------------------------------------

    function test_pausingStopsSpendingAndNothingElse() public {
        vm.prank(guardian);
        treasury.pause();

        vm.prank(address(module));
        vm.expectRevert(IAgentTreasury.TreasuryPaused.selector);
        treasury.spend(NATIVE, provider, 1, bytes32(0));

        // Money still arrives, and can still be counted. A guardian who could stop
        // money arriving could starve the developer and the protocol.
        _fundTreasury(1 ether, 0);
        treasury.recognise(NATIVE);
        assertEq(treasury.totalRecognised(NATIVE), 11 ether, "receiving was blocked");

        vm.prank(guardian);
        treasury.unpause();
        _spend(NATIVE, provider, 1 ether);
    }

    function test_onlyTheGuardianMayPause() public {
        address[3] memory nobody = [developer, operator, stranger];

        for (uint256 i = 0; i < nobody.length; i++) {
            vm.prank(nobody[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgentTreasury.NotGuardian.selector, nobody[i]));
            treasury.pause();
        }
    }

    // --- recognising ----------------------------------------------------------

    function test_recognisingCountsWhatArrivedWithoutBeingTold() public {
        // Funded in `setUp` by plain transfer, so nothing has counted it yet.
        assertEq(treasury.unrecognised(NATIVE), 10 ether, "unrecognised");
        assertEq(treasury.totalRecognised(NATIVE), 0, "recognised early");

        // Permissionless: a stranger may do the bookkeeping.
        vm.prank(stranger);
        treasury.recognise(NATIVE);

        assertEq(treasury.totalRecognised(NATIVE), 10 ether, "recognised");
        assertEq(treasury.unrecognised(NATIVE), 0, "still unrecognised");
        assertEq(treasury.receivedInPeriod(NATIVE, uint64(block.timestamp)), 10 ether, "period receipts");
    }

    function test_unrecognisedValueIsStillSpendable() public {
        // `balanceOf` reads the real balance, so value that arrived by plain
        // transfer is never stuck waiting for somebody to count it.
        assertEq(treasury.totalRecognised(NATIVE), 0, "recognised");
        _spend(NATIVE, provider, 1 ether);
        assertEq(provider.balance, 1 ether, "could not spend unrecognised value");
    }

    function test_recognisingNothingFailsRatherThanSucceedingWithAZero() public {
        treasury.recognise(NATIVE);

        vm.expectRevert(abi.encodeWithSelector(IAgentTreasury.NothingToRecognise.selector, NATIVE));
        treasury.recognise(NATIVE);
    }

    // --- properties -----------------------------------------------------------

    function testFuzz_spendingNeverExceedsTheMandate(uint256 first, uint256 second) public {
        first = bound(first, 1, MAX_ACTION_NATIVE);
        second = bound(second, 1, MAX_ACTION_NATIVE);

        _spend(NATIVE, provider, first);

        uint256 spent = first;
        if (first + second <= PERIOD_LIMIT_NATIVE) {
            _spend(NATIVE, provider, second);
            spent += second;
        }

        assertLe(spent, PERIOD_LIMIT_NATIVE, "period limit broken");
        assertEq(treasury.spentInPeriod(NATIVE, uint64(block.timestamp)), spent, "counter");
        assertEq(treasury.totalSpent(NATIVE), spent, "lifetime");
    }
}
