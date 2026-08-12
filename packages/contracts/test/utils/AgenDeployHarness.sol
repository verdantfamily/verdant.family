// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeployAgen} from "../../script/DeployAgen.s.sol";

/// @title InjectedAgenDeployHarness
/// @notice `script/DeployAgen.s.sol` with the two seams a test needs, and nothing else.
///
/// @dev The same shape as `InjectedDeployHarness`, for the same two reasons. A script's
/// sender is an account named on the command line and a test has to be its own sender,
/// because a contract cannot send a transaction. And the inputs are injected rather than
/// set with `vm.setEnv`, which Foundry does not roll back between cases — a variable one
/// test writes stays written for every case after it and every suite beside it.
///
/// Everything the seams do not touch is the production path: the anchored factory
/// address, the order of the three phases, and every assertion the script makes when
/// they are done. That is only true because no address in the script comes from an
/// operator's transaction count — see `FactoryOrigin` — so what this harness deploys is
/// arithmetically the same deployment an operator would get.
contract InjectedAgenDeployHarness is DeployAgen {
    Inputs private injected;

    constructor(address poolManager, address positionManager) {
        injected = Inputs({
            sender: address(this),
            poolManager: poolManager,
            positionManager: positionManager
        });
    }

    function _sender() internal view override returns (address) {
        return address(this);
    }

    /// @dev Validated through the script's own function, so an injected deployment
    /// cannot skip a precondition a broadcast one is held to.
    function _inputs() internal view override returns (Inputs memory input) {
        input = injected;
        _validate(input);
    }
}
