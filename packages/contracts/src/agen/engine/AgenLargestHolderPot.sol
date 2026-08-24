// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

import {AgenEngineVault} from "./AgenEngineVault.sol";
import {IAgenEngineHookV2} from "./IAgenEngineHookV2.sol";

/// @title AgenLargestHolderPot
/// @notice One market's largest-holder share: the ledger of who held what for how long,
/// and the claim that pays out each closed epoch.
///
/// @dev The pot does not compute a maximum. Nothing on chain can enumerate holders, so
/// anyone may propose one; anyone with more weight takes it during a challenge window;
/// after the window the best claimant is paid. Unclaimed pots roll forward rather than
/// being lost. ADR-019.
///
/// ## Why the weight ledger lives here rather than on the hook
///
/// It was on the hook, and the hook came to 25 417 bytes against EIP-170's 24 576 — a
/// contract that could not be deployed, discovered by an Anvil broadcast after the whole
/// suite passed, because `forge test` does not enforce the limit.
///
/// Moving it here is not only a size fix, though. This contract is the *only* consumer of
/// a weight: the hook never reads one, it only recorded them. A market with no
/// largest-holder recipient has no pot, and now also does no bookkeeping — before, every
/// v2 market paid for an accumulator that nothing would ever read.
contract AgenLargestHolderPot {
    using CurrencyLibrary for Currency;

    uint32 public constant CHALLENGE_SECONDS = 15 minutes;

    IAgenEngineHookV2 public immutable hook;
    uint256 public immutable slot;

    AgenEngineVault public vault;
    PoolId public poolId;
    bool public bound;

    /// @notice A balance, and the moment the wallet started holding it.
    ///
    /// @dev A list of these rather than a per-epoch accumulator, which is a correctness
    /// fix and not an optimisation. Accumulating on transfer means settling every epoch
    /// elapsed since the wallet last moved — one cold `SSTORE` each, twenty-four a day at
    /// the hourly period this exists for. A wallet that sat for a fortnight needed millions
    /// of gas to transfer and one that sat for months could not transfer at all, which
    /// would have frozen exactly the long-term holder the payout is meant to reward.
    ///
    /// A checkpoint costs one slot per transfer whatever the gap, because an untouched
    /// balance needs no record: the interval it spans is implied by the checkpoints either
    /// side of it. `weightOf` reads the interval instead of the ledger writing it.
    struct Checkpoint {
        uint40 at;
        uint128 balance;
    }

    /// @dev Ascending by `at`, since entries are only ever appended at `block.timestamp`.
    mapping(address wallet => Checkpoint[] history) private _history;

    /// @notice Addresses that hold the token structurally rather than as a trader.
    /// @dev The locked liquidity, the pool, the factory and the pots. A locked LP position
    /// holds most of the supply, so without this it would win every epoch and the market
    /// would pay its own fees back to itself.
    mapping(address wallet => bool isExcluded) public excluded;

    struct Claim {
        address holder;
        uint256 weight;
        uint40 claimedAt;
        uint256 pot;
        bool paid;
        bool assigned;
    }

    mapping(uint256 epoch => Claim claim) public claims;
    uint256 public unassigned;

    event Bound(address vault, PoolId poolId);
    event Collected(uint256 amount, uint256 unassigned);
    event EpochAssigned(uint256 indexed epoch, uint256 pot);
    event Claimed(uint256 indexed epoch, address indexed holder, uint256 weight);
    event Paid(uint256 indexed epoch, address indexed holder, uint256 amount);
    event Excluded(address indexed wallet);

    error AlreadyBound();
    error NotBound();
    error NotHook(address caller);
    error EpochNotClosed(uint256 epoch, uint256 current);
    error NothingToClaim(uint256 epoch);
    error WeightNotHigher(uint256 provided, uint256 current);
    error ChallengeOpen(uint256 closesAt);
    error AlreadyPaid(uint256 epoch);
    error NativeTransferFailed(address to, uint256 amount);

    constructor(IAgenEngineHookV2 hook_, uint256 slot_) {
        hook = hook_;
        slot = slot_;
    }

    modifier onlyHook() {
        if (msg.sender != address(hook)) revert NotHook(msg.sender);
        _;
    }

    function bind(AgenEngineVault vault_, PoolId poolId_) external onlyHook {
        if (bound) revert AlreadyBound();
        vault = vault_;
        poolId = poolId_;
        bound = true;
        emit Bound(address(vault_), poolId_);
    }

    // --- the ledger -----------------------------------------------------------

    /// @notice Record a transfer of the launched token.
    /// @dev Only the hook, which is the only thing the token notifies. Accounting only:
    /// no external call, no payout, nothing that could make a transfer fail for a reason
    /// the holder cannot see.
    function onTransfer(address from, address to, uint256 amount) external onlyHook {
        // forge-lint: disable-next-line(unsafe-typecast) -- the supply is uint128-bounded
        uint128 moved = uint128(amount);

        if (from != address(0)) _move(from, moved, false);
        if (to != address(0)) _move(to, moved, true);
    }

    function exclude(address wallet) external onlyHook {
        excluded[wallet] = true;
        emit Excluded(wallet);
    }

    /// @notice Balance × seconds held by `holder` during `epoch`.
    ///
    /// @dev Computed from the checkpoints rather than read from an accumulator, so a wallet
    /// that never moved during the epoch costs one lookup however long it has been still.
    /// The walk is bounded by the holder's own transfers inside that one epoch, which is
    /// the only quantity they control and the only one they pay for.
    ///
    /// The current epoch is measured only up to now, so a mid-epoch read is the weight so
    /// far rather than a projection. Only closed epochs are ever paid, and for those the
    /// answer is final.
    function weightOf(uint256 epoch, address holder) public view returns (uint256 weight) {
        if (excluded[holder]) return 0;

        (uint256 initTime, uint32 period) = hook.epochWindow(poolId);
        if (period == 0 || initTime == 0) return 0;

        uint256 start = initTime + epoch * period;
        uint256 end = start + period;
        if (end > block.timestamp) end = block.timestamp;
        if (end <= start) return 0;

        Checkpoint[] storage points = _history[holder];
        uint256 length = points.length;
        if (length == 0 || points[0].at >= end) return 0;

        for (uint256 i = _checkpointAt(points, start); i < length; i++) {
            uint256 from = points[i].at < start ? start : points[i].at;
            if (from >= end) break;

            uint256 until = i + 1 < length ? points[i + 1].at : end;
            if (until > end) until = end;
            if (until > from) weight += uint256(points[i].balance) * (until - from);
        }
    }

    /// @notice What this wallet holds, as the ledger has it.
    function balanceOf(address holder) external view returns (uint128) {
        uint256 length = _history[holder].length;
        return length == 0 ? 0 : _history[holder][length - 1].balance;
    }

    function _move(address wallet, uint128 amount, bool incoming) private {
        if (excluded[wallet]) return;

        Checkpoint[] storage points = _history[wallet];
        uint256 length = points.length;
        uint128 balance = length == 0 ? 0 : points[length - 1].balance;
        uint128 next = incoming ? balance + amount : balance - amount;

        // forge-lint: disable-next-line(unsafe-typecast) -- uint40 holds timestamps to 36812
        uint40 at = uint40(block.timestamp);

        // Several transfers in one block are one checkpoint: a zero-length interval carries
        // no weight, so only the block's final balance is worth recording.
        if (length != 0 && points[length - 1].at == at) {
            points[length - 1].balance = next;
            return;
        }

        points.push(Checkpoint({at: at, balance: next}));
    }

    /// @dev The last checkpoint at or before `timestamp`, or 0 when every checkpoint is
    /// later — in which case index 0 is where the overlap can begin anyway.
    function _checkpointAt(Checkpoint[] storage points, uint256 timestamp) private view returns (uint256) {
        if (points[0].at > timestamp) return 0;

        uint256 low = 0;
        uint256 high = points.length - 1;
        while (low < high) {
            uint256 mid = (low + high + 1) / 2;
            if (points[mid].at <= timestamp) low = mid;
            else high = mid - 1;
        }
        return low;
    }

    // --- the payout -----------------------------------------------------------

    function collect() public returns (uint256 amount) {
        if (!bound) revert NotBound();

        uint256 before = _balance();
        try vault.claim(slot) returns (uint256 pulled) {
            amount = pulled;
        } catch {
            amount = 0;
        }

        uint256 arrived = _balance() - before;
        if (arrived > amount) amount = arrived;
        if (amount != 0) {
            unassigned += amount;
            emit Collected(amount, unassigned);
        }
    }

    /// @notice Move whatever has not been assigned onto the most recently closed epoch.
    function assignClosed() public returns (uint256 epoch, uint256 pot) {
        if (!bound) revert NotBound();
        collect();

        uint256 current = hook.epochOf(poolId, block.timestamp);
        if (current == 0) return (0, 0);
        epoch = current - 1;

        Claim storage claim = claims[epoch];
        if (!claim.assigned && unassigned != 0) {
            claim.pot = unassigned;
            claim.assigned = true;
            unassigned = 0;
            emit EpochAssigned(epoch, claim.pot);
        }
        return (epoch, claim.pot);
    }

    function claimEpoch(uint256 epoch, address holder) external {
        if (!bound) revert NotBound();

        uint256 current = hook.epochOf(poolId, block.timestamp);
        if (epoch >= current) revert EpochNotClosed(epoch, current);

        assignClosed();

        uint256 weight = weightOf(epoch, holder);
        if (weight == 0) revert NothingToClaim(epoch);

        Claim storage claim = claims[epoch];
        if (weight <= claim.weight) revert WeightNotHigher(weight, claim.weight);

        claim.holder = holder;
        claim.weight = weight;
        // forge-lint: disable-next-line(unsafe-typecast)
        claim.claimedAt = uint40(block.timestamp);
        emit Claimed(epoch, holder, weight);
    }

    function finalize(uint256 epoch) external {
        Claim storage claim = claims[epoch];
        if (claim.holder == address(0)) revert NothingToClaim(epoch);
        if (claim.paid) revert AlreadyPaid(epoch);

        uint256 closesAt = uint256(claim.claimedAt) + CHALLENGE_SECONDS;
        if (block.timestamp < closesAt) revert ChallengeOpen(closesAt);

        assignClosed();
        uint256 amount = claim.pot;
        claim.paid = true;
        if (amount != 0) _pay(claim.holder, amount);
        emit Paid(epoch, claim.holder, amount);
    }

    receive() external payable {}

    function _balance() private view returns (uint256) {
        if (!bound) return 0;
        Currency currency = vault.currency();
        return currency.isAddressZero() ? address(this).balance : currency.balanceOfSelf();
    }

    function _pay(address to, uint256 amount) private {
        Currency currency = vault.currency();
        if (currency.isAddressZero()) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed(to, amount);
            return;
        }
        currency.transfer(to, amount);
    }
}
