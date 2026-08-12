// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {FeeForwarder, IFeeSplitter} from "../src/FeeForwarder.sol";
import {FeeForwarderFactory} from "../src/FeeForwarderFactory.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";

/// @dev An owner that will not take ether, which is the one way a creator can put
/// their own fees out of reach by choosing a bad address.
contract RejectsEther {
    receive() external payable {
        revert("no");
    }
}

/// @dev An owner that calls back into the forwarder while being paid. There is no
/// state here for it to corrupt, and this proves it.
contract Reenters {
    FeeForwarder public forwarder;
    IFeeSplitter public splitter;
    uint256 public received;

    function point(FeeForwarder forwarder_, IFeeSplitter splitter_) external {
        forwarder = forwarder_;
        splitter = splitter_;
    }

    receive() external payable {
        received += msg.value;
        // A second pull during the first. The splitter has already zeroed this
        // recipient's entitlement, so it reverts — and the try/catch keeps that
        // from taking down the payment that is in progress.
        try forwarder.pull(splitter) {} catch {}
    }
}

/// @title FeeForwarder — being paid without sending a transaction
/// @notice The claim this contract makes is narrow and worth stating exactly: a
/// creator's fees can be delivered by a stranger, and a stranger can do nothing
/// else with them. Every test here is one half of that — either "somebody who is
/// not the owner successfully moved the money", or "and it went to the owner and
/// only the owner".
///
/// The splitter is the real `FeeSplitter`, not a mock. What is being tested is an
/// interaction between two contracts — that naming a contract as `feeRecipient`
/// turns the splitter's msg.sender-only pull into something anybody can trigger —
/// and a mock splitter would be testing that this contract calls a function.
contract FeeForwarderTest is Test {
    uint16 internal constant PROTOCOL_BPS = 1_000;
    address internal constant NATIVE_QUOTE = address(0);

    FeeForwarderFactory internal factory;
    FeeForwarder internal forwarder;
    FeeSplitter internal splitter;
    MockERC20 internal token;

    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        factory = new FeeForwarderFactory();
        forwarder = factory.deploy(creator);

        token = new MockERC20("Market", "MKT", 18);
        // The market names the forwarder as its fee recipient. This is the whole
        // arrangement: everything else follows from the splitter paying a contract.
        splitter = new FeeSplitter(address(forwarder), treasury, NATIVE_QUOTE, address(token), PROTOCOL_BPS);
    }

    function _fund(uint256 nativeAmount, uint256 tokenAmount) internal {
        if (nativeAmount != 0) vm.deal(address(splitter), address(splitter).balance + nativeAmount);
        if (tokenAmount != 0) token.mint(address(splitter), tokenAmount);
    }

    // --- the point of the contract -------------------------------------------

    function test_aStrangerCanPayTheCreatorAndTheCreatorDoesNothing() public {
        _fund(10 ether, 1_000e18);

        vm.prank(stranger);
        (uint256 quoteAmount, uint256 tokenAmount) = forwarder.pull(IFeeSplitter(address(splitter)));

        assertEq(quoteAmount, 9 ether, "90% of the ether");
        assertEq(tokenAmount, 900e18, "90% of the token");

        // The creator never sent a transaction and holds the money.
        assertEq(creator.balance, 9 ether, "the creator was paid in ether");
        assertEq(token.balanceOf(creator), 900e18, "and in the token");

        // Nothing stays in the forwarder. A contract that accumulated would be a
        // second place to have to remember to empty.
        assertEq(address(forwarder).balance, 0, "the forwarder keeps no ether");
        assertEq(token.balanceOf(address(forwarder)), 0, "and no token");
    }

    function test_theProtocolShareIsUntouchedAndStillTheTreasurysToClaim() public {
        _fund(10 ether, 0);

        vm.prank(stranger);
        forwarder.pull(IFeeSplitter(address(splitter)));

        // Pulling the creator's share must not move or forfeit the other one.
        (uint256 treasuryNative,) = splitter.claimable(treasury);
        assertEq(treasuryNative, 1 ether, "the protocol's tenth is still there");

        vm.prank(treasury);
        splitter.claim();
        assertEq(treasury.balance, 1 ether, "and still claimable by the treasury");
    }

    function test_aStrangerCannotRedirectTheMoney() public {
        _fund(10 ether, 0);

        // There is no argument for whom to pay and no owner-only function to
        // change it, so the only lever a caller has is *when*.
        vm.prank(stranger);
        forwarder.pull(IFeeSplitter(address(splitter)));

        assertEq(stranger.balance, 0, "the caller gets nothing");
        assertEq(creator.balance, 9 ether, "the owner gets everything");
    }

    function test_onlyTheForwarderCanClaimWhatTheForwarderIsOwed() public {
        _fund(10 ether, 0);

        // The creator's own wallet is not the splitter's recipient any more — the
        // forwarder is. This is the cost of the arrangement and it is worth being
        // explicit about: a creator who uses a forwarder claims through it.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.NotARecipient.selector, creator));
        splitter.claim();
    }

    // --- behaviour a keeper depends on ---------------------------------------

    function test_anEmptyMarketRevertsRatherThanPayingNothing() public {
        // Inherited from the splitter, and worth pinning because a keeper's loop
        // has to expect it: most markets, most of the time, have nothing to pull.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.NothingToClaim.selector, address(forwarder)));
        forwarder.pull(IFeeSplitter(address(splitter)));
    }

    function test_aKeeperCanAskBeforeSpendingTheGas() public {
        _fund(10 ether, 1_000e18);

        (uint256 quoteAmount, uint256 tokenAmount) = forwarder.claimableFrom(IFeeSplitter(address(splitter)));
        assertEq(quoteAmount, 9 ether, "what a pull would move");
        assertEq(tokenAmount, 900e18, "in both currencies");

        vm.prank(stranger);
        forwarder.pull(IFeeSplitter(address(splitter)));

        (uint256 after_,) = forwarder.claimableFrom(IFeeSplitter(address(splitter)));
        assertEq(after_, 0, "and nothing afterwards");
    }

    function test_pullingRepeatedlyIsSafeAndPaysEachNewFee() public {
        _fund(10 ether, 0);
        vm.prank(stranger);
        forwarder.pull(IFeeSplitter(address(splitter)));
        assertEq(creator.balance, 9 ether, "the first collection");

        _fund(5 ether, 0);
        vm.prank(stranger);
        forwarder.pull(IFeeSplitter(address(splitter)));
        assertEq(creator.balance, 13.5 ether, "and the second, added to it");
    }

    // --- assets that arrive by other routes ----------------------------------

    function test_etherSentStraightToTheForwarderIsNotStuck() public {
        // Nobody should do this, and there is no reason for the owner's money to
        // be unreachable when they do.
        vm.deal(address(forwarder), 3 ether);

        vm.prank(stranger);
        forwarder.sweep(address(0));

        assertEq(creator.balance, 3 ether, "swept to the owner");
        assertEq(address(forwarder).balance, 0, "and nothing kept");
    }

    function test_anUnrelatedTokenIsNotStuck() public {
        MockERC20 airdrop = new MockERC20("Airdrop", "AIR", 18);
        airdrop.mint(address(forwarder), 42e18);

        vm.prank(stranger);
        forwarder.sweep(address(airdrop));

        assertEq(airdrop.balanceOf(creator), 42e18, "the owner's, like everything here");
    }

    function test_sweepingNothingIsNotAnError() public {
        // A keeper sweeping speculatively should not have to check first.
        vm.prank(stranger);
        forwarder.sweep(address(0));
        forwarder.sweep(address(token));
    }

    /// @dev A pull forwards the balance rather than the amount just claimed, so a
    /// stray transfer is carried out on the next pull instead of accumulating.
    function test_aPullAlsoCarriesOutWhateverWasAlreadyHere() public {
        vm.deal(address(forwarder), 1 ether);
        _fund(10 ether, 0);

        vm.prank(stranger);
        forwarder.pull(IFeeSplitter(address(splitter)));

        assertEq(creator.balance, 10 ether, "the claim plus what was sitting here");
        assertEq(address(forwarder).balance, 0);
    }

    // --- the ways this can go wrong ------------------------------------------

    function test_anOwnerThatRejectsEtherCannotBePaid() public {
        RejectsEther bad = new RejectsEther();
        FeeForwarder stuck = factory.deploy(address(bad));
        FeeSplitter theirs = new FeeSplitter(address(stuck), treasury, NATIVE_QUOTE, address(token), PROTOCOL_BPS);
        vm.deal(address(theirs), 10 ether);

        // Documented rather than defended against: this contract cannot make an
        // address accept ether. The money is not lost — it stays in the splitter,
        // still owed to this forwarder — but it cannot be delivered.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FeeForwarder.TransferFailed.selector, address(bad), 9 ether));
        stuck.pull(IFeeSplitter(address(theirs)));

        (uint256 owed,) = theirs.claimable(address(stuck));
        assertEq(owed, 9 ether, "still owed, still unreachable");
    }

    function test_anOwnerReenteringChangesNothing() public {
        Reenters greedy = new Reenters();
        FeeForwarder theirs = factory.deploy(address(greedy));
        FeeSplitter theirSplitter =
            new FeeSplitter(address(theirs), treasury, NATIVE_QUOTE, address(token), PROTOCOL_BPS);
        greedy.point(theirs, IFeeSplitter(address(theirSplitter)));

        vm.deal(address(theirSplitter), 10 ether);

        vm.prank(stranger);
        theirs.pull(IFeeSplitter(address(theirSplitter)));

        // Paid once, not twice. This contract holds no accounting for a reentrant
        // call to confuse; the splitter's own effects-before-transfers does the work.
        assertEq(greedy.received(), 9 ether, "exactly the entitlement");
        assertEq(address(theirSplitter).balance, 1 ether, "the treasury's share, untouched");
    }

    function test_construction() public {
        vm.expectRevert(FeeForwarder.ZeroOwner.selector);
        new FeeForwarder(address(0));

        assertEq(forwarder.owner(), creator, "the owner is fixed at construction");
    }

    // --- the factory ---------------------------------------------------------

    function test_theAddressIsDerivedFromTheOwnerAndKnownBeforeDeployment() public {
        address predicted = factory.forwarderOf(stranger);
        assertFalse(factory.isDeployed(stranger), "not there yet");
        assertEq(predicted.code.length, 0, "and no code at it");

        FeeForwarder made = factory.deploy(stranger);
        assertEq(address(made), predicted, "deployed exactly where it was predicted");
        assertTrue(factory.isDeployed(stranger), "and now it is there");
    }

    function test_deployingTwiceReturnsTheSameOneRatherThanFailing() public {
        // A launch flow calls this without checking, and a creator's second market
        // must not fail because their first already made a forwarder.
        FeeForwarder again = factory.deploy(creator);
        assertEq(address(again), address(forwarder), "the same forwarder");
        assertEq(again.owner(), creator, "still theirs");
    }

    function test_oneForwarderServesEveryMarketItsOwnerCreates() public {
        MockERC20 second = new MockERC20("Second", "TWO", 18);
        FeeSplitter other = new FeeSplitter(address(forwarder), treasury, NATIVE_QUOTE, address(second), PROTOCOL_BPS);

        _fund(10 ether, 0);
        vm.deal(address(other), 4 ether);
        second.mint(address(other), 100e18);

        vm.startPrank(stranger);
        forwarder.pull(IFeeSplitter(address(splitter)));
        forwarder.pull(IFeeSplitter(address(other)));
        vm.stopPrank();

        assertEq(creator.balance, 12.6 ether, "90% of both markets' ether");
        assertEq(second.balanceOf(creator), 90e18, "and the second market's token");
    }

    function test_everyOwnerGetsADifferentForwarder() public view {
        assertTrue(factory.forwarderOf(creator) != factory.forwarderOf(treasury), "one each");
    }
}
