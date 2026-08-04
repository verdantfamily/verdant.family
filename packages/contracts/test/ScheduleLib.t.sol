// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ScheduleLib} from "../src/libraries/ScheduleLib.sol";

/// @title ScheduleLib — validation and property tests
/// @notice The differential vectors prove ScheduleLib agrees with its TypeScript
/// twin on a fixed corpus. This file proves the properties that must hold for
/// inputs nobody wrote down.
///
/// @dev The single most important property here is that `feeAt` cannot revert.
/// It runs inside `beforeSwap`, so a revert is not an error report — it is a pool
/// that cannot be traded, permanently, with liquidity locked inside it. Every
/// other property in this file is secondary to that one.
contract ScheduleLibTest is Test {
    using ScheduleLib for ScheduleLib.Packed;

    uint40 internal constant INIT_TIME = 1_800_000_000;

    /// @dev The library's one storage-writing function cannot be reached from a
    /// pure context, so it gets a holder that keeps a schedule where a hook would.
    InitTimeHolder internal holder;

    function setUp() public {
        holder = new InitTimeHolder();
    }

    // --- helpers ------------------------------------------------------------

    function _stages(uint32[] memory offsets, uint24[] memory fees)
        internal
        pure
        returns (ScheduleLib.Stage[] memory stages)
    {
        require(offsets.length == fees.length, "ragged test input");
        stages = new ScheduleLib.Stage[](offsets.length);
        for (uint256 i = 0; i < offsets.length; i++) {
            stages[i] = ScheduleLib.Stage({startOffset: offsets[i], feePpm: fees[i]});
        }
    }

    function _one(uint32 offset, uint24 fee) internal pure returns (ScheduleLib.Stage[] memory stages) {
        stages = new ScheduleLib.Stage[](1);
        stages[0] = ScheduleLib.Stage({startOffset: offset, feePpm: fee});
    }

    function _two(uint32 o0, uint24 f0, uint32 o1, uint24 f1)
        internal
        pure
        returns (ScheduleLib.Stage[] memory stages)
    {
        stages = new ScheduleLib.Stage[](2);
        stages[0] = ScheduleLib.Stage({startOffset: o0, feePpm: f0});
        stages[1] = ScheduleLib.Stage({startOffset: o1, feePpm: f1});
    }

    /// @dev External wrapper so `vm.expectRevert` has a call boundary to observe.
    function validateExternal(uint40 initTime, ScheduleLib.Stage[] memory stages) external pure {
        ScheduleLib.validate(initTime, stages);
    }

    function packExternal(uint8 model, uint40 initTime, ScheduleLib.Stage[] memory stages) external pure {
        ScheduleLib.pack(model, initTime, stages);
    }

    // --- validation: one test per failure mode -------------------------------
    // Each asserts its own specific error with its own parameters. A validator
    // that rejects everything with one generic revert cannot tell a creator what
    // to fix, and cannot be shown to have rejected for the right reason.

    function test_validate_revertsOnZeroStages() public {
        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](0);
        vm.expectRevert(abi.encodeWithSelector(ScheduleLib.InvalidStageCount.selector, 0, ScheduleLib.MAX_STAGES));
        this.validateExternal(INIT_TIME, stages);
    }

    function test_validate_revertsOnTooManyStages() public {
        uint32[] memory offsets = new uint32[](9);
        uint24[] memory fees = new uint24[](9);
        for (uint256 i = 0; i < 9; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) -- i < 9 and MIN_STAGE_GAP is 300, so the product fits uint32
            offsets[i] = uint32(i * ScheduleLib.MIN_STAGE_GAP);
            fees[i] = 10_000;
        }
        vm.expectRevert(abi.encodeWithSelector(ScheduleLib.InvalidStageCount.selector, 9, ScheduleLib.MAX_STAGES));
        this.validateExternal(INIT_TIME, _stages(offsets, fees));
    }

    function test_validate_acceptsExactlyMaxStages() public pure {
        uint32[] memory offsets = new uint32[](8);
        uint24[] memory fees = new uint24[](8);
        for (uint256 i = 0; i < 8; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) -- i < 8 and MIN_STAGE_GAP is 300, so the product fits uint32
            offsets[i] = uint32(i * ScheduleLib.MIN_STAGE_GAP);
            fees[i] = 10_000;
        }
        // The boundary must be inclusive, or the documented maximum is a lie.
        ScheduleLib.validate(INIT_TIME, _stages(offsets, fees));
    }

    function test_validate_revertsWhenFirstOffsetIsNonZero() public {
        vm.expectRevert(abi.encodeWithSelector(ScheduleLib.FirstOffsetNonZero.selector, 1));
        this.validateExternal(INIT_TIME, _two(1, 50_000, 1 days, 10_000));
    }

    function test_validate_revertsOnEqualOffsets() public {
        vm.expectRevert(abi.encodeWithSelector(ScheduleLib.ScheduleNotIncreasing.selector, 1, 0, 0));
        this.validateExternal(INIT_TIME, _two(0, 50_000, 0, 10_000));
    }

    function test_validate_revertsOnDecreasingOffsets() public {
        uint32[] memory offsets = new uint32[](3);
        uint24[] memory fees = new uint24[](3);
        offsets[0] = 0;
        offsets[1] = 2 days;
        offsets[2] = 1 days;
        fees[0] = 50_000;
        fees[1] = 30_000;
        fees[2] = 10_000;
        vm.expectRevert(
            abi.encodeWithSelector(ScheduleLib.ScheduleNotIncreasing.selector, 2, uint256(2 days), uint256(1 days))
        );
        this.validateExternal(INIT_TIME, _stages(offsets, fees));
    }

    function test_validate_revertsOnGapOneSecondUnderMinimum() public {
        uint32 offset = uint32(ScheduleLib.MIN_STAGE_GAP) - 1;
        vm.expectRevert(
            abi.encodeWithSelector(ScheduleLib.StageGapTooSmall.selector, 1, offset, ScheduleLib.MIN_STAGE_GAP)
        );
        this.validateExternal(INIT_TIME, _two(0, 50_000, offset, 10_000));
    }

    function test_validate_acceptsGapExactlyAtMinimum() public pure {
        // The other side of the same boundary. Both directions are asserted
        // because a `<` / `<=` mix-up passes one and fails the other.
        ScheduleLib.validate(INIT_TIME, _two(0, 50_000, uint32(ScheduleLib.MIN_STAGE_GAP), 10_000));
    }

    function test_validate_appliesGapCheckToEveryPair() public {
        uint32[] memory offsets = new uint32[](4);
        uint24[] memory fees = new uint24[](4);
        offsets[0] = 0;
        offsets[1] = 1 days;
        offsets[2] = 2 days;
        offsets[3] = 2 days + 10;
        fees[0] = 50_000;
        fees[1] = 40_000;
        fees[2] = 30_000;
        fees[3] = 20_000;
        vm.expectRevert(abi.encodeWithSelector(ScheduleLib.StageGapTooSmall.selector, 3, 10, ScheduleLib.MIN_STAGE_GAP));
        this.validateExternal(INIT_TIME, _stages(offsets, fees));
    }

    function test_validate_revertsOneSecondPastTheHorizon() public {
        uint32 offset = uint32(ScheduleLib.MAX_HORIZON) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(ScheduleLib.HorizonExceeded.selector, 1, offset, ScheduleLib.MAX_HORIZON)
        );
        this.validateExternal(INIT_TIME, _two(0, 50_000, offset, 10_000));
    }

    function test_validate_acceptsAStageExactlyOnTheHorizon() public pure {
        ScheduleLib.validate(INIT_TIME, _two(0, 50_000, uint32(ScheduleLib.MAX_HORIZON), 100));
    }

    function test_validate_revertsOnFeeBelowMinimum() public {
        uint24 fee = uint24(ScheduleLib.MIN_FEE_PPM) - 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                ScheduleLib.FeeOutOfBounds.selector, 0, fee, ScheduleLib.MIN_FEE_PPM, ScheduleLib.MAX_FEE_PPM
            )
        );
        this.validateExternal(INIT_TIME, _one(0, fee));
    }

    function test_validate_revertsOnZeroFee() public {
        // Zero is what an uninitialised field holds, so it has to be rejected
        // explicitly rather than by happening to fall outside a range.
        vm.expectRevert(
            abi.encodeWithSelector(
                ScheduleLib.FeeOutOfBounds.selector, 0, 0, ScheduleLib.MIN_FEE_PPM, ScheduleLib.MAX_FEE_PPM
            )
        );
        this.validateExternal(INIT_TIME, _one(0, 0));
    }

    function test_validate_revertsOnFeeAboveMaximum() public {
        uint24 fee = uint24(ScheduleLib.MAX_FEE_PPM) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                ScheduleLib.FeeOutOfBounds.selector, 0, fee, ScheduleLib.MIN_FEE_PPM, ScheduleLib.MAX_FEE_PPM
            )
        );
        this.validateExternal(INIT_TIME, _one(0, fee));
    }

    function test_validate_revertsOnUniswapsOwnMaximumFee() public {
        // 1_000_000 ppm is a legal Uniswap fee and an illegal Verdant one.
        // Verdant's cap is a policy, and a policy has to be enforced where it is
        // declared rather than assumed to follow from the pool's own limits.
        vm.expectRevert(
            abi.encodeWithSelector(
                ScheduleLib.FeeOutOfBounds.selector, 0, 1_000_000, ScheduleLib.MIN_FEE_PPM, ScheduleLib.MAX_FEE_PPM
            )
        );
        this.validateExternal(INIT_TIME, _one(0, 1_000_000));
    }

    function test_validate_appliesFeeCheckToEveryStage() public {
        uint32[] memory offsets = new uint32[](3);
        uint24[] memory fees = new uint24[](3);
        offsets[0] = 0;
        offsets[1] = 1 days;
        offsets[2] = 2 days;
        fees[0] = 50_000;
        fees[1] = 30_000;
        fees[2] = uint24(ScheduleLib.MAX_FEE_PPM) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                ScheduleLib.FeeOutOfBounds.selector, 2, fees[2], ScheduleLib.MIN_FEE_PPM, ScheduleLib.MAX_FEE_PPM
            )
        );
        this.validateExternal(INIT_TIME, _stages(offsets, fees));
    }

    function test_validate_acceptsBothFeeBoundsExactly() public pure {
        ScheduleLib.validate(INIT_TIME, _one(0, uint24(ScheduleLib.MIN_FEE_PPM)));
        ScheduleLib.validate(INIT_TIME, _one(0, uint24(ScheduleLib.MAX_FEE_PPM)));
    }

    function test_validate_acceptsEqualFeesInAdjacentStages() public pure {
        // Only offsets must strictly increase. A validator that also demands
        // changing fees is over-strict and would reject a legitimate schedule.
        ScheduleLib.validate(INIT_TIME, _two(0, 10_000, 1 days, 10_000));
    }

    function test_pack_refusesToPackAnInvalidSchedule() public {
        // The load-bearing case for the whole encoding: every field is written
        // through a mask, so an unvalidated out-of-range value would be silently
        // truncated into a different, valid-looking, immutable schedule.
        vm.expectPartialRevert(ScheduleLib.FeeOutOfBounds.selector);
        this.packExternal(0, INIT_TIME, _one(0, 0));
    }

    function test_isValid_agreesWithValidate() public pure {
        assertTrue(ScheduleLib.isValid(INIT_TIME, _one(0, 10_000)));
        assertFalse(ScheduleLib.isValid(INIT_TIME, _one(1, 10_000)));
        assertFalse(ScheduleLib.isValid(INIT_TIME, _one(0, 0)));
        assertFalse(ScheduleLib.isValid(INIT_TIME, new ScheduleLib.Stage[](0)));
    }

    // --- field capacity ------------------------------------------------------
    // The P1 encoding narrowed a stage from the specified 56 bits to 48. That is
    // an improvement — four stages in word0 instead of three — but only if both
    // fields still span their whole declared range. Nothing else in this file
    // would reliably catch a narrowed field: `_validScheduleFrom` and the vector
    // generator both derive their inputs FROM the bounds, so a field too small to
    // hold a bound produces configurations that are truncated identically on the
    // way in and on the way out, and every round trip still passes.
    //
    // These tests therefore assert the capacity arithmetic directly, and then
    // exercise both extremes as real values in both storage words.

    function test_offsetFieldCanRepresentTheWholeHorizon() public pure {
        // 730 days = 63_072_000 needs ceil(log2(63_072_001)) = 26 bits.
        // forge-lint: disable-next-line(incorrect-shift) -- the shift is over the field width, which is the quantity under test
        uint256 capacity = (1 << ScheduleLib.OFFSET_BITS) - 1;
        assertGe(capacity, ScheduleLib.MAX_HORIZON, "startOffset cannot represent MAX_HORIZON");

        // Stated as an explicit floor as well as a comparison, so that lowering
        // OFFSET_BITS to 24 — the plausible even split, and a field that holds
        // only 194 days — fails here rather than somewhere subtle.
        assertGe(ScheduleLib.OFFSET_BITS, 26, "startOffset needs at least 26 bits");
    }

    function test_feeFieldCanRepresentTheMaximumFee() public pure {
        // 100_000 ppm needs ceil(log2(100_001)) = 17 bits.
        // forge-lint: disable-next-line(incorrect-shift) -- the shift is over the field width, which is the quantity under test
        uint256 capacity = (1 << ScheduleLib.FEE_BITS) - 1;
        assertGe(capacity, ScheduleLib.MAX_FEE_PPM, "feePpm cannot represent MAX_FEE_PPM");
        assertGe(ScheduleLib.FEE_BITS, 17, "feePpm needs at least 17 bits");

        // Uniswap's own cap, which Verdant's policy sits below. If Verdant ever
        // raised its cap to the protocol maximum, the field would not have to
        // change — worth knowing, and cheap to pin.
        assertGe(capacity, 1_000_000, "feePpm should still hold Uniswap's MAX_LP_FEE");
    }

    function test_stageWidthIsTheSumOfItsFields() public pure {
        assertEq(ScheduleLib.OFFSET_BITS + ScheduleLib.FEE_BITS, ScheduleLib.STAGE_BITS, "stage width");
    }

    function test_stagesInFirstWordIsExactlyTheNumberThatFit() public pure {
        // Both directions, because this constant is what the single-SLOAD claim
        // and the gas snapshot rest on. Four must fit; five must not.
        uint256 four = ScheduleLib.HEADER_BITS + ScheduleLib.STAGES_IN_FIRST_WORD * ScheduleLib.STAGE_BITS;
        uint256 five = ScheduleLib.HEADER_BITS + (ScheduleLib.STAGES_IN_FIRST_WORD + 1) * ScheduleLib.STAGE_BITS;

        assertLe(four, ScheduleLib.WORD_BITS, "the claimed stages do not fit in word0");
        assertGt(five, ScheduleLib.WORD_BITS, "one more stage would fit, so the constant is too low");
        assertEq(four, 248, "56 + 4 x 48");
    }

    function test_remainingStagesFitTheSecondWord() public pure {
        uint256 remaining = ScheduleLib.MAX_STAGES - ScheduleLib.STAGES_IN_FIRST_WORD;
        assertLe(remaining * ScheduleLib.STAGE_BITS, ScheduleLib.WORD_BITS, "word1 cannot hold the remaining stages");
    }

    // --- field capacity, exercised as values ---------------------------------

    function test_aStageOnTheHorizonSurvivesPackingAndIsActiveOnTime() public pure {
        // The acceptance case for the offset field: MAX_HORIZON as a real value,
        // round-tripped, and then read back as the active stage at exactly
        // initTime + MAX_HORIZON.
        ScheduleLib.Stage[] memory stages = _two(0, 50_000, uint32(ScheduleLib.MAX_HORIZON), 12_345);
        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, INIT_TIME, stages);

        (,, ScheduleLib.Stage[] memory restored) = ScheduleLib.unpack(packed);
        assertEq(restored[1].startOffset, uint32(ScheduleLib.MAX_HORIZON), "the horizon offset was truncated");

        uint256 at = uint256(INIT_TIME) + ScheduleLib.MAX_HORIZON;
        assertEq(packed.feeAt(at), 12_345, "fee at the horizon");
        assertEq(packed.stageAt(at), 1, "stage at the horizon");

        // One second earlier still belongs to the previous stage, which is what
        // makes the assertion above about the boundary rather than about the
        // schedule merely having ended up somewhere plausible.
        assertEq(packed.feeAt(at - 1), 50_000, "fee one second before the horizon");
        assertEq(packed.stageAt(at - 1), 0, "stage one second before the horizon");
    }

    function test_maximumFeeSurvivesPackingLosslessly() public pure {
        ScheduleLib.Stage[] memory stages = _one(0, uint24(ScheduleLib.MAX_FEE_PPM));
        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, INIT_TIME, stages);

        (,, ScheduleLib.Stage[] memory restored) = ScheduleLib.unpack(packed);
        assertEq(restored[0].feePpm, uint24(ScheduleLib.MAX_FEE_PPM), "the maximum fee was truncated");
        assertEq(packed.feeAt(INIT_TIME), uint24(ScheduleLib.MAX_FEE_PPM), "maximum fee read back");
    }

    function test_bothExtremesSurviveInTheHighestStageSlot() public pure {
        // Stage 7 lives in word1 at a different shift from stage 0, so the
        // extremes are exercised there too. A mask that is right for one word and
        // wrong for the other would otherwise pass everything above.
        uint32[] memory offsets = new uint32[](8);
        uint24[] memory fees = new uint24[](8);
        for (uint256 i = 0; i < 7; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) -- i < 7 and MIN_STAGE_GAP is 300, so the product fits uint32
            offsets[i] = uint32(i * ScheduleLib.MIN_STAGE_GAP);
            fees[i] = 10_000;
        }
        offsets[7] = uint32(ScheduleLib.MAX_HORIZON);
        fees[7] = uint24(ScheduleLib.MAX_FEE_PPM);

        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, INIT_TIME, _stages(offsets, fees));
        (,, ScheduleLib.Stage[] memory restored) = ScheduleLib.unpack(packed);

        assertEq(restored[7].startOffset, uint32(ScheduleLib.MAX_HORIZON), "offset truncated in word1");
        assertEq(restored[7].feePpm, uint24(ScheduleLib.MAX_FEE_PPM), "fee truncated in word1");

        uint256 at = uint256(INIT_TIME) + ScheduleLib.MAX_HORIZON;
        assertEq(packed.stageAt(at), 7, "the last stage must be active at the horizon");
        assertEq(packed.feeAt(at), uint24(ScheduleLib.MAX_FEE_PPM), "fee at the horizon in word1");
    }

    function test_validate_reportsTheOffendingStageIndexForHorizon() public {
        // The existing horizon test violates at index 1. This one violates at
        // index 3, so a hardcoded index in the error would show up.
        uint32[] memory offsets = new uint32[](4);
        uint24[] memory fees = new uint24[](4);
        offsets[0] = 0;
        offsets[1] = 1 days;
        offsets[2] = 2 days;
        offsets[3] = uint32(ScheduleLib.MAX_HORIZON) + 1;
        fees[0] = 50_000;
        fees[1] = 40_000;
        fees[2] = 30_000;
        fees[3] = 20_000;

        vm.expectRevert(
            abi.encodeWithSelector(ScheduleLib.HorizonExceeded.selector, 3, offsets[3], ScheduleLib.MAX_HORIZON)
        );
        this.validateExternal(INIT_TIME, _stages(offsets, fees));
    }

    // --- fuzz: the no-revert guarantee --------------------------------------

    /// @dev Builds a valid schedule from fuzzed entropy. Deriving a valid config
    /// rather than rejecting invalid ones keeps every one of the 10 000 runs
    /// useful; `vm.assume` on a structured input this constrained would discard
    /// almost everything.
    function _validScheduleFrom(uint256 seed, uint8 rawCount)
        internal
        pure
        returns (ScheduleLib.Stage[] memory stages)
    {
        uint256 count = 1 + (uint256(rawCount) % ScheduleLib.MAX_STAGES);
        stages = new ScheduleLib.Stage[](count);

        uint256 offset;
        for (uint256 i = 0; i < count; i++) {
            uint256 entropy = uint256(keccak256(abi.encode(seed, i)));

            if (i > 0) {
                // Leave room for every remaining stage to keep its minimum gap.
                uint256 remaining = count - i;
                uint256 headroom = ScheduleLib.MAX_HORIZON - offset - ScheduleLib.MIN_STAGE_GAP * remaining;
                offset += ScheduleLib.MIN_STAGE_GAP + (headroom == 0 ? 0 : entropy % headroom);
            }

            uint256 fee =
                ScheduleLib.MIN_FEE_PPM + ((entropy >> 128) % (ScheduleLib.MAX_FEE_PPM - ScheduleLib.MIN_FEE_PPM + 1));

            // forge-lint: disable-next-line(unsafe-typecast) -- both values are bounded to their field above; that bounding is the point
            stages[i] = ScheduleLib.Stage({startOffset: uint32(offset), feePpm: uint24(fee)});
        }
    }

    /// @notice THE gate for this phase.
    /// @dev `feeAt` must return a fee inside the permitted band for every valid
    /// schedule and every timestamp, without reverting. A revert here is a pool
    /// that cannot be traded with liquidity locked in it.
    function testFuzz_feeAtNeverRevertsAndStaysInBand(uint256 seed, uint8 rawCount, uint40 initTime, uint256 timestamp)
        public
        pure
    {
        ScheduleLib.Stage[] memory stages = _validScheduleFrom(seed, rawCount);
        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, initTime, stages);

        uint24 fee = packed.feeAt(timestamp);

        assertGe(uint256(fee), ScheduleLib.MIN_FEE_PPM, "fee below the permitted band");
        assertLe(uint256(fee), ScheduleLib.MAX_FEE_PPM, "fee above the permitted band");
    }

    /// @dev The same guarantee for timestamps at and around initTime, which is
    /// where an unsigned subtraction would underflow. Fuzzing the whole uint256
    /// range makes this region statistically unreachable, so it is targeted.
    function testFuzz_feeAtHandlesTimestampsAroundInitTime(uint256 seed, uint8 rawCount, uint40 initTime, uint16 delta)
        public
        pure
    {
        ScheduleLib.Stage[] memory stages = _validScheduleFrom(seed, rawCount);
        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, initTime, stages);

        uint256 before = initTime > delta ? initTime - delta : 0;

        assertEq(packed.feeAt(before), stages[0].feePpm, "before initTime must clamp to stage 0");
        assertEq(packed.stageAt(before), 0, "before initTime must be stage 0");

        uint24 fee = packed.feeAt(uint256(initTime) + delta);
        assertGe(uint256(fee), ScheduleLib.MIN_FEE_PPM);
        assertLe(uint256(fee), ScheduleLib.MAX_FEE_PPM);
    }

    function testFuzz_feeAtHandlesTheExtremesOfUint256(uint256 seed, uint8 rawCount, uint40 initTime) public pure {
        ScheduleLib.Stage[] memory stages = _validScheduleFrom(seed, rawCount);
        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, initTime, stages);

        // type(uint256).max would overflow `initTime + offset` in a naive
        // implementation. It must not here.
        assertEq(packed.feeAt(type(uint256).max), stages[stages.length - 1].feePpm, "max timestamp");
        assertEq(packed.feeAt(0), stages[0].feePpm, "zero timestamp");
    }

    // --- fuzz: packing ------------------------------------------------------

    function testFuzz_packUnpackRoundTrips(uint256 seed, uint8 rawCount, uint8 model, uint40 initTime) public pure {
        ScheduleLib.Stage[] memory stages = _validScheduleFrom(seed, rawCount);
        ScheduleLib.Packed memory packed = ScheduleLib.pack(model, initTime, stages);

        (uint8 outModel, uint40 outInitTime, ScheduleLib.Stage[] memory restored) = ScheduleLib.unpack(packed);

        assertEq(outModel, model, "model");
        assertEq(outInitTime, initTime, "initTime");
        assertEq(restored.length, stages.length, "stage count");
        for (uint256 i = 0; i < stages.length; i++) {
            assertEq(restored[i].startOffset, stages[i].startOffset, "offset");
            assertEq(restored[i].feePpm, stages[i].feePpm, "fee");
        }
    }

    /// @dev The round trip above uses schedules derived from the bounds, so its
    /// coverage of the extremes is probabilistic. This one places the maximum fee
    /// in every stage slot in turn, deterministically, while fuzzing the header
    /// around it — the header shares word0 with stages 0 to 3, so a header value
    /// that corrupted a neighbouring field would show up here.
    function testFuzz_maximumFeeRoundTripsInEveryStageSlot(uint8 model, uint40 initTime) public pure {
        for (uint256 slot = 0; slot < ScheduleLib.MAX_STAGES; slot++) {
            uint32[] memory offsets = new uint32[](ScheduleLib.MAX_STAGES);
            uint24[] memory fees = new uint24[](ScheduleLib.MAX_STAGES);
            for (uint256 i = 0; i < ScheduleLib.MAX_STAGES; i++) {
                // forge-lint: disable-next-line(unsafe-typecast) -- i < 8 and MIN_STAGE_GAP is 300, so the product fits uint32
                offsets[i] = uint32(i * ScheduleLib.MIN_STAGE_GAP);
                fees[i] = i == slot ? uint24(ScheduleLib.MAX_FEE_PPM) : uint24(ScheduleLib.MIN_FEE_PPM);
            }

            ScheduleLib.Stage[] memory stages = _stages(offsets, fees);
            ScheduleLib.Packed memory packed = ScheduleLib.pack(model, initTime, stages);
            (,, ScheduleLib.Stage[] memory restored) = ScheduleLib.unpack(packed);

            for (uint256 i = 0; i < ScheduleLib.MAX_STAGES; i++) {
                assertEq(restored[i].startOffset, offsets[i], "offset changed in some slot");
                assertEq(restored[i].feePpm, fees[i], "fee changed in some slot");
            }
            assertEq(packed.feeAt(uint256(initTime) + offsets[slot]), fees[slot], "extreme fee read back");
        }
    }

    function testFuzz_headerFieldsDoNotBleedIntoStages(uint8 model, uint40 initTime) public pure {
        // The model byte and initTime share word0 with the first four stages. If
        // a shift or mask is wrong, changing the header silently changes a fee.
        ScheduleLib.Stage[] memory stages = _two(0, 12_345, 1 days, 54_321);

        ScheduleLib.Packed memory packed = ScheduleLib.pack(model, initTime, stages);

        assertEq(packed.modelOf(), model, "model");
        assertEq(packed.initTimeOf(), initTime, "initTime");
        assertEq(packed.stageCount(), 2, "stage count");
        assertEq(packed.feeAt(uint256(initTime)), 12_345, "first fee");
        assertEq(packed.feeAt(uint256(initTime) + 1 days), 54_321, "second fee");
    }

    function testFuzz_smallSchedulesNeverTouchTheSecondWord(uint256 seed, uint40 initTime) public pure {
        for (uint256 count = 1; count <= ScheduleLib.STAGES_IN_FIRST_WORD; count++) {
            // forge-lint: disable-next-line(unsafe-typecast) -- count is bound to MAX_STAGES above, so count - 1 fits uint8
            ScheduleLib.Stage[] memory stages = _validScheduleFrom(seed, uint8(count - 1));
            // _validScheduleFrom maps rawCount to 1 + (rawCount % 8), so ask for
            // the count directly rather than trusting the modulus.
            if (stages.length > ScheduleLib.STAGES_IN_FIRST_WORD) continue;
            assertEq(ScheduleLib.pack(0, initTime, stages).word1, 0, "second word must stay empty");
        }
    }

    // --- fuzz: step-function properties ------------------------------------

    function testFuzz_stageIsMonotoneInTime(uint256 seed, uint8 rawCount, uint40 initTime, uint32 t0, uint32 t1)
        public
        pure
    {
        ScheduleLib.Stage[] memory stages = _validScheduleFrom(seed, rawCount);
        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, initTime, stages);

        (uint256 earlier, uint256 later) = t0 <= t1 ? (uint256(t0), uint256(t1)) : (uint256(t1), uint256(t0));

        // Time only moves forward, so the active stage may only move forward. A
        // schedule that could go backwards would mean a fee that rises again
        // after falling without a declared transition.
        assertLe(packed.stageAt(earlier), packed.stageAt(later), "stage went backwards in time");
    }

    function testFuzz_feeIsConstantWithinAStage(uint256 seed, uint8 rawCount, uint40 initTime, uint256 pick)
        public
        pure
    {
        ScheduleLib.Stage[] memory stages = _validScheduleFrom(seed, rawCount);
        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, initTime, stages);

        uint256 index = pick % stages.length;
        uint256 from = uint256(initTime) + stages[index].startOffset;
        uint256 to = index + 1 < stages.length
            ? uint256(initTime) + stages[index + 1].startOffset - 1
            : from + ScheduleLib.MAX_HORIZON;

        // The defining property: constant between transitions, sampled at both
        // ends, the midpoint, and a pseudorandom interior point.
        uint256 interior = from + (to == from ? 0 : (uint256(keccak256(abi.encode(pick, seed))) % (to - from + 1)));

        assertEq(packed.feeAt(from), stages[index].feePpm, "fee at stage start");
        assertEq(packed.feeAt(from + (to - from) / 2), stages[index].feePpm, "fee mid stage");
        assertEq(packed.feeAt(to), stages[index].feePpm, "fee at stage end");
        assertEq(packed.feeAt(interior), stages[index].feePpm, "fee at interior point");
        assertEq(packed.stageAt(from), index, "stage index at start");
    }

    function testFuzz_transitionIsInclusiveAtItsOffset(uint256 seed, uint8 rawCount, uint40 initTime, uint256 pick)
        public
        pure
    {
        ScheduleLib.Stage[] memory stages = _validScheduleFrom(seed, rawCount);
        if (stages.length < 2) return;

        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, initTime, stages);
        uint256 index = 1 + (pick % (stages.length - 1));
        uint256 at = uint256(initTime) + stages[index].startOffset;

        // The stage that owns a boundary is the one starting on it. One second
        // earlier still belongs to the previous stage. This is the off-by-one a
        // user would notice, because it is the instant a countdown reaches zero.
        assertEq(packed.stageAt(at), index, "boundary belongs to the new stage");
        assertEq(packed.stageAt(at - 1), index - 1, "one second earlier is the old stage");
        assertEq(packed.feeAt(at), stages[index].feePpm, "fee at the boundary");
        assertEq(packed.feeAt(at - 1), stages[index - 1].feePpm, "fee one second before");
    }

    function testFuzz_nextTransitionMatchesTheFollowingStage(uint256 seed, uint8 rawCount, uint40 initTime)
        public
        pure
    {
        ScheduleLib.Stage[] memory stages = _validScheduleFrom(seed, rawCount);
        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, initTime, stages);

        for (uint256 i = 0; i < stages.length; i++) {
            uint256 t = uint256(initTime) + stages[i].startOffset;
            uint256 next = packed.nextTransition(t);

            if (i + 1 < stages.length) {
                assertEq(next, uint256(initTime) + stages[i + 1].startOffset, "next transition timestamp");
                // The countdown and the fee must come from the same source, or
                // they can disagree at the moment anyone is watching.
                assertEq(packed.feeAt(next), stages[i + 1].feePpm, "fee at the next transition");
            } else {
                assertEq(next, 0, "no transition remains after the final stage");
            }
        }
    }

    function testFuzz_finalFeeIsHeldForever(uint256 seed, uint8 rawCount, uint40 initTime, uint64 extra) public pure {
        ScheduleLib.Stage[] memory stages = _validScheduleFrom(seed, rawCount);
        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, initTime, stages);

        ScheduleLib.Stage memory last = stages[stages.length - 1];
        uint256 t = uint256(initTime) + last.startOffset + uint256(extra);

        assertEq(packed.feeAt(t), last.feePpm, "final fee must be held indefinitely");
        assertEq(packed.stageAt(t), stages.length - 1, "final stage must be held indefinitely");
    }

    // --- the storage entry point --------------------------------------------
    //
    // `feeAtStored` is what `beforeSwap` actually calls, and it is a second
    // implementation of the read: it decides from the stage count whether to load
    // `word1` at all. That branch is a gas optimisation, so the risk is that it
    // saves an SLOAD by reading a word that a large schedule needed. It must
    // therefore agree with the memory form for every schedule, on both sides of
    // the branch. The gas suite exercises this path too, but it measures cost
    // rather than checking the answer.

    ScheduleLib.Packed internal stored;

    function _store(ScheduleLib.Stage[] memory stages, uint40 initTime) internal {
        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, initTime, stages);
        stored.word0 = packed.word0;
        stored.word1 = packed.word1;
    }

    function test_storedReadAgreesWhenTheScheduleFitsInOneWord() public {
        ScheduleLib.Stage[] memory stages = _two(0, 90_000, 7 days, 10_000);
        _store(stages, INIT_TIME);

        assertEq(stored.word1, 0, "a two-stage schedule must not occupy the second word");
        assertEq(ScheduleLib.feeAtStored(stored, INIT_TIME), 90_000, "first stage from storage");
        assertEq(ScheduleLib.feeAtStored(stored, uint256(INIT_TIME) + 7 days), 10_000, "second stage from storage");
    }

    function test_storedReadAgreesWhenTheScheduleSpillsIntoTheSecondWord() public {
        uint32[] memory offsets = new uint32[](ScheduleLib.MAX_STAGES);
        uint24[] memory fees = new uint24[](ScheduleLib.MAX_STAGES);
        for (uint256 i = 0; i < ScheduleLib.MAX_STAGES; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) -- i < 8, so i * 30 days fits uint32
            offsets[i] = uint32(i * 30 days);
            // forge-lint: disable-next-line(unsafe-typecast) -- stays above MIN_FEE_PPM, and so inside uint24, for i < 8
            fees[i] = uint24(ScheduleLib.MAX_FEE_PPM - i * 10_000);
        }
        ScheduleLib.Stage[] memory stages = _stages(offsets, fees);
        _store(stages, INIT_TIME);

        assertTrue(stored.word1 != 0, "an eight-stage schedule must occupy the second word");

        // Every stage, including the ones that live in word1, which are exactly
        // the stages a wrong branch would fail to see.
        for (uint256 i = 0; i < ScheduleLib.MAX_STAGES; i++) {
            assertEq(
                ScheduleLib.feeAtStored(stored, uint256(INIT_TIME) + offsets[i]), fees[i], "stage read from storage"
            );
        }
    }

    function testFuzz_storedReadAgreesWithTheMemoryRead(
        uint256 seed,
        uint8 rawCount,
        uint40 initTime,
        uint256 timestamp
    ) public {
        ScheduleLib.Stage[] memory stages = _validScheduleFrom(seed, rawCount);
        _store(stages, initTime);

        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, initTime, stages);

        assertEq(
            ScheduleLib.feeAtStored(stored, timestamp), packed.feeAt(timestamp), "the storage and memory reads disagree"
        );
    }

    // --- the unvalidated-schedule guarantee ---------------------------------

    function test_feeAtDoesNotRevertOnAScheduleThatSkippedValidation() public pure {
        // `stageAt` walks stages backwards and returns 0 if none has started.
        // For a validated schedule that is unreachable, because stage 0 has
        // offset 0. The fallback exists so that the no-revert guarantee holds
        // even for a schedule that somehow bypassed validation — a storage
        // corruption, or a future writer that packs without validating first.
        //
        // Constructed by packing a valid schedule and then setting stage 0's
        // offset field directly, which `validate` would have rejected.
        ScheduleLib.Packed memory packed = ScheduleLib.pack(0, INIT_TIME, _one(0, 42_000));
        packed.word0 |= uint256(1 hours) << ScheduleLib.HEADER_BITS;

        // Before any stage has started: stage 0 and its fee, not a revert and
        // not a zero fee, which would be a free swap.
        assertEq(packed.stageAt(uint256(INIT_TIME)), 0, "must fall back to stage 0");
        assertEq(packed.feeAt(uint256(INIT_TIME)), 42_000, "must return stage 0's fee");
    }

    // --- recording the initialisation time ----------------------------------
    // initTime is the origin every offset is measured from. It is written after
    // packing, because a schedule is configured before its pool exists, so these
    // assert the one property that makes that safe: it can be written once.

    function test_theInitTimeCanBeRecordedOnce() public {
        holder.store(0, 0, _one(0, 10_000));
        assertEq(ScheduleLib.initTimeOf(holder.read()), 0, "unset to begin with");

        holder.record(INIT_TIME);
        assertEq(ScheduleLib.initTimeOf(holder.read()), INIT_TIME, "recorded");

        // And the stages are untouched by the header write.
        (,, ScheduleLib.Stage[] memory stages) = ScheduleLib.unpack(holder.read());
        assertEq(stages.length, 1, "stage count survived");
        assertEq(stages[0].feePpm, 10_000, "fee survived");
    }

    function test_theInitTimeCannotBeRecordedTwice() public {
        holder.store(0, 0, _one(0, 10_000));
        holder.record(INIT_TIME);

        vm.expectRevert(abi.encodeWithSelector(ScheduleLib.InitTimeAlreadyRecorded.selector, INIT_TIME));
        holder.record(INIT_TIME + 1);
    }

    function test_recordingZeroIsRefused() public {
        // Zero is how "not yet recorded" is represented, so accepting it would
        // leave the field writable again — and a market whose origin can move is
        // a market whose whole schedule can be rewritten.
        holder.store(0, 0, _one(0, 10_000));

        vm.expectRevert(ScheduleLib.ZeroInitTime.selector);
        holder.record(0);
    }

    function testFuzz_anyNonZeroInitTimeIsRecordedExactly(uint40 initTime) public {
        vm.assume(initTime != 0);
        holder.store(0, 0, _one(0, 10_000));

        holder.record(initTime);
        assertEq(ScheduleLib.initTimeOf(holder.read()), initTime, "recorded exactly");
    }
}

/// @notice Holds a packed schedule in storage, as VerdantHook does, so that the
/// storage-writing part of the library can be exercised at all.
contract InitTimeHolder {
    ScheduleLib.Packed internal schedule;

    function store(uint8 model, uint40 initTime, ScheduleLib.Stage[] calldata stages) external {
        schedule = ScheduleLib.pack(model, initTime, stages);
    }

    function record(uint40 initTime) external {
        ScheduleLib.recordInitTime(schedule, initTime);
    }

    function read() external view returns (ScheduleLib.Packed memory) {
        return schedule;
    }
}
