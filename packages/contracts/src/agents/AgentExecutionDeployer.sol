// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentExecutionModule} from "./AgentExecutionModule.sol";

/// @title AgentExecutionDeployer
/// @notice Holds the bytecode of an agent's execution module — and through it, its
/// treasury — and deploys the pair on the factory's instruction.
///
/// @dev The second of the two deployers `AgentDeployer` explains the need for. The
/// module and the treasury are together the largest piece of an agent, and they are
/// deployed by one call because they must be: the module creates the treasury inside
/// its own constructor, passing `address(this)`, which is how the two hold each
/// other's address without a setter on the contract that holds the money.
///
/// Factory only, and the factory is fixed by having deployed this contract.
contract AgentExecutionDeployer {
    /// @notice The only address that may deploy anything here.
    address public immutable factory;

    error NotFactory(address caller);

    constructor() {
        factory = msg.sender;
    }

    /// @notice Deploy an agent's execution module and the treasury it creates.
    /// @return module The execution module.
    /// @return treasury The treasury the module deployed, read back from it rather
    /// than computed, so the address returned is the one that actually exists.
    function deployExecution(
        bytes32 agentId,
        address operator,
        address mandate,
        address guardian,
        address serviceRegistry,
        address identityRegistry
    ) external returns (address module, address treasury) {
        if (msg.sender != factory) revert NotFactory(msg.sender);

        AgentExecutionModule deployed =
            new AgentExecutionModule(agentId, operator, mandate, guardian, serviceRegistry, identityRegistry);

        return (address(deployed), address(deployed.treasuryContract()));
    }
}
