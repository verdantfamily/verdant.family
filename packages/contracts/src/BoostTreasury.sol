// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {BoostEscrowFactory} from "./BoostEscrowFactory.sol";

/// @dev The part of `InstantFeeVault` this contract uses.
interface IInstantFeeVaultPlatform {
    function claimPlatform() external returns (uint256 amount);
    function claimable(address recipient) external view returns (uint256);
    function creator() external view returns (address);
    function treasury() external view returns (address);
}

/// @dev The part of `BoostEscrow` this contract uses.
interface IBoostEscrowPlatform {
    function owner() external view returns (address);
    function receivePlatformFee(address vault) external payable;
}

/// @title BoostTreasury
/// @notice Where Agen's 0.50% lands, and the switch that sends it into a market's buybacks
/// instead of into Agen.
///
/// @dev **This is the contract that makes "100% Boost" true rather than aspirational.**
///
/// `BoostEscrow` can capture a creator's 1.00% because `InstantFeeVault.creator` is whatever a
/// launch named as its `feeRecipient`, and a creator can name a contract. The platform's 0.50%
/// is not like that: `InstantFeeVault.treasury` comes from `InstantFactory.treasury`, which is
/// an immutable of the *factory* rather than a per-launch argument. So there is exactly one way
/// to route it by code, and it is to be that address.
///
/// This contract is that address. An Instant deployment whose `TREASURY` is this contract has
/// every one of its markets' platform fees delivered here, and this decides — from a flag only
/// the market's own genuine escrow can set — whether they go to Agen or into the market's
/// buybacks. Nothing periodic, nothing manual, and no promise: the money cannot reach Agen while
/// Boost is on, because the only function that pays Agen reads the same flag.
///
/// The consequence, stated where it cannot be missed: **an Instant deployment whose treasury is
/// an EOA can never have its platform fee Boosted.** `InstantFactory.treasury` is immutable and
/// every vault snapshots it at creation, so this has to be in place before the markets exist.
/// See ADR-015.
///
/// ## Why it is keyed by vault and not by token
///
/// A vault pays with a bare call carrying no calldata, so `msg.sender` is the only thing
/// `receive` has to work with — and `msg.sender` *is* the market's vault. Keying on it means no
/// lookup, no registry dependency, and no way for the attribution to be wrong.
///
/// It also breaks a deployment cycle. Keyed by token this would need `MarketRegistry` to resolve
/// one to the other, and that registry's `writer` is the very factory that has to name this
/// contract — so the two would have to be deployed before each other. Keyed by vault there is
/// nothing to look up.
///
/// ## Why a separate contract from the escrow
///
/// Because `InstantFeeVault`'s constructor refuses `creator == treasury`
/// (`InstantFeeVault.sol:146`), and for a Boost market the creator *is* the escrow. The two
/// shares are told apart by which ledger they are in, so one address holding both would be a
/// configuration mistake the vault is right to reject. This is the second address.
///
/// ## The cutoff
///
/// `receive` books by the flag as it stands at that instant, and it never calls out — so what
/// makes the boundary exact is that the escrow *forces a settlement before it flips*. Enabling
/// claims the platform fee while the flag is still off, so everything earned up to that
/// transaction is Agen's; disabling claims it while the flag is still on, so everything earned
/// under Boost stays committed. Neither side can be moved afterwards by anybody.
contract BoostTreasury is ReentrancyGuard {
    // --- wiring, all immutable -------------------------------------------------

    /// @notice Where the platform's 0.50% goes when Boost is off. Agen's own address.
    /// @dev Immutable, so this contract cannot be turned into a way of paying somebody else.
    address public immutable agenTreasury;

    /// @notice The authority on whether a caller claiming to be a market's escrow is one.
    ///
    /// @dev The load-bearing dependency, and the reason this is not merely a
    /// `msg.sender == vault.creator()` check. That check alone would let the *creator of an
    /// ordinary market* — whose vault names their wallet — call `setBoost` and then
    /// `pullForBoost`, and walk off with Agen's half percent. Requiring the caller to be an
    /// escrow this factory derived closes that, because an escrow can only ever spend what it
    /// holds on buybacks and burns.
    BoostEscrowFactory public immutable escrowFactory;

    // --- per-market state ------------------------------------------------------

    struct Market {
        /// @dev Set once `register` has proved this vault pays here. Until then an arriving
        /// transfer cannot be attributed and falls to `unattributed`.
        bool registered;
        /// @dev Whether this market's platform fee is going into Boost right now.
        ///
        /// A mirror of the escrow's own flag rather than a read of it, and deliberately: `receive`
        /// must never revert — a vault pays with a bare call and reverts the whole claim if it
        /// fails, which for an immutable recipient would strand a market's platform fees forever.
        /// A stored flag has no failure mode. The escrow keeps it in step by setting it in the
        /// same transaction as its own, immediately after forcing a settlement.
        bool boosting;
        /// @dev Agen's, waiting to be withdrawn. Platform fees earned while Boost was off.
        uint256 agenPending;
        /// @dev Committed to this market's buybacks, waiting for the escrow to pull it.
        /// Unreachable by Agen: no path here adds this to `agenPending`.
        uint256 boostPending;
        /// @dev Ever routed into Boost, and ever paid to Agen. Cumulative, for the interface to
        /// state what each side has actually given up rather than what it currently holds.
        uint256 routedToBoost;
        uint256 paidToAgen;
    }

    mapping(address vault => Market) private _markets;

    /// @dev Every vault registered here, in registration order, so a keeper or an auditor can
    /// enumerate without an archive node.
    address[] private _vaults;

    /// @notice Ether from an address this contract cannot attribute to a market.
    /// @dev Should be zero. Reported rather than folded into a balance, for the reason
    /// `InstantFeeVault.unaccounted()` gives.
    uint256 public unattributed;

    // --- events ----------------------------------------------------------------

    event VaultRegistered(address indexed vault, address escrow);

    /// @notice A market's platform fee changed destination.
    /// @dev `settled` is what the escrow's own claim moved immediately before this, which is the
    /// amount the cutoff assigned to the side being left.
    event PlatformBoostSet(address indexed vault, bool boosting, uint256 settled);

    /// @notice Platform fees arrived and were booked.
    event PlatformFeeReceived(address indexed vault, uint256 amount, bool toBoost);

    /// @notice Committed platform fees left for the market's escrow.
    event RoutedToBoost(address indexed vault, address escrow, uint256 amount);

    /// @notice Agen took what was its.
    event PaidToAgen(address indexed vault, uint256 amount);

    // --- failures --------------------------------------------------------------

    error ZeroAddress();

    /// @notice This vault does not pay this contract, so it has nothing to do with Boost.
    /// @dev The check that makes registration permissionless. `treasury` is an immutable set from
    /// the factory that created the vault, so a vault whose answer is not this address belongs to
    /// a different Instant deployment and can never be routed here.
    error VaultPaysSomeoneElse(address vault, address paysTo);

    /// @notice The caller is not the address this vault pays as its creator.
    error NotTheMarketsEscrow(address vault, address escrow, address caller);

    /// @notice The caller is at the right address but is not an escrow this factory made.
    error NotAGenuineEscrow(address escrow, address owner);

    error NotRegistered(address vault);
    error NothingToRoute(address vault);
    error NothingToWithdraw(address vault);
    error TransferFailed(address to, uint256 amount);

    constructor(address agenTreasury_, BoostEscrowFactory escrowFactory_) {
        if (agenTreasury_ == address(0) || address(escrowFactory_) == address(0)) revert ZeroAddress();

        agenTreasury = agenTreasury_;
        escrowFactory = escrowFactory_;
    }

    // --- registration ----------------------------------------------------------

    /// @notice Record a vault whose platform fees arrive here.
    ///
    /// @dev Permissionless and fully derived: the vault is asked who it pays, and only an answer
    /// of this address gets it recorded. So the worst a stranger can do is finish a step somebody
    /// else would have taken.
    ///
    /// Idempotent, because every path below calls it and none of them should have to branch.
    function register(address vault) public returns (bool boosting) {
        Market storage market = _ensureRegistered(vault);
        return market.boosting;
    }

    /// @notice Whether this vault's platform fee is currently going into Boost.
    function isBoosting(address vault) external view returns (bool) {
        return _markets[vault].boosting;
    }

    // --- the switch, driven by the market's escrow ------------------------------

    /// @notice Point this market's platform fee at Boost, or back at Agen.
    ///
    /// @dev Callable only by the market's own escrow, and only if that escrow is one
    /// `escrowFactory` derived — see the note on `escrowFactory` for what the second half of that
    /// stops. The escrow is expected to have claimed the outstanding platform fee immediately
    /// before calling, which is what makes the boundary exact; `settled` is recorded here so the
    /// event carries the amount the cutoff assigned to the side being left.
    ///
    /// There is deliberately no way for Agen to call this. Agen gives up its share by deploying
    /// an Instant whose treasury is this contract, and after that the decision is the creator's
    /// alone — which is the only arrangement under which "Agen also gives up its fee" is a
    /// property of the market rather than of Agen's continued goodwill.
    function setBoost(address vault, bool boosting, uint256 settled) external returns (bool changed) {
        Market storage market = _ensureRegistered(vault);
        _requireMarketsEscrow(vault);

        if (market.boosting == boosting) return false;

        market.boosting = boosting;
        emit PlatformBoostSet(vault, boosting, settled);
        return true;
    }

    /// @notice Claim this market's outstanding platform fee out of its vault.
    ///
    /// @dev Permissionless, because the destination is decided by state the caller cannot
    /// influence: `receive` books it to whichever side the flag names at that instant, and both
    /// sides can only ever reach Agen or a burn.
    ///
    /// Not an error when there is nothing there. This runs inside every toggle and every
    /// buyback, and a market nobody has traded since the last claim is an ordinary state.
    function settle(address vault) public returns (uint256 amount) {
        _ensureRegistered(vault);

        IInstantFeeVaultPlatform paying = IInstantFeeVaultPlatform(vault);
        if (paying.claimable(address(this)) == 0) return 0;

        return paying.claimPlatform();
    }

    // --- paying out ------------------------------------------------------------

    /// @notice Send this market's committed platform fees to its escrow.
    ///
    /// @dev Callable only by that escrow, which is what makes the destination unarguable: there
    /// is no address parameter, and the one address it can reach is the caller. The escrow books
    /// what arrives as Boost funds and can only spend them on buying the market's own token and
    /// sending it to the dead address.
    function pullForBoost(address vault) external nonReentrant returns (uint256 amount) {
        Market storage market = _markets[vault];
        if (!market.registered) revert NotRegistered(vault);
        _requireMarketsEscrow(vault);

        amount = market.boostPending;
        if (amount == 0) revert NothingToRoute(vault);

        market.boostPending = 0;
        market.routedToBoost += amount;
        emit RoutedToBoost(vault, msg.sender, amount);

        // Effects first, and the call names the caller — so a reentrant escrow finds nothing
        // left to pull.
        IBoostEscrowPlatform(msg.sender).receivePlatformFee{value: amount}(vault);
    }

    /// @notice Pay Agen what this market owes it.
    ///
    /// @dev Permissionless and takes no destination, exactly as `InstantFeeVault.claimPlatform`
    /// does and for the same reason: the only address this can pay is an immutable, so an open
    /// caller has nothing to redirect.
    ///
    /// It cannot reach `boostPending`. That is not a check — it is a different storage field that
    /// no path in this contract adds to this one.
    function withdrawAgen(address vault) external nonReentrant returns (uint256 amount) {
        Market storage market = _markets[vault];

        amount = market.agenPending;
        if (amount == 0) revert NothingToWithdraw(vault);

        market.agenPending = 0;
        market.paidToAgen += amount;
        emit PaidToAgen(vault, amount);

        _pay(agenTreasury, amount);
    }

    /// @notice Move ether nobody could attribute to Agen.
    function sweepUnattributed() external nonReentrant returns (uint256 amount) {
        amount = unattributed;
        if (amount == 0) revert NothingToWithdraw(address(0));

        unattributed = 0;
        _pay(agenTreasury, amount);
    }

    // --- views -----------------------------------------------------------------

    struct PlatformState {
        bool registered;
        bool boosting;
        /// @dev Agen's, here, waiting to be withdrawn.
        uint256 agenPending;
        /// @dev Committed to Boost, here, waiting for the escrow to pull it.
        uint256 boostPending;
        /// @dev Still in the vault. A settle moves it to whichever side `boosting` names.
        uint256 vaultClaimable;
        uint256 routedToBoost;
        uint256 paidToAgen;
    }

    function platformStateOf(address vault) external view returns (PlatformState memory state) {
        Market storage market = _markets[vault];

        state.registered = market.registered;
        state.boosting = market.boosting;
        state.agenPending = market.agenPending;
        state.boostPending = market.boostPending;
        state.routedToBoost = market.routedToBoost;
        state.paidToAgen = market.paidToAgen;

        if (market.registered) {
            state.vaultClaimable = IInstantFeeVaultPlatform(vault).claimable(address(this));
        }
    }

    function registeredVaults() external view returns (address[] memory) {
        return _vaults;
    }

    // --- internals -------------------------------------------------------------

    function _ensureRegistered(address vault) private returns (Market storage market) {
        if (vault == address(0)) revert ZeroAddress();

        market = _markets[vault];
        if (market.registered) return market;

        address paysTo = IInstantFeeVaultPlatform(vault).treasury();
        if (paysTo != address(this)) revert VaultPaysSomeoneElse(vault, paysTo);

        market.registered = true;
        _vaults.push(vault);

        emit VaultRegistered(vault, IInstantFeeVaultPlatform(vault).creator());
    }

    /// @dev The caller is this market's escrow, and is a real one.
    ///
    /// Two checks, and neither is sufficient alone. The first establishes that the caller is the
    /// address this market's vault pays as its creator; the second establishes that such an
    /// address is an escrow rather than somebody's wallet. Without the second, the creator of an
    /// ordinary market could flip their own market's flag and pull Agen's half percent to
    /// themselves.
    ///
    /// `owner()` on a wallet has no code to run, so this reverts for one — which is the refusal,
    /// arrived at without a code-size check that a contract could satisfy trivially.
    function _requireMarketsEscrow(address vault) private view {
        address escrow = IInstantFeeVaultPlatform(vault).creator();
        if (msg.sender != escrow) revert NotTheMarketsEscrow(vault, escrow, msg.sender);

        address owner = IBoostEscrowPlatform(escrow).owner();
        if (!escrowFactory.isGenuine(owner, escrow)) revert NotAGenuineEscrow(escrow, owner);
    }

    function _pay(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);
    }

    /// @notice Books every wei that arrives, and never reverts.
    ///
    /// @dev The same reasoning as `BoostEscrow.receive`, and here it is load-bearing for Agen's
    /// side too: `InstantFeeVault._pay` sends with a bare call and reverts the whole claim if it
    /// fails, and the vault's `treasury` is an immutable — so a receive that could throw would
    /// make a market's platform fees permanently unreachable, with nothing anybody could do about
    /// it. No requires, no external calls, no arithmetic that can fail.
    ///
    /// The flag is read from storage rather than from the escrow for exactly that reason. An
    /// escrow that reverted on a view would otherwise take a market's platform fees down with it.
    receive() external payable {
        if (msg.value == 0) return;

        Market storage market = _markets[msg.sender];
        if (!market.registered) {
            unattributed += msg.value;
            return;
        }

        if (market.boosting) {
            market.boostPending += msg.value;
        } else {
            market.agenPending += msg.value;
        }

        emit PlatformFeeReceived(msg.sender, msg.value, market.boosting);
    }
}
