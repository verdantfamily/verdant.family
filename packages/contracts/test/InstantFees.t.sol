// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {InstantFees} from "../src/libraries/InstantFees.sol";

/// @title The Instant fee split, asserted rather than described
/// @notice ADR-014 states one invariant about every Instant trade: it costs
/// exactly 1.50%, of which exactly 1.00% is the creator's and exactly 0.50% is the
/// platform's, and there is no other charge. This file is that sentence as tests.
///
/// @dev The properties worth having are the ones that hold for *every* amount, not
/// for the round numbers a worked example uses, so most of what follows is fuzzed.
/// The fixed vectors exist alongside them to catch the failure a property test
/// cannot: an arithmetically self-consistent library that divides by the wrong
/// constant. `test_aWholeEtherPaysTheAdvertisedNumbers` would fail on a 1% fee even
/// though every invariant below would still hold.
contract InstantFeesTest is Test {
    /// The exact creator share, computed the way the library deliberately does
    /// not — a third independent multiplication — so the tests have something to
    /// measure the derived-by-subtraction answer against.
    function _exactCreator(uint256 amount) private pure returns (uint256) {
        return (amount * InstantFees.CREATOR_PPM) / InstantFees.PPM_DENOMINATOR;
    }

    // --- the constants themselves --------------------------------------------

    function test_theSharesSumToTheTotal() public pure {
        // The one relationship that cannot be allowed to drift. If somebody edits
        // a share without editing the total, every other test here still passes:
        // `split` derives the creator's cut by subtraction, so it would silently
        // hand the difference to the creator rather than failing.
        assertEq(
            uint256(InstantFees.CREATOR_PPM) + InstantFees.PLATFORM_PPM,
            InstantFees.TOTAL_PPM,
            "the creator and platform shares must be the whole fee"
        );
    }

    function test_theFeeIsTheOneAdrOneFourStates() public pure {
        assertEq(InstantFees.TOTAL_PPM, 15_000, "ADR-014 fixes the total at 1.50%");
        assertEq(InstantFees.CREATOR_PPM, 10_000, "ADR-014 fixes the creator's share at 1.00%");
        assertEq(InstantFees.PLATFORM_PPM, 5_000, "ADR-014 fixes the platform's share at 0.50%");
    }

    function test_theCreatorTakesTwiceWhatThePlatformDoes() public pure {
        // Stated as a ratio as well as as two numbers, because this is the part a
        // reader checks against the marketing copy: two thirds to the creator.
        assertEq(InstantFees.CREATOR_PPM, 2 * uint256(InstantFees.PLATFORM_PPM), "the split is 2:1 to the creator");
    }

    // --- worked examples ------------------------------------------------------

    function test_aWholeEtherPaysTheAdvertisedNumbers() public pure {
        (uint256 creator, uint256 platform, uint256 total) = InstantFees.split(1 ether);

        assertEq(total, 0.015 ether, "1 ether of trade owes 0.015 ether of fee");
        assertEq(creator, 0.01 ether, "the creator's 1.00% of one ether");
        assertEq(platform, 0.005 ether, "the platform's 0.50% of one ether");
    }

    function test_nothingIsOwedOnNothing() public pure {
        (uint256 creator, uint256 platform, uint256 total) = InstantFees.split(0);

        assertEq(total, 0, "a zero trade owes no fee");
        assertEq(creator, 0, "a zero trade owes the creator nothing");
        assertEq(platform, 0, "a zero trade owes the platform nothing");
    }

    function test_dustRoundsDownRatherThanUp() public pure {
        // Below 67 wei the fee rounds to nothing at all. Worth pinning: the
        // alternative rounding would charge a wei on a trade of one wei, which is
        // an infinite fee rate and the kind of thing that turns up in an audit.
        (uint256 creator, uint256 platform, uint256 total) = InstantFees.split(1);

        assertEq(total, 0, "one wei of trade owes no fee");
        assertEq(creator, 0, "no dust invented for the creator");
        assertEq(platform, 0, "no dust invented for the platform");
    }

    // --- the invariants -------------------------------------------------------

    /// The property the whole design exists for: the two shares are the fee, to
    /// the wei, for every amount. Nothing is stranded in the hook and nothing is
    /// conjured out of it.
    function testFuzz_theSharesAlwaysSumToExactlyTheFee(uint128 amount) public pure {
        (uint256 creator, uint256 platform, uint256 total) = InstantFees.split(amount);

        assertEq(creator + platform, total, "the two shares must be exactly the fee");
    }

    /// A trader is charged 1.50% and never a wei more. This is the half of "no
    /// hidden double-charge" that lives in the arithmetic; the other half is the
    /// pool's LP fee being zero, which belongs to the hook rather than here.
    function testFuzz_theTraderIsChargedExactlyOnePointFivePercent(uint128 amount) public pure {
        (,, uint256 total) = InstantFees.split(amount);

        assertEq(
            total,
            (uint256(amount) * InstantFees.TOTAL_PPM) / InstantFees.PPM_DENOMINATOR,
            "the fee must be 1.50% of the trade, rounded down"
        );
        assertLe(total * InstantFees.PPM_DENOMINATOR, uint256(amount) * InstantFees.TOTAL_PPM, "the fee overcharges");
    }

    function testFuzz_thePlatformTakesExactlyHalfAPercent(uint128 amount) public pure {
        (, uint256 platform,) = InstantFees.split(amount);

        assertEq(
            platform,
            (uint256(amount) * InstantFees.PLATFORM_PPM) / InstantFees.PPM_DENOMINATOR,
            "the platform's share must be 0.50% of the trade, rounded down"
        );
    }

    /// The creator's share is derived rather than computed, so it is worth
    /// checking against the computation it replaces. It can exceed it by a wei —
    /// that is the remainder of the other two divisions — and it can never fall
    /// short, which is the direction that matters: rounding favours the creator
    /// over the protocol, never the reverse.
    function testFuzz_theCreatorTakesOnePercentAndAnyRemainder(uint128 amount) public pure {
        (uint256 creator,,) = InstantFees.split(amount);

        uint256 exact = _exactCreator(amount);
        assertGe(creator, exact, "the creator was rounded against");
        assertLe(creator, exact + 1, "the creator was given more than a wei of rounding");
    }

    function testFuzz_neitherShareEverExceedsTheFee(uint128 amount) public pure {
        (uint256 creator, uint256 platform, uint256 total) = InstantFees.split(amount);

        assertLe(creator, total, "the creator's share exceeds the fee");
        assertLe(platform, total, "the platform's share exceeds the fee");
    }

    /// A fee larger than the trade it is taken from would mean a swap that cannot
    /// settle. Trivially true at 1.5%, and asserted anyway because it is the
    /// bound that stops a future edit to the constants from producing one.
    function testFuzz_theFeeIsAlwaysSmallerThanTheTrade(uint128 amount) public pure {
        (,, uint256 total) = InstantFees.split(amount);

        assertLt(total, amount == 0 ? 1 : amount, "the fee is not smaller than the trade");
    }

    /// Splitting a trade in two and splitting it whole cannot differ by more than
    /// the rounding of one extra division. Stated because the opposite — a fee
    /// that is materially cheaper when a trade is broken up — is the shape of
    /// every fee-avoidance bug, and at 1.5% the incentive to find one is real.
    function testFuzz_splittingATradeDoesNotAvoidTheFee(uint96 first, uint96 second) public pure {
        (,, uint256 whole) = InstantFees.split(uint256(first) + second);
        (,, uint256 apart) = InstantFees.split(first);
        (,, uint256 rest) = InstantFees.split(second);

        assertLe(apart + rest, whole, "splitting a trade charged more than doing it at once");
        assertLe(whole - (apart + rest), 1, "splitting a trade avoided more than a wei");
    }
}
