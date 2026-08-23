// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";

import {AgenRuleLib} from "./AgenRuleLib.sol";

/// @title AgenEngineVault
/// @notice Where one programmable market's fees land, and the only way they leave.
///
/// @dev One vault per market, deployed at launch, with no owner, no setter, no sweep and
/// no upgrade path. Up to four recipients with shares fixed at construction, one ledger,
/// and a claim each.
///
/// Descended from `InstantFeeVault`, and the differences are all consequences of the
/// engine being programmable rather than a preset:
///
///  - **One currency, but not always ether.** `InstantFeeVault` is ether-only because
///    Instant is. A programmable market's fee currency is derived from its rules — the
///    quote asset, or the launched token when the market has size tiers (ADR-018) — so
///    this holds whichever `Currency` its market settled on, native or ERC-20.
///  - **Up to four recipients, with configured shares.** Instant has two, at constants.
///  - **A cumulative ledger rather than a per-arrival one.** See below.
///
/// ## Why the ledger is cumulative
///
/// One number is written per trade — `totalAccrued` — and each recipient's entitlement is
/// computed from it on demand. That is `RevenueAllocationLib`'s design and it is chosen
/// for the same two reasons.
///
/// It is cheaper: one `SSTORE` on the swap path instead of one per recipient, which at
/// four recipients is the difference between a trade being viable and being resented.
///
/// And it is order-independent. Dividing each arrival separately means the dust left by
/// rounding depends on how the money came in — a thousand small trades and one large one
/// totalling the same fee would pay the creator slightly different amounts. Dividing the
/// running total means the split is a function of the total alone, so it does not matter
/// how it got there.
///
/// The first recipient in canonical order receives whatever rounding leaves over, which
/// is at most three base units at four recipients. It is stated here rather than left to
/// be derived because a splitter's rounding is exactly the thing an auditor should not
/// have to reconstruct: `_allocation` gives every other recipient `shareOf(total, share)`
/// and gives the first the remainder, so the allocations sum to `totalAccrued` exactly,
/// always, at every total.
///
/// ## Why pull, and why nothing is sent during a swap
///
/// The hook credits this vault inside `beforeSwap` or `afterSwap`, which is to say inside
/// somebody's trade. If crediting also *paid*, then a recipient that reverts on receipt —
/// a multisig with a strict fallback, a contract that later becomes one — would make every
/// swap in that market revert, permanently, with no way to fix it because the recipient is
/// immutable.
///
/// So a swap only ever writes storage here. The worst a broken recipient can do is fail
/// its own claim. That also keeps the swap path free of any external call to an address a
/// creator chose, which is the part an auditor should not have to think about twice.
///
/// ## Why the fee arrives as a claim rather than as value
///
/// Verbatim from `InstantFeeVault`, because the constraint is identical: at the moment the
/// hook charges, the trader has not settled, so the manager may hold nothing at all —
/// which is exactly the state a freshly launched pool is in until its first buy.
/// `poolManager.mint` credits this vault with ERC-6909 claims without moving value; the
/// trader settles them at the end of the same unlock like any other delta; this contract
/// redeems them for real value when somebody claims, outside any swap.
contract AgenEngineVault is IUnlockCallback {
    using CurrencyLibrary for Currency;

    /// @notice The engine hook, and the only contract that may credit this vault.
    address public immutable hook;

    /// @notice The v4 PoolManager: custodian of the claims, and the only address `receive`
    /// accepts native value from.
    IPoolManager public immutable poolManager;

    /// @notice The asset this market's fees are collected in.
    /// @dev Derived from the market's rules and fixed here. A vault holds exactly one
    /// currency, so there is no route by which a market's fees could arrive in two.
    Currency public immutable currency;

    /// @notice How many of the four recipient slots are in use.
    uint256 public immutable recipientCount;

    // Fixed slots rather than an array, so every read is a known immutable rather than a
    // storage lookup on the claim path. Four is `AgenRuleLib.MAX_RECIPIENTS`.
    address private immutable _recipient0;
    address private immutable _recipient1;
    address private immutable _recipient2;
    address private immutable _recipient3;
    uint24 private immutable _share0;
    uint24 private immutable _share1;
    uint24 private immutable _share2;
    uint24 private immutable _share3;

    /// @notice Every base unit of `currency` this vault has ever been credited.
    /// @dev The only thing a swap writes. Entitlements are derived from it.
    uint256 public totalAccrued;

    /// @notice What each recipient has taken, by slot.
    mapping(uint256 slot => uint256 amount) public claimed;

    /// @notice A trade paid its fee into this vault.
    event Accrued(uint256 amount, uint256 totalAccrued);

    /// @notice A recipient took what was owed to them.
    event Claimed(uint256 indexed slot, address indexed recipient, uint256 amount);

    error ZeroHook();
    error ZeroPoolManager();
    error NoRecipients();
    error TooManyRecipients(uint256 provided, uint256 max);
    error MismatchedShares(uint256 recipients, uint256 shares);
    error ZeroRecipient(uint256 slot);
    error ZeroShare(uint256 slot);
    error DuplicateRecipient(uint256 slot, address recipient);
    error SharesDoNotTotalOne(uint256 total, uint256 expected);

    /// @notice Something other than the hook tried to credit this vault.
    error NotHook(address caller);

    /// @notice Value arrived from somewhere that is not the PoolManager.
    error NotPoolManager(address sender);

    /// @notice A credit would promise more than this vault holds.
    /// @dev The check that keeps the ledger honest against custody. The hook mints the fee
    /// to this address and then credits it; if the two ever disagreed the ledger would be
    /// writing cheques the balance cannot cover, and the first claim would succeed while a
    /// later one reverted on a transfer — the worst possible place to discover it.
    error Undercredited(uint256 owed, uint256 held);

    error NoSuchRecipient(uint256 slot);
    error NothingToClaim(uint256 slot);
    error NativeTransferFailed(address recipient, uint256 amount);

    /// @param recipients Resolved addresses in canonical order. Roles are resolved by the
    /// factory before they reach here, so this contract never has to know what a "creator"
    /// is — it holds addresses and shares and nothing else.
    /// @param shares Parts per million, in the same order, totalling exactly one whole.
    constructor(
        address hook_,
        IPoolManager poolManager_,
        Currency currency_,
        address[] memory recipients,
        uint24[] memory shares
    ) {
        if (hook_ == address(0)) revert ZeroHook();
        if (address(poolManager_) == address(0)) revert ZeroPoolManager();
        if (recipients.length != shares.length) revert MismatchedShares(recipients.length, shares.length);
        if (recipients.length == 0) revert NoRecipients();
        if (recipients.length > AgenRuleLib.MAX_RECIPIENTS) {
            revert TooManyRecipients(recipients.length, AgenRuleLib.MAX_RECIPIENTS);
        }

        uint256 total;
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == address(0)) revert ZeroRecipient(i);
            if (shares[i] == 0) revert ZeroShare(i);

            // Two slots for one address would each be claimable, so the address would be
            // paid both — which is not wrong arithmetically but is a configuration mistake
            // in every case where it is not a test. `compile.ts` merges duplicates before
            // they get here; this refuses the ones that arrive by any other route.
            for (uint256 j = 0; j < i; j++) {
                if (recipients[j] == recipients[i]) revert DuplicateRecipient(i, recipients[i]);
            }

            total += shares[i];
        }
        if (total != AgenRuleLib.PPM_ONE) revert SharesDoNotTotalOne(total, AgenRuleLib.PPM_ONE);

        hook = hook_;
        poolManager = poolManager_;
        currency = currency_;
        recipientCount = recipients.length;

        _recipient0 = recipients[0];
        _share0 = shares[0];
        _recipient1 = recipients.length > 1 ? recipients[1] : address(0);
        _share1 = recipients.length > 1 ? shares[1] : 0;
        _recipient2 = recipients.length > 2 ? recipients[2] : address(0);
        _share2 = recipients.length > 2 ? shares[2] : 0;
        _recipient3 = recipients.length > 3 ? recipients[3] : address(0);
        _share3 = recipients.length > 3 ? shares[3] : 0;
    }

    // --- accrual --------------------------------------------------------------

    /// @notice Record `amount` of `currency` newly owed to this market's recipients.
    ///
    /// @dev One storage write, then a solvency check. Called on every swap that owes a fee,
    /// so it must not revert for any amount the hook can produce — including zero, which a
    /// trade too small to owe a base unit produces routinely.
    function credit(uint256 amount) external {
        if (msg.sender != hook) revert NotHook(msg.sender);
        if (amount == 0) return;

        uint256 total = totalAccrued + amount;
        totalAccrued = total;

        uint256 held = _backing();
        uint256 owed = total - _totalClaimed();
        if (owed > held) revert Undercredited(owed, held);

        emit Accrued(amount, total);
    }

    // --- claiming -------------------------------------------------------------

    /// @notice Pay recipient `slot` everything owed to them.
    ///
    /// @dev Deliberately callable by anybody and deliberately takes no address. The
    /// recipient is an immutable, so a third party triggering this can only move that
    /// recipient's value to that recipient — which lets Agen pay the gas for a creator who
    /// would rather not, without anyone being able to redirect a payment.
    function claim(uint256 slot) external returns (uint256 amount) {
        if (slot >= recipientCount) revert NoSuchRecipient(slot);

        amount = _allocation(totalAccrued, slot) - claimed[slot];
        if (amount == 0) revert NothingToClaim(slot);

        // Effects before the transfer, always. A recipient that reenters finds its claimed
        // total already equal to its allocation, so the second pass reverts and pays nothing.
        claimed[slot] += amount;

        address recipient = recipientAt(slot);
        emit Claimed(slot, recipient, amount);

        _pay(recipient, amount);
    }

    // --- views ----------------------------------------------------------------

    function recipientAt(uint256 slot) public view returns (address) {
        if (slot == 0) return _recipient0;
        if (slot == 1) return _recipient1;
        if (slot == 2) return _recipient2;
        if (slot == 3) return _recipient3;
        revert NoSuchRecipient(slot);
    }

    function shareAt(uint256 slot) public view returns (uint24) {
        if (slot == 0) return _share0;
        if (slot == 1) return _share1;
        if (slot == 2) return _share2;
        if (slot == 3) return _share3;
        revert NoSuchRecipient(slot);
    }

    /// @notice What recipient `slot` could claim right now.
    function claimable(uint256 slot) external view returns (uint256) {
        if (slot >= recipientCount) return 0;
        return _allocation(totalAccrued, slot) - claimed[slot];
    }

    /// @notice Everything still owed, across every recipient.
    function outstanding() public view returns (uint256) {
        return totalAccrued - _totalClaimed();
    }

    /// @notice Value held here that no allocation accounts for.
    ///
    /// @dev Should be zero. It can only become non-zero through a force-send that no
    /// contract can refuse, or an ERC-20 transferred here directly, and such value is not
    /// claimable by anybody. Exposed rather than swept: a sweep needs an owner, and an
    /// owner on the contract holding a market's fees is a larger risk than a stranded wei.
    function unaccounted() external view returns (uint256) {
        uint256 held = _backing();
        uint256 owed = outstanding();
        return held > owed ? held - owed : 0;
    }

    /// @notice Fees owed to this vault that have not been redeemed from the PoolManager
    /// yet, held as ERC-6909 claims.
    function claims() public view returns (uint256) {
        return poolManager.balanceOf(address(this), currency.toId());
    }

    // --- redemption -----------------------------------------------------------

    /// @notice The PoolManager's callback while this vault redeems its claims.
    /// @dev Reachable only from `_redeem`, which is reachable only from a claim, so the
    /// amount is one this contract has already decided it owes.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);

        uint256 amount = abi.decode(data, (uint256));

        // Burning the claim leaves this vault owed that much by the manager; taking it
        // settles the debt the other way. The pair nets to zero, which lets the unlock close.
        poolManager.burn(address(this), currency.toId(), amount);
        poolManager.take(currency, address(this), amount);

        return "";
    }

    // --- internals ------------------------------------------------------------

    /// @dev Recipient `slot`'s share of `total`, with the remainder going to slot 0.
    ///
    /// Every slot above zero rounds down; slot 0 takes what is left. So the allocations
    /// sum to `total` exactly at every total, which is the property that makes the ledger
    /// unable to promise more than it was credited.
    function _allocation(uint256 total, uint256 slot) private view returns (uint256) {
        if (slot != 0) return AgenRuleLib.shareOf(total, shareAt(slot));

        uint256 others;
        for (uint256 i = 1; i < recipientCount; i++) {
            others += AgenRuleLib.shareOf(total, shareAt(i));
        }
        return total - others;
    }

    function _totalClaimed() private view returns (uint256 total) {
        for (uint256 i = 0; i < recipientCount; i++) {
            total += claimed[i];
        }
    }

    /// @dev What stands behind the ledger: value already redeemed, plus claims not yet
    /// redeemed. The two are interchangeable — a claim is value the manager holds on this
    /// vault's behalf — so solvency has to be measured against the sum.
    function _backing() private view returns (uint256) {
        return currency.balanceOfSelf() + claims();
    }

    /// @dev Turn `amount` of claims into real value. Outside any swap, so the manager holds
    /// the balance and the unlock is this vault's own.
    function _redeem(uint256 amount) private {
        poolManager.unlock(abi.encode(amount));
    }

    /// @dev A bare call for native value rather than `transfer`: the 2 300 gas stipend was
    /// a safety measure against reentrancy that check-effects-interactions already handles,
    /// and today it is a liveness bug for any recipient whose `receive` costs more — which
    /// is most multisigs.
    function _pay(address recipient, uint256 amount) private {
        uint256 held = currency.balanceOfSelf();
        if (held < amount) _redeem(amount - held);

        if (currency.isAddressZero()) {
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert NativeTransferFailed(recipient, amount);
            return;
        }

        currency.transfer(recipient, amount);
    }

    /// @notice Accepts redeemed claims, and nothing else.
    /// @dev The `take` in `unlockCallback` sends native value here, so this has to exist.
    /// Restricting it to the PoolManager keeps `unaccounted()` at zero for every route a
    /// contract can actually refuse.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);
    }
}
