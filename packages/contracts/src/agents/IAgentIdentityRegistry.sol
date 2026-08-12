// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentLifecycle} from "./AgentLifecycle.sol";

/// @title IAgentIdentityRegistry
/// @notice The list of agents, what each one is made of, and where it is in its life.
///
/// @dev The one place an agent's components are recorded together, so a reader
/// with an `agentId` can reach everything else without a subgraph. It is also the
/// only contract in the agent layer that reads the market layer, and it reads it
/// `view` only — ADR-010.
///
/// The lifecycle it enforces is [`AgentLifecycle`](AgentLifecycle.sol), which is
/// the single definition the SDK, the indexer and the interface mirror.
interface IAgentIdentityRegistry {
    /// @notice What the developer says their market will be, before it exists.
    ///
    /// @dev Supplied at creation and hashed into a commitment. `bindMarket` later
    /// rebuilds the same hash from the market that actually exists and refuses
    /// anything that does not match, which is what makes binding a proof rather
    /// than a claim.
    ///
    /// The token address is knowable in advance: `VerdantDeployer` creates it with
    /// `CREATE2` under a salt derived from the creator, so the SDK mines the salt
    /// and predicts the address before the launch is sent (ADR-008).
    struct MarketExpectation {
        /// @dev The launch token, predicted from the mined salt.
        address token;
        /// @dev The pool's `currency0`: ether, or the equity the market is quoted in.
        address quoteAsset;
        /// @dev Index into `ModelRegistry`'s models.
        uint8 model;
        /// @dev Total supply, in the token's own units.
        uint256 expectedSupply;
        /// @dev The developer's own discriminant, so one developer can hold two
        /// otherwise-identical expectations without them colliding.
        uint64 launchNonce;
    }

    /// @notice What the factory supplies when it registers an agent.
    ///
    /// @dev A separate struct from `Agent` so the factory cannot pass a field the
    /// registry is going to overwrite. `createdAt`, `state`, `poolId` and `token`
    /// are the registry's to set, and a caller who could name them would be able to
    /// register an agent that claimed a market it had not proved.
    struct Registration {
        address developer;
        address guardian;
        address mandate;
        address treasury;
        address router;
        address executionModule;
        address serviceRegistry;
        string metadataURI;
        MarketExpectation expectation;
    }

    /// @notice Everything an agent is made of. Every address here is fixed at creation.
    struct Agent {
        address developer;
        address guardian;
        address mandate;
        address treasury;
        address router;
        address executionModule;
        address serviceRegistry;
        /// @dev Where the agent's public mandate, description and history live. The
        /// developer may change it; nothing on chain reads it. See `IAgentMandate`
        /// for why this is one of the two things about an agent that can move.
        string metadataURI;
        /// @dev What the developer said their market would be. Kept in full rather
        /// than only as a hash, because the interface has to show a reader what an
        /// unbound agent is waiting for, and because `launchNonce` is the one field
        /// of it that no chain read can recover.
        MarketExpectation expectation;
        /// @dev The hash of that expectation. Immutable, and the single comparison
        /// `bindMarket` reduces every field check to.
        bytes32 marketCommitment;
        /// @dev The market bound to this agent, or zero while `Created`.
        bytes32 poolId;
        address token;
        uint64 createdAt;
        uint64 marketBoundAt;
        uint64 activatedAt;
        uint64 stateChangedAt;
        AgentLifecycle.State state;
    }

    event AgentRegistered(
        bytes32 indexed agentId, address indexed developer, address indexed treasury, bytes32 marketCommitment
    );
    event MetadataUpdated(bytes32 indexed agentId, string metadataURI);

    /// @notice A market was proved to belong to this agent.
    ///
    /// @dev Emitted by `bindMarket`, which anyone may call. `splitter` is included
    /// so an indexer can check the proof without repeating the reads.
    event MarketBound(bytes32 indexed agentId, bytes32 indexed poolId, address token, address splitter);

    /// @notice Every lifecycle move, with who made it.
    ///
    /// @dev One event for all five states rather than one per transition, so an
    /// indexer reconstructs the whole history from a single log topic and cannot
    /// miss a state by forgetting to listen for it.
    event AgentStateChanged(
        bytes32 indexed agentId,
        AgentLifecycle.State indexed previousState,
        AgentLifecycle.State indexed newState,
        address actor
    );

    error UnknownAgent(bytes32 agentId);
    error NotGuardian(address caller);
    error NotDeveloper(address caller);
    error NotFactory(address caller);
    error AgentAlreadyBound(bytes32 agentId, bytes32 poolId);

    /// @notice The market's fee recipient is not this agent's router, so the market is not this agent's.
    error MarketNotOwnedByAgent(bytes32 poolId, address feeRecipient, address router);

    /// @notice The market that exists is not the market this agent was created expecting.
    error MarketCommitmentMismatch(bytes32 expected, bytes32 actual);

    /// @notice The market was created by somebody other than this agent's developer.
    error MarketNotCreatedByDeveloper(bytes32 poolId, address creator, address developer);

    /// @notice A market already bound to a different agent.
    error MarketAlreadyBound(bytes32 poolId, bytes32 agentId);

    /// @notice The id an agent would have. Namespaced by developer, so one developer
    /// cannot occupy another's id by choosing their salt.
    function agentIdFor(address developer, bytes32 salt) external view returns (bytes32);

    /// @notice The commitment an expectation produces.
    ///
    /// @dev `view` rather than `pure` because the chain id and this registry's own
    /// address are in the preimage: a commitment made for one chain or one
    /// deployment of this registry cannot be replayed against another.
    function commitmentFor(address developer, address router, MarketExpectation calldata expectation)
        external
        view
        returns (bytes32);

    /// @notice Append an agent. Factory only.
    function register(address developer, bytes32 salt, Registration calldata registration)
        external
        returns (bytes32 agentId, uint256 index);

    function agentOf(bytes32 agentId) external view returns (Agent memory);
    function agentByTreasury(address treasury) external view returns (bytes32);
    function agentByPool(bytes32 poolId) external view returns (bytes32);
    function agentCount() external view returns (uint256);
    function agentAt(uint256 index) external view returns (Agent memory);

    /// @notice The agent's lifecycle state. Reverts for an unknown agent.
    function stateOf(bytes32 agentId) external view returns (AgentLifecycle.State);

    /// @notice Whether the agent is `Active`, which is the only state that executes.
    /// @dev Returns false for an unknown agent rather than reverting: a caller
    /// asking "may this proceed?" wants an answer, and an unknown agent's is no.
    function isActive(bytes32 agentId) external view returns (bool);

    /// @notice Whether the agent may have its services configured right now.
    function mayConfigureServices(bytes32 agentId) external view returns (bool);

    /// @notice Prove a market belongs to an agent, and bind it. `Created` to `MarketBound`.
    ///
    /// @dev Permissionless, because it verifies rather than trusts. It reads the
    /// market from `MarketRegistry`, reads the splitter and the token, rebuilds the
    /// commitment the agent was created with, and accepts only on an exact match. A
    /// false binding is not discouraged, it is impossible, so restricting the caller
    /// would add a failure mode — a developer who never returns — and remove none.
    ///
    /// It does not switch execution on. That is `activate`, and it is the
    /// developer's.
    function bindMarket(bytes32 agentId, bytes32 poolId) external;

    /// @notice Switch execution on. `MarketBound` to `Active`. Developer only.
    function activate(bytes32 agentId) external;

    /// @notice Stop discretionary execution. `Active` to `Paused`. Guardian only.
    function pause(bytes32 agentId) external;

    /// @notice Allow discretionary execution again. `Paused` to `Active`. Guardian only.
    function resume(bytes32 agentId) external;

    /// @notice Stop execution permanently, from any state. Guardian only.
    ///
    /// @dev Terminal. There is no inverse for anybody, which is what stops "we
    /// paused it and quietly turned it back on" from being available. It seizes
    /// nothing: the treasury keeps its balance, revenue keeps arriving, and fixed
    /// entitlements stay claimable (ADR-012).
    function revoke(bytes32 agentId) external;

    /// @notice Point at a new metadata document. Developer only.
    function setMetadataURI(bytes32 agentId, string calldata metadataURI) external;
}
