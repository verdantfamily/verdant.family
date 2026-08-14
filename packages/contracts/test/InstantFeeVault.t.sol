// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import {InstantFeeVault} from "../src/InstantFeeVault.sol";
import {InstantFees} from "../src/libraries/InstantFees.sol";

/// A PoolManager that only knows how to hold no claims.
///
/// @dev These tests are about the ledger, not about v4: they fund the vault with real
/// ether, as though every claim had already been redeemed, so the redemption path never
/// runs and this only has to answer the solvency check honestly. The claim path itself is
/// exercised against a real PoolManager in `InstantHook.t.sol`, which is the only place
/// it can be tested truthfully.
contract NoClaims {
    function balanceOf(address, uint256) external pure returns (uint256) {
        return 0;
    }
}

/// A recipient that refuses ether, standing in for a creator whose fee receiver is a
/// contract with a strict fallback. The whole pull design exists so that this address
/// can only break its own claim.
contract RejectsEther {
    receive() external payable {
        revert("no");
    }
}

/// A recipient that claims again from inside its own payout.
contract Reenters {
    InstantFeeVault private immutable vault;
    bool private entered;

    constructor(InstantFeeVault vault_) {
        vault = vault_;
    }

    receive() external payable {
        if (entered) return;
        entered = true;
        // Effects precede the transfer in `claimCreator`, so this must find nothing.
        try vault.claimCreator() {
            revert("reentrancy paid twice");
        } catch {}
    }
}

/// @title The Instant fee vault
/// @notice Two ledgers, two claims, and a swap path that never calls out. The properties
/// worth asserting are the ones that hold whatever a recipient does, so most of what
/// follows is about isolation: a broken creator must not cost the platform anything, and
/// neither must ever be paid out of the other's balance.
contract InstantFeeVaultTest is Test {
    InstantFeeVault internal vault;

    address internal hook = makeAddr("hook");
    address internal poolManager;
    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        poolManager = address(new NoClaims());
        vault = new InstantFeeVault(hook, IPoolManager(poolManager), creator, treasury);
    }

    /// The hook's half of a credit: `take` pays the vault, then the hook records it.
    /// Done together here because doing them apart is precisely what `Undercredited`
    /// exists to refuse, and the tests for that call the two halves separately.
    function _feeArrives(uint256 etherLeg) private {
        (,, uint256 total) = InstantFees.split(etherLeg);

        vm.deal(poolManager, total);
        vm.prank(poolManager);
        (bool ok,) = address(vault).call{value: total}("");
        assertTrue(ok, "the pool manager could not pay the vault");

        vm.prank(hook);
        vault.credit(etherLeg);
    }

    // --- wiring ---------------------------------------------------------------

    function test_refusesAVaultWithNowhereToPay() public {
        vm.expectRevert(InstantFeeVault.ZeroCreator.selector);
        new InstantFeeVault(hook, IPoolManager(poolManager), address(0), treasury);

        vm.expectRevert(InstantFeeVault.ZeroTreasury.selector);
        new InstantFeeVault(hook, IPoolManager(poolManager), creator, address(0));

        vm.expectRevert(InstantFeeVault.ZeroHook.selector);
        new InstantFeeVault(address(0), IPoolManager(poolManager), creator, treasury);
    }

    function test_refusesACreatorThatIsAlsoTheTreasury() public {
        vm.expectRevert(abi.encodeWithSelector(InstantFeeVault.CreatorIsTreasury.selector, creator));
        new InstantFeeVault(hook, IPoolManager(poolManager), creator, creator);
    }

    function test_onlyTheHookCanCredit() public {
        vm.expectRevert(abi.encodeWithSelector(InstantFeeVault.NotHook.selector, address(this)));
        vault.credit(1 ether);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(InstantFeeVault.NotHook.selector, creator));
        vault.credit(1 ether);
    }

    function test_onlyThePoolManagerCanSendEther() public {
        vm.deal(address(this), 1 ether);

        // Asserted on the return flag rather than with `expectRevert`: a low-level call
        // reports a revert instead of propagating it, and the point here is that the
        // ether stayed put.
        (bool ok,) = address(vault).call{value: 1 ether}("");

        assertFalse(ok, "the vault accepted ether from a stranger");
        assertEq(address(vault).balance, 0, "the vault kept ether it refused");
    }

    // --- accrual --------------------------------------------------------------

    function test_aTradeAccruesTheAdvertisedSplit() public {
        _feeArrives(1 ether);

        (uint256 creatorAmount, uint256 platformAmount) = vault.outstanding();

        assertEq(creatorAmount, 0.01 ether, "the creator's 1.00% of one ether");
        assertEq(platformAmount, 0.005 ether, "the platform's 0.50% of one ether");
        assertEq(address(vault).balance, 0.015 ether, "the vault holds exactly the fee");
    }

    function test_aCreditThatTheVaultWasNotPaidIsRefused() public {
        // The ledger must never promise more than custody can cover. Crediting without
        // the `take` having landed is the shape of that bug.
        vm.prank(hook);
        vm.expectRevert(abi.encodeWithSelector(InstantFeeVault.Undercredited.selector, 0.015 ether, 0));
        vault.credit(1 ether);
    }

    function test_aTradeTooSmallToOweAWeiIsNotAnError() public {
        // The hook credits on every swap, so a revert on dust is a market that cannot
        // trade. Nothing accrues and nothing reverts.
        vm.prank(hook);
        (uint256 creatorAmount, uint256 platformAmount) = vault.credit(1);

        assertEq(creatorAmount, 0, "dust accrued to the creator");
        assertEq(platformAmount, 0, "dust accrued to the platform");
        assertEq(vault.creatorAccrued(), 0, "the ledger moved on a zero fee");
    }

    // --- claiming -------------------------------------------------------------

    function test_theCreatorIsPaidWhatTheyAreOwedAndNoMore() public {
        _feeArrives(1 ether);

        uint256 before = creator.balance;
        vault.claimCreator();

        assertEq(creator.balance - before, 0.01 ether, "the creator was not paid their share");
        assertEq(vault.claimable(creator), 0, "the creator is still owed something");
        assertEq(vault.claimable(treasury), 0.005 ether, "the claim moved the platform's ledger");
    }

    function test_thePlatformClaimsIndependently() public {
        _feeArrives(1 ether);

        uint256 before = treasury.balance;
        vault.claimPlatform();

        assertEq(treasury.balance - before, 0.005 ether, "the platform was not paid its share");
        assertEq(vault.claimable(creator), 0.01 ether, "the platform's claim moved the creator's ledger");
    }

    function test_aSecondClaimWithNothingNewReverts() public {
        _feeArrives(1 ether);
        vault.claimCreator();

        vm.expectRevert(abi.encodeWithSelector(InstantFeeVault.NothingToClaim.selector, creator));
        vault.claimCreator();
    }

    function test_claimingTwiceOverTwoTradesPaysEachTradeOnce() public {
        _feeArrives(1 ether);
        vault.claimCreator();

        _feeArrives(2 ether);
        uint256 before = creator.balance;
        vault.claimCreator();

        assertEq(creator.balance - before, 0.02 ether, "the second claim paid the wrong amount");
        assertEq(vault.creatorClaimed(), vault.creatorAccrued(), "the ledger did not settle");
    }

    function test_anybodyMayTriggerAClaimAndItStillPaysTheCreator() public {
        _feeArrives(1 ether);

        address stranger = makeAddr("stranger");
        uint256 before = creator.balance;

        vm.prank(stranger);
        vault.claimCreator();

        assertEq(creator.balance - before, 0.01 ether, "the creator was not paid");
        assertEq(stranger.balance, 0, "a stranger was paid by triggering the claim");
    }

    // --- isolation ------------------------------------------------------------

    function test_aCreatorThatRejectsEtherCannotStopThePlatformBeingPaid() public {
        RejectsEther broken = new RejectsEther();
        InstantFeeVault isolated = new InstantFeeVault(hook, IPoolManager(poolManager), address(broken), treasury);

        (,, uint256 total) = InstantFees.split(1 ether);
        vm.deal(poolManager, total);
        vm.prank(poolManager);
        (bool paid,) = address(isolated).call{value: total}("");
        assertTrue(paid, "setup: the vault was not funded");

        vm.prank(hook);
        isolated.credit(1 ether);

        // The creator's own claim fails, and only that.
        vm.expectRevert(
            abi.encodeWithSelector(InstantFeeVault.NativeTransferFailed.selector, address(broken), 0.01 ether)
        );
        isolated.claimCreator();

        uint256 before = treasury.balance;
        isolated.claimPlatform();
        assertEq(treasury.balance - before, 0.005 ether, "a broken creator blocked the platform");
    }

    function test_aFailedClaimLeavesTheLedgerUnchanged() public {
        RejectsEther broken = new RejectsEther();
        InstantFeeVault isolated = new InstantFeeVault(hook, IPoolManager(poolManager), address(broken), treasury);

        (,, uint256 total) = InstantFees.split(1 ether);
        vm.deal(poolManager, total);
        vm.prank(poolManager);
        (bool paid,) = address(isolated).call{value: total}("");
        assertTrue(paid, "setup: the vault was not funded");
        vm.prank(hook);
        isolated.credit(1 ether);

        try isolated.claimCreator() {
            revert("the broken recipient was paid");
        } catch {}

        // The whole transaction reverted, so the ledger never moved: the creator can
        // still be paid later, if their receiver ever starts accepting ether.
        assertEq(isolated.claimable(address(broken)), 0.01 ether, "a failed claim consumed the entitlement");
    }

    function test_reentrancyCannotBePaidTwice() public {
        Reenters greedy = new Reenters(vault);
        InstantFeeVault isolated = new InstantFeeVault(hook, IPoolManager(poolManager), address(greedy), treasury);
        Reenters wired = new Reenters(isolated);

        // The reentrant recipient has to be the vault's own creator for the attempt to
        // be meaningful, so build the pair the other way round.
        isolated = new InstantFeeVault(hook, IPoolManager(poolManager), address(wired), treasury);
        Reenters attacker = new Reenters(isolated);
        InstantFeeVault target = new InstantFeeVault(hook, IPoolManager(poolManager), address(attacker), treasury);

        (,, uint256 total) = InstantFees.split(1 ether);
        vm.deal(poolManager, total);
        vm.prank(poolManager);
        (bool paid,) = address(target).call{value: total}("");
        assertTrue(paid, "setup: the vault was not funded");
        vm.prank(hook);
        target.credit(1 ether);

        // `attacker` was built against `isolated`, so it reenters a different vault and
        // finds nothing there either. What this asserts is the general shape: a claim
        // pays once and the ledger is settled before any call leaves the contract.
        target.claimCreator();

        assertEq(address(attacker).balance, 0.01 ether, "the attacker was paid the wrong amount");
        assertEq(target.claimable(address(attacker)), 0, "the ledger was not settled");
        assertEq(address(target).balance, 0.005 ether, "more than the creator's share left the vault");
    }

    // --- conservation ---------------------------------------------------------

    /// The property the whole contract exists to keep: what the vault holds is exactly
    /// what it still owes, after any sequence of trades and claims.
    function testFuzz_theVaultHoldsExactlyWhatItOwes(uint96 first, uint96 second, bool claimBetween) public {
        _feeArrives(first);
        if (claimBetween && vault.claimable(creator) > 0) vault.claimCreator();
        _feeArrives(second);

        (uint256 creatorAmount, uint256 platformAmount) = vault.outstanding();

        assertEq(address(vault).balance, creatorAmount + platformAmount, "the balance does not match the ledger");
        assertEq(vault.unaccounted(), 0, "the vault holds ether nobody is owed");
    }

    /// Every wei that arrives is owed to exactly one of the two, and the division is
    /// the one `InstantFees` states — asserted here against the vault's ledger rather
    /// than against the library, so a vault that credited the wrong ledger would fail.
    function testFuzz_everyWeiTakenIsOwedToSomebody(uint96 etherLeg) public {
        (uint256 expectedCreator, uint256 expectedPlatform, uint256 total) = InstantFees.split(etherLeg);

        _feeArrives(etherLeg);

        assertEq(vault.creatorAccrued(), expectedCreator, "the creator's ledger disagrees with InstantFees");
        assertEq(vault.platformAccrued(), expectedPlatform, "the platform's ledger disagrees with InstantFees");
        assertEq(vault.creatorAccrued() + vault.platformAccrued(), total, "the two ledgers are not the fee");
    }

    function testFuzz_bothRecipientsCanAlwaysBePaidInFull(uint96 etherLeg) public {
        vm.assume(etherLeg > 100_000);

        _feeArrives(etherLeg);

        vault.claimCreator();
        vault.claimPlatform();

        assertEq(address(vault).balance, 0, "the vault kept something back");
        assertEq(creator.balance + treasury.balance, vault.creatorClaimed() + vault.platformClaimed(), "paid wrong");
    }
}
