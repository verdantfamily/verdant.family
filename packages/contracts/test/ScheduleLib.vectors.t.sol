// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ScheduleLib} from "../src/libraries/ScheduleLib.sol";

/// @title Differential vector harness — Solidity half
/// @notice Asserts ScheduleLib against the same file, and the same expected
/// values, that packages/sdk/src/models/schedule.test.ts asserts schedule.ts
/// against.
///
/// @dev The point of this test is narrow and important: the fee a trader pays is
/// decided here, and the fee the interface promises is decided in TypeScript. If
/// those two implementations can disagree, the interface lies — and it will lie
/// most convincingly at a stage boundary, which is exactly where someone is
/// watching a countdown and deciding whether to trade.
///
/// The vectors were generated before either implementation existed, with expected
/// values from an independent naive scan. Neither implementation may be tuned to
/// fit them.
///
/// The corpus is held in **memory**, loaded per test, never in storage. Writing
/// ~57 000 words to storage in `setUp` costs on the order of a billion gas and
/// simply fails; re-reading the file per test costs a few million and the parse
/// itself happens off-chain in the cheatcode.
contract ScheduleLibVectorsTest is Test {
    using ScheduleLib for ScheduleLib.Packed;

    string internal constant VECTORS = "../sdk/src/models/vectors/schedule.json";

    struct Corpus {
        string json;
        uint256 caseCount;
        uint256 probeCount;
        uint256 invalidCount;
        uint256 validStride;
        uint256 invalidStride;
        uint256 minFeePpm;
        uint256 maxFeePpm;
        uint256 maxHorizon;
        uint256[] caseModel;
        uint256[] caseInitTime;
        uint256[] caseStageCount;
        uint256[] caseOffsets;
        uint256[] caseFees;
        uint256[] probeCase;
        uint256[] probeTime;
        uint256[] probeFee;
        uint256[] probeStage;
    }

    struct InvalidCorpus {
        uint256 count;
        uint256 stride;
        uint256[] initTime;
        uint256[] stageCount;
        uint256[] offsets;
        uint256[] fees;
        string[] names;
        string[] errors;
    }

    // --- loading ------------------------------------------------------------

    function _load() internal view returns (Corpus memory c) {
        c.json = vm.readFile(VECTORS);

        c.caseCount = vm.parseJsonUint(c.json, ".caseCount");
        c.probeCount = vm.parseJsonUint(c.json, ".probeCount");
        c.invalidCount = vm.parseJsonUint(c.json, ".invalidCount");
        c.validStride = vm.parseJsonUint(c.json, ".validStride");
        c.invalidStride = vm.parseJsonUint(c.json, ".invalidStride");

        c.minFeePpm = vm.parseJsonUint(c.json, ".bounds.minFeePpm");
        c.maxFeePpm = vm.parseJsonUint(c.json, ".bounds.maxFeePpm");
        c.maxHorizon = vm.parseJsonUint(c.json, ".bounds.maxHorizon");

        c.caseModel = vm.parseJsonUintArray(c.json, ".caseModel");
        c.caseInitTime = vm.parseJsonUintArray(c.json, ".caseInitTime");
        c.caseStageCount = vm.parseJsonUintArray(c.json, ".caseStageCount");
        c.caseOffsets = vm.parseJsonUintArray(c.json, ".caseOffsets");
        c.caseFees = vm.parseJsonUintArray(c.json, ".caseFees");

        c.probeCase = vm.parseJsonUintArray(c.json, ".probeCase");
        c.probeTime = vm.parseJsonUintArray(c.json, ".probeTime");
        c.probeFee = vm.parseJsonUintArray(c.json, ".probeFee");
        c.probeStage = vm.parseJsonUintArray(c.json, ".probeStage");
    }

    function _loadInvalid() internal view returns (InvalidCorpus memory c) {
        string memory json = vm.readFile(VECTORS);
        c.count = vm.parseJsonUint(json, ".invalidCount");
        c.stride = vm.parseJsonUint(json, ".invalidStride");
        c.initTime = vm.parseJsonUintArray(json, ".invalidInitTime");
        c.stageCount = vm.parseJsonUintArray(json, ".invalidStageCount");
        c.offsets = vm.parseJsonUintArray(json, ".invalidOffsets");
        c.fees = vm.parseJsonUintArray(json, ".invalidFees");
        c.names = vm.parseJsonStringArray(json, ".invalidNames");
        c.errors = vm.parseJsonStringArray(json, ".invalidError");
    }

    function _stagesFor(Corpus memory c, uint256 caseIndex) internal pure returns (ScheduleLib.Stage[] memory stages) {
        uint256 count = c.caseStageCount[caseIndex];
        stages = new ScheduleLib.Stage[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 flat = caseIndex * c.validStride + i;
            stages[i] = ScheduleLib.Stage({startOffset: uint32(c.caseOffsets[flat]), feePpm: uint24(c.caseFees[flat])});
        }
    }

    function _packAll(Corpus memory c) internal pure returns (ScheduleLib.Packed[] memory packed) {
        packed = new ScheduleLib.Packed[](c.caseCount);
        for (uint256 i = 0; i < c.caseCount; i++) {
            packed[i] = ScheduleLib.pack(uint8(c.caseModel[i]), uint40(c.caseInitTime[i]), _stagesFor(c, i));
        }
    }

    function _caseName(Corpus memory c, uint256 index) internal pure returns (string memory) {
        return vm.parseJsonString(c.json, string.concat(".caseNames[", vm.toString(index), "]"));
    }

    // --- corpus integrity ---------------------------------------------------

    function test_corpusIsTheOneBothSuitesExpect() public view {
        Corpus memory c = _load();
        // Guards against half a regeneration: if the TypeScript suite runs against
        // a newer corpus than this one, the differential guarantee is void, and a
        // count mismatch is the cheapest way to notice.
        assertEq(c.caseCount, 515, "case count");
        assertEq(c.probeCount, 11_435, "probe count");
        assertEq(c.invalidCount, 13, "invalid count");
        assertEq(vm.parseJsonUint(c.json, ".seed"), 0x5645524e, "seed");
    }

    function test_corpusArraysAreIndexAligned() public view {
        Corpus memory c = _load();
        assertEq(c.caseOffsets.length, c.caseCount * c.validStride);
        assertEq(c.caseFees.length, c.caseCount * c.validStride);
        assertEq(c.caseModel.length, c.caseCount);
        assertEq(c.caseInitTime.length, c.caseCount);
        assertEq(c.caseStageCount.length, c.caseCount);
        assertEq(c.probeTime.length, c.probeCount);
        assertEq(c.probeFee.length, c.probeCount);
        assertEq(c.probeStage.length, c.probeCount);
        assertEq(c.probeCase.length, c.probeCount);
    }

    function test_corpusBoundsMatchTheLibrary() public view {
        Corpus memory c = _load();
        assertEq(vm.parseJsonUint(c.json, ".bounds.maxStages"), ScheduleLib.MAX_STAGES, "maxStages");
        assertEq(c.minFeePpm, ScheduleLib.MIN_FEE_PPM, "minFeePpm");
        assertEq(c.maxFeePpm, ScheduleLib.MAX_FEE_PPM, "maxFeePpm");
        assertEq(vm.parseJsonUint(c.json, ".bounds.minStageGap"), ScheduleLib.MIN_STAGE_GAP, "minStageGap");
        assertEq(c.maxHorizon, ScheduleLib.MAX_HORIZON, "maxHorizon");
    }

    // --- the differential assertion ----------------------------------------

    /// @dev Not `view`: it emits diagnostic logs on divergence, which is the only
    /// thing that makes one failure among 11 405 probes actionable.
    function test_feeAtAndStageAtMatchEveryProbe() public {
        Corpus memory c = _load();
        ScheduleLib.Packed[] memory packed = _packAll(c);

        for (uint256 p = 0; p < c.probeCount; p++) {
            uint256 index = c.probeCase[p];
            uint256 t = c.probeTime[p];

            uint24 fee = packed[index].feeAt(t);
            uint256 stage = packed[index].stageAt(t);

            if (fee != c.probeFee[p] || stage != c.probeStage[p]) {
                // Built only on failure; string.concat for every probe would
                // dominate the runtime of the whole suite.
                emit log_named_string("case", _caseName(c, index));
                emit log_named_uint("timestamp", t);
                emit log_named_uint("initTime", c.caseInitTime[index]);
                emit log_named_uint("expected fee", c.probeFee[p]);
                emit log_named_uint("actual fee", fee);
                emit log_named_uint("expected stage", c.probeStage[p]);
                emit log_named_uint("actual stage", stage);
                assertTrue(false, "schedule diverged from the shared vectors");
            }
        }
    }

    // --- packing ------------------------------------------------------------

    function test_packUnpackRoundTripsEveryCase() public view {
        Corpus memory c = _load();

        for (uint256 i = 0; i < c.caseCount; i++) {
            ScheduleLib.Stage[] memory original = _stagesFor(c, i);
            ScheduleLib.Packed memory packed =
                ScheduleLib.pack(uint8(c.caseModel[i]), uint40(c.caseInitTime[i]), original);

            (uint8 model, uint40 initTime, ScheduleLib.Stage[] memory restored) = ScheduleLib.unpack(packed);

            assertEq(model, uint8(c.caseModel[i]), "model");
            assertEq(uint256(initTime), c.caseInitTime[i], "initTime");
            assertEq(restored.length, original.length, "stage count");
            for (uint256 s = 0; s < original.length; s++) {
                assertEq(restored[s].startOffset, original[s].startOffset, "offset");
                assertEq(restored[s].feePpm, original[s].feePpm, "fee");
            }
        }
    }

    function test_threeStageScheduleFitsInTheFirstWord() public view {
        // The property behind the gas snapshot: a schedule of three stages or
        // fewer must be readable with a single SLOAD, because that is the common
        // case and it sits on the swap path. The encoding actually affords four.
        Corpus memory c = _load();
        ScheduleLib.Packed[] memory packed = _packAll(c);

        uint256 checked;
        for (uint256 i = 0; i < c.caseCount; i++) {
            if (c.caseStageCount[i] > 3) continue;
            assertEq(packed[i].word1, 0, "a small schedule must not touch the second word");
            checked++;
        }
        assertGt(checked, 0, "corpus contains no small schedules");
    }

    function test_fourStageScheduleAlsoFitsInTheFirstWord() public view {
        Corpus memory c = _load();
        ScheduleLib.Packed[] memory packed = _packAll(c);

        uint256 checked;
        for (uint256 i = 0; i < c.caseCount; i++) {
            if (c.caseStageCount[i] != ScheduleLib.STAGES_IN_FIRST_WORD) continue;
            assertEq(packed[i].word1, 0, "four stages must still fit the first word");
            checked++;
        }
        assertGt(checked, 0, "corpus contains no four-stage schedules");
    }

    function test_largeScheduleUsesTheSecondWord() public view {
        Corpus memory c = _load();
        ScheduleLib.Packed[] memory packed = _packAll(c);

        bool found;
        for (uint256 i = 0; i < c.caseCount; i++) {
            if (c.caseStageCount[i] != 8) continue;
            assertTrue(packed[i].word1 != 0, "an eight-stage schedule must use the second word");
            found = true;
            break;
        }
        assertTrue(found, "corpus contains no eight-stage schedule");
    }

    // --- validation ---------------------------------------------------------

    function test_validateAcceptsEveryValidCase() public view {
        Corpus memory c = _load();
        for (uint256 i = 0; i < c.caseCount; i++) {
            ScheduleLib.Stage[] memory stages = _stagesFor(c, i);
            ScheduleLib.validate(uint40(c.caseInitTime[i]), stages);
            assertTrue(ScheduleLib.isValid(uint40(c.caseInitTime[i]), stages), "isValid disagreed with validate");
        }
    }

    /// @dev One assertion per invalid shape, each naming its own error. The
    /// specific selector matters: a validator that rejects everything with one
    /// generic revert cannot tell a creator what to fix, and cannot be shown to
    /// have rejected for the right reason.
    function test_validateRejectsEachInvalidCaseWithItsOwnError() public {
        InvalidCorpus memory c = _loadInvalid();

        for (uint256 i = 0; i < c.count; i++) {
            uint256 count = c.stageCount[i];
            ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](count);
            for (uint256 s = 0; s < count; s++) {
                uint256 flat = i * c.stride + s;
                stages[s] = ScheduleLib.Stage({startOffset: uint32(c.offsets[flat]), feePpm: uint24(c.fees[flat])});
            }

            // Partial match: the selector is the assertion, the parameters are
            // diagnostics and are allowed to change without breaking this test.
            vm.expectPartialRevert(_selectorFor(c.errors[i]));
            this.validateExternal(uint40(c.initTime[i]), stages);

            assertFalse(ScheduleLib.isValid(uint40(c.initTime[i]), stages), c.names[i]);
        }
    }

    /// @dev External so `vm.expectPartialRevert` has a call boundary to observe;
    /// an internal library revert would abort the test itself.
    function validateExternal(uint40 initTime, ScheduleLib.Stage[] memory stages) external pure {
        ScheduleLib.validate(initTime, stages);
    }

    function _selectorFor(string memory name) internal pure returns (bytes4) {
        bytes32 id = keccak256(bytes(name));
        if (id == keccak256("InvalidStageCount")) return ScheduleLib.InvalidStageCount.selector;
        if (id == keccak256("FirstOffsetNonZero")) return ScheduleLib.FirstOffsetNonZero.selector;
        if (id == keccak256("ScheduleNotIncreasing")) return ScheduleLib.ScheduleNotIncreasing.selector;
        if (id == keccak256("StageGapTooSmall")) return ScheduleLib.StageGapTooSmall.selector;
        if (id == keccak256("HorizonExceeded")) return ScheduleLib.HorizonExceeded.selector;
        if (id == keccak256("FeeOutOfBounds")) return ScheduleLib.FeeOutOfBounds.selector;
        revert("unknown error id in vectors");
    }

    // --- step-function properties -------------------------------------------

    function test_feeIsAlwaysInsideThePermittedBand() public view {
        Corpus memory c = _load();
        ScheduleLib.Packed[] memory packed = _packAll(c);

        for (uint256 p = 0; p < c.probeCount; p++) {
            uint24 fee = packed[c.probeCase[p]].feeAt(c.probeTime[p]);
            assertGe(uint256(fee), c.minFeePpm);
            assertLe(uint256(fee), c.maxFeePpm);
        }
    }

    function test_activeStageNeverMovesBackwards() public view {
        Corpus memory c = _load();
        ScheduleLib.Packed[] memory packed = _packAll(c);

        for (uint256 i = 0; i < c.caseCount; i++) {
            ScheduleLib.Stage[] memory stages = _stagesFor(c, i);
            uint256 initTime = c.caseInitTime[i];

            uint256 previous;
            for (uint256 s = 0; s < stages.length; s++) {
                uint256 at = initTime + stages[s].startOffset;
                for (uint256 k = 0; k < 3; k++) {
                    // at-1, at, at+1, guarding the underflow at timestamp 0.
                    uint256 t = k == 0 ? (at == 0 ? 0 : at - 1) : (k == 1 ? at : at + 1);
                    uint256 stage = packed[i].stageAt(t);
                    assertGe(stage, previous, "stage moved backwards");
                    previous = stage;
                }
            }
        }
    }

    function test_changesValueOnlyAtADeclaredOffset() public view {
        // The defining property of a step function: between two adjacent
        // transitions the fee is constant. Sampled at both ends and the midpoint.
        Corpus memory c = _load();
        ScheduleLib.Packed[] memory packed = _packAll(c);

        for (uint256 i = 0; i < c.caseCount; i++) {
            ScheduleLib.Stage[] memory stages = _stagesFor(c, i);
            uint256 initTime = c.caseInitTime[i];

            for (uint256 s = 0; s < stages.length; s++) {
                uint256 from = initTime + stages[s].startOffset;
                uint256 to = s + 1 < stages.length ? initTime + stages[s + 1].startOffset - 1 : from + c.maxHorizon;
                uint256 mid = from + (to - from) / 2;

                assertEq(packed[i].feeAt(from), stages[s].feePpm, "fee at stage start");
                assertEq(packed[i].feeAt(mid), stages[s].feePpm, "fee mid stage");
                assertEq(packed[i].feeAt(to), stages[s].feePpm, "fee at stage end");
            }
        }
    }

    function test_clampsToFirstStageAtAndBeforeInitTime() public view {
        Corpus memory c = _load();
        ScheduleLib.Packed[] memory packed = _packAll(c);

        for (uint256 i = 0; i < c.caseCount; i++) {
            ScheduleLib.Stage[] memory stages = _stagesFor(c, i);
            uint256 initTime = c.caseInitTime[i];

            assertEq(packed[i].feeAt(initTime), stages[0].feePpm, "fee at initTime");
            assertEq(packed[i].stageAt(initTime), 0, "stage at initTime");
            if (initTime > 0) {
                assertEq(packed[i].feeAt(initTime - 1), stages[0].feePpm, "fee before initTime");
            }
            // Timestamp 0 must not underflow. A library that can be made to
            // underflow on the swap path is a library that can brick a pool.
            assertEq(packed[i].feeAt(0), stages[0].feePpm, "fee at timestamp zero");
        }
    }

    function test_holdsTheFinalFeeForever() public view {
        Corpus memory c = _load();
        ScheduleLib.Packed[] memory packed = _packAll(c);

        for (uint256 i = 0; i < c.caseCount; i++) {
            ScheduleLib.Stage[] memory stages = _stagesFor(c, i);
            ScheduleLib.Stage memory last = stages[stages.length - 1];

            uint256 wayPast = c.caseInitTime[i] + last.startOffset + 100 * 365 days;
            assertEq(packed[i].feeAt(wayPast), last.feePpm, "final fee not held");
            assertEq(packed[i].stageAt(wayPast), stages.length - 1, "final stage not held");
        }
    }

    function test_nextTransitionAgreesWithTheStageBoundaries() public view {
        // The countdown the interface renders must come from the same source as
        // the fee, or the two can disagree at exactly the moment anyone is
        // watching.
        Corpus memory c = _load();
        ScheduleLib.Packed[] memory packed = _packAll(c);

        for (uint256 i = 0; i < c.caseCount; i++) {
            ScheduleLib.Stage[] memory stages = _stagesFor(c, i);
            uint256 initTime = c.caseInitTime[i];

            for (uint256 s = 0; s < stages.length; s++) {
                uint256 t = initTime + stages[s].startOffset;
                uint256 next = packed[i].nextTransition(t);

                if (s + 1 < stages.length) {
                    assertEq(next, initTime + stages[s + 1].startOffset, "next transition");
                    // At the transition itself the fee must already be the new one.
                    assertEq(packed[i].feeAt(next), stages[s + 1].feePpm, "fee at next transition");
                } else {
                    assertEq(next, 0, "no transition should remain after the last stage");
                }
            }
        }
    }
}
