// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentActionLib} from "./AgentActionLib.sol";
import {AgentTreasury} from "./AgentTreasury.sol";
import {IAgentExecutionModule} from "./IAgentExecutionModule.sol";
import {IAgentIdentityRegistry} from "./IAgentIdentityRegistry.sol";
import {IAgentMandate} from "./IAgentMandate.sol";
import {IAgentServiceRegistry} from "./IAgentServiceRegistry.sol";

/// @title AgentExecutionModule
/// @notice The only path from a proposed action to money moving.
///
/// @dev One entry point, taking a struct. No fallback, no `receive`, no
/// `delegatecall`, and no function here takes `bytes`. Somebody establishing what
/// an agent can do reads this file and is finished (ADR-011).
///
/// ## It deploys its own treasury
///
/// The treasury must know its module and the module must know its treasury. Rather
/// than break that circle with a setter — which would be a privileged write on the
/// contract that holds the money, for the length of time between two transactions —
/// the module deploys the treasury in its constructor and passes `address(this)`.
/// The relationship is fixed by construction and there is no window in which it is
/// something else.
///
/// ## What a payment cannot do
///
/// It cannot name a recipient: the destination is whatever the provider's service
/// resolves to in the registry, and the quote's copy of it is compared rather than
/// used. It cannot name an amount: the amount must equal the listed price exactly.
/// It cannot name an asset: the asset must be the one the service is priced in. It
/// cannot use a stale price: the version must be the one currently listed.
///
/// So the worst a compromised runtime can do through this path is buy an approved
/// service, at its current listed price, from an approved provider, no more often
/// than the mandate's interval allows, until the period limit is spent. That is a
/// much smaller set than "transfer an approved asset to an approved address", which
/// is what a target allowlist alone would have permitted.
contract AgentExecutionModule is IAgentExecutionModule {
    using AgentActionLib for AgentActionLib.ServiceQuote;

    bytes32 public immutable agentId;

    /// @notice The only address that may submit an action.
    ///
    /// @dev Assumed hostile. Everything it can do is bounded by the mandate, which
    /// it cannot change, and by the guardian's stop, which it cannot reach.
    address public immutable operator;

    IAgentMandate public immutable mandateContract;
    AgentTreasury public immutable treasuryContract;
    IAgentServiceRegistry public immutable services;
    IAgentIdentityRegistry public immutable identity;

    uint256 public nextNonce;
    uint64 public lastActionAt;

    mapping(bytes32 requestId => bool) private _settledRequests;

    error ZeroAgentId();
    error ZeroOperator();
    error ZeroMandate();
    error ZeroServiceRegistry();
    error ZeroIdentityRegistry();
    error ZeroGuardian();

    constructor(
        bytes32 agentId_,
        address operator_,
        address mandate_,
        address guardian_,
        address serviceRegistry_,
        address identityRegistry_
    ) {
        if (agentId_ == bytes32(0)) revert ZeroAgentId();
        if (operator_ == address(0)) revert ZeroOperator();
        if (mandate_ == address(0)) revert ZeroMandate();
        if (guardian_ == address(0)) revert ZeroGuardian();
        if (serviceRegistry_ == address(0)) revert ZeroServiceRegistry();
        if (identityRegistry_ == address(0)) revert ZeroIdentityRegistry();

        agentId = agentId_;
        operator = operator_;
        mandateContract = IAgentMandate(mandate_);
        services = IAgentServiceRegistry(serviceRegistry_);
        identity = IAgentIdentityRegistry(identityRegistry_);

        treasuryContract = new AgentTreasury(agentId_, address(this), mandate_, guardian_);
    }

    // --- the one action -----------------------------------------------------

    /// @inheritdoc IAgentExecutionModule
    function payService(AgentActionLib.ServiceQuote calldata quote) external returns (bytes32 actionHash) {
        uint64 nowSeconds = _authorise(quote.agentId, quote.nonce, quote.deadline);

        IAgentServiceRegistry.Service memory service = services.serviceOf(quote.serviceId);

        // The service must belong to the provider the quote names. Without this a
        // quote could name a cheap provider and pay an expensive stranger's service,
        // and the event would record the wrong counterparty.
        if (service.agentId != quote.providerAgentId) {
            revert ServiceNotOwnedBy(quote.serviceId, quote.providerAgentId);
        }
        if (!services.isActive(quote.serviceId)) revert ServiceInactive(quote.serviceId);

        // The version is checked before the price, because a stale version is the
        // *reason* a price would differ, and reporting the cause is more useful than
        // reporting the symptom.
        if (service.version != quote.serviceVersion) {
            revert ServiceVersionStale(quote.serviceId, service.version, quote.serviceVersion);
        }

        if (service.paymentAsset != quote.asset) {
            revert ServiceAssetMismatch(quote.serviceId, service.paymentAsset, quote.asset);
        }

        // Exactly the listed price, not at most. Overpaying an approved provider is
        // the cheapest way to move value out of a mandated treasury, and "at most"
        // would permit it right up to the per-action limit.
        if (service.price != quote.exactAmount) {
            revert ServicePriceMismatch(quote.serviceId, service.price, quote.exactAmount);
        }

        // The registry is the source of truth for the destination. The quote carries
        // a copy so a human approved the same address the chain will pay, and the
        // copy is compared rather than used.
        address to = services.payeeOf(quote.serviceId);
        if (to != quote.provider) revert ProviderMismatch(quote.serviceId, to, quote.provider);
        if (!mandateContract.isApprovedTarget(to)) revert TargetNotApproved(to);

        if (_settledRequests[quote.requestId]) revert RequestAlreadySettled(quote.requestId);

        _requireInterval(nowSeconds);

        actionHash = quote.hash();

        _settledRequests[quote.requestId] = true;
        _commit(nowSeconds);

        emit ServicePaid(
            agentId,
            quote.serviceId,
            actionHash,
            quote.providerAgentId,
            quote.serviceVersion,
            quote.asset,
            to,
            quote.exactAmount,
            quote.requestId,
            quote.nonce
        );

        treasuryContract.spend(quote.asset, to, quote.exactAmount, actionHash);
    }

    // --- checks -------------------------------------------------------------

    /// @dev Everything every action is checked for, in the order the SDK reports it.
    /// The order is part of the contract with the interface: a simulation whose first
    /// refusal is not the error the transaction would carry sends somebody to fix the
    /// wrong thing.
    ///
    /// Both stops are read. The identity registry holds the agent's lifecycle state
    /// and the mandate holds its own revocation flag, and either alone would be a
    /// kill switch that depends on one contract being read correctly (ADR-012).
    function _authorise(bytes32 quoteAgentId, uint256 nonce, uint256 deadline) private view returns (uint64) {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        if (quoteAgentId != agentId) revert WrongAgent(agentId, quoteAgentId);

        // `Active` and nothing else. `Created` and `MarketBound` have not started,
        // `Paused` is stopped, `Revoked` is finished.
        if (!identity.isActive(agentId)) revert AgentNotActive(agentId);
        if (mandateContract.revoked()) revert MandateIsRevoked();

        uint64 nowSeconds = uint64(block.timestamp);

        if (!mandateContract.isLive(nowSeconds)) revert MandateExpired(mandateContract.expiry(), nowSeconds);
        if (deadline < nowSeconds) revert QuoteExpired(deadline, nowSeconds);
        if (nonce != nextNonce) revert NonceOutOfOrder(nextNonce, nonce);

        return nowSeconds;
    }

    /// @dev The first action of an agent's life is never too soon. A `lastActionAt`
    /// of zero means "never acted", not "acted at the epoch", and treating the two
    /// alike would make a mandate with a long interval unusable exactly once.
    function _requireInterval(uint64 nowSeconds) private view {
        if (lastActionAt == 0) return;

        uint64 earliest = lastActionAt + mandateContract.minActionInterval();
        if (nowSeconds < earliest) revert ActionTooSoon(earliest, nowSeconds);
    }

    /// @dev Written before the treasury is called. The treasury pays an address the
    /// mandate approved, and approved is not trusted: a recipient that reenters must
    /// find the nonce already consumed.
    function _commit(uint64 nowSeconds) private {
        nextNonce += 1;
        lastActionAt = nowSeconds;
    }

    // --- reading ------------------------------------------------------------

    function isRequestSettled(bytes32 requestId) external view returns (bool) {
        return _settledRequests[requestId];
    }

    function mandate() external view returns (address) {
        return address(mandateContract);
    }

    function treasury() external view returns (address) {
        return address(treasuryContract);
    }

    function serviceRegistry() external view returns (address) {
        return address(services);
    }

    function identityRegistry() external view returns (address) {
        return address(identity);
    }
}
