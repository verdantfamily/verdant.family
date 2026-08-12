// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAgentIdentityRegistry} from "./IAgentIdentityRegistry.sol";
import {IAgentMandate} from "./IAgentMandate.sol";
import {RevenueAllocationLib} from "./RevenueAllocationLib.sol";

/// @title IAgentLaunchFactory
/// @notice Creating an agent: what a developer chooses, and what they get back.
///
/// @dev The parameter types live in an interface rather than on the factory because
/// the deployers take them too, and a struct defined on the factory would make the
/// factory and its deployers import each other.
interface IAgentLaunchFactory {
    /// @notice Everything a developer chooses about their agent.
    ///
    /// @dev Every field except `metadataURI` becomes immutable the moment this
    /// transaction lands. `IAgentMandate` carries the full table of what can move
    /// afterwards and who may move it.
    ///
    /// Notably absent: the protocol's address, which the factory holds. A developer
    /// who could name it would be naming their own, and the protocol leg would be a
    /// second developer leg wearing a different label.
    struct AgentParams {
        /// @dev Namespaced by the developer, so choosing a salt cannot reach into
        /// somebody else's ids.
        bytes32 salt;
        /// @dev May pause and revoke. May never move or redirect money (ADR-012).
        address guardian;
        /// @dev Submits actions. Assumed hostile in the threat model.
        address operator;
        IAgentMandate.AssetLimit[] limits;
        address[] targets;
        uint64 minActionInterval;
        uint64 periodLength;
        uint64 expiry;
        RevenueAllocationLib.Allocation allocation;
        string metadataURI;
        /// @dev What the developer says the market they are about to launch will
        /// be. Hashed into a commitment that `bindMarket` verifies against the
        /// market that actually exists, which is what makes a false binding
        /// impossible rather than merely detectable.
        IAgentIdentityRegistry.MarketExpectation expectation;
    }

    /// @notice What a launch produced.
    struct AgentAddresses {
        bytes32 agentId;
        address mandate;
        address treasury;
        address router;
        address executionModule;
    }

    /// @notice One agent, fully described.
    ///
    /// @dev Deliberately complete rather than minimal. An indexer reading this event
    /// has every address and every share without a follow-up call, which is what
    /// makes the agent page renderable from logs alone.
    event AgentLaunched(
        bytes32 indexed agentId,
        address indexed developer,
        address indexed operator,
        address guardian,
        address mandate,
        address treasury,
        address router,
        address executionModule,
        uint16 operationsBps,
        uint16 buybacksBps,
        uint16 developerBps,
        uint16 protocolBps,
        bytes32 marketCommitment
    );

    function createAgent(AgentParams calldata params) external returns (AgentAddresses memory agent);
}
