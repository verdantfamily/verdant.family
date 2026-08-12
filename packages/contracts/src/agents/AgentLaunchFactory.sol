// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentDeployer} from "./AgentDeployer.sol";
import {AgentExecutionDeployer} from "./AgentExecutionDeployer.sol";
import {AgentIdentityRegistry} from "./AgentIdentityRegistry.sol";
import {AgentServiceRegistry} from "./AgentServiceRegistry.sol";
import {IAgentIdentityRegistry} from "./IAgentIdentityRegistry.sol";
import {IAgentLaunchFactory} from "./IAgentLaunchFactory.sol";

/// @title AgentLaunchFactory
/// @notice Deploys one agent's contracts in one transaction, and nothing else.
///
/// @dev It does **not** wrap `VerdantFactory.create`, and that is the central design
/// decision of this layer rather than an omission (ADR-010). `create` reads
/// `msg.sender` six times and means something different by it each time — the
/// token's creator, the salt namespace, the vesting beneficiary, the allocation
/// recipient, the first-buy recipient and the refund address. A wrapper becomes all
/// six: every agent market would be attributed to this contract on the profile page,
/// and this contract would take custody of allocations and refunds it has no
/// function to release.
///
/// So a launch is two signatures. The developer creates their agent here, then calls
/// the existing, unmodified launch path themselves with `feeRecipient` set to the
/// agent's revenue router. `AgentIdentityRegistry.bindMarket` then proves the two
/// belong together by reading the market's own splitter, so nothing rests on the
/// developer being honest about which market is which.
///
/// ## What this contract deploys, and what it does not hold
///
/// Its constructor creates the deployment's identity registry, its shared service
/// registry, and the two deployers that hold the agent contracts' creation code.
/// Each of those is created here so its `factory` is `msg.sender` by construction —
/// no predicted address to assert and no setter to be called by whoever gets there
/// first.
///
/// The creation code sits on the deployers rather than here for the reason
/// `AgentDeployer` states plainly: four contracts of creation code do not fit inside
/// one 24 576-byte runtime alongside the logic that orders them.
contract AgentLaunchFactory is IAgentLaunchFactory {
    /// @notice The agent record for this deployment.
    AgentIdentityRegistry public immutable identityRegistry;

    /// @notice The shared service registry. One for the deployment, so resolving a
    /// provider's service does not require knowing which registry to ask.
    AgentServiceRegistry public immutable serviceRegistry;

    AgentDeployer public immutable deployer;
    AgentExecutionDeployer public immutable executionDeployer;

    /// @notice Where every agent's protocol leg pays. Set once, at deployment.
    address public immutable protocolTreasury;

    error ZeroMarketRegistry();
    error ZeroProtocolTreasury();
    error AgentIdMismatch(bytes32 expected, bytes32 registered);

    constructor(address marketRegistry, address protocolTreasury_) {
        if (marketRegistry == address(0)) revert ZeroMarketRegistry();
        if (protocolTreasury_ == address(0)) revert ZeroProtocolTreasury();

        protocolTreasury = protocolTreasury_;

        identityRegistry = new AgentIdentityRegistry(marketRegistry);
        serviceRegistry = new AgentServiceRegistry(address(identityRegistry));
        deployer = new AgentDeployer();
        executionDeployer = new AgentExecutionDeployer();
    }

    /// @inheritdoc IAgentLaunchFactory
    ///
    /// @dev The developer is `msg.sender` and is not a parameter. A factory that
    /// accepted one would let anybody launch an agent attributed to somebody else,
    /// and the developer leg of the revenue split is a payment address.
    function createAgent(AgentParams calldata params) external returns (AgentAddresses memory agent) {
        agent.agentId = identityRegistry.agentIdFor(msg.sender, params.salt);
        agent.mandate = deployer.deployMandate(agent.agentId, params);

        (agent.executionModule, agent.treasury) = executionDeployer.deployExecution(
            agent.agentId,
            params.operator,
            agent.mandate,
            params.guardian,
            address(serviceRegistry),
            address(identityRegistry)
        );

        agent.router = deployer.deployRouter(
            agent.agentId, agent.treasury, msg.sender, protocolTreasury, address(identityRegistry), params.allocation
        );

        _register(agent, params);
    }

    /// @dev Split out so the registration call and the twelve-field event do not
    /// share a stack frame with four external deployments. The alternative is
    /// `via_ir`, which would change the compiler settings for every contract in the
    /// repository — including the seven already deployed and verified on 4663 — to
    /// make one function fit.
    function _register(AgentAddresses memory agent, AgentParams calldata params) private {
        (bytes32 registeredId,) = identityRegistry.register(
            msg.sender,
            params.salt,
            IAgentIdentityRegistry.Registration({
                developer: msg.sender,
                guardian: params.guardian,
                mandate: agent.mandate,
                treasury: agent.treasury,
                router: agent.router,
                executionModule: agent.executionModule,
                serviceRegistry: address(serviceRegistry),
                metadataURI: params.metadataURI,
                expectation: params.expectation
            })
        );

        // The registry derives the id from the developer and the salt, exactly as
        // this contract did before deploying anything with it. They agree by
        // construction; asserting it means a change to either derivation is a failed
        // launch rather than an agent whose components carry an id the record does
        // not use.
        if (registeredId != agent.agentId) revert AgentIdMismatch(agent.agentId, registeredId);

        _emitLaunched(agent, params, identityRegistry.commitmentFor(msg.sender, agent.router, params.expectation));
    }

    /// @dev A third frame, for the same reason `_register` is a second one. The
    /// thirteen-field event does not fit on the stack alongside the registration
    /// call, and the commitment arrives as a scalar argument rather than by reading
    /// it back out of the `Agent` struct — `agentOf` returns the whole record, and
    /// putting that in memory here is what pushed the frame over.
    ///
    /// `commitmentFor` recomputes the same preimage `register` just hashed, from the
    /// same inputs, so the value emitted is the value stored.
    function _emitLaunched(AgentAddresses memory agent, AgentParams calldata params, bytes32 marketCommitment) private {
        emit AgentLaunched(
            agent.agentId,
            msg.sender,
            params.operator,
            params.guardian,
            agent.mandate,
            agent.treasury,
            agent.router,
            agent.executionModule,
            params.allocation.operationsBps,
            params.allocation.buybacksBps,
            params.allocation.developerBps,
            params.allocation.protocolBps,
            marketCommitment
        );
    }
}
