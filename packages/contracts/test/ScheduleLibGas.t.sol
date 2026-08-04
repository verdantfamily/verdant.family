// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ScheduleLib} from "../src/libraries/ScheduleLib.sol";

/// @notice Holds a packed schedule in storage exactly as VerdantHook will.
/// @dev The two words occupy slots 0 and 1. Nothing else is declared before them,
/// so the slot numbers in the assertions below are stable and meaningful.
contract ScheduleHolder {
    ScheduleLib.Packed internal schedule; // slot 0 and slot 1

    function store(uint8 model, uint40 initTime, ScheduleLib.Stage[] calldata stages) external {
        schedule = ScheduleLib.pack(model, initTime, stages);
    }

    /// @notice The swap-path read. This is the call whose cost every trader pays.
    function feeAt(uint256 timestamp) external view returns (uint24) {
        return ScheduleLib.feeAtStored(schedule, timestamp);
    }

    function words() external view returns (uint256, uint256) {
        return (schedule.word0, schedule.word1);
    }
}

/// @title ScheduleLib — cost and storage-access gate
/// @notice Proves the claim the encoding exists to support: reading the fee for a
/// small schedule touches one storage slot, not two.
///
/// @dev Gas alone is a weak proof of that — a number can drift for a dozen
/// reasons and still look plausible. So the SLOAD count is asserted directly with
/// `vm.record` / `vm.accesses`, and the gas figures are reported alongside as the
/// consequence rather than as the evidence.
///
/// Why this matters beyond tidiness: `feeAt` runs inside `beforeSwap` on every
/// trade for the life of the market. A second cold SLOAD is 2 100 gas that every
/// trader pays forever, in exchange for stages 5 through 8 that most markets will
/// never declare.
contract ScheduleLibGasTest is Test {
    ScheduleHolder internal oneStage;
    ScheduleHolder internal threeStage;
    ScheduleHolder internal fourStage;
    ScheduleHolder internal eightStage;

    uint40 internal constant INIT_TIME = 1_800_000_000;

    /// @dev A timestamp deep into the schedule, so the backwards scan in
    /// `stageAt` does the least work — the common case for a mature market.
    uint256 internal constant LATE = INIT_TIME + 400 days;

    function setUp() public {
        oneStage = new ScheduleHolder();
        threeStage = new ScheduleHolder();
        fourStage = new ScheduleHolder();
        eightStage = new ScheduleHolder();

        oneStage.store(0, INIT_TIME, _stages(1));
        threeStage.store(0, INIT_TIME, _stages(3));
        fourStage.store(0, INIT_TIME, _stages(4));
        eightStage.store(0, INIT_TIME, _stages(8));
    }

    function _stages(uint256 count) internal pure returns (ScheduleLib.Stage[] memory stages) {
        stages = new ScheduleLib.Stage[](count);
        for (uint256 i = 0; i < count; i++) {
            stages[i] = ScheduleLib.Stage({
                // forge-lint: disable-next-line(unsafe-typecast) -- i < 8, so i * 30 days fits uint32
                startOffset: uint32(i * 30 days),
                // forge-lint: disable-next-line(unsafe-typecast) -- stays above MIN_FEE_PPM for i < 8
                feePpm: uint24(ScheduleLib.MAX_FEE_PPM - i * 10_000)
            });
        }
    }

    /// @dev Counts the distinct storage slots read during one `feeAt` call.
    /// `vm.accesses` returns every read including repeats, so the distinct set is
    /// what matters: reading slot 0 twice is a warm access, reading slot 1 at all
    /// is a second cold access.
    function _distinctSlotsRead(ScheduleHolder holder, uint256 timestamp) internal returns (uint256) {
        vm.record();
        holder.feeAt(timestamp);
        (bytes32[] memory reads,) = vm.accesses(address(holder));

        uint256 distinct;
        for (uint256 i = 0; i < reads.length; i++) {
            bool seen;
            for (uint256 j = 0; j < i; j++) {
                if (reads[j] == reads[i]) {
                    seen = true;
                    break;
                }
            }
            if (!seen) distinct++;
        }
        return distinct;
    }

    // --- the storage-access gate --------------------------------------------

    function test_oneStageReadTouchesOnlySlotZero() public {
        assertEq(_distinctSlotsRead(oneStage, LATE), 1, "a one-stage read must touch one slot");
    }

    function test_threeStageReadTouchesOnlySlotZero() public {
        // The gate as specified. Three stages is the practical common case: a
        // launch fee, a step down, a resting fee.
        assertEq(_distinctSlotsRead(threeStage, LATE), 1, "a three-stage read must touch one slot");
    }

    function test_fourStageReadAlsoTouchesOnlySlotZero() public {
        // The encoding affords one more than required, because a 48-bit stage
        // leaves room for the header plus four stages in word0. Asserted so the
        // headroom is a known property rather than an accident.
        assertEq(_distinctSlotsRead(fourStage, LATE), 1, "four stages must still fit one slot");
    }

    function test_slotZeroIsTheOneRead() public {
        // Not merely "one slot" but the *first* slot, which is what makes the
        // claim about storage layout rather than about access counting.
        vm.record();
        threeStage.feeAt(LATE);
        (bytes32[] memory reads,) = vm.accesses(address(threeStage));
        assertGt(reads.length, 0, "no storage was read at all");
        for (uint256 i = 0; i < reads.length; i++) {
            assertEq(reads[i], bytes32(0), "a small schedule read a slot other than slot 0");
        }
    }

    function test_eightStageReadTouchesBothSlots() public {
        // The other side of the claim: the second word is read only when a stage
        // living there is actually needed.
        assertEq(_distinctSlotsRead(eightStage, LATE), 2, "an eight-stage read needs both slots");
    }

    function test_eightStageReadOfAnEarlyStageStillTouchesBothSlots() public {
        // Honest accounting: the storage overload branches on stage COUNT, not on
        // which stage is active, so an eight-stage schedule pays for both words
        // even early in its life. Branching on the active stage would require
        // finding it first, which needs the header, which is the same read.
        assertEq(_distinctSlotsRead(eightStage, INIT_TIME), 2, "count, not position, decides the second read");
    }

    // --- reported cost ------------------------------------------------------
    // These are the numbers quoted in the phase report. They are measured around
    // the external call, so they include the CALL and the cold SLOADs, which is
    // what the hook will actually pay.

    function _measure(ScheduleHolder holder, uint256 timestamp) internal view returns (uint256) {
        uint256 before = gasleft();
        holder.feeAt(timestamp);
        return before - gasleft();
    }

    function test_gas_feeAt_1Stage() public {
        uint256 used = _measure(oneStage, LATE);
        emit log_named_uint("feeAt gas, 1 stage", used);
        assertLt(used, 12_000, "one-stage read got more expensive than budgeted");
    }

    function test_gas_feeAt_3Stages() public {
        uint256 used = _measure(threeStage, LATE);
        emit log_named_uint("feeAt gas, 3 stages", used);
        assertLt(used, 12_000, "three-stage read got more expensive than budgeted");
    }

    function test_gas_feeAt_4Stages() public {
        uint256 used = _measure(fourStage, LATE);
        emit log_named_uint("feeAt gas, 4 stages", used);
        assertLt(used, 12_000, "four-stage read got more expensive than budgeted");
    }

    function test_gas_feeAt_8Stages() public {
        uint256 used = _measure(eightStage, LATE);
        emit log_named_uint("feeAt gas, 8 stages", used);
        assertLt(used, 15_000, "eight-stage read got more expensive than budgeted");
    }

    function test_gas_feeAt_8StagesEarlyInSchedule() public {
        // Worst case for the backwards scan: the active stage is the first, so
        // every stage is examined before it is found.
        uint256 used = _measure(eightStage, INIT_TIME);
        emit log_named_uint("feeAt gas, 8 stages, first stage active", used);
        assertLt(used, 15_000, "worst-case scan got more expensive than budgeted");
    }

    /// @notice The property the two-word encoding exists for: within the first
    /// word, reading the fee costs the same whether the market declared one stage
    /// or four.
    ///
    /// @dev Asserted rather than reported. Two phase reports quoted different
    /// numbers for this cost — one the metered figure below, the other the whole
    /// test function's gas from the committed snapshot — and neither could settle
    /// whether the property still held, because nothing tested it. The snapshot
    /// cannot: its per-test totals include the emit and the assert, so they differ
    /// between these tests (11 370, 11 403, 11 404) even when the reads do not.
    ///
    /// Tolerance is eight gas rather than zero because the three paths are the
    /// same opcodes over the same single slot but not bit-identical traces. Making
    /// stage count matter would cost a cold SLOAD, 2 100 gas.
    function test_gas_costIsFlatFromOneStageToFour() public view {
        uint256 one = _measure(oneStage, LATE);
        uint256 three = _measure(threeStage, LATE);
        uint256 four = _measure(fourStage, LATE);

        assertApproxEqAbs(one, three, 8, "one and three stages must cost the same");
        assertApproxEqAbs(three, four, 8, "three and four stages must cost the same");
    }

    /// @dev The comparison the encoding is justified by. Reported rather than
    /// asserted with a tight bound, because the exact delta is a function of the
    /// optimizer and is allowed to move; the sign of it is not.
    function test_gas_smallScheduleIsCheaperThanLarge() public {
        uint256 small = _measure(threeStage, LATE);
        uint256 large = _measure(eightStage, LATE);

        emit log_named_uint("3-stage", small);
        emit log_named_uint("8-stage", large);
        emit log_named_uint("saving from the single-slot path", large - small);

        assertLt(small, large, "the single-slot path must be cheaper, or it has no purpose");
    }
}
