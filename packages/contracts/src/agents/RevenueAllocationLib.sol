// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title RevenueAllocationLib
/// @notice How an agent's revenue divides between operations, buybacks, the developer and the protocol.
///
/// @dev The Solidity twin of `packages/sdk/src/agents/allocation.ts`. The two are
/// asserted equal against `packages/sdk/src/agents/vectors/allocation.json` by
/// `test/agents/RevenueAllocationLib.vectors.t.sol` and by the SDK's own suite.
/// This decides who is paid; the SDK decides what the agent page says they are
/// owed. If the two can disagree, the page lies about somebody's money.
///
/// ## Allocation is cumulative, not per-arrival
///
/// The obvious rule is to split each payment as it lands. It is wrong in a way
/// that only appears in aggregate: `floor` discards a sub-unit remainder on every
/// call, and whichever leg absorbs it collects a systematic bias. An agent paid
/// one wei a thousand times would give its whole income to one leg while every
/// individual split looked defensible.
///
/// So a leg's entitlement is computed from the running total of everything the
/// agent has ever received:
///
/// ```
/// entitlement(leg) = floor(received * bps(leg) / 10_000)
/// allocatable(leg) = entitlement(leg) - alreadyAllocated(leg)
/// ```
///
/// The split is exact against the lifetime total however many calls it took to
/// get there. One payment of 1 000 and a thousand payments of 1 produce identical
/// buckets, which is what makes the numbers auditable rather than path-dependent.
///
/// ## Dust
///
/// Four floors of a total that divides exactly leave a shortfall of at most three
/// units: the fractional parts sum to a whole number, so the shortfall is 0, 1, 2
/// or 3 and never more. That dust is assigned to nobody. It stays in the router
/// and is picked up by the next allocation that makes it whole, because
/// entitlements are recomputed from the cumulative total every time.
///
/// Handing dust to a nominated leg was rejected: it makes a leg configured for
/// zero receive money, and it reintroduces the bias the cumulative rule exists to
/// remove.
library RevenueAllocationLib {
    /// @notice Basis points in the whole. Shares are exact against this denominator.
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Operations, buybacks, developer, protocol.
    uint256 internal constant LEG_COUNT = 4;

    /// @notice The most that can be unallocated at any instant, per asset.
    ///
    /// @dev `LEG_COUNT - 1`. Each leg's floor discards less than one unit and the
    /// fractional parts sum to an integer, so the shortfall cannot reach four. The
    /// bound is tight: three is reachable, and the vectors contain a case that
    /// reaches it.
    uint256 internal constant MAX_UNALLOCATED_DUST = LEG_COUNT - 1;

    /// @notice The four shares, in basis points, summing to `BPS_DENOMINATOR`.
    ///
    /// @dev `uint16` holds 65 535, so a share above the denominator is
    /// representable and the range check is real work rather than a formality.
    /// The four fit in one storage slot with room to spare.
    struct Allocation {
        uint16 operationsBps;
        uint16 buybacksBps;
        uint16 developerBps;
        uint16 protocolBps;
    }

    /// @notice An amount per leg, in one asset's own units.
    struct Legs {
        uint256 operations;
        uint256 buybacks;
        uint256 developer;
        uint256 protocol;
    }

    /// @notice The shares do not sum to the denominator.
    error BpsSumMismatch(uint256 total);

    /// @notice One share is above the denominator. `leg` is its index in canonical order.
    error BpsOutOfRange(uint256 leg, uint256 bps);

    /// @notice Validate the four shares.
    ///
    /// @dev Range before sum, so a caller who writes 10 001 into one leg is told
    /// that rather than being told the total is wrong — which would be true and
    /// useless. A leg at zero is legal: an agent with no buyback programme sets
    /// that leg to zero and it receives nothing, forever.
    function validate(Allocation memory allocation) internal pure {
        if (allocation.operationsBps > BPS_DENOMINATOR) revert BpsOutOfRange(0, allocation.operationsBps);
        if (allocation.buybacksBps > BPS_DENOMINATOR) revert BpsOutOfRange(1, allocation.buybacksBps);
        if (allocation.developerBps > BPS_DENOMINATOR) revert BpsOutOfRange(2, allocation.developerBps);
        if (allocation.protocolBps > BPS_DENOMINATOR) revert BpsOutOfRange(3, allocation.protocolBps);

        uint256 total = uint256(allocation.operationsBps) + allocation.buybacksBps + allocation.developerBps
            + allocation.protocolBps;

        if (total != BPS_DENOMINATOR) revert BpsSumMismatch(total);
    }

    /// @notice A leg's lifetime entitlement: its share of everything received, rounded down.
    ///
    /// @dev `Math.mulDiv`, not `received * bps / BPS_DENOMINATOR`.
    ///
    /// The naive form is the definition and it is unusable on chain: it reverts on
    /// overflow once `received` passes `2^256 / 10_000`, which would turn an
    /// arithmetic edge into a router that can never allocate that asset again. The
    /// treasury of a long-lived agent is not going to reach 1.15e73 of anything, but
    /// "no market will ever be that large" is a claim about the future and this is a
    /// contract that cannot be redeployed.
    ///
    /// `mulDiv` computes the 512-bit product and divides it down, so the result is
    /// `floor(received * bps / 10_000)` for **every** pair of inputs, with no
    /// intermediate overflow and no precision lost on the way. Because
    /// `bps <= BPS_DENOMINATOR` the result is at most `received` and therefore always
    /// representable, so the function is total over `uint256` — it cannot revert.
    ///
    /// This replaced a hand-rolled decomposition that was also exact, and the reason
    /// is not that the decomposition was wrong. It is that `mulDiv` is the same
    /// answer from audited, widely-reviewed code, and it does not need a paragraph
    /// arguing that dividing before multiplying is safe here. The differential
    /// vectors still hold both to the naive definition across the whole range.
    function entitlement(uint256 received, uint16 bps) internal pure returns (uint256) {
        return Math.mulDiv(received, bps, BPS_DENOMINATOR);
    }

    /// @notice Every leg's lifetime entitlement.
    ///
    /// @dev Validates first. An allocation that does not sum to the denominator
    /// produces four numbers that look like money and do not add up to it, and the
    /// caller has no way to notice.
    function entitlements(uint256 received, Allocation memory allocation) internal pure returns (Legs memory) {
        validate(allocation);

        return Legs({
            operations: entitlement(received, allocation.operationsBps),
            buybacks: entitlement(received, allocation.buybacksBps),
            developer: entitlement(received, allocation.developerBps),
            protocol: entitlement(received, allocation.protocolBps)
        });
    }

    /// @notice The sum across all four legs.
    function totalOf(Legs memory legs) internal pure returns (uint256) {
        return legs.operations + legs.buybacks + legs.developer + legs.protocol;
    }

    /// @notice Revenue received that no leg is entitled to yet: the dust.
    ///
    /// @dev Always in `[0, MAX_UNALLOCATED_DUST]` for a valid allocation.
    function unallocated(uint256 received, Allocation memory allocation) internal pure returns (uint256) {
        return received - totalOf(entitlements(received, allocation));
    }

    /// @notice A leg's amount by index, in canonical order.
    ///
    /// @dev For the differential harness and for events, which iterate. Reverts
    /// on an out-of-range index rather than returning zero, because a silent zero
    /// in a payout path is the worst available failure.
    function legAt(Legs memory legs, uint256 index) internal pure returns (uint256) {
        if (index == 0) return legs.operations;
        if (index == 1) return legs.buybacks;
        if (index == 2) return legs.developer;
        if (index == 3) return legs.protocol;
        revert BpsOutOfRange(index, 0);
    }

    /// @notice A share by index, in canonical order.
    function bpsAt(Allocation memory allocation, uint256 index) internal pure returns (uint16) {
        if (index == 0) return allocation.operationsBps;
        if (index == 1) return allocation.buybacksBps;
        if (index == 2) return allocation.developerBps;
        if (index == 3) return allocation.protocolBps;
        revert BpsOutOfRange(index, 0);
    }
}
