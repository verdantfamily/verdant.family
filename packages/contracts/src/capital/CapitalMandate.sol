// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title CapitalMandate
/// @notice One authorisation, given once, that bounds everything Agen may afterwards do with
/// somebody's money without asking again.
///
/// @dev The depositor says "allocate up to 0.05 ether into these venues" a single time, and this
/// contract is that sentence. From then on the operator moves, allocates, rebalances, enters, exits
/// and redeploys inside these numbers with no further signature — which is the product — and cannot
/// step outside them, which is what makes the product safe to offer.
///
/// ## There is no setter
///
/// The same rule as `AgentMandate`, for the same reason and with one deliberate addition. Nothing
/// widens a mandate after it is signed: not the operator, not the guardian, and not the depositor.
/// A depositor who wants different limits deploys a different mandate, because a mandate that could
/// be edited is one whose text at signing time proved nothing about what it would permit later, and
/// an operator that could ask for an edit is an operator whose limits are a negotiation.
///
/// The addition is `revoke`, which the depositor may call at any time and which only ever
/// subtracts. Revoking ends the operator's authority permanently and touches neither the money nor
/// the depositor's own access to it — see `CapitalVault.withdraw`, which does not read this contract.
///
/// ## What is enforced here rather than off chain
///
/// All of it. The off-chain policy compiler produces percentages, risk profiles and rebalance
/// thresholds, and none of that is in this file: those are questions of judgement, and judgement
/// belongs to code that can be replaced. What is here is the set of statements that have to be true
/// however wrong the judgement was — the ceiling on capital, which venues exist, how much may move
/// at once, and how often. A limit enforced only by the agent that wants to exceed it is not a limit.
contract CapitalMandate {
    /// @notice The most venues one mandate may name.
    ///
    /// @dev Bounded because the allowlist is checked linearly and copied to return it, so an
    /// unbounded list is a mandate that costs unbounded gas to act under. Eight is more than a
    /// first version has venues.
    uint256 public constant MAX_VENUES = 8;

    /// @notice A period must be at least this long, or it is a rate limit rather than a budget.
    uint64 public constant MIN_PERIOD_LENGTH = 1 hours;

    /// @notice A period may be at most this long.
    ///
    /// @dev A budget that resets yearly makes the worst case of a compromised operator a year's
    /// allowance in one afternoon.
    uint64 public constant MAX_PERIOD_LENGTH = 30 days;

    /// @notice The longest a mandate may run before the depositor has to think about it again.
    ///
    /// @dev An authorisation with no end is one somebody gave in a context that has since changed.
    /// A year is long enough to be useful and short enough that an abandoned account stops being
    /// managed rather than being managed forever by nobody's decision.
    uint64 public constant MAX_DURATION = 365 days;

    /// @notice Whose money it is. The only address that may revoke, and the only one paid by the vault.
    address public immutable owner;

    /// @notice Agen. Assumed hostile: everything it may do is in this file, and it cannot change it.
    address public immutable operator;

    /// @notice May stop the operator acting. May not move anything, and may not reach the owner's exit.
    address public immutable guardian;

    /// @notice The ceiling on principal the operator may have deployed at once.
    ///
    /// @dev The number in "allocate up to 0.05 ETH". Deliberately about deployed principal rather
    /// than about the vault's balance: a depositor who later adds ether has not thereby enlarged the
    /// operator's authority, and one whose position gained value has not either.
    uint256 public immutable maxDeployedWei;

    /// @notice The ceiling on principal in any single venue.
    uint256 public immutable maxPerVenueWei;

    /// @notice The most that may be sent into venues in one period.
    ///
    /// @dev Separate from `maxDeployedWei`, and not redundant with it. The first bounds how
    /// much is at risk; this bounds how fast it can be churned, which is the cost a compromised or
    /// simply bad operator can inflict without ever exceeding the exposure limit.
    uint256 public immutable periodDeployLimitWei;

    uint64 public immutable periodLength;

    /// @notice The least time between two operator actions.
    uint64 public immutable minActionInterval;

    /// @notice After this, the operator may do nothing. The owner is unaffected.
    uint64 public immutable expiry;

    /// @notice Permanent once set, and only the owner sets it.
    bool public revoked;

    address[] private _venues;

    event Revoked(address indexed by);

    error ZeroOwner();
    error ZeroOperator();
    error ZeroGuardian();
    error OwnerCannotBeOperator();
    error NoVenues();
    error TooManyVenues(uint256 given, uint256 most);
    error ZeroVenue();
    error DuplicateVenue(address venue);
    error ZeroMaxDeployed();
    error PerVenueExceedsTotal(uint256 perVenue, uint256 total);
    error ZeroPeriodLimit();
    error PeriodLengthOutOfRange(uint64 given, uint64 low, uint64 high);
    error IntervalTooLong(uint64 given, uint64 most);
    error DurationOutOfRange(uint64 given, uint64 most);
    error NotOwner(address caller);
    error AlreadyRevoked();

    constructor(
        address owner_,
        address operator_,
        address guardian_,
        address[] memory venues_,
        uint256 maxDeployedWei_,
        uint256 maxPerVenueWei_,
        uint256 periodDeployLimitWei_,
        uint64 periodLength_,
        uint64 minActionInterval_,
        uint64 duration_
    ) {
        if (owner_ == address(0)) revert ZeroOwner();
        if (operator_ == address(0)) revert ZeroOperator();
        if (guardian_ == address(0)) revert ZeroGuardian();

        // A mandate whose operator is its owner authorises nothing: every check against the operator
        // would pass for the person the checks exist to protect, and the separation the whole design
        // rests on would be cosmetic.
        if (owner_ == operator_) revert OwnerCannotBeOperator();

        if (venues_.length == 0) revert NoVenues();
        if (venues_.length > MAX_VENUES) revert TooManyVenues(venues_.length, MAX_VENUES);

        for (uint256 i = 0; i < venues_.length; ++i) {
            address venue = venues_[i];
            if (venue == address(0)) revert ZeroVenue();

            // A duplicate would make `maxPerVenueWei` ambiguous and would let one venue appear twice
            // in anything that iterates the list.
            for (uint256 j = 0; j < i; ++j) {
                if (venues_[j] == venue) revert DuplicateVenue(venue);
            }

            _venues.push(venue);
        }

        if (maxDeployedWei_ == 0) revert ZeroMaxDeployed();
        if (maxPerVenueWei_ == 0 || maxPerVenueWei_ > maxDeployedWei_) {
            revert PerVenueExceedsTotal(maxPerVenueWei_, maxDeployedWei_);
        }
        if (periodDeployLimitWei_ == 0) revert ZeroPeriodLimit();

        if (periodLength_ < MIN_PERIOD_LENGTH || periodLength_ > MAX_PERIOD_LENGTH) {
            revert PeriodLengthOutOfRange(periodLength_, MIN_PERIOD_LENGTH, MAX_PERIOD_LENGTH);
        }

        // An interval longer than the period would make the period limit unreachable, which is a
        // mandate that reads as permissive and behaves as broken.
        if (minActionInterval_ > periodLength_) revert IntervalTooLong(minActionInterval_, periodLength_);

        if (duration_ == 0 || duration_ > MAX_DURATION) revert DurationOutOfRange(duration_, MAX_DURATION);

        owner = owner_;
        operator = operator_;
        guardian = guardian_;
        maxDeployedWei = maxDeployedWei_;
        maxPerVenueWei = maxPerVenueWei_;
        periodDeployLimitWei = periodDeployLimitWei_;
        periodLength = periodLength_;
        minActionInterval = minActionInterval_;
        expiry = uint64(block.timestamp) + duration_;
    }

    /// @notice End the operator's authority, permanently.
    ///
    /// @dev The owner's, and nobody else's. A guardian who could revoke could strand an account it
    /// does not own, and the guardian already has the stop that is proportionate to its role — a
    /// pause on the vault, which the owner can lift.
    ///
    /// This does not move money and does not need to: the withdrawal path never reads this contract.
    function revoke() external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        if (revoked) revert AlreadyRevoked();

        revoked = true;
        emit Revoked(msg.sender);
    }

    /// @notice Whether the operator may act at `timestamp`, on the mandate's own terms.
    ///
    /// @dev Says nothing about the vault's pause or its balances. Composed rather than merged so that
    /// each contract answers for the rules it owns, and a reader asking "what ended the mandate" is
    /// not sent to two files.
    function isLive(uint64 timestamp) external view returns (bool) {
        return !revoked && timestamp < expiry;
    }

    function isVenue(address venue) external view returns (bool) {
        uint256 count = _venues.length;
        for (uint256 i = 0; i < count; ++i) {
            if (_venues[i] == venue) return true;
        }
        return false;
    }

    function venues() external view returns (address[] memory) {
        return _venues;
    }

    function venueCount() external view returns (uint256) {
        return _venues.length;
    }
}
