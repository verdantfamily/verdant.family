// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title InstantFees
/// @notice What an Instant market charges, and how that charge divides. Frozen
/// rather than configured.
///
/// @dev Three numbers, and none of them is a parameter:
///
///   - **1.50%** taken from every trade;
///   - **1.00%** of the trade to the creator's fee receiver;
///   - **0.50%** of the trade to the Agen platform treasury.
///
/// Instant's whole claim is that it is the launch with nothing to decide, and a
/// fee schedule is the most consequential thing a launchpad can put in a form. A
/// creator who wants to choose one wants Programmable, whose stages are a
/// per-market input validated against `ModelBounds`. There is deliberately no
/// setter, no owner and no registry read here: these are constants of the
/// deployment, and changing one means deploying a different hook.
///
/// ## Why this is stated in ppm of the trade, and not in bps of the fee
///
/// The obvious encoding is a total fee plus the protocol's share of it, which is
/// how `FeeSplitter` divides an ordinary Verdant market: one pot, split on
/// `protocolBps`. That encoding cannot express this split. The platform's cut is
/// 0.50 / 1.50 of the fee, which is one third, and one third is not representable
/// in basis points — the nearest is 3 333 bps, which pays 0.49995% and 1.00005%.
/// Rounding of a few parts per million is not a scandal, but "exactly 1.00% and
/// exactly 0.50%" is the specification, and an encoding that cannot state the
/// specification is the wrong encoding.
///
/// So both shares are taken from the *trade* rather than one being a ratio of the
/// other. In ppm each is exact: 15 000, 10 000 and 5 000 of 1 000 000.
///
/// ## What `split` guarantees
///
/// Given any amount of ether, for every input reachable in a v4 swap:
///
///   1. `totalAmount` is exactly 1.50% of it, rounded down — so a trader is never
///      charged more than the interface states;
///   2. `creatorAmount + platformAmount == totalAmount`, always and exactly — the
///      creator's share is *derived by subtraction* rather than computed, so there
///      is no third number that could disagree and no dust stranded anywhere. This
///      is the same rule `FeeSplitter` uses, and for the same reason;
///   3. `platformAmount` is exactly 0.50% rounded down, so the remainder of at
///      most one wei falls to the creator rather than to the protocol.
///
/// Together those make the creator's share exactly 1.00% to within the single wei
/// that integer division cannot divide, and they make the sum of the two exactly
/// the amount the trader paid. There is no route by which the two shares add to
/// more than the fee, which is the property that matters: this library is the only
/// thing that charges an Instant market, because the pool's own LP fee is set to
/// zero at initialisation. A non-zero LP fee alongside this would be a second
/// charge on the same trade, and the invariant the interface states — that a trade
/// costs 1.50% and nothing else — would quietly be false.
///
/// ## Overflow
///
/// `split` multiplies before dividing, which is what keeps the rounding correct,
/// and cannot overflow on any input v4 can hand it: swap amounts are `int128`, so
/// the largest conceivable argument is under 1.71e38, and 1.71e38 × 15 000 is
/// about 2.6e42 against a `uint256` ceiling of 1.16e77. The multiplication is
/// checked regardless, because a hook that reverts is better than a hook that
/// wraps — but it is unreachable rather than merely unlikely.
library InstantFees {
    /// @notice The denominator every share below is expressed in.
    /// @dev Parts per million, matching `ScheduleLib`'s fee unit and v4's own
    /// `LPFeeLibrary`, so a fee moving between this library and a pool never
    /// changes base on the way.
    uint256 internal constant PPM_DENOMINATOR = 1_000_000;

    /// @notice Everything an Instant trade costs: 1.50%.
    /// @dev The whole charge, not a component of one. See the note above on the
    /// pool's LP fee being zero.
    uint24 internal constant TOTAL_PPM = 15_000;

    /// @notice The creator's share of a trade: 1.00%, paid in ether.
    uint24 internal constant CREATOR_PPM = 10_000;

    /// @notice The platform's share of a trade: 0.50%, paid in ether.
    uint24 internal constant PLATFORM_PPM = 5_000;

    /// @notice Divide a swap's ether leg into the two shares it owes.
    ///
    /// @param etherAmount The ether side of the swap the fee is taken from — the
    /// input on a buy and the output on a sell, which is what makes both sides pay
    /// in ether rather than one side paying in the launched token.
    ///
    /// @return creatorAmount Ether owed to the market's fee receiver.
    /// @return platformAmount Ether owed to the platform treasury.
    /// @return totalAmount The two of them, and exactly what leaves the trade.
    function split(uint256 etherAmount)
        internal
        pure
        returns (uint256 creatorAmount, uint256 platformAmount, uint256 totalAmount)
    {
        totalAmount = (etherAmount * TOTAL_PPM) / PPM_DENOMINATOR;
        platformAmount = (etherAmount * PLATFORM_PPM) / PPM_DENOMINATOR;

        // Subtraction, not a third multiplication. Two independently rounded
        // shares would sum to the total only by luck, and the wei they disagreed
        // by would be owed to nobody and held by the hook forever.
        creatorAmount = totalAmount - platformAmount;
    }
}
