// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IAgentTreasury
/// @notice Where an agent's money sits, and the only door out of it.
///
/// @dev One function moves value — `spend` — and only the execution module bound
/// at construction may call it. There is no `delegatecall`, no function taking
/// `bytes`, no owner withdrawal, and no sweep. The guardian can pause this
/// contract and can do nothing else to it: pausing stops money leaving, and there
/// is no guardian-callable path that moves or redirects any (ADR-012).
///
/// ## Which rules live here
///
/// The contract that holds the money owns the money rules. This one checks that
/// the asset is approved, that the amount is inside the mandate's per-action
/// maximum and inside what is left of the period's limit, and that the balance
/// covers it. Everything else — whether the agent is active, whether the nonce and
/// deadline are good, whether the destination was approved, whether the service
/// resolves — belongs to the execution module, which is the only caller.
///
/// The rules are split rather than duplicated. Two contracts enforcing one rule
/// means two places for it to drift, and a test that cannot say which one it is
/// exercising.
///
/// ## Period accounting
///
/// Two running totals per asset: what has left in the current period, which the
/// limits are enforced against, and what has arrived in it, which the agent page
/// shows. Both are per asset for the reason `IAgentMandate` gives — there is no
/// oracle in this layer, so there is no common unit to add them in.
///
/// Periods roll lazily. When an action arrives and the current period has elapsed,
/// the counter resets before the limit is checked. Nothing needs a keeper to turn
/// the day over, and an agent idle for a month does not wake up with a month of
/// stale spending against it.
///
/// Allocation between the four legs is not here. That is the router's job, and
/// the treasury is the destination of exactly one of those legs.
interface IAgentTreasury {
    event Spent(address indexed asset, address indexed to, uint256 amount, bytes32 indexed actionHash);
    event Received(address indexed asset, address indexed from, uint256 amount);
    event PeriodRolled(address indexed asset, uint64 startedAt);
    event PausedSet(bool paused);

    error NotExecutionModule(address caller);
    error NotGuardian(address caller);
    error TreasuryPaused();
    error NotPaused();
    error ZeroRecipient();
    error ZeroAmount();
    error NothingToRecognise(address asset);
    error AssetNotApproved(address asset);
    error ActionValueExceeded(address asset, uint256 amount, uint256 maxActionValue);
    error PeriodLimitExceeded(address asset, uint256 wouldSpend, uint256 periodLimit);
    error InsufficientBalance(address asset, uint256 requested, uint256 held);
    error NativeTransferFailed(address to, uint256 amount);

    function agentId() external view returns (bytes32);
    function executionModule() external view returns (address);
    function mandate() external view returns (address);
    function guardian() external view returns (address);
    function paused() external view returns (bool);

    /// @notice What the treasury holds of an asset. The zero address means ether.
    function balanceOf(address asset) external view returns (uint256);

    /// @notice What has left in the period covering `timestamp`.
    /// @dev Zero once the period has rolled, whether or not anything has written
    /// the reset yet, so a `view` caller and a transaction agree.
    function spentInPeriod(address asset, uint64 timestamp) external view returns (uint256);

    /// @notice What has arrived in the period covering `timestamp`.
    function receivedInPeriod(address asset, uint64 timestamp) external view returns (uint256);

    /// @notice When the current period for an asset began.
    function periodStartedAt(address asset) external view returns (uint64);

    /// @notice Move value out. Execution module only.
    ///
    /// @dev The module is the authority on whether the action was permitted; this
    /// contract's job is to be unreachable by anything else. It still checks the
    /// balance and the recipient, because a treasury that trusts its caller
    /// completely is a treasury with two ways to be emptied instead of one.
    ///
    /// `actionHash` is carried through only to be emitted, so a payment in the
    /// activity feed can be matched to the action that authorised it.
    function spend(address asset, address to, uint256 amount, bytes32 actionHash) external;

    /// @notice Value held that the period counters have not counted yet.
    function unrecognised(address asset) external view returns (uint256);

    /// @notice Count what has arrived into the current period. Permissionless.
    ///
    /// @dev Self-detecting rather than notified: it credits the difference between
    /// the balance and what the accounting expects. Nothing about money arriving is
    /// allowed to depend on a call succeeding — a router settlement that had to
    /// invoke a callback here could be blocked by a bug in this contract, and the
    /// operations leg would stop paying. So the router transfers, and counting is a
    /// separate call anybody can make.
    ///
    /// Value that is never recognised is not lost. It is spendable, because
    /// `balanceOf` reads the real balance, and it is counted the moment somebody
    /// calls this.
    function recognise(address asset) external;

    /// @notice Stop value leaving. Guardian only.
    function pause() external;

    /// @notice Allow value to leave again. Guardian only.
    function unpause() external;
}
