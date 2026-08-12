// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, stdError} from "forge-std/Test.sol";
import {RevenueAllocationLib} from "../../src/agents/RevenueAllocationLib.sol";

/// @title RevenueAllocationLibVectorsTest
/// @notice The Solidity half of the differential harness for an agent's revenue split.
///
/// @dev `packages/sdk/src/agents/allocation.test.ts` asserts the same expected
/// values from the same file. Neither implementation may be adjusted to satisfy
/// these vectors: they were generated first, from the naive definition
/// `received * bps / 10_000` evaluated in arbitrary-precision arithmetic, and they
/// are what the split *means*.
///
/// The naive form is precisely what this library cannot do — it reverts on
/// overflow once `received` passes `2^256 / 10_000` — so these vectors are not a
/// tautology. They are the proof that the decomposition the library uses instead
/// is exact, at values where the definition could not have been evaluated on chain
/// at all.
contract RevenueAllocationLibVectorsTest is Test {
    using RevenueAllocationLib for RevenueAllocationLib.Allocation;

    string internal constant VECTORS = "../sdk/src/agents/vectors/allocation.json";

    uint256 internal constant LEG_COUNT = 4;

    struct Corpus {
        string json;
        uint256 caseCount;
        uint256 probeCount;
        uint256 streamCount;
        uint256 invalidCount;
        uint256[] caseBps;
        uint256[] probeCase;
        string[] probeReceived;
        string[] probeEntitlement;
        string[] probeDust;
    }

    struct Streams {
        string json;
        uint256 count;
        uint256[] bps;
        string[] total;
        uint256[] arrivalCount;
        string[] arrival;
        string[] finalAllocated;
    }

    function _load() internal view returns (Corpus memory c) {
        c.json = vm.readFile(VECTORS);

        c.caseCount = vm.parseJsonUint(c.json, ".caseCount");
        c.probeCount = vm.parseJsonUint(c.json, ".probeCount");
        c.streamCount = vm.parseJsonUint(c.json, ".streamCount");
        c.invalidCount = vm.parseJsonUint(c.json, ".invalidCount");

        c.caseBps = vm.parseJsonUintArray(c.json, ".caseBps");
        c.probeCase = vm.parseJsonUintArray(c.json, ".probeCase");

        // Amounts are decimal strings: JSON has no integer as wide as a uint256,
        // and a number in the document would arrive as a float that had quietly
        // lost its low bits — which would silently delete the overflow cases these
        // vectors exist for.
        c.probeReceived = vm.parseJsonStringArray(c.json, ".probeReceived");
        c.probeEntitlement = vm.parseJsonStringArray(c.json, ".probeEntitlement");
        c.probeDust = vm.parseJsonStringArray(c.json, ".probeDust");
    }

    function _loadStreams() internal view returns (Streams memory s) {
        s.json = vm.readFile(VECTORS);
        s.count = vm.parseJsonUint(s.json, ".streamCount");
        s.bps = vm.parseJsonUintArray(s.json, ".streamBps");
        s.total = vm.parseJsonStringArray(s.json, ".streamTotal");
        s.arrivalCount = vm.parseJsonUintArray(s.json, ".streamArrivalCount");
        s.arrival = vm.parseJsonStringArray(s.json, ".streamArrival");
        s.finalAllocated = vm.parseJsonStringArray(s.json, ".streamFinal");
    }

    function _allocationAt(uint256[] memory bps, uint256 offset)
        internal
        pure
        returns (RevenueAllocationLib.Allocation memory)
    {
        return RevenueAllocationLib.Allocation({
            operationsBps: uint16(bps[offset]),
            buybacksBps: uint16(bps[offset + 1]),
            developerBps: uint16(bps[offset + 2]),
            protocolBps: uint16(bps[offset + 3])
        });
    }

    /// @dev Only ever called on a failure. Naming a case means re-parsing an
    /// 800 KB document, and doing that once per assertion — Solidity evaluates the
    /// message argument whether or not the assertion holds — exhausts memory long
    /// before the corpus is exhausted.
    function _caseName(Corpus memory c, uint256 index) internal pure returns (string memory) {
        return vm.parseJsonString(c.json, string.concat(".caseNames[", vm.toString(index), "]"));
    }

    // --- corpus integrity ---------------------------------------------------

    function test_corpusIsTheOneTheSdkReads() public view {
        Corpus memory c = _load();

        // Pinned so that regenerating the vectors with different content is a
        // visible change in this file rather than a silently smaller corpus.
        assertEq(c.caseCount, 159, "case count");
        assertEq(c.probeCount, 4716, "probe count");
        assertEq(c.streamCount, 5, "stream count");
        assertEq(c.invalidCount, 5, "invalid count");
        assertEq(vm.parseJsonUint(c.json, ".seed"), 0x41474e54, "seed");
    }

    function test_corpusArraysAreIndexAligned() public view {
        Corpus memory c = _load();

        assertEq(c.caseBps.length, c.caseCount * LEG_COUNT, "caseBps");
        assertEq(c.probeCase.length, c.probeCount, "probeCase");
        assertEq(c.probeReceived.length, c.probeCount, "probeReceived");
        assertEq(c.probeDust.length, c.probeCount, "probeDust");
        assertEq(c.probeEntitlement.length, c.probeCount * LEG_COUNT, "probeEntitlement");
    }

    function test_corpusBoundsMatchTheLibrary() public view {
        Corpus memory c = _load();

        assertEq(
            vm.parseUint(vm.parseJsonString(c.json, ".bounds.bpsDenominator")),
            RevenueAllocationLib.BPS_DENOMINATOR,
            "denominator"
        );
        assertEq(vm.parseJsonUint(c.json, ".bounds.legCount"), RevenueAllocationLib.LEG_COUNT, "leg count");
        assertEq(
            vm.parseUint(vm.parseJsonString(c.json, ".bounds.maxUnallocatedDust")),
            RevenueAllocationLib.MAX_UNALLOCATED_DUST,
            "dust bound"
        );
    }

    // --- entitlements -------------------------------------------------------

    function test_entitlementsMatchTheVectors() public view {
        Corpus memory c = _load();

        for (uint256 probe = 0; probe < c.probeCount; probe++) {
            RevenueAllocationLib.Allocation memory allocation = _allocationAt(c.caseBps, c.probeCase[probe] * LEG_COUNT);
            uint256 received = vm.parseUint(c.probeReceived[probe]);

            RevenueAllocationLib.Legs memory owed = RevenueAllocationLib.entitlements(received, allocation);

            for (uint256 leg = 0; leg < LEG_COUNT; leg++) {
                uint256 actual = RevenueAllocationLib.legAt(owed, leg);
                uint256 expected = vm.parseUint(c.probeEntitlement[probe * LEG_COUNT + leg]);

                // Compared before asserted, so the descriptive message — which
                // costs a full re-parse of the corpus — is built only when there is
                // a failure to describe.
                if (actual != expected) {
                    assertEq(
                        actual,
                        expected,
                        string.concat("case ", _caseName(c, c.probeCase[probe]), " leg ", vm.toString(leg))
                    );
                }
            }
        }
    }

    function test_dustMatchesTheVectorsAndStaysInsideItsBound() public view {
        Corpus memory c = _load();

        uint256 worst = 0;

        for (uint256 probe = 0; probe < c.probeCount; probe++) {
            RevenueAllocationLib.Allocation memory allocation = _allocationAt(c.caseBps, c.probeCase[probe] * LEG_COUNT);
            uint256 received = vm.parseUint(c.probeReceived[probe]);
            uint256 expected = vm.parseUint(c.probeDust[probe]);

            uint256 dust = RevenueAllocationLib.unallocated(received, allocation);

            assertEq(dust, expected, "dust");
            assertLe(dust, RevenueAllocationLib.MAX_UNALLOCATED_DUST, "dust bound");

            if (dust > worst) worst = dust;
        }

        // Otherwise the bound is an untested claim: a corpus that never rounds all
        // four legs down at once would pass a bound of any size.
        assertEq(worst, RevenueAllocationLib.MAX_UNALLOCATED_DUST, "the corpus must reach the bound");
    }

    function test_aLegWithNoShareIsPaidNothingAtEveryTotal() public view {
        Corpus memory c = _load();

        for (uint256 probe = 0; probe < c.probeCount; probe++) {
            RevenueAllocationLib.Allocation memory allocation = _allocationAt(c.caseBps, c.probeCase[probe] * LEG_COUNT);
            uint256 received = vm.parseUint(c.probeReceived[probe]);

            RevenueAllocationLib.Legs memory owed = RevenueAllocationLib.entitlements(received, allocation);

            for (uint256 leg = 0; leg < LEG_COUNT; leg++) {
                if (RevenueAllocationLib.bpsAt(allocation, leg) == 0) {
                    assertEq(RevenueAllocationLib.legAt(owed, leg), 0, "a leg with no share");
                }
            }
        }
    }

    function test_entitlementsNeverExceedWhatWasReceived() public view {
        Corpus memory c = _load();

        for (uint256 probe = 0; probe < c.probeCount; probe++) {
            RevenueAllocationLib.Allocation memory allocation = _allocationAt(c.caseBps, c.probeCase[probe] * LEG_COUNT);
            uint256 received = vm.parseUint(c.probeReceived[probe]);

            assertLe(
                RevenueAllocationLib.totalOf(RevenueAllocationLib.entitlements(received, allocation)),
                received,
                "paid out more than arrived"
            );
        }
    }

    /// @dev The reason the decomposition exists. At `received = type(uint256).max`
    /// the definition `received * bps / 10_000` cannot be evaluated on chain at
    /// all, and the vectors carry the answer it would have given.
    function test_theDecompositionSurvivesWhereTheDefinitionOverflows() public {
        uint16 bps = 6000;
        uint256 received = type(uint256).max;

        vm.expectRevert(stdError.arithmeticError);
        this.naiveEntitlement(received, bps);

        // 0.6 * (2^256 - 1), floored. Independently: the vectors carry this value
        // for every case at this total, and the loop above has already asserted it.
        assertEq(
            RevenueAllocationLib.entitlement(received, bps),
            69_475_253_542_389_717_254_142_591_005_212_744_711_961_990_799_384_338_423_674_550_404_747_877_783_961,
            "decomposed entitlement at the top of the range"
        );
    }

    /// @dev External so `vm.expectRevert` can catch the overflow: a revert inside
    /// the test's own frame would fail the test rather than be caught.
    function naiveEntitlement(uint256 received, uint16 bps) external pure returns (uint256) {
        return (received * bps) / RevenueAllocationLib.BPS_DENOMINATOR;
    }

    // --- streaming ----------------------------------------------------------

    function test_allocationDoesNotDependOnHowTheMoneyArrived() public view {
        Streams memory s = _loadStreams();
        uint256 cursor = 0;

        for (uint256 stream = 0; stream < s.count; stream++) {
            RevenueAllocationLib.Allocation memory allocation = _allocationAt(s.bps, stream * LEG_COUNT);

            uint256 received = 0;
            uint256[LEG_COUNT] memory allocated;

            for (uint256 i = 0; i < s.arrivalCount[stream]; i++) {
                received += vm.parseUint(s.arrival[cursor + i]);

                // Allocate after every arrival, including the ones that move
                // nothing. A run that only allocated at the end would never
                // exercise the high-water mark, which is the whole mechanism.
                RevenueAllocationLib.Legs memory owed = RevenueAllocationLib.entitlements(received, allocation);
                for (uint256 leg = 0; leg < LEG_COUNT; leg++) {
                    uint256 entitled = RevenueAllocationLib.legAt(owed, leg);
                    assertGe(entitled, allocated[leg], "an entitlement fell below what was allocated");
                    allocated[leg] = entitled;
                }
            }
            cursor += s.arrivalCount[stream];

            assertEq(received, vm.parseUint(s.total[stream]), "total received");

            for (uint256 leg = 0; leg < LEG_COUNT; leg++) {
                assertEq(
                    allocated[leg],
                    vm.parseUint(s.finalAllocated[stream * LEG_COUNT + leg]),
                    "a drip and a single payment must land in the same place"
                );
            }
        }
    }

    // --- validation ---------------------------------------------------------

    function test_rejectsSharesThatDoNotSumToTheDenominator() public {
        RevenueAllocationLib.Allocation memory short = RevenueAllocationLib.Allocation({
            operationsBps: 6000, buybacksBps: 2000, developerBps: 1000, protocolBps: 999
        });

        vm.expectRevert(abi.encodeWithSelector(RevenueAllocationLib.BpsSumMismatch.selector, 9999));
        this.validate(short);

        RevenueAllocationLib.Allocation memory over = RevenueAllocationLib.Allocation({
            operationsBps: 6000, buybacksBps: 2000, developerBps: 1000, protocolBps: 1001
        });

        vm.expectRevert(abi.encodeWithSelector(RevenueAllocationLib.BpsSumMismatch.selector, 10_001));
        this.validate(over);
    }

    function test_rejectsAnAllOfNothingAllocation() public {
        RevenueAllocationLib.Allocation memory empty =
            RevenueAllocationLib.Allocation({operationsBps: 0, buybacksBps: 0, developerBps: 0, protocolBps: 0});

        vm.expectRevert(abi.encodeWithSelector(RevenueAllocationLib.BpsSumMismatch.selector, 0));
        this.validate(empty);
    }

    function test_reportsRangeBeforeSum() public {
        RevenueAllocationLib.Allocation memory wide =
            RevenueAllocationLib.Allocation({operationsBps: 10_001, buybacksBps: 0, developerBps: 0, protocolBps: 0});

        // Both rules are broken. The range one is checked first, so a caller who
        // wrote 10 001 into a leg is told that rather than told the total is wrong.
        vm.expectRevert(abi.encodeWithSelector(RevenueAllocationLib.BpsOutOfRange.selector, 0, 10_001));
        this.validate(wide);
    }

    function test_acceptsALegAtZero() public view {
        this.validate(
            RevenueAllocationLib.Allocation({operationsBps: 10_000, buybacksBps: 0, developerBps: 0, protocolBps: 0})
        );
    }

    /// @dev External so the reverting cases can be caught by `vm.expectRevert`.
    function validate(RevenueAllocationLib.Allocation memory allocation) external pure {
        RevenueAllocationLib.validate(allocation);
    }

    // --- properties ---------------------------------------------------------

    function testFuzz_theFourLegsNeverPayOutMoreThanArrived(uint256 received, uint16 a, uint16 b, uint16 c)
        public
        pure
    {
        a = uint16(bound(a, 0, 10_000));
        b = uint16(bound(b, 0, 10_000 - a));
        c = uint16(bound(c, 0, 10_000 - a - b));
        uint16 d = uint16(10_000 - a - b - c);

        RevenueAllocationLib.Allocation memory allocation =
            RevenueAllocationLib.Allocation({operationsBps: a, buybacksBps: b, developerBps: c, protocolBps: d});

        RevenueAllocationLib.Legs memory owed = RevenueAllocationLib.entitlements(received, allocation);
        uint256 total = RevenueAllocationLib.totalOf(owed);

        assertLe(total, received, "created value");
        assertLe(received - total, RevenueAllocationLib.MAX_UNALLOCATED_DUST, "lost more than the dust bound");
    }

    function testFuzz_entitlementsAreMonotonicInWhatWasReceived(uint128 first, uint128 second, uint16 a) public pure {
        a = uint16(bound(a, 0, 10_000));

        RevenueAllocationLib.Allocation memory allocation = RevenueAllocationLib.Allocation({
            operationsBps: a, buybacksBps: uint16(10_000 - a), developerBps: 0, protocolBps: 0
        });

        uint256 low = first < second ? first : second;
        uint256 high = first < second ? second : first;

        RevenueAllocationLib.Legs memory atLow = RevenueAllocationLib.entitlements(low, allocation);
        RevenueAllocationLib.Legs memory atHigh = RevenueAllocationLib.entitlements(high, allocation);

        // The property that makes `allocatable` safe to compute as a subtraction:
        // more revenue can never reduce what a leg is owed.
        for (uint256 leg = 0; leg < LEG_COUNT; leg++) {
            assertGe(RevenueAllocationLib.legAt(atHigh, leg), RevenueAllocationLib.legAt(atLow, leg), "not monotonic");
        }
    }

    function testFuzz_splittingAtOnceEqualsSplittingInTwo(uint128 first, uint128 second, uint16 a) public pure {
        a = uint16(bound(a, 0, 10_000));

        RevenueAllocationLib.Allocation memory allocation = RevenueAllocationLib.Allocation({
            operationsBps: a, buybacksBps: uint16(10_000 - a), developerBps: 0, protocolBps: 0
        });

        RevenueAllocationLib.Legs memory once = RevenueAllocationLib.entitlements(uint256(first) + second, allocation);

        // Two arrivals, allocating after each: the high-water mark means the
        // second call catches up rather than splitting the increment on its own.
        RevenueAllocationLib.Legs memory afterFirst = RevenueAllocationLib.entitlements(first, allocation);
        RevenueAllocationLib.Legs memory afterSecond =
            RevenueAllocationLib.entitlements(uint256(first) + second, allocation);

        for (uint256 leg = 0; leg < LEG_COUNT; leg++) {
            assertGe(RevenueAllocationLib.legAt(afterSecond, leg), RevenueAllocationLib.legAt(afterFirst, leg), "order");
            assertEq(RevenueAllocationLib.legAt(afterSecond, leg), RevenueAllocationLib.legAt(once, leg), "path");
        }
    }
}
