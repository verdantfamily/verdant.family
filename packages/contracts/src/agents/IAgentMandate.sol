// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IAgentMandate
/// @notice What an agent is permitted to do. Fixed at launch, readable by anyone, changeable by nobody.
///
/// @dev The authority in the execution model. An agent proposes a typed action;
/// this decides whether it happens. The SDK mirrors every check in this interface
/// so the interface can refuse an action before anyone is asked to sign, but the
/// SDK is a mirror and this is the authority — ADR-011.
///
/// ## What is immutable and what is not
///
/// The line is drawn once and it is not subtle: **anything that decides where
/// money can go is immutable; anything that describes what the agent offers is
/// not.**
///
/// | Fixed at creation, forever | Changeable, and by whom |
/// |---|---|
/// | Approved assets and their limits | Service endpoint, price, schema — the developer |
/// | Approved targets | Metadata URI — the developer |
/// | Per-action and per-period limits | Status: paused or revoked — the guardian only |
/// | Minimum interval between actions | |
/// | Expiry | |
/// | Revenue shares and their destinations | |
/// | Developer, guardian, protocol treasury | |
///
/// So an agent cannot widen its own permissions, its developer cannot widen them
/// after people have bought the token, and the guardian cannot widen them at all —
/// the guardian's whole power is to stop the agent, never to redirect it
/// (ADR-012). A configuration a buyer dislikes is visible before they buy, which
/// is the guarantee this design offers instead of the ability to fix it later.
///
/// ## Why limits are per asset
///
/// A single "daily limit" cannot mean anything across assets with different
/// decimals and different prices: 10^18 is a routine amount of one and a fortune
/// in another. There is no oracle in this layer and there deliberately is not one,
/// because an oracle would make every spending decision depend on a price feed
/// that can be moved. So the developer sets a limit per approved asset in that
/// asset's own units, and the contract does no conversion.
interface IAgentMandate {
    /// @notice One approved asset and the two limits that apply to it.
    struct AssetLimit {
        address asset;
        /// @notice The most one action may move.
        uint256 maxActionValue;
        /// @notice The most that may move within one period.
        uint256 periodLimit;
    }

    /// @notice The mandate was revoked and will never permit another action.
    event MandateRevoked(address indexed guardian);

    error ZeroAgentId();
    error ZeroGuardian();
    error NotGuardian(address caller);
    error AlreadyRevoked();
    error NoApprovedAssets();
    error DuplicateAsset(address asset);
    error ZeroAsset();
    error ZeroLimit(address asset);
    error MaxActionValueAbovePeriodLimit(address asset, uint256 maxActionValue, uint256 periodLimit);
    error ZeroPeriodLength();
    error PeriodTooLong(uint64 periodLength);
    error IntervalTooLong(uint64 minActionInterval);
    error ExpiryInThePast(uint64 expiry, uint64 nowSeconds);

    function agentId() external view returns (bytes32);

    /// @notice Seconds that must pass between two actions.
    function minActionInterval() external view returns (uint64);

    /// @notice Length of a spending period in seconds.
    function periodLength() external view returns (uint64);

    /// @notice Unix seconds after which nothing executes. Zero means no expiry.
    function expiry() external view returns (uint64);

    function approvedAssets() external view returns (address[] memory);
    function approvedTargets() external view returns (address[] memory);

    function isApprovedAsset(address asset) external view returns (bool);
    function isApprovedTarget(address target) external view returns (bool);

    /// @notice The limits for an approved asset.
    /// @dev Reverts for an asset the mandate does not approve, rather than
    /// returning zeros, so a caller cannot read "no limit" out of "not permitted".
    function limitFor(address asset) external view returns (AssetLimit memory);

    /// @notice Whether the mandate is still in force at `timestamp`.
    function isLive(uint64 timestamp) external view returns (bool);

    function guardian() external view returns (address);
    function revoked() external view returns (bool);

    /// @notice Stop this mandate permitting anything, forever. Guardian only.
    ///
    /// @dev Deliberately duplicated: the identity registry can also revoke an
    /// agent, and the execution module checks both. Two independent stops on two
    /// contracts, because the mandate is the authority an action is checked
    /// against, and a kill switch that lives only on a different contract is a kill
    /// switch that depends on that contract being read correctly.
    ///
    /// One way. There is no un-revoke here either.
    function revoke() external;
}
