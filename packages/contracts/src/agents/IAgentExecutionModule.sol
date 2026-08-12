// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentActionLib} from "./AgentActionLib.sol";

/// @title IAgentExecutionModule
/// @notice The only path from a proposed action to money moving.
///
/// @dev One entry point, taking a struct. No fallback, no `receive`, no
/// `delegatecall`, and no function anywhere in this interface takes `bytes`. The
/// set of things an agent can do is this list, and reading this file is how
/// somebody establishes that (ADR-011).
///
/// ## Who may call
///
/// The operator, an address fixed at launch. In the MVP that is a human or a
/// server holding a key, and the model never touches it: the runtime proposes a
/// quote, the SDK validates and simulates it, and a person decides. The operator
/// key is assumed hostile in the threat model — everything it can do is bounded by
/// the mandate, which it cannot change, and by the guardian's stop, which it cannot
/// reach (ADR-012).
///
/// ## What it cannot reach
///
/// The developer's and the protocol's revenue shares. Those are settled by
/// permissionless calls on `AgentRevenueRouter` and are not actions at all, so an
/// agent cannot withhold them, cannot bring them forward, and cannot spend its
/// daily limit on them.
///
/// ## Replay, staleness and versioning
///
/// Four independent mechanisms, because they answer four different questions:
///
///  - **The nonce** is per agent and strictly increasing. It makes a quote
///    executable once.
///  - **The `requestId`** makes a *request* payable once, even across two nonces.
///    Without it, paying the same invoice twice is two perfectly valid actions.
///  - **The deadline** makes a quote stop being executable at all. An approval that
///    sits unsubmitted for a week is a different decision by the time it lands.
///  - **The service version** makes a quote stop being executable if the thing it
///    priced has changed. Without it, a repricing would silently rewrite an
///    approval a human already gave.
interface IAgentExecutionModule {
    event ServicePaid(
        bytes32 indexed agentId,
        bytes32 indexed serviceId,
        bytes32 indexed actionHash,
        bytes32 providerAgentId,
        uint32 serviceVersion,
        address asset,
        address to,
        uint256 amount,
        bytes32 requestId,
        uint256 nonce
    );

    error NotOperator(address caller);
    error AgentNotActive(bytes32 agentId);
    error MandateIsRevoked();
    error WrongAgent(bytes32 expected, bytes32 given);
    error MandateExpired(uint64 expiry, uint64 nowSeconds);
    error QuoteExpired(uint256 deadline, uint64 nowSeconds);
    error NonceOutOfOrder(uint256 expected, uint256 given);
    error TargetNotApproved(address target);
    error UnknownService(bytes32 serviceId);
    error ServiceInactive(bytes32 serviceId);
    error ServiceNotOwnedBy(bytes32 serviceId, bytes32 providerAgentId);

    /// @notice The service has been changed since this quote was priced.
    error ServiceVersionStale(bytes32 serviceId, uint32 listed, uint32 quoted);

    /// @notice The quote named a payee the registry does not resolve this service to.
    error ProviderMismatch(bytes32 serviceId, address listed, address quoted);

    /// @notice The quote offered a different amount than the service is listed at.
    error ServicePriceMismatch(bytes32 serviceId, uint256 listed, uint256 offered);

    /// @notice The quote offered a different asset than the service is priced in.
    error ServiceAssetMismatch(bytes32 serviceId, address listed, address offered);

    error RequestAlreadySettled(bytes32 requestId);
    error ActionTooSoon(uint64 earliest, uint64 nowSeconds);

    function agentId() external view returns (bytes32);
    function operator() external view returns (address);
    function mandate() external view returns (address);
    function treasury() external view returns (address);
    function serviceRegistry() external view returns (address);
    function identityRegistry() external view returns (address);

    /// @notice The next nonce this module will accept.
    function nextNonce() external view returns (uint256);

    /// @notice When the agent last executed anything. Zero if never.
    function lastActionAt() external view returns (uint64);

    /// @notice Whether a service request has already been paid for.
    function isRequestSettled(bytes32 requestId) external view returns (bool);

    /// @notice Pay another agent for a service, at exactly the price it lists.
    ///
    /// @dev The only action. Everything about where the money goes and how much of
    /// it comes from the registry rather than from the quote; the quote's copies of
    /// those values exist to be checked, so that a human approved the same numbers
    /// the chain will use.
    function payService(AgentActionLib.ServiceQuote calldata quote) external returns (bytes32 actionHash);
}
