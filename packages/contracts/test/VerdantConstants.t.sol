// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {VerdantConstants} from "../src/libraries/VerdantConstants.sol";

/// @title ADR-001 — the tick constants, checked against Uniswap's own
/// @notice The TypeScript side asserts the same arithmetic in
/// `packages/sdk/src/config.test.ts`. Both exist because the constants are
/// duplicated across languages, and a duplicated constant that is only checked in
/// one language is a constant that can drift in the other.
///
/// @dev Everything here is asserted against `TickMath` rather than against
/// literals, so an upstream change to the tick range fails in this file rather
/// than at pool creation.
contract VerdantConstantsTest is Test {
    function test_tickSpacingIs200() public pure {
        assertEq(VerdantConstants.TICK_SPACING, 200, "ADR-001 fixes tickSpacing at 200");
    }

    function test_usableTicksAreAlignedToTheSpacing() public pure {
        assertEq(VerdantConstants.MAX_USABLE_TICK % VerdantConstants.TICK_SPACING, 0, "max tick misaligned");
        assertEq(VerdantConstants.MIN_USABLE_TICK % VerdantConstants.TICK_SPACING, 0, "min tick misaligned");
    }

    function test_usableTicksAreInsideUniswapsRange() public pure {
        assertLt(VerdantConstants.MAX_USABLE_TICK, TickMath.MAX_TICK, "max tick outside v4's range");
        assertGt(VerdantConstants.MIN_USABLE_TICK, TickMath.MIN_TICK, "min tick outside v4's range");
    }

    function test_usableTicksAreTheWidestThatFit() public pure {
        // Not merely inside the range but as wide as alignment allows: one more
        // step in either direction falls outside. This is what makes them "full
        // range" rather than "some wide range".
        assertGt(
            VerdantConstants.MAX_USABLE_TICK + VerdantConstants.TICK_SPACING,
            TickMath.MAX_TICK,
            "a wider aligned tick exists"
        );
        assertLt(
            VerdantConstants.MIN_USABLE_TICK - VerdantConstants.TICK_SPACING,
            TickMath.MIN_TICK,
            "a wider aligned tick exists"
        );
    }

    function test_usableTicksAreSymmetric() public pure {
        assertEq(VerdantConstants.MIN_USABLE_TICK, -VerdantConstants.MAX_USABLE_TICK, "asymmetric range");
    }

    function test_upstreamRangeIsNotItselfAligned() public pure {
        // 887272 is not a multiple of 200. Asserted so that the alignment tests
        // above cannot be made to pass by "fixing" the usable ticks to the raw
        // bound, which is the obvious wrong repair.
        assertTrue(TickMath.MAX_TICK % VerdantConstants.TICK_SPACING != 0, "upstream bound is aligned after all");
    }

    function test_usableTicksAreValidTickMathInputs() public pure {
        // The strongest form of "inside the range": TickMath will actually price
        // them. getSqrtPriceAtTick reverts outside its own bounds, so a passing
        // call is the proof.
        assertGt(TickMath.getSqrtPriceAtTick(VerdantConstants.MAX_USABLE_TICK), 0);
        assertGt(TickMath.getSqrtPriceAtTick(VerdantConstants.MIN_USABLE_TICK), 0);
    }
}
