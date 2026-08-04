// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TokenVesting
/// @notice Linear release of one allocation to one beneficiary after a cliff.
///
/// @dev Deployed only when a creator configures vesting, and then holding only
/// that creator's own allocation. It is not a general-purpose vesting utility and
/// deliberately does not try to be:
///
///   - **One beneficiary, immutable.** No transfer of entitlement.
///   - **One schedule, immutable.** Start, cliff, duration and amount are fixed at
///     construction.
///   - **No revocation, no owner, no pause, no sweep.** There is no party who can
///     interfere with the schedule, including Verdant and including the creator
///     who set it up. That is the entire point: a creator saying "my allocation
///     unlocks over a year" should be a fact a buyer can check, not an intention
///     they have to trust.
///
/// ## The cliff
///
/// Vesting accrues from `start`; the cliff gates *access* to what has accrued. So
/// at the cliff the whole accrued portion becomes releasable at once, and after it
/// release is continuous. This is the standard reading — it matches
/// OpenZeppelin's `VestingWalletCliff` — and it is stated here because the other
/// plausible reading, accrual beginning at the cliff, differs only in the amount
/// available in the instant the cliff passes, which is exactly the kind of
/// difference nobody notices until a beneficiary complains.
///
/// ## Funding
///
/// The contract does not pull tokens. Whoever deploys it transfers the allocation
/// in — in production the factory, in the same transaction. `release()` therefore
/// depends on the contract actually holding what it promises; a contract deployed
/// and never funded reverts on transfer rather than misreporting. That is a
/// deployment-script property, asserted there, not something this contract can
/// check without pulling, and pulling would need an allowance and an approval step
/// that the factory flow does not otherwise require.
contract TokenVesting {
    using SafeERC20 for IERC20;

    /// @notice The vesting token.
    IERC20 public immutable token;

    /// @notice The only address that can ever be paid.
    address public immutable beneficiary;

    /// @notice The full amount to be released over the schedule.
    uint256 public immutable totalAllocation;

    /// @notice When accrual begins.
    uint64 public immutable start;

    /// @notice The timestamp before which nothing can be released. Absolute, not a
    /// duration, so that reading the contract does not require arithmetic.
    uint64 public immutable cliff;

    /// @notice When the whole allocation has vested.
    uint64 public immutable end;

    /// @notice Cumulative amount released so far.
    uint256 public released;

    event Released(address indexed beneficiary, uint256 amount);

    error ZeroToken();
    error ZeroBeneficiary();
    error ZeroAllocation();
    error ZeroDuration();

    /// @notice A cliff past the end of the schedule would lock the allocation
    /// forever while looking like a schedule.
    error CliffAfterEnd(uint64 cliffDuration, uint64 duration);

    /// @notice Nothing has vested since the last release.
    error NothingToRelease();

    /// @param cliffDuration Seconds after `start_` before anything is releasable.
    /// May be zero. May equal `duration_`, which means a single unlock at the end.
    /// @param duration_ Total length of the schedule in seconds.
    constructor(
        address token_,
        address beneficiary_,
        uint256 totalAllocation_,
        uint64 start_,
        uint64 cliffDuration,
        uint64 duration_
    ) {
        if (token_ == address(0)) revert ZeroToken();
        if (beneficiary_ == address(0)) revert ZeroBeneficiary();
        if (totalAllocation_ == 0) revert ZeroAllocation();
        if (duration_ == 0) revert ZeroDuration();
        if (cliffDuration > duration_) revert CliffAfterEnd(cliffDuration, duration_);

        token = IERC20(token_);
        beneficiary = beneficiary_;
        totalAllocation = totalAllocation_;
        start = start_;
        cliff = start_ + cliffDuration;
        end = start_ + duration_;
    }

    /// @notice The total that has vested by `timestamp`, released or not.
    ///
    /// @dev Pure function of the schedule and the clock. Takes an explicit
    /// timestamp rather than reading `block.timestamp` so that the interface can
    /// draw the whole curve, including its future, from one call per point — and so
    /// that the arithmetic is testable at boundaries without warping.
    ///
    /// Overflow: `totalAllocation * elapsed` is bounded by the supply cap times the
    /// horizon cap, far inside 2^256. Solidity 0.8 would revert rather than wrap in
    /// any case.
    function vestedAmount(uint64 timestamp) public view returns (uint256) {
        if (timestamp < cliff) return 0;
        if (timestamp >= end) return totalAllocation;

        uint64 elapsed = timestamp - start;
        uint64 duration = end - start;

        // Rounds down, so the final second of the schedule carries any remainder.
        // The `timestamp >= end` branch above is what guarantees the beneficiary
        // is nonetheless paid the exact total rather than the total minus dust.
        return (totalAllocation * elapsed) / duration;
    }

    /// @notice What can be released right now.
    function releasable() public view returns (uint256) {
        return vestedAmount(uint64(block.timestamp)) - released;
    }

    /// @notice Release everything vested and unreleased to the beneficiary.
    ///
    /// @dev Permissionless. There is no discretion about the amount or the
    /// destination, so restricting the caller would protect nothing and would mean
    /// a beneficiary who cannot pay for gas cannot be paid at all.
    ///
    /// Reverts rather than transferring zero: a zero-value success is worse than a
    /// failure, because a keeper or an interface reads it as confirmation that the
    /// release happened.
    function release() external {
        uint256 amount = releasable();
        if (amount == 0) revert NothingToRelease();

        // Accounting before the transfer. The token is a VerdantToken and cannot
        // reenter, but this contract should not depend on that: it is deployed
        // beside a token whose address is a constructor argument.
        released += amount;

        emit Released(beneficiary, amount);
        token.safeTransfer(beneficiary, amount);
    }
}
