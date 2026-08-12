// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgentMandate} from "./AgentMandate.sol";
import {AgentRevenueRouter} from "./AgentRevenueRouter.sol";
import {IAgentLaunchFactory} from "./IAgentLaunchFactory.sol";
import {RevenueAllocationLib} from "./RevenueAllocationLib.sol";

/// @title AgentDeployer
/// @notice Holds the bytecode of an agent's mandate and revenue router, and deploys
/// them on the factory's instruction. Nothing else.
///
/// @dev This exists for the same boring reason `VerdantDeployer` does, and it is
/// worth saying plainly: a contract that deploys another carries that contract's
/// creation code in its own bytecode. An agent is four contracts and they come to
/// about twenty-six kilobytes, so the factory that deploys them all in one
/// transaction cannot also fit inside the 24 576-byte limit. The bytecode lives on
/// two addresses and the orchestration on a third — this one and
/// `AgentExecutionDeployer`.
///
/// It is deliberately not a policy contract. Every rule about a mandate is checked
/// by `AgentMandate`'s own constructor and every rule about a split by
/// `AgentRevenueRouter`'s. Adding checks here would be a second implementation of
/// rules that already have one, and two implementations of a rule disagree
/// eventually.
///
/// What it does enforce is who may call it. Only the factory, which deployed this
/// contract in its own constructor and is therefore `msg.sender` at that moment —
/// no prediction and no setter. An open deployer would let anyone mint contracts
/// whose addresses derive from Verdant's, and address provenance is something
/// people read.
contract AgentDeployer {
    /// @notice The only address that may deploy anything here.
    address public immutable factory;

    error NotFactory(address caller);

    constructor() {
        factory = msg.sender;
    }

    /// @notice Deploy one agent's mandate.
    ///
    /// @dev Plain `CREATE` rather than `CREATE2`. `VerdantDeployer` uses `CREATE2`
    /// because a launch token sometimes has to be mined to sort above an equity's
    /// address (ADR-008); nothing about an agent depends on its address, so a salt
    /// would buy predictability nobody needs and one more thing to get wrong.
    function deployMandate(bytes32 agentId, IAgentLaunchFactory.AgentParams calldata params)
        external
        returns (address)
    {
        _onlyFactory();

        return address(
            new AgentMandate(
                agentId,
                params.guardian,
                params.limits,
                params.targets,
                params.minActionInterval,
                params.periodLength,
                params.expiry
            )
        );
    }

    /// @notice Deploy one agent's revenue router.
    function deployRouter(
        bytes32 agentId,
        address treasury,
        address developer,
        address protocolTreasury,
        address identityRegistry,
        RevenueAllocationLib.Allocation calldata allocation
    ) external returns (address) {
        _onlyFactory();

        return
            address(
                new AgentRevenueRouter(agentId, treasury, developer, protocolTreasury, identityRegistry, allocation)
            );
    }

    function _onlyFactory() private view {
        if (msg.sender != factory) revert NotFactory(msg.sender);
    }
}
