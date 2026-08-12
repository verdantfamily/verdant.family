// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAgentMandate} from "./IAgentMandate.sol";

/// @title AgentMandate
/// @notice What one agent is permitted to do. Written once, at construction, and never again.
///
/// @dev The authority in the execution model. `AgentExecutionModule` asks this
/// contract whether an action is permitted and does what it says; the SDK asks the
/// same questions off chain so an agent can be told no before anybody signs, but
/// the SDK is a mirror and this is the authority (ADR-011).
///
/// ## There is no setter
///
/// Not for the agent, not for the developer who deployed it, not for the guardian.
/// Solidity cannot mark an array `immutable`, so the approved assets and targets
/// live in storage — but nothing in this contract writes them after the
/// constructor, and there is no function that could. The scalars are genuinely
/// `immutable`.
///
/// This is the whole value of the contract. An agent that could widen its own
/// limits has no limits; a developer who could widen them after people bought the
/// token has sold something they can change afterwards. A configuration a buyer
/// dislikes is visible before they buy, and that is the guarantee offered instead
/// of the ability to fix it later.
///
/// ## The one thing the guardian can do
///
/// Revoke, permanently. Not edit, not widen, not redirect. The identity registry
/// can revoke an agent too and the execution module checks both — two stops on two
/// contracts, because a kill switch that lives only somewhere else is a kill switch
/// that depends on somewhere else being read correctly (ADR-012).
contract AgentMandate is IAgentMandate {
    /// @notice The most assets one agent may be approved for.
    ///
    /// @dev Bounded because `approvedAssets()` and the constructor's duplicate
    /// check are both linear, and an unbounded list is a launch that costs
    /// unbounded gas and a page that cannot render. Eight is more than any
    /// plausible agent needs on a chain whose reviewed set is ether plus equities.
    uint256 public constant MAX_APPROVED_ASSETS = 8;

    /// @notice The most targets one agent may pay.
    uint256 public constant MAX_APPROVED_TARGETS = 32;

    /// @notice A period must be at least this long.
    ///
    /// @dev Below an hour the limit stops being a spending cap and becomes a rate
    /// limit with a rounding artefact at every boundary.
    uint64 public constant MIN_PERIOD_LENGTH = 1 hours;

    /// @notice A period may be at most this long.
    ///
    /// @dev A limit that resets yearly is not a limit anybody can reason about, and
    /// it makes the worst case of a compromised operator a whole year's budget in
    /// one afternoon.
    uint64 public constant MAX_PERIOD_LENGTH = 30 days;

    /// @notice The longest gap a mandate may require between two actions.
    ///
    /// @dev An interval longer than this is indistinguishable from an agent that
    /// does not work, and it is more honestly expressed as an expiry.
    uint64 public constant MAX_ACTION_INTERVAL = 7 days;

    bytes32 public immutable agentId;
    address public immutable guardian;
    uint64 public immutable minActionInterval;
    uint64 public immutable periodLength;
    uint64 public immutable expiry;

    bool public revoked;

    address[] private _assets;
    address[] private _targets;

    mapping(address asset => AssetLimit) private _limits;
    mapping(address asset => bool) private _assetApproved;
    mapping(address target => bool) private _targetApproved;

    error TooManyAssets(uint256 count);
    error TooManyTargets(uint256 count);
    error DuplicateTarget(address target);
    error ZeroTarget();
    error PeriodTooShort(uint64 periodLength);
    error AssetNotApproved(address asset);

    /// @param limits One entry per approved asset. At least one is required: an
    /// agent approved for nothing can never act, and a contract that permits
    /// nothing should not be deployed as though it permits something.
    /// @param targets Addresses a service payment may resolve to. May be empty,
    /// which means the agent buys nothing and only pays its own legs.
    /// @param expiry_ Unix seconds after which nothing executes. Zero means never.
    constructor(
        bytes32 agentId_,
        address guardian_,
        AssetLimit[] memory limits,
        address[] memory targets,
        uint64 minActionInterval_,
        uint64 periodLength_,
        uint64 expiry_
    ) {
        if (agentId_ == bytes32(0)) revert ZeroAgentId();
        if (guardian_ == address(0)) revert ZeroGuardian();

        if (limits.length == 0) revert NoApprovedAssets();
        if (limits.length > MAX_APPROVED_ASSETS) revert TooManyAssets(limits.length);
        if (targets.length > MAX_APPROVED_TARGETS) revert TooManyTargets(targets.length);

        if (periodLength_ < MIN_PERIOD_LENGTH) revert PeriodTooShort(periodLength_);
        if (periodLength_ > MAX_PERIOD_LENGTH) revert PeriodTooLong(periodLength_);
        if (minActionInterval_ > MAX_ACTION_INTERVAL) revert IntervalTooLong(minActionInterval_);

        _requireExpiryInTheFuture(expiry_, uint64(block.timestamp));

        for (uint256 i = 0; i < limits.length; i++) {
            AssetLimit memory limit = limits[i];

            // The zero address is ether here, and is legitimate. What is not
            // legitimate is a zero limit, which reads as "approved" and behaves as
            // "cannot move any of it".
            if (limit.maxActionValue == 0 || limit.periodLimit == 0) revert ZeroLimit(limit.asset);

            // A per-action cap above the period's cap is not a cap. It would let
            // one action pass the first check and fail the second, which is a
            // configuration nobody meant to write.
            if (limit.maxActionValue > limit.periodLimit) {
                revert MaxActionValueAbovePeriodLimit(limit.asset, limit.maxActionValue, limit.periodLimit);
            }

            if (_assetApproved[limit.asset]) revert DuplicateAsset(limit.asset);

            _assetApproved[limit.asset] = true;
            _limits[limit.asset] = limit;
            _assets.push(limit.asset);
        }

        for (uint256 i = 0; i < targets.length; i++) {
            address target = targets[i];
            if (target == address(0)) revert ZeroTarget();
            if (_targetApproved[target]) revert DuplicateTarget(target);

            _targetApproved[target] = true;
            _targets.push(target);
        }

        agentId = agentId_;
        guardian = guardian_;
        minActionInterval = minActionInterval_;
        periodLength = periodLength_;
        expiry = expiry_;
    }

    /// @dev An expiry already in the past would deploy a mandate that has never
    /// permitted anything and never will — a launch that looks successful and
    /// produces an agent that cannot move.
    ///
    /// Split out and `pure`, taking the clock as an argument rather than reading
    /// it, so the rule is testable at its boundary without warping a chain. The
    /// same treatment `TokenVesting` and `ScheduleLib` give time.
    function _requireExpiryInTheFuture(uint64 expiry_, uint64 nowSeconds) private pure {
        if (expiry_ != 0 && expiry_ <= nowSeconds) revert ExpiryInThePast(expiry_, nowSeconds);
    }

    // --- reading ------------------------------------------------------------

    function approvedAssets() external view returns (address[] memory) {
        return _assets;
    }

    function approvedTargets() external view returns (address[] memory) {
        return _targets;
    }

    function isApprovedAsset(address asset) external view returns (bool) {
        return _assetApproved[asset];
    }

    function isApprovedTarget(address target) external view returns (bool) {
        return _targetApproved[target];
    }

    /// @inheritdoc IAgentMandate
    function limitFor(address asset) external view returns (AssetLimit memory) {
        if (!_assetApproved[asset]) revert AssetNotApproved(asset);
        return _limits[asset];
    }

    /// @inheritdoc IAgentMandate
    ///
    /// @dev Takes an explicit timestamp rather than reading the clock, so the
    /// interface can draw a countdown to expiry from one call per point and so the
    /// boundary is testable without warping.
    function isLive(uint64 timestamp) public view returns (bool) {
        if (revoked) return false;
        if (expiry == 0) return true;
        return timestamp < expiry;
    }

    // --- the guardian -------------------------------------------------------

    /// @inheritdoc IAgentMandate
    function revoke() external {
        if (msg.sender != guardian) revert NotGuardian(msg.sender);
        if (revoked) revert AlreadyRevoked();

        revoked = true;
        emit MandateRevoked(msg.sender);
    }
}
