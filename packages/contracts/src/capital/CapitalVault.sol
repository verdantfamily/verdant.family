// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CapitalMandate} from "./CapitalMandate.sol";
import {ICapitalVenue} from "./ICapitalVenue.sol";

/// @title CapitalVault
/// @notice One depositor's money, managed by Agen inside a mandate they signed once, and reachable
/// by them at any moment without asking anybody.
///
/// @dev Read the function list. Ether leaves this contract in exactly two ways: `withdraw`,
/// which pays the owner and nobody else, and `allocate`, which pays a venue the mandate names.
/// There is no `delegatecall`, no function taking `bytes`, no function taking a recipient, and no
/// administrative sweep. "The operator cannot send this money to itself" is therefore not a claim
/// about the off-chain agent's behaviour — there is no function it could call to do it.
///
/// ## The property the agent layer did not have
///
/// `withdraw` reads the owner and the balance. It does not read the mandate, the pause flag,
/// the operator, or any model's opinion. `AgentTreasury` is a better-audited contract than this one
/// in most respects and has no withdrawal at all — value leaves it only as a service payment — which
/// is correct for an agent's own float and wrong for somebody's savings. Getting your money back must
/// not depend on automation being healthy, on a keeper running, or on the thing that manages it
/// agreeing that now is a good time.
///
/// The consequence is stated where it cannot be missed: a paused vault, a revoked mandate, an expired
/// mandate and a compromised operator all leave `withdraw` working exactly as it did.
///
/// ## Authorisation is per mandate, not per transaction
///
/// The depositor signs once. Afterwards the operator allocates, exits and redeploys with no further
/// signature, which is the entire product — a design requiring approval per action is a design where
/// the automation stops the moment the person is asleep. What bounds it is the mandate: a ceiling on
/// deployed principal, a ceiling per venue, a budget per period, a minimum gap between actions, an
/// expiry, and a fixed list of venues. Every one of those is checked here, in the contract, rather
/// than in the agent that would like to exceed them.
///
/// ## Ether only
///
/// No ERC-20 path, deliberately. This chain's managed asset is ether, there is no stablecoin in the
/// deployment, and a token path would add approvals, fee-on-transfer edge cases and a second
/// accounting model for an asset nothing can currently hold. When there is a token worth holding this
/// contract does not grow a branch; a second vault is deployed.
///
/// ## What this contract does not protect against
///
/// The venue. An adapter the mandate names can lose the money it is given, and no arrangement of
/// checks here prevents that — the depositor's protection against a bad venue is that they signed a
/// mandate naming it. The vault protects against the *operator*, and against itself.
contract CapitalVault is ReentrancyGuard {
    CapitalMandate public immutable mandate;

    /// @notice Copied from the mandate so the hot path does not make a call to learn who to pay.
    address public immutable owner;

    /// @notice Stops the operator. Set by the owner or the guardian, cleared only by the owner.
    bool public paused;

    /// @notice Principal the operator has deployed and not yet taken back, across all venues.
    uint256 public deployedWei;

    /// @notice Principal deployed per venue. Cost basis, not value: the venue's value is its own claim.
    mapping(address venue => uint256) public principalOf;

    /// @notice Shares held per venue, in whatever unit that venue counts in.
    mapping(address venue => uint256) public sharesOf;

    /// @notice Cumulative, for the audit trail and for a P&L nobody has to reconstruct from events.
    uint256 public totalDepositedWei;
    uint256 public totalWithdrawnWei;

    uint256 private _periodDeployedWei;
    uint64 private _periodStartedAt;
    uint64 public lastActionAt;

    event Deposited(address indexed from, uint256 amount, uint256 balance);
    event Withdrawn(address indexed to, uint256 amount, uint256 balance);
    event Allocated(address indexed venue, uint256 amount, uint256 sharesOut, uint256 deployed);
    event Divested(address indexed venue, uint256 shares, uint256 principalOut, uint256 ethOut, int256 realised);
    event PausedSet(bool paused, address indexed by);
    event PeriodRolled(uint64 startedAt);

    error ZeroMandate();
    error NotOwner(address caller);
    error NotOperator(address caller);
    error NotOwnerOrOperator(address caller);
    error NotOwnerOrGuardian(address caller);
    error VaultPaused();
    error NotPaused();
    error MandateNotLive();
    error ZeroAmount();
    error NothingToWithdraw();
    error InsufficientLiquid(uint256 wanted, uint256 liquid);
    error VenueNotInMandate(address venue);
    error DeployedCapExceeded(uint256 wouldBe, uint256 cap);
    error VenueCapExceeded(address venue, uint256 wouldBe, uint256 cap);
    error PeriodLimitExceeded(uint256 wouldBe, uint256 cap);
    error ActionTooSoon(uint64 earliest, uint64 now_);
    error ZeroMinOut();
    error NotEnoughShares(address venue, uint256 wanted, uint256 held);
    error ShortfallOnExit(uint256 received, uint256 minimum);
    error NativeTransferFailed(address to, uint256 amount);

    constructor(address mandate_) {
        if (mandate_ == address(0)) revert ZeroMandate();

        mandate = CapitalMandate(mandate_);
        owner = CapitalMandate(mandate_).owner();
    }

    // --- funding and the exit ------------------------------------------------

    /// @notice Add ether to the managed balance.
    ///
    /// @dev Payable and open to the owner only. A vault anybody could fund is a vault whose balance
    /// includes money whose owner is not the address the withdrawal pays, and the honest way to
    /// receive a gift is not to accept it here.
    function deposit() external payable {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        if (msg.value == 0) revert ZeroAmount();

        totalDepositedWei += msg.value;
        emit Deposited(msg.sender, msg.value, address(this).balance);
    }

    /// @notice Reject bare transfers, except from a venue paying out.
    ///
    /// @dev A venue's `exit` sends ether with no calldata, so `receive` has to exist. It records
    /// nothing: `divest` measures the balance across the call, and a `receive` that also did
    /// bookkeeping would count the same ether twice.
    ///
    /// Everything else is refused so that `totalDepositedWei` means what it says. Ether arriving
    /// from nowhere would otherwise be withdrawable but uncounted, and the P&L on the dashboard would
    /// silently include somebody's mistake.
    receive() external payable {
        if (msg.sender != owner && !mandate.isVenue(msg.sender)) {
            revert NotOwnerOrOperator(msg.sender);
        }
    }

    /// @notice Take ether out, to the owner.
    ///
    /// @dev The most important function here, and the plainest. No pause check, no mandate check, no
    /// operator check, no reentrancy concern worth guarding because the only recipient is the owner
    /// and the state is written first. See the note at the top of this contract for why it must stay
    /// this shape.
    ///
    /// It can only pay out what is liquid. Principal sitting in a venue has to be brought back with
    /// `divest` first, which the owner may also call — so the owner's route to all of their
    /// money never passes through the operator, it merely takes two transactions when they are
    /// invested.
    function withdraw(uint256 amount) public returns (uint256 paid) {
        if (msg.sender != owner) revert NotOwner(msg.sender);

        uint256 liquid = address(this).balance;
        if (liquid == 0) revert NothingToWithdraw();

        // Zero means "everything liquid", which is what somebody typing "withdraw everything" means and
        // saves them reading a balance to name it exactly.
        paid = amount == 0 ? liquid : amount;
        if (paid > liquid) revert InsufficientLiquid(paid, liquid);

        totalWithdrawnWei += paid;
        emit Withdrawn(owner, paid, liquid - paid);

        _pay(owner, paid);
    }

    // --- the operator's authority -------------------------------------------

    /// @notice Put ether into a venue the mandate names.
    ///
    /// @dev Every limit in the mandate is checked here before any value moves, and the accounting is
    /// written before the venue is called: an adapter that reenters must find the caps already
    /// charged, or a per-period limit is a limit per call.
    function allocate(address venue, uint256 amount, uint256 minSharesOut)
        external
        nonReentrant
        returns (uint256 sharesOut)
    {
        if (msg.sender != mandate.operator()) revert NotOperator(msg.sender);
        _requireLive();
        if (amount == 0) revert ZeroAmount();

        // Zero would let an adapter return nothing and be recorded as a position. The vault cannot
        // value shares, so the only guarantee available is that it asked for some.
        if (minSharesOut == 0) revert ZeroMinOut();

        if (!mandate.isVenue(venue)) revert VenueNotInMandate(venue);

        uint256 liquid = address(this).balance;
        if (amount > liquid) revert InsufficientLiquid(amount, liquid);

        uint256 wouldDeploy = deployedWei + amount;
        uint256 cap = mandate.maxDeployedWei();
        if (wouldDeploy > cap) revert DeployedCapExceeded(wouldDeploy, cap);

        uint256 wouldHold = principalOf[venue] + amount;
        uint256 venueCap = mandate.maxPerVenueWei();
        if (wouldHold > venueCap) revert VenueCapExceeded(venue, wouldHold, venueCap);

        uint64 nowSeconds = uint64(block.timestamp);
        _requireInterval(nowSeconds);

        uint256 alreadyThisPeriod = _rollPeriod(nowSeconds);
        uint256 wouldSpend = alreadyThisPeriod + amount;
        uint256 periodCap = mandate.periodDeployLimitWei();
        if (wouldSpend > periodCap) revert PeriodLimitExceeded(wouldSpend, periodCap);

        _periodDeployedWei = wouldSpend;
        deployedWei = wouldDeploy;
        principalOf[venue] = wouldHold;
        lastActionAt = nowSeconds;

        sharesOut = ICapitalVenue(venue).enter{value: amount}(minSharesOut);

        // The adapter is required to revert instead, and is not trusted to have done so.
        if (sharesOut < minSharesOut) revert ShortfallOnExit(sharesOut, minSharesOut);

        sharesOf[venue] += sharesOut;

        emit Allocated(venue, amount, sharesOut, deployedWei);
    }

    /// @notice Take ether back out of a venue.
    ///
    /// @dev Callable by the operator, which is how rebalancing and stop-losses work, and by the owner,
    /// which is how somebody gets their money back without the operator's cooperation. Not gated on
    /// the pause or the mandate for the owner, for the same reason `withdraw` is not: an exit is
    /// how the owner reaches their own funds, and a stop that blocked it would be a stop that trapped
    /// them.
    ///
    /// The operator's exits are gated on the pause, because a paused vault is one whose automation has
    /// been stopped, and unwinding positions is automation.
    function divest(address venue, uint256 shares, uint256 minEthOut) public nonReentrant returns (uint256 ethOut) {
        bool byOwner = msg.sender == owner;
        if (!byOwner) {
            if (msg.sender != mandate.operator()) revert NotOwnerOrOperator(msg.sender);
            _requireLive();
        }

        if (shares == 0) revert ZeroAmount();
        if (minEthOut == 0) revert ZeroMinOut();

        uint256 held = sharesOf[venue];
        if (shares > held) revert NotEnoughShares(venue, shares, held);

        // Principal comes out in the same proportion as the shares, so a partial exit leaves a cost
        // basis that still means something and a P&L that is not distorted by the order of exits.
        uint256 principal = principalOf[venue];
        uint256 principalOut = (principal * shares) / held;

        sharesOf[venue] = held - shares;
        principalOf[venue] = principal - principalOut;
        deployedWei -= principalOut;
        if (!byOwner) lastActionAt = uint64(block.timestamp);

        uint256 before = address(this).balance;
        ethOut = ICapitalVenue(venue).exit(shares, minEthOut);

        // What the adapter says it sent, against what arrived. The balance delta is the one number here
        // the venue cannot choose, so it is the one the check is made against.
        uint256 received = address(this).balance - before;
        if (received < minEthOut) revert ShortfallOnExit(received, minEthOut);

        emit Divested(venue, shares, principalOut, received, int256(received) - int256(principalOut));

        return received;
    }

    /// @notice Unwind a venue completely and pay the proceeds to the owner, in one transaction.
    ///
    /// @dev Convenience with a purpose: "revoke and get me out" should not be a sequence somebody can
    /// half-finish. Owner only, and it holds no privilege the owner does not already have.
    function exitAndWithdraw(address venue, uint256 minEthOut) external returns (uint256 paid) {
        if (msg.sender != owner) revert NotOwner(msg.sender);

        divest(venue, sharesOf[venue], minEthOut);
        return withdraw(0);
    }

    // --- the stops ----------------------------------------------------------

    /// @notice Stop the operator.
    ///
    /// @dev Either the owner or the guardian, because the two stops answer different questions: the
    /// owner's is "I want this to stop", and the guardian's is the platform-wide emergency. Neither can
    /// move value, and neither reaches `withdraw`.
    function pause() external {
        if (msg.sender != owner && msg.sender != mandate.guardian()) {
            revert NotOwnerOrGuardian(msg.sender);
        }
        if (paused) revert VaultPaused();

        paused = true;
        emit PausedSet(true, msg.sender);
    }

    /// @notice Let the operator act again.
    ///
    /// @dev Owner only, including when it was the guardian that paused. A guardian that could also
    /// unpause could hold an account's automation hostage to its own judgement; a guardian that can
    /// only stop can only ever make things safer.
    function unpause() external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        if (!paused) revert NotPaused();

        paused = false;
        emit PausedSet(false, msg.sender);
    }

    // --- reading ------------------------------------------------------------

    /// @notice Ether sitting here, available to withdraw or deploy.
    function liquidWei() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice What the operator may still deploy right now, on every limit at once.
    ///
    /// @dev The minimum of the three ceilings and the balance, so an interface can show one number
    /// rather than recomputing the rules and eventually disagreeing with them.
    function deployableWei() external view returns (uint256) {
        if (paused || !mandate.isLive(uint64(block.timestamp))) return 0;

        uint256 room = mandate.maxDeployedWei() - deployedWei;
        uint256 periodRoom = mandate.periodDeployLimitWei() - spentInPeriod(uint64(block.timestamp));
        if (periodRoom < room) room = periodRoom;

        uint256 liquid = address(this).balance;
        return liquid < room ? liquid : room;
    }

    /// @notice Deployed this period, answered from the caller's clock.
    ///
    /// @dev From the timestamp rather than from storage so a `view` caller and a transaction in the
    /// same block agree about whether the period has rolled. Reading only the stored counter would tell
    /// an interface there was no room left right up until the transaction that rolled it succeeded.
    function spentInPeriod(uint64 timestamp) public view returns (uint256) {
        return _hasRolled(timestamp) ? 0 : _periodDeployedWei;
    }

    function periodStartedAt() external view returns (uint64) {
        return _periodStartedAt;
    }

    // --- internals ----------------------------------------------------------

    function _requireLive() private view {
        if (paused) revert VaultPaused();
        if (!mandate.isLive(uint64(block.timestamp))) revert MandateNotLive();
    }

    /// @dev A vault that has never acted is never too soon. Zero means "never", not "at the epoch",
    /// and treating the two alike would make a long interval unusable exactly once.
    function _requireInterval(uint64 nowSeconds) private view {
        if (lastActionAt == 0) return;

        uint64 earliest = lastActionAt + mandate.minActionInterval();
        if (nowSeconds < earliest) revert ActionTooSoon(earliest, nowSeconds);
    }

    function _hasRolled(uint64 timestamp) private view returns (bool) {
        if (_periodStartedAt == 0) return false;
        return timestamp >= _periodStartedAt + mandate.periodLength();
    }

    /// @dev Rolls lazily, so nothing needs a keeper to turn the period over and a vault idle for a
    /// month does not wake up with a month of stale spending against it.
    function _rollPeriod(uint64 nowSeconds) private returns (uint256) {
        if (_periodStartedAt == 0 || _hasRolled(nowSeconds)) {
            _periodStartedAt = nowSeconds;
            _periodDeployedWei = 0;
            emit PeriodRolled(nowSeconds);
            return 0;
        }
        return _periodDeployedWei;
    }

    /// @dev A bare call rather than `transfer`: the owner may be a contract whose receive costs more
    /// than 2 300 gas, and a stipend that was a safety measure in 2018 is a liveness bug now. The same
    /// reasoning as `FeeSplitter.claim`. State is written before this is reached.
    function _pay(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed(to, amount);
    }
}
