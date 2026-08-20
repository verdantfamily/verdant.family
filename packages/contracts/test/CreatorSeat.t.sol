// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {CreatorSeat, IInstantFeeVault} from "../src/CreatorSeat.sol";
import {CreatorSeatFactory} from "../src/CreatorSeatFactory.sol";
import {InstantFeeVault} from "../src/InstantFeeVault.sol";
import {InstantFees} from "../src/libraries/InstantFees.sol";

/// A PoolManager that only knows how to hold no claims.
///
/// @dev Borrowed wholesale from `InstantFeeVault.t.sol`, and for its reason: these tests are
/// about who a fee reaches, not about v4, so the vault is funded with real ether as though
/// every claim had already been redeemed and the redemption path never runs.
contract NoClaims {
    function balanceOf(address, uint256) external pure returns (uint256) {
        return 0;
    }
}

/// An occupant that refuses ether but can still send transactions, standing in for a
/// community multisig with a strict fallback. It must be able to break its own payout and
/// nothing else — and, because it can sign, to hand the seat to an address that works.
contract RejectsEther {
    function offer(CreatorSeat seat, address next) external {
        seat.offer(next);
    }

    receive() external payable {
        revert("no");
    }
}

/// An occupant that calls back into the seat while being paid.
contract Reenters {
    CreatorSeat private seat;
    IInstantFeeVault private vault;
    uint256 public received;

    function point(CreatorSeat seat_, IInstantFeeVault vault_) external {
        seat = seat_;
        vault = vault_;
    }

    receive() external payable {
        received += msg.value;
        // A second collect during the first. The vault has already zeroed this seat's
        // entitlement and the seat's balance is already spent, so neither can pay twice.
        try seat.collect(vault) {} catch {}
        try seat.sweep(address(0)) {} catch {}
    }
}

/// An occupant that tries to hand the seat on from inside its own payout.
contract OffersWhilePaid {
    CreatorSeat private seat;
    address private next;

    function point(CreatorSeat seat_, address next_) external {
        seat = seat_;
        next = next_;
    }

    receive() external payable {
        try seat.offer(next) {} catch {}
    }
}

/// @title CreatorSeat — a fee stream that can change hands
/// @notice Two claims, worth stating exactly: a market's creator fee can move to a
/// different owner without the market moving; and if the owner is gone, Agen can name a
/// successor, but only after a delay the owner can still cancel. Every test below is one
/// half of one of those — either "the seat changed hands and the money followed", or
/// "somebody who should not be able to move it could not".
///
/// The vault under these tests is the real `InstantFeeVault`, not a stand-in, because the
/// property being claimed is precisely that a contract can occupy an immutable the vault will
/// never let anybody rewrite.
contract CreatorSeatTest is Test {
    CreatorSeatFactory internal factory;
    CreatorSeat internal seat;
    InstantFeeVault internal vault;

    address internal hook = makeAddr("hook");
    address internal poolManager;
    address internal treasury = makeAddr("treasury");

    address internal founder = makeAddr("founder");
    address internal community = makeAddr("community");
    address internal stranger = makeAddr("stranger");
    address internal keeper = makeAddr("keeper");
    address internal agen = makeAddr("agen");

    bytes32 internal constant LABEL = bytes32(uint256(1));

    function setUp() public {
        poolManager = address(new NoClaims());
        factory = new CreatorSeatFactory(agen);

        seat = factory.deploy(founder, LABEL);

        // The launch: the seat is what the market names, so the vault's immutable creator is
        // the seat and the founder is merely who sits in it.
        vault = new InstantFeeVault(hook, IPoolManager(poolManager), address(seat), treasury);
    }

    /// The hook's half of a credit: `take` pays the vault, then the hook records it.
    function _feeArrives(uint256 etherLeg) private {
        (,, uint256 total) = InstantFees.split(etherLeg);

        vm.deal(poolManager, total);
        vm.prank(poolManager);
        (bool ok,) = address(vault).call{value: total}("");
        assertTrue(ok, "the pool manager could not pay the vault");

        vm.prank(hook);
        vault.credit(etherLeg);
    }

    function _handOver(address from, address to) private {
        vm.prank(from);
        seat.offer(to);
        vm.prank(to);
        seat.take();
    }

    // --- what the seat is ------------------------------------------------------

    function test_theVaultPaysTheSeatAndTheSeatIsStillImmutableToTheVault() public view {
        assertEq(vault.creator(), address(seat), "the market did not name the seat");
        assertEq(seat.beneficiary(), founder, "the founder does not hold their own seat");
        assertTrue(seat.seatedAt(IInstantFeeVault(address(vault))), "the seat does not know its market");
    }

    function test_refusesASeatWithNobodyInIt() public {
        vm.expectRevert(CreatorSeat.ZeroBeneficiary.selector);
        new CreatorSeat(address(0), address(0));
    }

    // --- the fee reaches whoever holds the seat -------------------------------

    function test_feesReachTheFounderBeforeAnyHandover() public {
        _feeArrives(1 ether);
        uint256 owed = vault.claimable(address(seat));
        assertGt(owed, 0, "nothing accrued to the seat");

        vm.prank(keeper);
        seat.collect(IInstantFeeVault(address(vault)));

        assertEq(founder.balance, owed, "the founder was not paid their own fee");
        assertEq(address(seat).balance, 0, "the seat kept ether that was not its own");
    }

    /// The whole point of the contract, in one test: the same market, the same vault, the
    /// same immutable recipient, and the money arrives somewhere else afterwards.
    function test_afterAHandoverTheSameMarketPaysTheCommunity() public {
        _handOver(founder, community);

        _feeArrives(1 ether);
        uint256 owed = vault.claimable(address(seat));

        vm.prank(keeper);
        seat.collect(IInstantFeeVault(address(vault)));

        assertEq(community.balance, owed, "the community was not paid");
        assertEq(founder.balance, 0, "the founder was paid after giving up the seat");
        assertEq(vault.creator(), address(seat), "the vault's recipient changed, which it must never do");
    }

    /// Fees that accrued under the old occupant and were never claimed belong to whoever
    /// holds the seat when the claim happens. Worth pinning because it is a choice: the
    /// vault has no record of who was seated when a swap paid it, so there is nothing to
    /// split on, and a handover is therefore a handover of the unclaimed balance too.
    function test_unclaimedFeesFollowTheSeatRatherThanTheOccupantWhoEarnedThem() public {
        _feeArrives(1 ether);
        uint256 owed = vault.claimable(address(seat));

        _handOver(founder, community);

        vm.prank(keeper);
        seat.collect(IInstantFeeVault(address(vault)));

        assertEq(community.balance, owed, "the pending balance did not follow the seat");
        assertEq(founder.balance, 0, "the previous occupant was paid from after their tenure");
    }

    // --- only the occupant may move it ----------------------------------------

    function test_aStrangerCannotOfferTheSeat() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotBeneficiary.selector, stranger));
        seat.offer(stranger);
    }

    function test_thePreviousOccupantCannotTakeItBack() public {
        _handOver(founder, community);

        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotBeneficiary.selector, founder));
        seat.offer(founder);
    }

    function test_theFactoryCannotMoveASeatItDeployed() public {
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotBeneficiary.selector, address(factory)));
        seat.offer(stranger);
    }

    function test_anUninvitedAddressCannotTakeTheSeat() public {
        vm.prank(founder);
        seat.offer(community);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotOffered.selector, stranger));
        seat.take();

        assertEq(seat.beneficiary(), founder, "the seat moved to somebody who was not invited");
    }

    function test_anOfferIsNotItselfAHandover() public {
        vm.prank(founder);
        seat.offer(community);

        _feeArrives(1 ether);
        vm.prank(keeper);
        seat.collect(IInstantFeeVault(address(vault)));

        assertEq(community.balance, 0, "an unaccepted invitation redirected the fee");
        assertGt(founder.balance, 0, "the founder stopped being paid before the seat moved");
    }

    // --- the shape of the handover --------------------------------------------

    function test_theOccupantCanWithdrawAnInvitation() public {
        vm.prank(founder);
        seat.offer(community);

        vm.prank(founder);
        seat.withdrawOffer();

        assertEq(seat.offered(), address(0), "the invitation outlived its withdrawal");

        vm.prank(community);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotOffered.selector, community));
        seat.take();
    }

    function test_withdrawingNothingIsAnError() public {
        vm.prank(founder);
        vm.expectRevert(CreatorSeat.NoOffer.selector);
        seat.withdrawOffer();
    }

    /// A handover in progress must not be cancellable by a bystander. Without this the
    /// cheapest attack on a takeover is to withdraw the invitation between the two
    /// transactions and make the seat look broken.
    function test_aStrangerCannotWithdrawAnInvitation() public {
        vm.prank(founder);
        seat.offer(community);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotBeneficiary.selector, stranger));
        seat.withdrawOffer();

        assertEq(seat.offered(), community, "a stranger cancelled a handover");

        vm.prank(community);
        seat.take();
        assertEq(seat.beneficiary(), community, "the invitation did not survive the attempt");
    }

    /// Nor by the address being invited, which would otherwise be able to decline in a way
    /// that looks to the occupant like the offer was never made.
    function test_theInvitedAddressCannotWithdrawTheInvitation() public {
        vm.prank(founder);
        seat.offer(community);

        vm.prank(community);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotBeneficiary.selector, community));
        seat.withdrawOffer();
    }

    function test_aSecondInvitationReplacesTheFirst() public {
        vm.prank(founder);
        seat.offer(community);
        vm.prank(founder);
        seat.offer(stranger);

        vm.prank(community);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotOffered.selector, community));
        seat.take();

        vm.prank(stranger);
        seat.take();
        assertEq(seat.beneficiary(), stranger, "the replacement invitation did not stand");
    }

    function test_theSeatCannotBeOfferedIntoTheVoid() public {
        vm.prank(founder);
        vm.expectRevert(CreatorSeat.ZeroBeneficiary.selector);
        seat.offer(address(0));
    }

    function test_theSeatCannotBeOfferedToWhoeverAlreadyHoldsIt() public {
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.AlreadySeated.selector, founder));
        seat.offer(founder);
    }

    function test_takingTheSeatClearsTheInvitation() public {
        _handOver(founder, community);
        assertEq(seat.offered(), address(0), "the invitation survived being accepted");
    }

    function test_aSeatCanChangeHandsRepeatedly() public {
        _handOver(founder, community);
        _handOver(community, stranger);

        _feeArrives(1 ether);
        uint256 owed = vault.claimable(address(seat));
        seat.collect(IInstantFeeVault(address(vault)));

        assertEq(stranger.balance, owed, "the second handover did not take");
        assertEq(community.balance, 0, "an intermediate occupant kept being paid");
    }

    // --- hostile and awkward occupants ----------------------------------------

    /// An occupant that refuses ether breaks its own payout and nothing else. The failure is
    /// atomic, which is the part worth pinning: the collect reverts whole, so the fee is not
    /// left sitting in the seat but stays in the vault where it was, still owed and still
    /// claimable by nobody else. Handing the seat to an address that does accept ether
    /// recovers it in full, which is what the two-step handover is for.
    function test_anOccupantThatRefusesEtherBlocksOnlyItself() public {
        RejectsEther broken = new RejectsEther();
        _handOver(founder, address(broken));

        _feeArrives(1 ether);
        uint256 owed = vault.claimable(address(seat));
        assertGt(owed, 0, "nothing accrued to the seat");

        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.TransferFailed.selector, address(broken), owed));
        seat.collect(IInstantFeeVault(address(vault)));

        assertEq(vault.claimable(address(seat)), owed, "a reverted collect consumed the entitlement");
        assertEq(address(seat).balance, 0, "a reverted collect left the fee stranded in the seat");

        broken.offer(seat, community);
        vm.prank(community);
        seat.take();

        seat.collect(IInstantFeeVault(address(vault)));
        assertEq(community.balance, owed, "the fee could not be recovered by a working occupant");
    }

    /// The platform's 0.50% is never touched by a creator's broken address, which is the
    /// vault's own guarantee and must survive a seat standing in for the creator.
    function test_aBrokenOccupantDoesNotBlockThePlatform() public {
        RejectsEther broken = new RejectsEther();
        _handOver(founder, address(broken));

        _feeArrives(1 ether);
        uint256 platformOwed = vault.claimable(treasury);
        assertGt(platformOwed, 0, "nothing accrued to the platform");

        vault.claimPlatform();
        assertEq(treasury.balance, platformOwed, "the platform could not claim past a broken occupant");
    }

    function test_anOccupantReenteringIsPaidOnce() public {
        Reenters occupant = new Reenters();
        occupant.point(seat, IInstantFeeVault(address(vault)));
        _handOver(founder, address(occupant));

        _feeArrives(1 ether);
        uint256 owed = vault.claimable(address(seat));

        seat.collect(IInstantFeeVault(address(vault)));

        assertEq(occupant.received(), owed, "reentrancy changed what was paid");
        assertEq(address(occupant).balance, owed, "the occupant was paid twice");
        assertEq(address(seat).balance, 0, "the seat retained ether after paying out");
    }

    /// An occupant may hand the seat on from inside its own payout — there is no lock here
    /// and no reason for one — but doing so must not redirect the payment in flight.
    function test_offeringFromInsideAPayoutDoesNotRedirectThatPayout() public {
        OffersWhilePaid occupant = new OffersWhilePaid();
        occupant.point(seat, stranger);
        _handOver(founder, address(occupant));

        _feeArrives(1 ether);
        uint256 owed = vault.claimable(address(seat));

        seat.collect(IInstantFeeVault(address(vault)));

        assertEq(address(occupant).balance, owed, "the occupant being paid did not receive the fee");
        assertEq(stranger.balance, 0, "an invitation made mid-payment took the payment with it");
        assertEq(seat.offered(), stranger, "the invitation was not recorded");
        assertEq(seat.beneficiary(), address(occupant), "an invitation moved the seat by itself");
    }

    // --- collecting and sweeping ----------------------------------------------

    function test_anybodyMayCollect() public {
        _feeArrives(1 ether);
        uint256 owed = vault.claimable(address(seat));

        vm.prank(stranger);
        seat.collect(IInstantFeeVault(address(vault)));

        assertEq(founder.balance, owed, "a stranger's collect did not pay the occupant");
        assertEq(stranger.balance, 0, "the caller kept some of it");
    }

    function test_collectingAnUntradedMarketReverts() public {
        vm.expectRevert(abi.encodeWithSelector(InstantFeeVault.NothingToClaim.selector, address(seat)));
        seat.collect(IInstantFeeVault(address(vault)));
    }

    function test_claimableFromReportsWhatACollectWouldMove() public {
        assertEq(seat.claimableFrom(IInstantFeeVault(address(vault))), 0, "an untraded market owed something");

        _feeArrives(1 ether);
        assertEq(
            seat.claimableFrom(IInstantFeeVault(address(vault))),
            vault.claimable(address(seat)),
            "the seat and the vault disagree about what is owed"
        );
    }

    function test_etherSentToTheSeatByHandReachesTheOccupant() public {
        vm.deal(stranger, 3 ether);
        vm.prank(stranger);
        (bool ok,) = address(seat).call{value: 3 ether}("");
        assertTrue(ok, "the seat refused a bare transfer");

        seat.sweep(address(0));
        assertEq(founder.balance, 3 ether, "ether sent by hand did not reach the occupant");
    }

    function test_aTokenSentToTheSeatReachesTheOccupant() public {
        MockERC20 airdrop = new MockERC20("Airdrop", "AIR", 18);
        airdrop.mint(address(seat), 500e18);

        seat.sweep(address(airdrop));

        assertEq(airdrop.balanceOf(founder), 500e18, "the token did not reach the occupant");
        assertEq(airdrop.balanceOf(address(seat)), 0, "the seat kept the token");
    }

    function test_sweepingNothingIsHarmless() public {
        MockERC20 airdrop = new MockERC20("Airdrop", "AIR", 18);

        seat.sweep(address(0));
        seat.sweep(address(airdrop));

        assertEq(founder.balance, 0, "a sweep of nothing paid something");
    }

    function test_aSweepAfterAHandoverPaysTheNewOccupant() public {
        vm.deal(address(seat), 2 ether);
        _handOver(founder, community);

        seat.sweep(address(0));

        assertEq(community.balance, 2 ether, "a balance held before the handover did not follow the seat");
        assertEq(founder.balance, 0, "the previous occupant was paid from the seat's balance");
    }

    // --- the factory -----------------------------------------------------------

    function test_theFactoryDeploysWhereItSaidItWould() public view {
        assertEq(factory.seatOf(founder, LABEL), address(seat), "the derivation does not match the deployment");
        assertTrue(factory.isDeployed(founder, LABEL), "a deployed seat reads as absent");
        assertTrue(factory.isGenuine(founder, LABEL, address(seat)), "a genuine seat did not verify");
    }

    function test_aSecondDeployReturnsTheSameSeat() public {
        CreatorSeat again = factory.deploy(founder, LABEL);
        assertEq(address(again), address(seat), "a second deploy produced a different seat");
    }

    /// The reason the salt carries a label at all: one creator, two launches, two seats, so
    /// handing over one token does not hand over the other.
    function test_oneLabelPerLaunchKeepsHandoversApart() public {
        bytes32 other = bytes32(uint256(2));
        CreatorSeat second = factory.deploy(founder, other);
        assertTrue(address(second) != address(seat), "two labels shared one seat");

        _handOver(founder, community);

        assertEq(seat.beneficiary(), community, "the first seat did not change hands");
        assertEq(second.beneficiary(), founder, "handing over one launch handed over another");
    }

    function test_aSeatCannotBeForged() public {
        CreatorSeat impostor = new CreatorSeat(founder, address(factory));
        assertFalse(factory.isGenuine(founder, LABEL, address(impostor)), "a hand-rolled seat passed as genuine");
        assertFalse(factory.isGenuine(founder, LABEL, address(0)), "the zero address passed as genuine");
    }

    /// `isGenuine` proves who opened a seat and never who holds it now, which is the one
    /// thing an interface could reasonably misread it as.
    function test_isGenuineStillHoldsAfterTheSeatChangesHands() public {
        _handOver(founder, community);

        assertTrue(factory.isGenuine(founder, LABEL, address(seat)), "a handover invalidated the derivation");
        assertFalse(factory.isGenuine(community, LABEL, address(seat)), "the new occupant appeared to have opened it");
    }

    function test_anUndeployedSeatReadsAsAbsent() public view {
        bytes32 unused = bytes32(uint256(99));
        assertFalse(factory.isDeployed(founder, unused), "an undeployed seat reads as present");
        assertFalse(
            factory.isGenuine(founder, unused, factory.seatOf(founder, unused)), "an address with no code verified"
        );
    }

    function _arbitrate(address next) private {
        vm.prank(agen);
        seat.propose(next);
        vm.warp(block.timestamp + seat.TIMELOCK());
        vm.prank(next);
        seat.accept();
    }

    // --- the steward's path ----------------------------------------------------

    function test_theSeatAsksTheFactoryWhoTheStewardIs() public view {
        assertEq(seat.steward(), agen, "the seat does not see the factory's steward");
        assertEq(seat.factory(), address(factory), "the seat does not remember its factory");
        assertTrue(seat.arbitrable(), "a fresh seat came with arbitration already refused");
    }

    /// The whole point of the abandoned path, in one test: Agen names a wallet after an
    /// off-chain check, the delay elapses, the community signs, and the same market's 1%
    /// arrives somewhere the founder never named.
    function test_afterAStewardHandoverTheSameMarketPaysTheCommunity() public {
        _arbitrate(community);

        _feeArrives(1 ether);
        uint256 owed = vault.claimable(address(seat));

        vm.prank(keeper);
        seat.collect(IInstantFeeVault(address(vault)));

        assertEq(community.balance, owed, "the community was not paid");
        assertEq(founder.balance, 0, "the founder was paid after Agen moved the seat");
        assertEq(vault.creator(), address(seat), "the vault's recipient changed, which it must never do");
    }

    function test_aProposalIsNotItselfAHandover() public {
        vm.prank(agen);
        seat.propose(community);

        _feeArrives(1 ether);
        vm.prank(keeper);
        seat.collect(IInstantFeeVault(address(vault)));

        assertEq(community.balance, 0, "an unaccepted proposal redirected the fee");
        assertGt(founder.balance, 0, "the founder stopped being paid the moment Agen proposed");
        assertEq(seat.beneficiary(), founder, "proposing moved the seat");
    }

    function test_theSuccessorCannotAcceptBeforeTheDelay() public {
        vm.prank(agen);
        seat.propose(community);

        uint256 executableAt = seat.executableAt();
        vm.warp(executableAt - 1);

        vm.prank(community);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.TooEarly.selector, executableAt));
        seat.accept();

        assertEq(seat.beneficiary(), founder, "the delay did not hold");
    }

    function test_theSuccessorCanAcceptTheMomentTheDelayElapses() public {
        vm.prank(agen);
        seat.propose(community);

        vm.warp(seat.executableAt());
        vm.prank(community);
        seat.accept();

        assertEq(seat.beneficiary(), community, "accepting at the boundary did not take");
        assertEq(seat.proposed(), address(0), "the proposal survived being accepted");
        assertEq(seat.executableAt(), 0, "a consumed proposal still advertised a time");
    }

    function test_aLiveCreatorCanVetoAProposal() public {
        vm.prank(agen);
        seat.propose(community);

        vm.prank(founder);
        seat.veto();

        assertEq(seat.proposed(), address(0), "the veto did not clear the proposal");

        vm.warp(block.timestamp + seat.TIMELOCK());
        vm.prank(community);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotProposed.selector, community));
        seat.accept();

        assertEq(seat.beneficiary(), founder, "a vetoed proposal still moved the seat");
    }

    function test_aStrangerCannotVeto() public {
        vm.prank(agen);
        seat.propose(community);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotBeneficiary.selector, stranger));
        seat.veto();

        assertEq(seat.proposed(), community, "a stranger cancelled a CTO");
    }

    function test_theProposedAddressCannotVeto() public {
        vm.prank(agen);
        seat.propose(community);

        vm.prank(community);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotBeneficiary.selector, community));
        seat.veto();
    }

    function test_vetoingNothingIsAnError() public {
        vm.prank(founder);
        vm.expectRevert(CreatorSeat.NoProposal.selector);
        seat.veto();
    }

    function test_aStrangerCannotPropose() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotSteward.selector, stranger));
        seat.propose(stranger);
    }

    function test_theFactoryCannotProposeUnlessItIsTheSteward() public {
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotSteward.selector, address(factory)));
        seat.propose(community);
    }

    function test_theFounderCannotPropose() public {
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotSteward.selector, founder));
        seat.propose(community);
    }

    function test_anUninvitedAddressCannotAccept() public {
        vm.prank(agen);
        seat.propose(community);
        vm.warp(block.timestamp + seat.TIMELOCK());

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotProposed.selector, stranger));
        seat.accept();

        assertEq(seat.beneficiary(), founder, "a stranger intercepted a CTO");
    }

    function test_aProposalCannotNameTheCurrentOccupant() public {
        vm.prank(agen);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.AlreadySeated.selector, founder));
        seat.propose(founder);
    }

    function test_aProposalCannotNameTheZeroAddress() public {
        vm.prank(agen);
        vm.expectRevert(CreatorSeat.ZeroBeneficiary.selector);
        seat.propose(address(0));
    }

    /// Replacing a proposal restarts the clock. Without this a steward waits thirteen days
    /// against a dummy, then swaps in the real address and executes immediately — a delay
    /// in name only.
    function test_replacingAProposalRestartsTheDelay() public {
        vm.prank(agen);
        seat.propose(stranger);

        vm.warp(block.timestamp + seat.TIMELOCK() - 1 days);

        vm.prank(agen);
        seat.propose(community);

        uint256 ready = seat.executableAt();
        vm.prank(community);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.TooEarly.selector, ready));
        seat.accept();

        vm.warp(block.timestamp + seat.TIMELOCK());
        vm.prank(community);
        seat.accept();
        assertEq(seat.beneficiary(), community, "the replacement proposal did not take after its own delay");
    }

    function test_aProposalWithdrawsAnOpenOccupantOffer() public {
        vm.prank(founder);
        seat.offer(stranger);

        vm.prank(agen);
        seat.propose(community);

        assertEq(seat.offered(), address(0), "the occupant's offer survived a competing proposal");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotOffered.selector, stranger));
        seat.take();
    }

    function test_anOccupantOfferVetoesAPendingProposal() public {
        vm.prank(agen);
        seat.propose(community);

        vm.prank(founder);
        seat.offer(stranger);

        assertEq(seat.proposed(), address(0), "the occupant's offer left the proposal standing");

        vm.warp(block.timestamp + seat.TIMELOCK());
        vm.prank(community);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotProposed.selector, community));
        seat.accept();

        vm.prank(stranger);
        seat.take();
        assertEq(seat.beneficiary(), stranger, "the occupant's own handover did not take");
    }

    function test_aSeatWithoutAFactoryHasNoSteward() public {
        CreatorSeat orphan = new CreatorSeat(founder, address(0));
        assertEq(orphan.steward(), address(0), "an orphan seat invented a steward");

        vm.prank(agen);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotSteward.selector, agen));
        orphan.propose(community);
    }

    function test_aFactoryWithNoStewardCannotPropose() public {
        CreatorSeatFactory lonely = new CreatorSeatFactory(address(0));
        CreatorSeat seated = lonely.deploy(founder, LABEL);

        vm.prank(agen);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotSteward.selector, agen));
        seated.propose(community);
    }

    function test_renouncingArbitrationStopsTheStewardForever() public {
        vm.prank(founder);
        seat.renounceArbitration();

        assertFalse(seat.arbitrable(), "renouncing did not stick");

        vm.prank(agen);
        vm.expectRevert(CreatorSeat.NotArbitrable.selector);
        seat.propose(community);

        vm.prank(founder);
        vm.expectRevert(CreatorSeat.AlreadyRenounced.selector);
        seat.renounceArbitration();
    }

    function test_renouncingClearsAPendingProposal() public {
        vm.prank(agen);
        seat.propose(community);

        vm.prank(founder);
        seat.renounceArbitration();

        assertEq(seat.proposed(), address(0), "renouncing left a proposal that could still be accepted");

        vm.warp(block.timestamp + seat.TIMELOCK());
        vm.prank(community);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotProposed.selector, community));
        seat.accept();
    }

    function test_aStrangerCannotRenounceArbitration() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotBeneficiary.selector, stranger));
        seat.renounceArbitration();

        assertTrue(seat.arbitrable(), "a stranger opted the seat out of Agen's path");
    }

    function test_aLaterOccupantInheritsARenounce() public {
        vm.prank(founder);
        seat.renounceArbitration();
        _handOver(founder, community);

        vm.prank(agen);
        vm.expectRevert(CreatorSeat.NotArbitrable.selector);
        seat.propose(stranger);
    }

    function test_rotatingTheStewardUpdatesEverySeat() public {
        address next = makeAddr("next-agen");

        vm.prank(agen);
        factory.offerSteward(next);
        vm.prank(next);
        factory.acceptSteward();

        assertEq(seat.steward(), next, "the seat still honoured the old key");

        vm.prank(agen);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotSteward.selector, agen));
        seat.propose(community);

        vm.prank(next);
        seat.propose(community);
        assertEq(seat.proposed(), community, "the new steward could not propose");
    }

    function test_aStrangerCannotRotateTheSteward() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeatFactory.NotSteward.selector, stranger));
        factory.offerSteward(stranger);
    }

    function test_anUninvitedAddressCannotAcceptTheStewardRole() public {
        vm.prank(agen);
        factory.offerSteward(community);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeatFactory.NotPendingSteward.selector, stranger));
        factory.acceptSteward();
    }

    function test_aStrangerCannotWithdrawAStewardInvitation() public {
        vm.prank(agen);
        factory.offerSteward(community);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeatFactory.NotSteward.selector, stranger));
        factory.withdrawStewardOffer();

        assertEq(factory.pendingSteward(), community, "a stranger cancelled a steward handover");
    }

    function test_theStewardCanWithdrawItsOwnInvitation() public {
        vm.prank(agen);
        factory.offerSteward(community);
        vm.prank(agen);
        factory.withdrawStewardOffer();

        vm.prank(community);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeatFactory.NotPendingSteward.selector, community));
        factory.acceptSteward();
    }

    function test_withdrawingNoStewardOfferIsAnError() public {
        vm.prank(agen);
        vm.expectRevert(CreatorSeatFactory.NoStewardOffer.selector);
        factory.withdrawStewardOffer();
    }

    function test_theStewardCannotBeOfferedIntoTheVoid() public {
        vm.prank(agen);
        vm.expectRevert(CreatorSeatFactory.ZeroSteward.selector);
        factory.offerSteward(address(0));
    }

    function test_theStewardCannotBeOfferedToWhoeverAlreadyHoldsIt() public {
        vm.prank(agen);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeatFactory.AlreadySteward.selector, agen));
        factory.offerSteward(agen);
    }

    function test_renouncingTheStewardTurnsProposeOffEverywhere() public {
        vm.prank(agen);
        factory.renounceSteward();

        assertEq(factory.steward(), address(0), "renouncing did not clear the steward");
        assertEq(seat.steward(), address(0), "the seat still saw a steward");

        vm.prank(agen);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeat.NotSteward.selector, agen));
        seat.propose(community);

        // Occupant handovers keep working; the abandoned path is what went away.
        _handOver(founder, community);
        assertEq(seat.beneficiary(), community, "renouncing the steward broke the occupant's own path");
    }

    function test_aStrangerCannotRenounceTheSteward() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreatorSeatFactory.NotSteward.selector, stranger));
        factory.renounceSteward();
    }
}
