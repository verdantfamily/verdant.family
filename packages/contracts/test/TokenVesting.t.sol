// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {TokenVesting} from "../src/TokenVesting.sol";
import {VerdantToken} from "../src/VerdantToken.sol";
import {Abi} from "./utils/Abi.sol";

/// @title TokenVesting — the creator's allocation, released on a schedule
///
/// @notice The contract exists so a creator can say "my allocation unlocks over a
/// year" and have that be a fact rather than an intention. Everything about it is
/// therefore immutable: beneficiary, amount, start, cliff, duration. There is no
/// revocation and no owner, because either one would turn the schedule back into
/// a promise.
///
/// @dev The properties worth testing are arithmetic ones, so most of this file is
/// fuzzed over the whole parameter space rather than checked at hand-picked
/// points. The three that matter:
///
///   1. nothing is releasable before the cliff — the case a creator is judged on;
///   2. the total ever released equals the allocation exactly, never more and
///      never less by the end;
///   3. releasing repeatedly, at any timings, never pays out more than the
///      schedule allows.
contract TokenVestingTest is Test {
    VerdantToken internal token;

    address internal constant BENEFICIARY = address(0xBEEF);
    address internal constant STRANGER = address(0x5747A6E);

    uint256 internal constant ALLOCATION = 100_000e18;
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    uint64 internal constant START = 1_800_000_000;
    uint64 internal constant CLIFF = 90 days;
    uint64 internal constant DURATION = 365 days;

    string internal constant ARTIFACT = "out/TokenVesting.sol/TokenVesting.json";

    function setUp() public {
        token = new VerdantToken("Vested", "VST", SUPPLY, address(0xC0FFEE), "ipfs://Qm", true);
        vm.warp(START);
    }

    function _deploy() internal returns (TokenVesting vesting) {
        return _deploy(ALLOCATION, START, CLIFF, DURATION);
    }

    function _deploy(uint256 amount, uint64 start, uint64 cliff, uint64 duration)
        internal
        returns (TokenVesting vesting)
    {
        vesting = new TokenVesting(address(token), BENEFICIARY, amount, start, cliff, duration);
        assertTrue(token.transfer(address(vesting), amount), "funding transfer failed");
    }

    // --- construction --------------------------------------------------------

    function test_storesTheScheduleItWasGiven() public {
        TokenVesting vesting = _deploy();

        assertEq(address(vesting.token()), address(token));
        assertEq(vesting.beneficiary(), BENEFICIARY);
        assertEq(vesting.totalAllocation(), ALLOCATION);
        assertEq(vesting.start(), START);
        assertEq(vesting.cliff(), START + CLIFF);
        assertEq(vesting.end(), START + DURATION);
        assertEq(vesting.released(), 0);
    }

    function test_refusesACliffLongerThanTheDuration() public {
        // A cliff past the end would lock the allocation forever while looking
        // like a schedule. This is the configuration error most likely to be made
        // by hand, so it is rejected rather than merely documented.
        vm.expectRevert(abi.encodeWithSelector(TokenVesting.CliffAfterEnd.selector, DURATION + 1, DURATION));
        new TokenVesting(address(token), BENEFICIARY, ALLOCATION, START, DURATION + 1, DURATION);
    }

    function test_acceptsACliffExactlyAtTheEnd() public {
        // The boundary the check above must not over-reject: a cliff equal to the
        // duration is a single unlock at the end, which is a legitimate schedule.
        TokenVesting vesting = _deploy(ALLOCATION, START, DURATION, DURATION);
        assertEq(vesting.cliff(), vesting.end());
    }

    function test_refusesAZeroDuration() public {
        vm.expectRevert(TokenVesting.ZeroDuration.selector);
        new TokenVesting(address(token), BENEFICIARY, ALLOCATION, START, 0, 0);
    }

    function test_refusesAZeroAllocation() public {
        vm.expectRevert(TokenVesting.ZeroAllocation.selector);
        new TokenVesting(address(token), BENEFICIARY, 0, START, CLIFF, DURATION);
    }

    function test_refusesAZeroBeneficiary() public {
        vm.expectRevert(TokenVesting.ZeroBeneficiary.selector);
        new TokenVesting(address(token), address(0), ALLOCATION, START, CLIFF, DURATION);
    }

    function test_refusesAZeroToken() public {
        vm.expectRevert(TokenVesting.ZeroToken.selector);
        new TokenVesting(address(0), BENEFICIARY, ALLOCATION, START, CLIFF, DURATION);
    }

    // --- the cliff -----------------------------------------------------------

    function test_nothingIsReleasableBeforeTheCliff() public {
        TokenVesting vesting = _deploy();

        assertEq(vesting.vestedAmount(START), 0, "at start");
        assertEq(vesting.vestedAmount(START + CLIFF - 1), 0, "one second before the cliff");
        assertEq(vesting.releasable(), 0, "releasable before the cliff");
    }

    function test_releaseBeforeTheCliffRevertsRatherThanPayingZero() public {
        TokenVesting vesting = _deploy();

        // A zero-value release that "succeeds" is a worse interface than one that
        // fails: a keeper or a UI would take it as confirmation.
        vm.expectRevert(TokenVesting.NothingToRelease.selector);
        vesting.release();
    }

    function test_theCliffUnlocksTheAccruedPortionAtOnce() public {
        TokenVesting vesting = _deploy();

        // Vesting accrues from `start`, and the cliff gates access to it. So at
        // the cliff the accrued 90/365 becomes releasable in one step. This is the
        // standard meaning of a cliff and it is worth pinning, because the other
        // plausible reading — accrual beginning at the cliff — produces a
        // different number here and the same number nowhere else.
        uint256 expected = (ALLOCATION * CLIFF) / DURATION;
        assertEq(vesting.vestedAmount(START + CLIFF), expected, "vested at the cliff");

        vm.warp(START + CLIFF);
        assertEq(vesting.releasable(), expected, "releasable at the cliff");
    }

    // --- linear release ------------------------------------------------------

    function test_isLinearBetweenTheCliffAndTheEnd() public {
        TokenVesting vesting = _deploy();

        // Sampled at quarters. Linear means the vested amount is proportional to
        // elapsed time, so these are computed from the definition rather than
        // hardcoded.
        uint64[3] memory points = [START + DURATION / 4, START + DURATION / 2, START + (DURATION * 3) / 4];
        for (uint256 i = 0; i < points.length; i++) {
            uint256 elapsed = points[i] - START;
            assertEq(vesting.vestedAmount(points[i]), (ALLOCATION * elapsed) / DURATION, "not linear");
        }
    }

    function test_theFullAllocationIsVestedAtTheEndAndNeverMore() public {
        TokenVesting vesting = _deploy();

        assertEq(vesting.vestedAmount(START + DURATION), ALLOCATION, "at the end");
        assertEq(vesting.vestedAmount(START + DURATION + 1), ALLOCATION, "one second after");
        assertEq(vesting.vestedAmount(START + DURATION * 10), ALLOCATION, "long after");
        assertEq(vesting.vestedAmount(type(uint64).max), ALLOCATION, "at the end of time");
    }

    function test_anyoneCanTriggerARelease_butOnlyTheBeneficiaryIsPaid() public {
        TokenVesting vesting = _deploy();
        vm.warp(START + DURATION);

        // Permissionless on purpose: a beneficiary who has lost access to gas
        // should not lose their allocation, and there is no discretion in where
        // the tokens go, so there is nothing to protect by restricting the caller.
        vm.prank(STRANGER);
        vesting.release();

        assertEq(token.balanceOf(BENEFICIARY), ALLOCATION, "beneficiary paid");
        assertEq(token.balanceOf(STRANGER), 0, "caller paid nothing");
    }

    function test_releaseEmitsTheAmount() public {
        TokenVesting vesting = _deploy();
        vm.warp(START + DURATION);

        vm.expectEmit(true, true, true, true, address(vesting));
        emit TokenVesting.Released(BENEFICIARY, ALLOCATION);
        vesting.release();
    }

    function test_releasingTwiceAtTheSameInstantPaysOnce() public {
        TokenVesting vesting = _deploy();
        vm.warp(START + DURATION);

        vesting.release();
        assertEq(token.balanceOf(BENEFICIARY), ALLOCATION);

        vm.expectRevert(TokenVesting.NothingToRelease.selector);
        vesting.release();
        assertEq(token.balanceOf(BENEFICIARY), ALLOCATION, "paid twice");
    }

    // --- fuzz ---------------------------------------------------------------

    /// @dev Bounds chosen to cover the whole configured range — 30 to 730 days per
    /// the parameter register — plus degenerate one-second schedules, which is
    /// where integer division misbehaves.
    function _fuzzSchedule(uint256 amount, uint64 cliffSeed, uint64 durationSeed)
        internal
        returns (TokenVesting vesting, uint256 allocation, uint64 cliff, uint64 duration)
    {
        allocation = bound(amount, 1, SUPPLY / 2);
        duration = uint64(bound(durationSeed, 1, 730 days));
        cliff = uint64(bound(cliffSeed, 0, duration));
        vesting = _deploy(allocation, START, cliff, duration);
    }

    function testFuzz_nothingIsReleasableBeforeTheCliff(uint256 amount, uint64 cliffSeed, uint64 durationSeed) public {
        (TokenVesting vesting,, uint64 cliff,) = _fuzzSchedule(amount, cliffSeed, durationSeed);

        if (cliff == 0) return; // no cliff to be before

        vm.warp(START + cliff - 1);
        assertEq(vesting.releasable(), 0, "releasable before the cliff");
        assertEq(vesting.vestedAmount(START + cliff - 1), 0, "vested before the cliff");
    }

    function testFuzz_vestedIsMonotoneAndBounded(
        uint256 amount,
        uint64 cliffSeed,
        uint64 durationSeed,
        uint64 t0,
        uint64 t1
    ) public {
        (TokenVesting vesting, uint256 allocation,,) = _fuzzSchedule(amount, cliffSeed, durationSeed);

        (uint64 earlier, uint64 later) = t0 <= t1 ? (t0, t1) : (t1, t0);

        uint256 vestedEarlier = vesting.vestedAmount(earlier);
        uint256 vestedLater = vesting.vestedAmount(later);

        // Time only moves forward, so vested value only increases, and it never
        // exceeds the allocation no matter how far out the timestamp is.
        assertLe(vestedEarlier, vestedLater, "vested went backwards");
        assertLe(vestedLater, allocation, "vested more than the allocation");
    }

    function testFuzz_releasingRepeatedlyNeverExceedsTheSchedule(
        uint256 amount,
        uint64 cliffSeed,
        uint64 durationSeed,
        uint64[8] calldata jumps
    ) public {
        (TokenVesting vesting, uint256 allocation,,) = _fuzzSchedule(amount, cliffSeed, durationSeed);

        uint256 paid;
        uint64 t = START;

        for (uint256 i = 0; i < jumps.length; i++) {
            // Bounded jumps, so a run spends its time inside the schedule rather
            // than immediately past the end where everything is trivially full.
            t += uint64(bound(jumps[i], 0, 200 days));
            vm.warp(t);

            uint256 releasable = vesting.releasable();
            if (releasable == 0) continue;

            vesting.release();
            paid += releasable;

            // The invariant, checked after every single release: what has been
            // paid is exactly what the schedule says is vested at this instant.
            assertEq(vesting.released(), paid, "released accounting drifted");
            assertEq(paid, vesting.vestedAmount(t), "paid more or less than vested");
            assertEq(token.balanceOf(BENEFICIARY), paid, "beneficiary balance disagrees");
            assertLe(paid, allocation, "paid more than the allocation");
        }
    }

    function testFuzz_theWholeAllocationIsEventuallyPaidExactlyOnce(
        uint256 amount,
        uint64 cliffSeed,
        uint64 durationSeed,
        uint64 intermediate
    ) public {
        (TokenVesting vesting, uint256 allocation,, uint64 duration) = _fuzzSchedule(amount, cliffSeed, durationSeed);

        // One arbitrary partial release on the way, to prove the final total does
        // not depend on how many times it was collected.
        vm.warp(START + uint64(bound(intermediate, 0, duration)));
        if (vesting.releasable() > 0) vesting.release();

        vm.warp(START + duration);
        if (vesting.releasable() > 0) vesting.release();

        assertEq(token.balanceOf(BENEFICIARY), allocation, "beneficiary was not made whole");
        assertEq(vesting.released(), allocation, "released total");
        assertEq(token.balanceOf(address(vesting)), 0, "tokens stranded in the vesting contract");

        // And nothing remains claimable afterwards, at any later time.
        vm.warp(START + duration * 2);
        assertEq(vesting.releasable(), 0, "still releasable after being fully paid");
    }

    // --- the absences -------------------------------------------------------

    function test_abiHasNoRevocationOrOwnership() public view {
        string memory abiSection = Abi.section(ARTIFACT);

        // The contract's entire value is that the schedule cannot be interfered
        // with. Any of these would contradict that.
        string[9] memory forbidden = [
            "revoke",
            "cancel",
            "owner",
            "transferOwnership",
            "renounceOwnership",
            "setBeneficiary",
            "sweep",
            "rescue",
            "emergencyWithdraw"
        ];

        for (uint256 i = 0; i < forbidden.length; i++) {
            assertFalse(Abi.declaresFunction(abiSection, forbidden[i]), string.concat("ABI declares ", forbidden[i]));
        }

        assertTrue(Abi.declaresFunction(abiSection, "release"), "no release in ABI");
        assertTrue(Abi.declaresFunction(abiSection, "releasable"), "no releasable in ABI");
    }
}
