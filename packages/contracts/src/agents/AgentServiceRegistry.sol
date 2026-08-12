// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAgentIdentityRegistry} from "./IAgentIdentityRegistry.sol";
import {IAgentServiceRegistry} from "./IAgentServiceRegistry.sol";

/// @title AgentServiceRegistry
/// @notice What every agent sells: an endpoint, a versioned price, and a commitment to the request format.
///
/// @dev One registry for the deployment rather than one per agent, because the
/// point of it is cross-agent: a paying agent resolves a *provider's* service, and
/// a registry per agent would mean knowing which registry to ask before being able
/// to ask. Agents record the address anyway so that a reader holding an agent id
/// needs one lookup rather than two.
///
/// ## Why every change bumps a version
///
/// Because a quote is approved by a human, and the gap between approving and
/// landing is where a silent reprice would do its damage. A quote carries the
/// version it was priced against; a repriced service has a higher version, and the
/// payment is refused rather than executed at the new number.
///
/// That makes repricing safe for the provider too. Without versioning the only way
/// to avoid honouring a stale price is to refuse payments during a change, and the
/// only way to do *that* is a pause nobody built.
///
/// The developer makes these changes. Not the agent: a runtime that could rewrite
/// its own price list could sell nothing for everything, and the operator key is
/// assumed hostile.
contract AgentServiceRegistry is IAgentServiceRegistry {
    /// @notice The agent record, for ownership, lifecycle and resolving where payment goes.
    IAgentIdentityRegistry public immutable identityRegistry;

    mapping(bytes32 serviceId => Service) private _services;
    mapping(bytes32 agentId => bytes32[]) private _byAgent;

    error ZeroIdentityRegistry();

    constructor(address identityRegistry_) {
        if (identityRegistry_ == address(0)) revert ZeroIdentityRegistry();
        identityRegistry = IAgentIdentityRegistry(identityRegistry_);
    }

    // --- writing ------------------------------------------------------------

    /// @inheritdoc IAgentServiceRegistry
    function serviceIdFor(bytes32 agentId, bytes32 name) public pure returns (bytes32) {
        return keccak256(abi.encode(agentId, name));
    }

    /// @inheritdoc IAgentServiceRegistry
    function register(
        bytes32 agentId,
        bytes32 name,
        string calldata endpoint,
        bytes32 schemaHash,
        address paymentAsset,
        uint256 price
    ) external returns (bytes32 serviceId, uint32 version) {
        _onlyDeveloperOfConfigurableAgent(agentId);

        if (name == bytes32(0)) revert ZeroName();
        if (bytes(endpoint).length == 0) revert ZeroEndpoint();

        // A free service is not expressible here, and that is on purpose: a price of
        // zero makes a payment of nothing, which the treasury refuses anyway. An
        // agent giving something away does not need to register it as a paid service
        // to do so.
        if (price == 0) revert ZeroPrice();

        serviceId = serviceIdFor(agentId, name);
        if (_services[serviceId].agentId != bytes32(0)) revert ServiceExists(serviceId);

        // Versions start at 1. Zero is what an unset field reads as, and a quote
        // carrying version 0 should never match a real service.
        version = 1;

        _services[serviceId] = Service({
            agentId: agentId,
            version: version,
            endpoint: endpoint,
            schemaHash: schemaHash,
            paymentAsset: paymentAsset,
            price: price,
            paymentAdapter: address(0),
            active: true,
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            deprecatedAt: 0
        });

        _byAgent[agentId].push(serviceId);

        emit ServiceRegistered(agentId, serviceId, paymentAsset, price, version);
    }

    /// @inheritdoc IAgentServiceRegistry
    function update(bytes32 serviceId, string calldata endpoint, bytes32 schemaHash, uint256 price, bool active)
        external
        returns (uint32 version)
    {
        Service storage service = _load(serviceId);
        _onlyDeveloperOfConfigurableAgent(service.agentId);

        if (bytes(endpoint).length == 0) revert ZeroEndpoint();
        if (price == 0) revert ZeroPrice();

        // Unconditional, even when nothing material changed. A version that only
        // moves when the registry judges the change "significant" is a version that
        // has to be trusted; one that moves on every write can be compared.
        version = service.version + 1;

        service.version = version;
        service.endpoint = endpoint;
        service.schemaHash = schemaHash;
        service.price = price;
        service.active = active;
        service.updatedAt = uint64(block.timestamp);

        emit ServiceUpdated(service.agentId, serviceId, price, active, version);
    }

    /// @inheritdoc IAgentServiceRegistry
    ///
    /// @dev Retiring deactivates; it does not delete. The record of what was on
    /// offer, and at what price, is what somebody who paid for it needs later. It
    /// bumps the version too, so a quote priced before the retirement is refused for
    /// the version as well as for the inactive flag.
    function retire(bytes32 serviceId) external returns (uint32 version) {
        Service storage service = _load(serviceId);
        _onlyDeveloperOfConfigurableAgent(service.agentId);

        version = service.version + 1;

        service.version = version;
        service.active = false;
        service.updatedAt = uint64(block.timestamp);
        service.deprecatedAt = uint64(block.timestamp);

        emit ServiceRetired(service.agentId, serviceId, version);
    }

    // --- reading ------------------------------------------------------------

    function serviceOf(bytes32 serviceId) external view returns (Service memory) {
        return _load(serviceId);
    }

    function servicesOf(bytes32 agentId) external view returns (bytes32[] memory) {
        return _byAgent[agentId];
    }

    /// @inheritdoc IAgentServiceRegistry
    ///
    /// @dev Also false for a service whose agent is not `Active`. A stopped agent
    /// should not be sold to, and the check belongs here rather than only in the
    /// paying agent's module — otherwise every consumer has to remember to make it.
    function isActive(bytes32 serviceId) external view returns (bool) {
        Service memory service = _services[serviceId];
        if (service.agentId == bytes32(0) || !service.active) return false;
        return identityRegistry.isActive(service.agentId);
    }

    /// @inheritdoc IAgentServiceRegistry
    function payeeOf(bytes32 serviceId) external view returns (address) {
        return identityRegistry.agentOf(_load(serviceId).agentId).router;
    }

    // --- internals ----------------------------------------------------------

    function _load(bytes32 serviceId) private view returns (Service storage service) {
        service = _services[serviceId];
        if (service.agentId == bytes32(0)) revert UnknownService(serviceId);
    }

    /// @dev The developer, and only while the lifecycle permits configuration —
    /// `MarketBound` or `Active`. A `Created` agent has no market to sell against, a
    /// paused one cannot be bought from, and a revoked one is finished.
    function _onlyDeveloperOfConfigurableAgent(bytes32 agentId) private view {
        IAgentIdentityRegistry.Agent memory agent = identityRegistry.agentOf(agentId);
        if (msg.sender != agent.developer) revert NotDeveloper(msg.sender);
        if (!identityRegistry.mayConfigureServices(agentId)) revert AgentCannotConfigureServices(agentId);
    }
}
