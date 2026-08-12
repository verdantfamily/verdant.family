// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAgentMandate} from "./IAgentMandate.sol";
import {IAgentTreasury} from "./IAgentTreasury.sol";

/// @title AgentTreasury
/// @notice Where one agent's money sits, and the only door out of it.
///
/// @dev Every way value can leave this contract is `spend`, and only the execution
/// module fixed at construction can call it. There is no `delegatecall`, no
/// function taking `bytes`, no owner, no withdrawal and no sweep. A reader
/// establishing "this contract cannot be emptied by its developer" does it by
/// reading the function list, which is short on purpose.
///
/// ## Balances are read, not tracked
///
/// `balanceOf` asks the token, or reads `address(this).balance`. The contract does
/// not keep its own idea of what it holds, so there is no way for the two to
/// disagree and no asset that arrives by plain transfer and becomes unspendable.
/// The period counters are separate, and are counters rather than balances: they
/// answer "how much moved this period", which is what the limits are about.
///
/// ## Which rules live here
///
/// The ones about money: the asset is approved, the amount is inside the mandate's
/// per-action maximum, it is inside what is left of the period, and the balance
/// covers it. Everything else belongs to the execution module, which is the only
/// caller. The rules are split rather than duplicated so that each has one owner.
contract AgentTreasury is IAgentTreasury {
    using SafeERC20 for IERC20;

    /// @notice Ether, in the per-asset mappings.
    ///
    /// @dev The same convention `FeeSplitter` uses for a market's quote asset, and
    /// for the same reason: an ether-denominated agent has no ERC-20 to name, and a
    /// separate code path for ether would be a second implementation of every rule.
    address public constant NATIVE = address(0);

    bytes32 public immutable agentId;

    /// @notice The only address that may call `spend`.
    address public immutable executionModule;

    /// @notice The authority on what may be spent. Immutable, and immutable itself.
    IAgentMandate public immutable mandateContract;

    /// @notice May stop value leaving. May do nothing else here.
    address public immutable guardian;

    bool public paused;

    /// @dev Cumulative, per asset. `recognised - spent` is what the accounting
    /// expects to be holding, and the difference from the real balance is what
    /// `recognise` picks up.
    mapping(address asset => uint256) private _recognised;
    mapping(address asset => uint256) private _spent;

    mapping(address asset => uint256) private _periodSpent;
    mapping(address asset => uint256) private _periodReceived;
    mapping(address asset => uint64) private _periodStartedAt;

    error ZeroAgentId();
    error ZeroExecutionModule();
    error ZeroMandate();
    error ZeroGuardian();

    constructor(bytes32 agentId_, address executionModule_, address mandate_, address guardian_) {
        if (agentId_ == bytes32(0)) revert ZeroAgentId();
        if (executionModule_ == address(0)) revert ZeroExecutionModule();
        if (mandate_ == address(0)) revert ZeroMandate();
        if (guardian_ == address(0)) revert ZeroGuardian();

        agentId = agentId_;
        executionModule = executionModule_;
        mandateContract = IAgentMandate(mandate_);
        guardian = guardian_;
    }

    /// @notice Accept ether.
    ///
    /// @dev Required: the router settles the operations leg by transferring, and a
    /// treasury that could not receive ether would be an agent that could not be
    /// paid on a chain whose gas asset is ether. It records nothing, because
    /// counting is `recognise`'s job and a `receive` that did bookkeeping would put
    /// a revert in the path of somebody paying this agent.
    receive() external payable {}

    // --- spending -----------------------------------------------------------

    /// @inheritdoc IAgentTreasury
    ///
    /// @dev Effects before interactions, without exception. The recipient is an
    /// address the mandate approved, but "approved" is not "trusted" — an approved
    /// provider that reenters must find the counters already written, or the
    /// per-period limit is a limit per call rather than per period.
    function spend(address asset, address to, uint256 amount, bytes32 actionHash) external {
        if (msg.sender != executionModule) revert NotExecutionModule(msg.sender);
        if (paused) revert TreasuryPaused();
        if (to == address(0)) revert ZeroRecipient();
        if (amount == 0) revert ZeroAmount();

        IAgentMandate.AssetLimit memory limit = _limitFor(asset);
        if (amount > limit.maxActionValue) revert ActionValueExceeded(asset, amount, limit.maxActionValue);

        uint64 nowSeconds = uint64(block.timestamp);
        uint256 alreadySpent = _rollPeriod(asset, nowSeconds);

        uint256 wouldSpend = alreadySpent + amount;
        if (wouldSpend > limit.periodLimit) revert PeriodLimitExceeded(asset, wouldSpend, limit.periodLimit);

        uint256 held = balanceOf(asset);
        if (amount > held) revert InsufficientBalance(asset, amount, held);

        _periodSpent[asset] = wouldSpend;
        _spent[asset] += amount;

        emit Spent(asset, to, amount, actionHash);

        if (asset == NATIVE) {
            // A bare call rather than `transfer`: the recipient may be a contract
            // whose receive costs more than 2 300 gas, and a stipend that was a
            // safety measure in 2018 is a liveness bug now. The same reasoning as
            // `FeeSplitter.claim`. The state above is already written.
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed(to, amount);
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    // --- receiving ----------------------------------------------------------

    /// @inheritdoc IAgentTreasury
    function unrecognised(address asset) public view returns (uint256) {
        uint256 expected = _recognised[asset] - _spent[asset];
        uint256 held = balanceOf(asset);

        // Cannot underflow in practice — the only way out is `spend`, which writes
        // `_spent` — but a token that takes a fee on transfer, or one whose balance
        // rebases downward, would make it. Reporting zero is the honest answer for
        // "nothing new has arrived"; reverting here would make the whole contract
        // unreadable for the sake of a case that is already unsupported.
        return held > expected ? held - expected : 0;
    }

    /// @inheritdoc IAgentTreasury
    function recognise(address asset) external {
        uint256 amount = unrecognised(asset);
        if (amount == 0) revert NothingToRecognise(asset);

        uint64 nowSeconds = uint64(block.timestamp);
        _rollPeriod(asset, nowSeconds);

        _recognised[asset] += amount;
        _periodReceived[asset] += amount;

        emit Received(asset, msg.sender, amount);
    }

    // --- the guardian -------------------------------------------------------

    /// @inheritdoc IAgentTreasury
    ///
    /// @dev Stops value leaving. It does not stop value arriving, does not touch
    /// the balances, and cannot redirect anything: a guardian who could stop money
    /// arriving could starve the developer and the protocol, and one who could
    /// redirect it would be a custodian (ADR-012).
    function pause() external {
        if (msg.sender != guardian) revert NotGuardian(msg.sender);
        if (paused) revert TreasuryPaused();

        paused = true;
        emit PausedSet(true);
    }

    /// @inheritdoc IAgentTreasury
    function unpause() external {
        if (msg.sender != guardian) revert NotGuardian(msg.sender);
        if (!paused) revert NotPaused();

        paused = false;
        emit PausedSet(false);
    }

    // --- reading ------------------------------------------------------------

    /// @inheritdoc IAgentTreasury
    function balanceOf(address asset) public view returns (uint256) {
        return asset == NATIVE ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }

    /// @inheritdoc IAgentTreasury
    ///
    /// @dev Answers from the caller's clock rather than from storage, so a `view`
    /// caller and a transaction in the same block agree about whether the period
    /// has rolled. A version that read only the stored counter would tell an
    /// interface an agent had no room left, right up until the transaction that
    /// rolled the period succeeded.
    function spentInPeriod(address asset, uint64 timestamp) public view returns (uint256) {
        return _hasRolled(asset, timestamp) ? 0 : _periodSpent[asset];
    }

    /// @inheritdoc IAgentTreasury
    function receivedInPeriod(address asset, uint64 timestamp) external view returns (uint256) {
        return _hasRolled(asset, timestamp) ? 0 : _periodReceived[asset];
    }

    /// @inheritdoc IAgentTreasury
    function periodStartedAt(address asset) external view returns (uint64) {
        return _periodStartedAt[asset];
    }

    /// @notice Cumulative value recognised for an asset, over the agent's life.
    function totalRecognised(address asset) external view returns (uint256) {
        return _recognised[asset];
    }

    /// @notice Cumulative value spent of an asset, over the agent's life.
    function totalSpent(address asset) external view returns (uint256) {
        return _spent[asset];
    }

    /// @notice What is left of this asset's period limit at `timestamp`.
    function remainingInPeriod(address asset, uint64 timestamp) external view returns (uint256) {
        IAgentMandate.AssetLimit memory limit = _limitFor(asset);
        uint256 used = spentInPeriod(asset, timestamp);
        return limit.periodLimit > used ? limit.periodLimit - used : 0;
    }

    // --- periods ------------------------------------------------------------

    /// @dev A period that has never started is not rolled — the first spend or
    /// receipt starts it. Otherwise every asset would appear to be mid-period since
    /// the epoch, and the first action of an agent's life would be measured against
    /// a period that began decades ago.
    function _hasRolled(address asset, uint64 timestamp) private view returns (bool) {
        uint64 startedAt = _periodStartedAt[asset];
        if (startedAt == 0) return false;
        return timestamp >= startedAt + mandateContract.periodLength();
    }

    /// @dev Rolls lazily and returns what has been spent in the period now current.
    /// Nothing needs a keeper to turn the period over, and an agent idle for a month
    /// does not wake up with a month of stale spending against it.
    function _rollPeriod(address asset, uint64 nowSeconds) private returns (uint256) {
        uint64 startedAt = _periodStartedAt[asset];

        if (startedAt == 0 || _hasRolled(asset, nowSeconds)) {
            _periodStartedAt[asset] = nowSeconds;
            _periodSpent[asset] = 0;
            _periodReceived[asset] = 0;

            emit PeriodRolled(asset, nowSeconds);
            return 0;
        }

        return _periodSpent[asset];
    }

    function _limitFor(address asset) private view returns (IAgentMandate.AssetLimit memory) {
        if (!mandateContract.isApprovedAsset(asset)) revert AssetNotApproved(asset);
        return mandateContract.limitFor(asset);
    }

    /// @inheritdoc IAgentTreasury
    function mandate() external view returns (address) {
        return address(mandateContract);
    }
}
