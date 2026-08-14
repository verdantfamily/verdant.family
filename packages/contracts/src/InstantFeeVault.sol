// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";

import {InstantFees} from "./libraries/InstantFees.sol";

/// @title InstantFeeVault
/// @notice Where one Instant market's ether fees land, and the only way they leave.
///
/// @dev One vault per market, deployed at creation, with no owner, no setter, no sweep
/// and no upgrade path. Two recipients, two ledgers, and a claim each.
///
/// ## Why this is not `FeeSplitter`
///
/// `FeeSplitter` computes an entitlement from its own *balance*: whatever has arrived,
/// times `protocolBps`. It can do that because its split is a fixed ratio of everything
/// it holds, so a fee that lands by any route at all is divided correctly and no ledger
/// is needed.
///
/// Instant's split is not a ratio of the pot. It is 1.00% and 0.50% *of the trade*, which
/// exists as a ratio of the fee only as one third — and one third is not a whole number
/// of basis points, which is the entire reason `InstantFees` states the shares the way it
/// does. A balance here therefore does not say how it should divide, so this contract
/// keeps an explicit ledger and the ledger is authoritative.
///
/// That is a real trade-off and worth naming rather than glossing: ether arriving by any
/// route other than a credit is not claimable by anybody. The route is closed as far as
/// it can be — `receive` accepts only from the PoolManager, which is the one address that
/// pays a `take` — so the reachable case is a `selfdestruct` force-send, which no
/// contract can refuse. `unaccounted()` reports it rather than hiding it.
///
/// ## Why pull, and why nothing is sent during a swap
///
/// The hook credits this vault inside `beforeSwap` or `afterSwap`, which is to say inside
/// somebody's trade. If crediting also *paid* the creator, then a creator whose fee
/// receiver is a contract that reverts on receipt — a multisig with a strict fallback, a
/// splitter of their own, an address that later becomes one — would make every swap in
/// their own market revert. The market would stop trading, permanently, and nothing could
/// fix it because the receiver is immutable.
///
/// So a swap only ever writes to storage here, and the worst a broken recipient can do is
/// fail its own claim. That also keeps the swap path free of any external call to an
/// address chosen by a creator, which is the part an auditor should not have to think
/// about twice.
///
/// ## Why the fee arrives as a claim rather than as ether
///
/// The hook charges inside `beforeSwap` or `afterSwap`, and at that point in a v4 swap
/// the trader has not settled yet — the PoolManager has computed what everyone owes but
/// has not been paid. `poolManager.take` moves real ether, so on a buy it would try to
/// send ether the manager does not hold. In an established pool it would appear to work,
/// by spending reserves that other pools' traders had settled moments earlier; in a
/// freshly launched Instant market, whose pool is one-sided and holds no ether at all
/// until somebody buys, the very first trade would simply revert. A launchpad whose
/// markets cannot take their first trade is not a launchpad.
///
/// So the hook calls `poolManager.mint` instead, which credits this vault with ERC-6909
/// claims on ether without moving any. The claims are settled by the trader at the end of
/// the same unlock, exactly like every other delta in the swap, and this contract redeems
/// them for real ether when somebody claims — outside any swap, where the manager
/// certainly holds the balance. It is also the cheaper path: no value transfer per trade,
/// one per withdrawal.
contract InstantFeeVault is IUnlockCallback {
    /// @notice The Instant hook, and the only contract that may credit this vault.
    /// @dev Shared across every Instant market rather than deployed per market: the fee
    /// is a constant of the deployment, so there is nothing per-market for a hook to
    /// hold. What is per-market is this vault, which is why the hook names the vault on
    /// every credit rather than the other way round.
    address public immutable hook;

    /// @notice The v4 PoolManager: custodian of the claims, and the only address
    /// `receive` accepts ether from.
    IPoolManager public immutable poolManager;

    /// @notice Receives the creator's share. Whatever they named at launch.
    /// @dev Immutable, and this contract takes no view on what it is beyond refusing the
    /// zero address. It may be a wallet, a multisig, or a splitter of their own — the
    /// pull design above is what makes that safe rather than a liability.
    address public immutable creator;

    /// @notice Receives Agen's share.
    address public immutable treasury;

    /// @notice Ether ever credited to the creator, including what they have taken.
    uint256 public creatorAccrued;

    /// @notice Ether the creator has taken.
    uint256 public creatorClaimed;

    /// @notice Ether ever credited to the platform, including what it has taken.
    uint256 public platformAccrued;

    /// @notice Ether the platform has taken.
    uint256 public platformClaimed;

    /// @notice A trade paid its fee into this vault.
    /// @dev Carries the ether leg it was taken from as well as the two shares, so an
    /// indexer can check the split without knowing the constants.
    event Accrued(uint256 etherLeg, uint256 creatorAmount, uint256 platformAmount);

    /// @notice A recipient took what was owed to them.
    event Claimed(address indexed recipient, uint256 amount);

    error ZeroHook();
    error ZeroPoolManager();
    error ZeroCreator();
    error ZeroTreasury();

    /// @notice One address cannot hold both shares.
    /// @dev The two entitlements are told apart by which ledger they are in, and a
    /// claim is aimed by which function is called — so an address that was both would
    /// still be paid both, but the market's economics would be a configuration mistake
    /// in every case where it is not a test. Refused rather than handled.
    error CreatorIsTreasury(address recipient);

    /// @notice Something other than the hook tried to credit this vault.
    error NotHook(address caller);

    /// @notice Ether arrived from somewhere that is not the PoolManager.
    error NotPoolManager(address sender);

    /// @notice A credit would promise more ether than this vault holds.
    /// @dev The check that keeps the ledger honest against custody. The hook takes the
    /// fee to this address and then credits it, and if those two ever disagreed the
    /// ledger would be writing cheques the balance could not cover — the first claim
    /// would succeed and a later one would revert on a transfer, which is the worst
    /// possible place to discover it.
    error Undercredited(uint256 owed, uint256 held);

    /// @notice Nothing has accrued to this recipient since their last claim.
    error NothingToClaim(address recipient);

    /// @notice A native transfer failed.
    /// @dev Only reachable for a recipient that rejects ether. Their own claim fails and
    /// nothing else is affected, which is the property the pull design exists for.
    error NativeTransferFailed(address recipient, uint256 amount);

    constructor(address hook_, IPoolManager poolManager_, address creator_, address treasury_) {
        if (hook_ == address(0)) revert ZeroHook();
        if (address(poolManager_) == address(0)) revert ZeroPoolManager();
        if (creator_ == address(0)) revert ZeroCreator();
        if (treasury_ == address(0)) revert ZeroTreasury();
        if (creator_ == treasury_) revert CreatorIsTreasury(creator_);

        hook = hook_;
        poolManager = poolManager_;
        creator = creator_;
        treasury = treasury_;
    }

    // --- accrual --------------------------------------------------------------

    /// @notice Record the fee owed on a trade whose ether leg was `etherLeg`.
    ///
    /// @dev Called by the hook immediately after it has taken the fee to this address.
    /// The hook passes the *leg*, not the fee and not the two shares, so that
    /// `InstantFees.split` is applied exactly once per trade by the contract that owns
    /// the ledger. A hook passing pre-divided amounts could hand this vault a split that
    /// did not sum to what it took, and the ledger would be wrong in a way no test of
    /// the hook alone would catch.
    ///
    /// @param etherLeg The ether side of the swap: the input on a buy, the output on a
    /// sell. The same number the hook took 1.50% of.
    ///
    /// @return creatorAmount Ether newly owed to the creator.
    /// @return platformAmount Ether newly owed to the platform.
    function credit(uint256 etherLeg) external returns (uint256 creatorAmount, uint256 platformAmount) {
        if (msg.sender != hook) revert NotHook(msg.sender);

        uint256 totalAmount;
        (creatorAmount, platformAmount, totalAmount) = InstantFees.split(etherLeg);

        // A trade too small to owe a wei is not an error, and must not be: the hook
        // calls this on every swap, and a revert here is a market that cannot trade.
        if (totalAmount == 0) return (0, 0);

        creatorAccrued += creatorAmount;
        platformAccrued += platformAmount;

        uint256 owed = _owed();
        uint256 held = _backing();
        if (owed > held) revert Undercredited(owed, held);

        emit Accrued(etherLeg, creatorAmount, platformAmount);
    }

    // --- claiming -------------------------------------------------------------

    /// @notice Pay the creator everything owed to them.
    ///
    /// @dev Deliberately callable by anybody, and deliberately takes no argument. There
    /// is no address to aim it at — the recipient is an immutable — so a third party
    /// triggering it can only move the creator's ether to the creator. That lets Agen
    /// pay the gas for a creator who would rather not, without any of them being able to
    /// redirect a payment.
    function claimCreator() external returns (uint256 amount) {
        amount = creatorAccrued - creatorClaimed;
        if (amount == 0) revert NothingToClaim(creator);

        creatorClaimed = creatorAccrued;
        emit Claimed(creator, amount);

        _pay(creator, amount);
    }

    /// @notice Pay the platform everything owed to it. Independent of the creator's
    /// claim in every respect: a creator whose receiver reverts does not block this, and
    /// neither ledger can be moved by the other's claim.
    function claimPlatform() external returns (uint256 amount) {
        amount = platformAccrued - platformClaimed;
        if (amount == 0) revert NothingToClaim(treasury);

        platformClaimed = platformAccrued;
        emit Claimed(treasury, amount);

        _pay(treasury, amount);
    }

    // --- views ----------------------------------------------------------------

    /// @notice What `recipient` could claim right now. Zero for anybody else.
    function claimable(address recipient) external view returns (uint256) {
        if (recipient == creator) return creatorAccrued - creatorClaimed;
        if (recipient == treasury) return platformAccrued - platformClaimed;
        return 0;
    }

    /// @notice Both outstanding balances, for an interface that shows them together.
    function outstanding() external view returns (uint256 creatorAmount, uint256 platformAmount) {
        creatorAmount = creatorAccrued - creatorClaimed;
        platformAmount = platformAccrued - platformClaimed;
    }

    /// @notice Ether held here that no ledger accounts for.
    ///
    /// @dev Should be zero. It can only become non-zero through a `selfdestruct`
    /// force-send, which no contract can refuse, and such ether is not claimable by
    /// anybody. Exposed rather than swept: a sweep needs an owner, and an owner on the
    /// contract holding a market's fees is a larger risk than a stranded wei.
    function unaccounted() external view returns (uint256) {
        uint256 owed = _owed();
        uint256 held = _backing();
        return held > owed ? held - owed : 0;
    }

    /// @notice Ether owed to this vault that has not been redeemed from the PoolManager
    /// yet, held as ERC-6909 claims. Normally the whole unclaimed balance.
    function claims() external view returns (uint256) {
        return poolManager.balanceOf(address(this), CurrencyLibrary.ADDRESS_ZERO.toId());
    }

    // --- redemption -----------------------------------------------------------

    /// @notice The PoolManager's callback while this vault redeems its claims.
    /// @dev Reachable only from `_redeem`, which is reachable only from a claim, so the
    /// amount is one this contract has already decided it owes.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);

        uint256 amount = abi.decode(data, (uint256));

        // Burning the claim leaves this vault owed that much ether by the manager;
        // taking it settles the debt the other way. The pair nets to zero, which is what
        // lets the unlock close.
        poolManager.burn(address(this), CurrencyLibrary.ADDRESS_ZERO.toId(), amount);
        poolManager.take(CurrencyLibrary.ADDRESS_ZERO, address(this), amount);

        return "";
    }

    // --- internals ------------------------------------------------------------

    /// @dev Everything this vault still owes to both recipients.
    function _owed() private view returns (uint256) {
        return (creatorAccrued - creatorClaimed) + (platformAccrued - platformClaimed);
    }

    /// @dev What stands behind the ledger: ether already redeemed, plus claims not yet
    /// redeemed. The two are interchangeable — a claim is ether the manager is holding
    /// on this vault's behalf — so solvency has to be measured against the sum.
    function _backing() private view returns (uint256) {
        return address(this).balance + poolManager.balanceOf(address(this), CurrencyLibrary.ADDRESS_ZERO.toId());
    }

    /// @dev Turn `amount` of claims into ether. Outside any swap, so the manager holds
    /// the balance and the unlock is this vault's own.
    ///
    /// A claim made from inside somebody else's unlock would revert here, because v4
    /// permits one at a time. That is a failed claim and nothing more: it cannot happen
    /// during a swap this vault is credited by, since the hook only ever calls `credit`.
    function _redeem(uint256 amount) private {
        poolManager.unlock(abi.encode(amount));
    }

    /// @dev Effects precede this, always. A recipient that reenters finds its claimed
    /// total already equal to its accrued total, so the second pass reverts
    /// `NothingToClaim` and pays nothing.
    ///
    /// A bare call rather than `transfer`: the 2 300 gas stipend was a safety measure
    /// against reentrancy that CEI already handles, and today it is a liveness bug for
    /// any recipient whose `receive` costs more than that — which is most multisigs.
    function _pay(address recipient, uint256 amount) private {
        uint256 held = address(this).balance;
        if (held < amount) _redeem(amount - held);

        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert NativeTransferFailed(recipient, amount);
    }

    /// @notice Accepts redeemed claims, and nothing else.
    /// @dev The `take` in `unlockCallback` sends native ether here, so this has to
    /// exist. Restricting it to the PoolManager is what keeps `unaccounted()` at zero for
    /// every route a contract can actually refuse.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);
    }
}
