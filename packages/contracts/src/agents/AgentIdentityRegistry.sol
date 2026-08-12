// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {AgentLifecycle} from "./AgentLifecycle.sol";
import {IAgentIdentityRegistry} from "./IAgentIdentityRegistry.sol";
import {IAgentRevenueRouter} from "./IAgentRevenueRouter.sol";
import {MarketRegistry} from "../MarketRegistry.sol";
import {FeeSplitter} from "../FeeSplitter.sol";

/// @title AgentIdentityRegistry
/// @notice The record of every agent, and the only contract in the agent layer that reads a market.
///
/// @dev Append-only for agents, exactly as `MarketRegistry` is for markets: one
/// immutable writer, no update function, no way to remove a record. Two things
/// about an agent move afterwards — its lifecycle state, along the matrix in
/// [`AgentLifecycle`](AgentLifecycle.sol), and its metadata URI.
///
/// ## Why the factory is `msg.sender`
///
/// The registry needs to know its factory and the factory needs to know its
/// registry. The market layer breaks that circle with `FactoryOrigin` because the
/// factory's address had to be known before the hook was mined against it
/// (ADR-007). Nothing here is mined, so the simpler resolution works: the factory
/// deploys this contract in its own constructor, `factory` is `msg.sender`, and
/// the relationship is fixed by construction rather than by a setter somebody
/// could later be persuaded to call.
///
/// ## Binding is a proof, and the commitment is what makes it one
///
/// An agent is created carrying the hash of the market it expects — token, quote
/// asset, model, supply, its own router, the chain, this registry. `bindMarket`
/// reads the market that actually exists, rebuilds that hash from what it finds,
/// and accepts only on an exact match.
///
/// Checking the splitter's fee recipient alone would already make a *hostile*
/// binding impossible, because `FeeSplitter.creator` is an immutable set when the
/// market was created. The commitment closes the rest: a developer who launches a
/// market with the wrong quote asset, the wrong model, or a different supply than
/// they advertised cannot bind it and call it the agent they described. The
/// binding proves the market is the one the agent was sold as, not merely one that
/// pays it.
contract AgentIdentityRegistry is IAgentIdentityRegistry {
    /// @notice The only address that may append. The factory that deployed this.
    address public immutable factory;

    /// @notice The market layer's record, read `view` and never written.
    MarketRegistry public immutable markets;

    mapping(bytes32 agentId => Agent) private _agents;
    mapping(address treasury => bytes32 agentId) private _agentByTreasury;
    mapping(bytes32 poolId => bytes32 agentId) private _agentByPool;

    /// @dev Insertion order, which is creation order.
    bytes32[] private _agentIds;

    error ZeroMarketRegistry();
    error ZeroAddressInRegistration();
    error AgentExists(bytes32 agentId);
    error TreasuryAlreadyRegistered(address treasury);
    error ZeroExpectedToken();
    error ZeroExpectedSupply();

    constructor(address markets_) {
        if (markets_ == address(0)) revert ZeroMarketRegistry();

        factory = msg.sender;
        markets = MarketRegistry(markets_);
    }

    // --- identity -----------------------------------------------------------

    /// @inheritdoc IAgentIdentityRegistry
    ///
    /// @dev The chain id and this contract's own address are in the preimage so an
    /// id cannot be replayed from another chain or another deployment of this
    /// registry, and `developer` is in it so choosing a salt cannot reach into
    /// somebody else's namespace. The same reasoning as `VerdantFactory.saltFor`.
    function agentIdFor(address developer, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), developer, salt));
    }

    /// @inheritdoc IAgentIdentityRegistry
    ///
    /// @dev Every field that decides *which market this is* goes in, and nothing
    /// that does not. The router is included because it is what makes the market
    /// pay this agent; the chain and this registry are included so a commitment is
    /// not portable between deployments.
    function commitmentFor(address developer, address router, MarketExpectation calldata expectation)
        external
        view
        returns (bytes32)
    {
        return _commitment(developer, router, expectation);
    }

    /// @dev The `memory` form, so `bindMarket` can rebuild a commitment from values
    /// it read off the chain. One implementation, two entry points: a second copy of
    /// this preimage is a second thing to keep in step with the SDK.
    function _commitment(address developer, address router, MarketExpectation memory expectation)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                address(markets),
                developer,
                expectation.token,
                expectation.quoteAsset,
                expectation.model,
                router,
                expectation.expectedSupply,
                expectation.launchNonce
            )
        );
    }

    // --- registration -------------------------------------------------------

    /// @inheritdoc IAgentIdentityRegistry
    function register(address developer, bytes32 salt, Registration calldata registration)
        external
        returns (bytes32 agentId, uint256 index)
    {
        if (msg.sender != factory) revert NotFactory(msg.sender);

        // Every component is required. An agent missing one of them would be a
        // record that reads as complete and behaves as though a piece of it were
        // burned into the zero address.
        if (
            registration.developer == address(0) || registration.guardian == address(0)
                || registration.mandate == address(0) || registration.treasury == address(0)
                || registration.router == address(0) || registration.executionModule == address(0)
                || registration.serviceRegistry == address(0)
        ) revert ZeroAddressInRegistration();

        // An expectation that cannot describe a real market would produce a
        // commitment nothing can ever satisfy, and an agent permanently stuck in
        // `Created` reads as a launch that worked.
        if (registration.expectation.token == address(0)) revert ZeroExpectedToken();
        if (registration.expectation.expectedSupply == 0) revert ZeroExpectedSupply();

        agentId = agentIdFor(developer, salt);

        if (_agents[agentId].treasury != address(0)) revert AgentExists(agentId);
        if (_agentByTreasury[registration.treasury] != bytes32(0)) {
            revert TreasuryAlreadyRegistered(registration.treasury);
        }

        bytes32 commitment = _commitment(developer, registration.router, registration.expectation);

        _agents[agentId] = Agent({
            developer: registration.developer,
            guardian: registration.guardian,
            mandate: registration.mandate,
            treasury: registration.treasury,
            router: registration.router,
            executionModule: registration.executionModule,
            serviceRegistry: registration.serviceRegistry,
            metadataURI: registration.metadataURI,
            expectation: registration.expectation,
            marketCommitment: commitment,
            poolId: bytes32(0),
            token: address(0),
            createdAt: uint64(block.timestamp),
            marketBoundAt: 0,
            activatedAt: 0,
            stateChangedAt: uint64(block.timestamp),
            state: AgentLifecycle.State.Created
        });

        _agentByTreasury[registration.treasury] = agentId;
        index = _agentIds.length;
        _agentIds.push(agentId);

        emit AgentRegistered(agentId, registration.developer, registration.treasury, commitment);
        emit AgentStateChanged(
            agentId, AgentLifecycle.State.Created, AgentLifecycle.State.Created, registration.developer
        );
    }

    // --- binding ------------------------------------------------------------

    /// @inheritdoc IAgentIdentityRegistry
    function bindMarket(bytes32 agentId, bytes32 poolId) external {
        Agent storage agent = _load(agentId);
        AgentLifecycle.requireTransition(agent.state, AgentLifecycle.State.MarketBound);

        if (agent.poolId != bytes32(0)) revert AgentAlreadyBound(agentId, agent.poolId);

        bytes32 boundTo = _agentByPool[poolId];
        if (boundTo != bytes32(0)) revert MarketAlreadyBound(poolId, boundTo);

        // Reverts `UnknownMarket` for a pool the factory never created, so a
        // binding can only ever name a real Verdant market.
        MarketRegistry.Market memory market = markets.marketOf(poolId);

        // The launch path puts `msg.sender` in `market.creator`, and the agent
        // layer never wraps that call — so this asserts the developer launched
        // their own agent's market rather than pointing at somebody else's.
        if (market.creator != agent.developer) {
            revert MarketNotCreatedByDeveloper(poolId, market.creator, agent.developer);
        }

        // `creator` on a splitter is the `feeRecipient` supplied at creation, held
        // as an immutable: if it is this agent's router then this market's fees are
        // this agent's revenue, and that was decided before this call and cannot be
        // revised after it.
        address feeRecipient = FeeSplitter(payable(market.splitter)).creator();
        if (feeRecipient != agent.router) revert MarketNotOwnedByAgent(poolId, feeRecipient, agent.router);

        // And the whole of the rest, in one comparison. The token, quote asset,
        // model and supply are read from the chain rather than from the record, so
        // the hash only reproduces if the market that exists is field-for-field the
        // one the agent was created expecting. This is what turns "a market that
        // pays me" into "the market I said I would launch".
        //
        // `launchNonce` comes from the record because it is the developer's own
        // discriminant and appears nowhere on chain. It cannot be used to force a
        // match: every other input is read from the market.
        bytes32 actual = _commitment(
            agent.developer,
            agent.router,
            MarketExpectation({
                token: market.token,
                quoteAsset: market.quoteAsset,
                model: market.model,
                expectedSupply: IERC20Metadata(market.token).totalSupply(),
                launchNonce: agent.expectation.launchNonce
            })
        );

        if (actual != agent.marketCommitment) revert MarketCommitmentMismatch(agent.marketCommitment, actual);

        agent.poolId = poolId;
        agent.token = market.token;
        agent.marketBoundAt = uint64(block.timestamp);

        _agentByPool[poolId] = agentId;

        emit MarketBound(agentId, poolId, market.token, market.splitter);
        _moveTo(agentId, agent, AgentLifecycle.State.MarketBound);

        // Hand the router the splitter it is the fee recipient of, now that the
        // line above has proved it is. `FeeSplitter.claim` pays `msg.sender` and
        // takes no argument saying whom to pay, so the router has to make that call
        // itself — and it should never have to find the address, or be told it by
        // somebody whose word has not been checked. This is the only write the agent
        // layer makes as a consequence of reading the market layer, and it happens
        // after every check above has passed.
        IAgentRevenueRouter(agent.router).bindSplitter(market.splitter);
    }

    // --- lifecycle ----------------------------------------------------------

    /// @inheritdoc IAgentIdentityRegistry
    function activate(bytes32 agentId) external {
        Agent storage agent = _load(agentId);
        if (msg.sender != agent.developer) revert NotDeveloper(msg.sender);

        AgentLifecycle.requireTransition(agent.state, AgentLifecycle.State.Active);

        agent.activatedAt = uint64(block.timestamp);
        _moveTo(agentId, agent, AgentLifecycle.State.Active);
    }

    /// @inheritdoc IAgentIdentityRegistry
    ///
    /// @dev Pausing stops the execution module accepting actions. It does not stop
    /// the market trading, fees accruing, the splitter paying, revenue arriving and
    /// allocating, or a fixed entitlement being settled. A guardian who could stop
    /// money arriving could starve the developer and the protocol; this one can stop
    /// the agent spending and nothing else (ADR-012).
    function pause(bytes32 agentId) external {
        Agent storage agent = _onlyGuardian(agentId);
        AgentLifecycle.requireTransition(agent.state, AgentLifecycle.State.Paused);

        _moveTo(agentId, agent, AgentLifecycle.State.Paused);
    }

    /// @inheritdoc IAgentIdentityRegistry
    function resume(bytes32 agentId) external {
        Agent storage agent = _onlyGuardian(agentId);
        AgentLifecycle.requireTransition(agent.state, AgentLifecycle.State.Active);

        _moveTo(agentId, agent, AgentLifecycle.State.Active);
    }

    /// @inheritdoc IAgentIdentityRegistry
    function revoke(bytes32 agentId) external {
        Agent storage agent = _onlyGuardian(agentId);
        AgentLifecycle.requireTransition(agent.state, AgentLifecycle.State.Revoked);

        _moveTo(agentId, agent, AgentLifecycle.State.Revoked);
    }

    function _moveTo(bytes32 agentId, Agent storage agent, AgentLifecycle.State next) private {
        AgentLifecycle.State previous = agent.state;

        agent.state = next;
        agent.stateChangedAt = uint64(block.timestamp);

        emit AgentStateChanged(agentId, previous, next, msg.sender);
    }

    function _onlyGuardian(bytes32 agentId) private view returns (Agent storage agent) {
        agent = _load(agentId);
        if (msg.sender != agent.guardian) revert NotGuardian(msg.sender);
    }

    function _load(bytes32 agentId) private view returns (Agent storage agent) {
        agent = _agents[agentId];
        if (agent.treasury == address(0)) revert UnknownAgent(agentId);
    }

    // --- metadata -----------------------------------------------------------

    /// @inheritdoc IAgentIdentityRegistry
    function setMetadataURI(bytes32 agentId, string calldata metadataURI) external {
        Agent storage agent = _load(agentId);
        if (msg.sender != agent.developer) revert NotDeveloper(msg.sender);
        if (agent.state == AgentLifecycle.State.Revoked) {
            revert AgentLifecycle.IllegalTransition(agent.state, agent.state);
        }

        agent.metadataURI = metadataURI;
        emit MetadataUpdated(agentId, metadataURI);
    }

    // --- reading ------------------------------------------------------------

    /// @inheritdoc IAgentIdentityRegistry
    ///
    /// @dev Reverts rather than returning a zeroed struct. A caller that cannot
    /// tell "no such agent" from "an agent whose fields are all zero" will
    /// eventually treat one as the other — the same reasoning as
    /// `MarketRegistry.marketOf`.
    function agentOf(bytes32 agentId) external view returns (Agent memory) {
        return _load(agentId);
    }

    function agentByTreasury(address treasury) external view returns (bytes32) {
        return _agentByTreasury[treasury];
    }

    function agentByPool(bytes32 poolId) external view returns (bytes32) {
        return _agentByPool[poolId];
    }

    function agentCount() external view returns (uint256) {
        return _agentIds.length;
    }

    function agentAt(uint256 index) external view returns (Agent memory) {
        return _agents[_agentIds[index]];
    }

    /// @inheritdoc IAgentIdentityRegistry
    function stateOf(bytes32 agentId) external view returns (AgentLifecycle.State) {
        return _load(agentId).state;
    }

    /// @inheritdoc IAgentIdentityRegistry
    function isActive(bytes32 agentId) external view returns (bool) {
        Agent storage agent = _agents[agentId];
        return agent.treasury != address(0) && AgentLifecycle.mayExecute(agent.state);
    }

    /// @inheritdoc IAgentIdentityRegistry
    function mayConfigureServices(bytes32 agentId) external view returns (bool) {
        Agent storage agent = _agents[agentId];
        return agent.treasury != address(0) && AgentLifecycle.mayConfigureServices(agent.state);
    }
}
