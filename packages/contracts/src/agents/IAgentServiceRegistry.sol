// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IAgentServiceRegistry
/// @notice What an agent sells: an endpoint, a price, a version, and the shape of the request.
///
/// @dev The only mutable part of an agent, and deliberately so. A price or an
/// endpoint changing does not let an agent spend more, reach a new address, or
/// alter anybody's revenue share — those live in the mandate and the router and
/// are immutable (`IAgentMandate`). What an agent *offers* has to be able to
/// change, because an endpoint that cannot be moved is an agent that dies with its
/// first hosting provider.
///
/// ## Versioning is what makes that mutability safe
///
/// A price that can change silently invalidates every quote in flight. A buyer who
/// was shown 0.1 ether, approved it, and had the transaction land after a repricing
/// would pay whatever the new number was — which is the whole reason a paying
/// agent's mandate approves a *provider* rather than an amount.
///
/// So every change bumps `version`, and a payment carries the version it was
/// quoted against. Repricing does not invalidate the buyer's approval silently; it
/// invalidates it loudly, and the buyer requotes. The registry never mutates a
/// price that a live quote still refers to without that quote becoming refusable.
///
/// ## Room for x402, without a rewrite
///
/// Payment today is a `ServiceQuote` executed by the paying agent's module, which
/// moves value from its treasury to the provider's revenue router. That is a
/// pull-free, on-chain settlement needing no counterparty software.
///
/// x402 — an HTTP 402 challenge answered with a signed payment — is a different
/// settlement path for the same registered service, and it is expected. The seam is
/// `paymentAdapter`: an address, per service, that is zero today and can later point
/// at a contract implementing `IAgentPaymentAdapter`. Adding it changes how a
/// service is paid for. It does not touch identity, the mandate or the treasury,
/// which is the property that made it worth leaving a seam rather than building the
/// thing now.
interface IAgentServiceRegistry {
    struct Service {
        bytes32 agentId;
        /// @notice Increments on every change. A quote carries the version it was
        /// priced against, and execution refuses a stale one.
        uint32 version;
        /// @notice Where the service lives. An https URL in practice; not parsed here.
        string endpoint;
        /// @notice keccak256 of the request schema in force.
        bytes32 schemaHash;
        /// @notice The asset a caller pays in. Zero address means ether. Immutable
        /// after registration — see `update`.
        address paymentAsset;
        /// @notice Price per request, in the payment asset's own units.
        uint256 price;
        /// @notice Zero until a settlement path other than a direct payment exists.
        address paymentAdapter;
        bool active;
        uint64 createdAt;
        uint64 updatedAt;
        /// @notice When it was retired, or zero.
        uint64 deprecatedAt;
    }

    event ServiceRegistered(
        bytes32 indexed agentId, bytes32 indexed serviceId, address paymentAsset, uint256 price, uint32 version
    );
    event ServiceUpdated(
        bytes32 indexed agentId, bytes32 indexed serviceId, uint256 price, bool active, uint32 version
    );
    event ServiceRetired(bytes32 indexed agentId, bytes32 indexed serviceId, uint32 version);

    error NotDeveloper(address caller);
    error UnknownService(bytes32 serviceId);
    error ServiceExists(bytes32 serviceId);
    error ServiceInactive(bytes32 serviceId);
    error ZeroEndpoint();
    error ZeroPrice();
    error ZeroName();
    error AgentCannotConfigureServices(bytes32 agentId);

    /// @notice The service belongs to a different agent than the caller named.
    error ServiceNotOwnedBy(bytes32 serviceId, bytes32 agentId);

    function serviceOf(bytes32 serviceId) external view returns (Service memory);
    function servicesOf(bytes32 agentId) external view returns (bytes32[] memory);
    function isActive(bytes32 serviceId) external view returns (bool);

    /// @notice Where a payment for this service should go.
    ///
    /// @dev The provider's revenue router, so buying a service and funding an agent
    /// are the same act. This is what a quote's `provider` field is checked against;
    /// the paying agent never names a destination itself.
    function payeeOf(bytes32 serviceId) external view returns (address);

    /// @notice The id a service would have.
    ///
    /// @dev Derived from the agent and a name rather than supplied, so one agent
    /// cannot register an id that collides with another's — the same reasoning that
    /// namespaces a market's salt by its creator.
    function serviceIdFor(bytes32 agentId, bytes32 name) external pure returns (bytes32);

    function register(
        bytes32 agentId,
        bytes32 name,
        string calldata endpoint,
        bytes32 schemaHash,
        address paymentAsset,
        uint256 price
    ) external returns (bytes32 serviceId, uint32 version);

    /// @notice Change what is on offer, and bump the version.
    ///
    /// @dev The payment asset is not a parameter and cannot be changed. A caller who
    /// approved an amount of one asset and found the service repriced in another has
    /// been handed a different deal under the same id, and a paying agent's mandate
    /// approves assets individually. Selling in a different asset is a different
    /// service.
    function update(bytes32 serviceId, string calldata endpoint, bytes32 schemaHash, uint256 price, bool active)
        external
        returns (uint32 version);

    function retire(bytes32 serviceId) external returns (uint32 version);
}

/// @title IAgentPaymentAdapter
/// @notice The seam an alternative settlement path plugs into.
///
/// @dev Nothing implements this yet. It exists so that adding x402 later is a new
/// contract and one field, rather than a change to the registry's storage layout.
/// An adapter answers one question — has this request been paid for? — and the
/// service is free to answer a request once it can.
interface IAgentPaymentAdapter {
    /// @notice Whether `requestId` for `serviceId` has been settled by this adapter.
    function isSettled(bytes32 serviceId, bytes32 requestId) external view returns (bool);

    /// @notice The asset and amount this adapter expects for a request.
    function quote(bytes32 serviceId) external view returns (address asset, uint256 amount);
}
