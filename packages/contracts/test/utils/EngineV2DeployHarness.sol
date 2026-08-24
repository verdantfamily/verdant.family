// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeployAgenEngineV2} from "../../script/DeployAgenEngineV2.s.sol";

/// @title InjectedEngineV2DeployHarness
/// @notice `script/DeployAgenEngineV2.s.sol` with the two seams a test needs.
///
/// @dev The same shape as `InjectedEngineDeployHarness`, for the same two reasons. A
/// script's sender is an account named on the command line and a test has to be its own
/// sender, because a contract cannot send a transaction. And the inputs are injected rather
/// than set with `vm.setEnv`, which Foundry does not roll back between cases.
///
/// Everything the seams do not touch is the broadcast path: the anchored factory address,
/// the hook mining, the order of the phases, and every assertion the script makes when they
/// are done.
contract InjectedEngineV2DeployHarness is DeployAgenEngineV2 {
    Inputs private injected;

    constructor(address poolManager, address positionManager, address treasury, address agenRouter) {
        injected = Inputs({
            sender: address(this),
            poolManager: poolManager,
            positionManager: positionManager,
            treasury: treasury,
            agenRouter: agenRouter
        });
    }

    function _sender() internal view override returns (address) {
        return address(this);
    }

    /// @dev Validated through the script's own function, so an injected deployment cannot
    /// skip a precondition a broadcast one is held to.
    function _inputs() internal view override returns (Inputs memory input) {
        input = injected;
        _validate(input);
    }
}
