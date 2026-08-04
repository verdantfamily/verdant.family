// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ScheduleLib
/// @notice Packing, validation and evaluation of a Verdant fee schedule.
///
/// @dev A schedule is a step function of time. The active stage is the last stage
/// whose start offset has elapsed since the pool was initialised, and the active
/// fee is that stage's fee. There is no interpolation, no oracle, no off-chain
/// trigger and no discretion: given the packed schedule and a timestamp, the fee
/// is determined.
///
/// This library sits on the swap path. `feeAt` runs inside `beforeSwap` on every
/// single trade, so its cost is paid by every trader forever. That is why the
/// encoding is two storage words rather than an array of structs, and why a
/// schedule of four stages or fewer is guaranteed to be readable with a single
/// SLOAD.
///
/// ## Time is `block.timestamp`, never `block.number`
///
/// Robinhood Chain is an Arbitrum Orbit chain. Inside the EVM, `block.number`
/// returns the **L1** block number, not the L2 height. This was measured, not
/// assumed: across two probes the L2 height advanced 21 705 while the header's
/// `l1BlockNumber` advanced 182, so `block.number` runs roughly 119x slower than
/// the chain a user experiences. A two-hour stage keyed on it would last about
/// ten days.
///
/// The reason this is a prohibition rather than something a test catches: on
/// mainnet the two counters are within ~10% of each other (23 348 377 against
/// 25 645 948), so the wrong one still looks like a plausible block height. On
/// testnet they are 8.4x apart, because 46630 settles to a much younger L1. A
/// `block.number` bug would therefore look obviously broken in testing and almost
/// right in production. See docs/verification.md, V7.
///
/// ## Encoding
///
/// Two 256-bit words. The header and the first four stages live in `word0`, the
/// remaining four in `word1`.
///
/// ```
/// word0  [  0.. 7]  model        uint8
///        [  8..15]  stageCount   uint8
///        [ 16..55]  initTime     uint40
///        [ 56..103] stage 0      48 bits
///        [104..151] stage 1
///        [152..199] stage 2
///        [200..247] stage 3
///        [248..255] reserved     8 bits, always zero
///
/// word1  [  0..47]  stage 4      48 bits
///        [ 48..95]  stage 5
///        [ 96..143] stage 6
///        [144..191] stage 7
///        [192..255] reserved     64 bits, always zero
///
/// stage  [  0..27]  startOffset  uint28   seconds since initTime
///        [ 28..47]  feePpm       uint20   hundredths of a basis point
/// ```
///
/// A 48-bit stage rather than a 56-bit one is a deliberate departure from the
/// original sketch. At 56 bits, eight stages plus a header total 504 bits, which
/// fits in two words only if stage 3 straddles the word boundary — every read of
/// that stage would then have to combine both words, and the shift arithmetic
/// around it is the kind of thing that passes review and fails in production. At
/// 48 bits nothing straddles: the header plus four stages occupy 56 + 4 x 48 =
/// 248 of `word0`'s 256 bits, a fifth would need 296 and so cannot fit.
///
/// ### Why the 28/20 split is sufficient, arithmetically
///
/// Narrowing a field is only free if the field still spans its whole declared
/// range. Both do, with the required width computed from the bound rather than
/// from the field:
///
/// | field | must represent | bits required | bits given | capacity | headroom |
/// |---|---|---|---|---|---|
/// | `startOffset` | `MAX_HORIZON` = 63 072 000 s (730 d) | ceil(log2(63 072 001)) = **26** | **28** | 268 435 455 s (3 106 d) | 4.26x |
/// | `feePpm` | `MAX_FEE_PPM` = 100 000 | ceil(log2(100 001)) = **17** | **20** | 1 048 575 | 10.49x |
///
/// So 26 + 17 = 43 bits are strictly necessary and 48 are available. The five
/// spare bits are split two to `startOffset` (28 rather than 26) and three to
/// `feePpm` (20 rather than 17), the latter of which incidentally also covers
/// Uniswap's own `MAX_LP_FEE` of 1 000 000 should the cap ever be raised.
///
/// The hazard this table exists to rule out is a plausible-looking even split. A
/// 24/24 stage would give `startOffset` only 16 777 215 seconds — 194 days —
/// silently narrowing a 730-day product bound to a quarter of itself, with every
/// existing test still passing, because the vector generator only ever emits
/// configurations inside the bounds it already believes in. `ScheduleLib.t.sol`
/// therefore asserts the capacity of each field against its bound directly, and
/// exercises `MAX_HORIZON` and `MAX_FEE_PPM` as exact round-trip values.
///
/// The consequence of 48 bits is better than the requirement: a schedule of up to
/// **four** stages is readable from `word0` alone.
library ScheduleLib {
    // --- bounds -------------------------------------------------------------
    // Mirrored in packages/config/src/bounds.ts and asserted equal by the
    // differential vectors. These three copies must never disagree.

    uint256 internal constant MAX_STAGES = 8;
    uint256 internal constant MIN_FEE_PPM = 100;
    uint256 internal constant MAX_FEE_PPM = 100_000;
    uint256 internal constant MIN_STAGE_GAP = 300;
    uint256 internal constant MAX_HORIZON = 730 days; // 63_072_000

    /// @notice Stages that fit in `word0` alongside the header.
    uint256 internal constant STAGES_IN_FIRST_WORD = 4;

    // --- layout -------------------------------------------------------------

    // `internal` rather than `private` because the field widths are part of this
    // library's contract, not an implementation detail: `schedule.ts` mirrors them,
    // and `ScheduleLib.t.sol` asserts each field's capacity against the bound it
    // has to represent. A narrowed field is the one bug in here that no
    // behavioural test is guaranteed to catch, because the vector generator only
    // ever emits configurations inside the bounds it already believes in.
    uint256 internal constant MODEL_BITS = 8;
    uint256 internal constant STAGE_COUNT_BITS = 8;
    uint256 internal constant INIT_TIME_BITS = 40;
    uint256 internal constant HEADER_BITS = MODEL_BITS + STAGE_COUNT_BITS + INIT_TIME_BITS; // 56

    uint256 internal constant OFFSET_BITS = 28;
    uint256 internal constant FEE_BITS = 20;
    uint256 internal constant STAGE_BITS = OFFSET_BITS + FEE_BITS; // 48

    /// @notice Bits in one EVM word. Named so the packing arithmetic reads as
    /// arithmetic rather than as a magic 256.
    uint256 internal constant WORD_BITS = 256;

    uint256 private constant MODEL_SHIFT = 0;
    uint256 private constant STAGE_COUNT_SHIFT = MODEL_BITS; // 8
    uint256 private constant INIT_TIME_SHIFT = MODEL_BITS + STAGE_COUNT_BITS; // 16

    // Written as literals rather than as `(1 << BITS) - 1` so the width of each
    // field is legible at a glance, and so the linter's shift-order check is not
    // suppressed here — that check catches a real bug class and should stay on.
    // The derivations are given for review.
    uint256 private constant MASK_U8 = 0xff; // (1 << 8)  - 1
    uint256 private constant MASK_U40 = 0xffffffffff; // (1 << 40) - 1, initTime
    uint256 private constant MASK_U28 = 0xfffffff; // (1 << 28) - 1, startOffset
    uint256 private constant MASK_U20 = 0xfffff; // (1 << 20) - 1, feePpm
    uint256 private constant MASK_STAGE = 0xffffffffffff; // (1 << 48) - 1, one stage

    // On the `unsafe-typecast` suppressions below: every narrowing cast in this
    // file is applied to a value that has just been masked to exactly the target
    // width, so truncation is arithmetically impossible rather than merely
    // unlikely. They are suppressed one line at a time, never file-wide, so that
    // a cast added later without a mask still raises the warning.

    // --- errors -------------------------------------------------------------
    // Typed and specific. A creator whose schedule is rejected is entitled to
    // know which rule they broke and with which value; a single generic failure
    // would make the create form guess.

    /// @notice Stage count is zero or above MAX_STAGES.
    error InvalidStageCount(uint256 provided, uint256 max);

    /// @notice Stage 0 must start at the pool's own initialisation. Otherwise the
    /// fee between initTime and the first offset would be undefined.
    error FirstOffsetNonZero(uint256 provided);

    /// @notice Offsets must strictly increase. Equal offsets make the active
    /// stage ambiguous; decreasing offsets make a stage unreachable.
    error ScheduleNotIncreasing(uint256 index, uint256 previousOffset, uint256 offset);

    /// @notice Adjacent stages are closer together than MIN_STAGE_GAP.
    error StageGapTooSmall(uint256 index, uint256 gap, uint256 minimum);

    /// @notice A stage starts beyond MAX_HORIZON after initTime.
    error HorizonExceeded(uint256 index, uint256 offset, uint256 max);

    /// @notice A fee falls outside [MIN_FEE_PPM, MAX_FEE_PPM].
    error FeeOutOfBounds(uint256 index, uint256 feePpm, uint256 min, uint256 max);

    /// @notice `recordInitTime` was given zero, which is indistinguishable from
    /// "not yet recorded" and would leave the field writable again.
    error ZeroInitTime();

    /// @notice `recordInitTime` was called on a schedule that already has one.
    error InitTimeAlreadyRecorded(uint40 initTime);

    // --- types --------------------------------------------------------------

    /// @notice One step of the schedule.
    /// @param startOffset Seconds after the pool's initTime at which this stage
    /// becomes active. Stage 0 is always 0.
    /// @param feePpm The LP fee while this stage is active, in hundredths of a
    /// basis point. 10_000 is 1%.
    struct Stage {
        uint32 startOffset;
        uint24 feePpm;
    }

    /// @notice A packed schedule.
    /// @dev Declared as two `uint256` fields so that a caller holding this in
    /// storage occupies exactly two consecutive slots, and so that reading
    /// `word0` alone is a single SLOAD.
    struct Packed {
        uint256 word0;
        uint256 word1;
    }

    // --- validation ---------------------------------------------------------

    /// @notice Reverts unless `stages` is a well-formed schedule.
    /// @dev Checks are ordered from the most structural to the most local so the
    /// error a creator sees is the most useful one. A schedule with nine stages
    /// and a bad fee is reported as a stage-count problem, because that is the
    /// thing they have to fix first.
    ///
    /// `initTime` is accepted for symmetry with the TypeScript twin and to keep
    /// the call sites identical; no rule currently constrains it, since a
    /// schedule is valid or not independently of when the pool started.
    function validate(uint40 initTime, Stage[] memory stages) internal pure {
        initTime; // silences the unused-parameter warning without changing the ABI

        uint256 count = stages.length;
        if (count == 0 || count > MAX_STAGES) {
            revert InvalidStageCount(count, MAX_STAGES);
        }

        if (stages[0].startOffset != 0) {
            revert FirstOffsetNonZero(stages[0].startOffset);
        }

        uint256 previousOffset;
        for (uint256 i = 0; i < count; i++) {
            uint256 offset = stages[i].startOffset;
            uint256 fee = stages[i].feePpm;

            if (i > 0) {
                if (offset <= previousOffset) {
                    revert ScheduleNotIncreasing(i, previousOffset, offset);
                }
                uint256 gap = offset - previousOffset;
                if (gap < MIN_STAGE_GAP) {
                    revert StageGapTooSmall(i, gap, MIN_STAGE_GAP);
                }
            }

            if (offset > MAX_HORIZON) {
                revert HorizonExceeded(i, offset, MAX_HORIZON);
            }

            // Checked for every stage, not only the first: a schedule whose last
            // stage is out of bounds is just as broken as one whose first is.
            if (fee < MIN_FEE_PPM || fee > MAX_FEE_PPM) {
                revert FeeOutOfBounds(i, fee, MIN_FEE_PPM, MAX_FEE_PPM);
            }

            previousOffset = offset;
        }
    }

    /// @notice Non-reverting form of `validate`, for callers that need to branch.
    /// @dev Intentionally not used by `pack`: packing an invalid schedule must be
    /// impossible, not merely discouraged.
    function isValid(uint40 initTime, Stage[] memory stages) internal pure returns (bool) {
        // Solidity has no try/catch for internal calls, so the checks are
        // mirrored rather than delegated. Kept adjacent to `validate` so a change
        // to one is visibly a change to the other.
        uint256 count = stages.length;
        if (count == 0 || count > MAX_STAGES) return false;
        if (stages[0].startOffset != 0) return false;

        uint256 previousOffset;
        for (uint256 i = 0; i < count; i++) {
            uint256 offset = stages[i].startOffset;
            uint256 fee = stages[i].feePpm;
            if (i > 0) {
                if (offset <= previousOffset) return false;
                if (offset - previousOffset < MIN_STAGE_GAP) return false;
            }
            if (offset > MAX_HORIZON) return false;
            if (fee < MIN_FEE_PPM || fee > MAX_FEE_PPM) return false;
            previousOffset = offset;
        }
        initTime;
        return true;
    }

    // --- packing ------------------------------------------------------------

    /// @notice Validates and packs a schedule into two words.
    /// @dev Validation is not optional here. Every field is written with a mask,
    /// so an out-of-range value would otherwise be silently truncated into a
    /// different, valid-looking schedule — the worst possible failure for an
    /// immutable parameter.
    function pack(uint8 model, uint40 initTime, Stage[] memory stages) internal pure returns (Packed memory packed) {
        validate(initTime, stages);

        uint256 count = stages.length;

        uint256 w0 = (uint256(model) & MASK_U8) << MODEL_SHIFT | (count & MASK_U8) << STAGE_COUNT_SHIFT
            | (uint256(initTime) & MASK_U40) << INIT_TIME_SHIFT;
        uint256 w1;

        for (uint256 i = 0; i < count; i++) {
            uint256 encoded =
                (uint256(stages[i].startOffset) & MASK_U28) | (uint256(stages[i].feePpm) & MASK_U20) << OFFSET_BITS;

            if (i < STAGES_IN_FIRST_WORD) {
                w0 |= encoded << (HEADER_BITS + i * STAGE_BITS);
            } else {
                w1 |= encoded << ((i - STAGES_IN_FIRST_WORD) * STAGE_BITS);
            }
        }

        packed.word0 = w0;
        packed.word1 = w1;
    }

    /// @notice Expands a packed schedule back into its fields.
    /// @dev Used by the SDK's read path and by tests. Never on the swap path:
    /// `feeAt` reads the one stage it needs rather than materialising eight.
    function unpack(Packed memory packed) internal pure returns (uint8 model, uint40 initTime, Stage[] memory stages) {
        uint256 w0 = packed.word0;

        // forge-lint: disable-next-line(unsafe-typecast)
        model = uint8((w0 >> MODEL_SHIFT) & MASK_U8);
        // forge-lint: disable-next-line(unsafe-typecast)
        initTime = uint40((w0 >> INIT_TIME_SHIFT) & MASK_U40);

        uint256 count = (w0 >> STAGE_COUNT_SHIFT) & MASK_U8;
        stages = new Stage[](count);

        for (uint256 i = 0; i < count; i++) {
            uint256 encoded = i < STAGES_IN_FIRST_WORD
                ? (w0 >> (HEADER_BITS + i * STAGE_BITS)) & MASK_STAGE
                : (packed.word1 >> ((i - STAGES_IN_FIRST_WORD) * STAGE_BITS)) & MASK_STAGE;

            stages[i] = Stage({
                // forge-lint: disable-next-line(unsafe-typecast)
                startOffset: uint32(encoded & MASK_U28),
                // forge-lint: disable-next-line(unsafe-typecast)
                feePpm: uint24((encoded >> OFFSET_BITS) & MASK_U20)
            });
        }
    }

    // --- reading ------------------------------------------------------------

    /// @notice The index of the active stage at `timestamp`.
    /// @dev Scans from the last stage backwards and returns on the first stage
    /// that has started. Backwards because in the common case — a market past its
    /// final transition — that returns immediately.
    ///
    /// For `timestamp <= initTime` the result is stage 0. This is a clamp rather
    /// than a revert, and the choice is deliberate: this function is called from
    /// `beforeSwap`, so a revert here does not report an error to anyone, it makes
    /// the pool untradeable. There is no timestamp for which a swap should fail
    /// because of the fee schedule.
    function stageAt(Packed memory packed, uint256 timestamp) internal pure returns (uint256) {
        uint256 w0 = packed.word0;
        uint256 count = (w0 >> STAGE_COUNT_SHIFT) & MASK_U8;
        uint256 initTime = (w0 >> INIT_TIME_SHIFT) & MASK_U40;

        // Unsigned subtraction: guard rather than rely on the checked-arithmetic
        // revert, which is exactly the revert we must not have.
        uint256 elapsed = timestamp > initTime ? timestamp - initTime : 0;

        for (uint256 i = count; i > 0; i--) {
            uint256 index = i - 1;
            uint256 offset = index < STAGES_IN_FIRST_WORD
                ? (w0 >> (HEADER_BITS + index * STAGE_BITS)) & MASK_U28
                : (packed.word1 >> ((index - STAGES_IN_FIRST_WORD) * STAGE_BITS)) & MASK_U28;

            if (offset <= elapsed) return index;
        }

        // Unreachable for a validated schedule, whose stage 0 has offset 0 and so
        // always satisfies the comparison above. Returning 0 rather than
        // reverting keeps the no-revert guarantee true even for a schedule that
        // somehow bypassed validation.
        return 0;
    }

    /// @notice The active LP fee at `timestamp`, in ppm.
    /// @dev The swap-path function. Never reverts for any input.
    ///
    /// Reads the header, locates the active stage, then reads that stage's fee.
    /// A schedule of four stages or fewer touches `word0` only, which for a
    /// caller holding this in storage is a single SLOAD.
    function feeAt(Packed memory packed, uint256 timestamp) internal pure returns (uint24) {
        uint256 index = stageAt(packed, timestamp);

        uint256 encoded = index < STAGES_IN_FIRST_WORD
            ? (packed.word0 >> (HEADER_BITS + index * STAGE_BITS)) & MASK_STAGE
            : (packed.word1 >> ((index - STAGES_IN_FIRST_WORD) * STAGE_BITS)) & MASK_STAGE;

        // forge-lint: disable-next-line(unsafe-typecast)
        return uint24((encoded >> OFFSET_BITS) & MASK_U20);
    }

    /// @notice Storage-reading form of `feeAt`. **This is the swap-path entry
    /// point**; the memory form above is for callers that already hold the words.
    ///
    /// @dev The entire point of this function is the SLOAD count. `word1` is read
    /// only when the schedule actually has a stage living there, so the common
    /// small-schedule case costs one cold SLOAD (2 100 gas) rather than two.
    ///
    /// Named distinctly rather than overloading `feeAt`, because Solidity cannot
    /// disambiguate `storage` from `memory` parameters at a call site: a storage
    /// struct is implicitly copyable to a memory parameter, so the two would be
    /// ambiguous and the cheap path could be silently missed.
    ///
    /// The branch is on stage *count*, not on which stage is active. Deciding by
    /// position would mean locating the active stage first, and the header needed
    /// to do that is in `word0` — the same read. Counting is therefore both
    /// cheaper and simpler.
    function feeAtStored(Packed storage packed, uint256 timestamp) internal view returns (uint24) {
        uint256 w0 = packed.word0;
        uint256 count = (w0 >> STAGE_COUNT_SHIFT) & MASK_U8;

        if (count <= STAGES_IN_FIRST_WORD) {
            return feeAt(Packed({word0: w0, word1: 0}), timestamp);
        }
        return feeAt(Packed({word0: w0, word1: packed.word1}), timestamp);
    }

    /// @notice Writes the pool's initialisation time into an already-packed
    /// schedule in storage.
    ///
    /// @dev Exists so that the one contract that has to fill in `initTime` after
    /// the fact does not need to know where in `word0` it lives. A schedule is
    /// packed when its market is configured, but `initTime` is only knowable once
    /// the pool has actually been initialised, and the two are separate calls
    /// because v4's initialise path carries no hook data (see V15 in
    /// docs/verification.md).
    ///
    /// Recording is one-shot: a second attempt reverts rather than overwriting.
    /// initTime is the origin every stage offset is measured from, so moving it
    /// would silently reschedule every transition of a live market.
    ///
    /// Costs ~100 gas when it follows `pack` in the same transaction, because the
    /// slot is already dirty; it is not worth folding into the header write to
    /// save that.
    function recordInitTime(Packed storage packed, uint40 initTime) internal {
        if (initTime == 0) revert ZeroInitTime();

        uint256 w0 = packed.word0;
        uint256 existing = (w0 >> INIT_TIME_SHIFT) & MASK_U40;
        // forge-lint: disable-next-line(unsafe-typecast) -- masked to 40 bits above
        if (existing != 0) revert InitTimeAlreadyRecorded(uint40(existing));

        packed.word0 = w0 | (uint256(initTime) & MASK_U40) << INIT_TIME_SHIFT;
    }

    /// @notice The number of stages in a packed schedule.
    function stageCount(Packed memory packed) internal pure returns (uint256) {
        return (packed.word0 >> STAGE_COUNT_SHIFT) & MASK_U8;
    }

    /// @notice The pool initialisation time recorded in the header.
    function initTimeOf(Packed memory packed) internal pure returns (uint40) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint40((packed.word0 >> INIT_TIME_SHIFT) & MASK_U40);
    }

    /// @notice The model byte recorded in the header.
    function modelOf(Packed memory packed) internal pure returns (uint8) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8((packed.word0 >> MODEL_SHIFT) & MASK_U8);
    }

    /// @notice The timestamp of the next transition, or 0 if none remains.
    /// @dev Used by the interface to render a countdown, and returned to the SDK
    /// so the countdown and the fee come from the same source. Zero means "no
    /// further transition", which callers must distinguish from a real timestamp.
    function nextTransition(Packed memory packed, uint256 timestamp) internal pure returns (uint256) {
        uint256 count = stageCount(packed);
        uint256 current = stageAt(packed, timestamp);
        if (current + 1 >= count) return 0;

        uint256 next = current + 1;
        uint256 offset = next < STAGES_IN_FIRST_WORD
            ? (packed.word0 >> (HEADER_BITS + next * STAGE_BITS)) & MASK_U28
            : (packed.word1 >> ((next - STAGES_IN_FIRST_WORD) * STAGE_BITS)) & MASK_U28;

        return initTimeOf(packed) + offset;
    }
}
