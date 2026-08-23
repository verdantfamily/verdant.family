// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeployAgenEngine} from "../../script/DeployAgenEngine.s.sol";

/// @title InjectedEngineDeployHarness
/// @notice `script/DeployAgenEngine.s.sol` with the two seams a test needs, and nothing else.
///
/// @dev The same shape as `InjectedInstantDeployHarness`, for the same two reasons. A
/// script's sender is an account named on the command line and a test has to be its own
/// sender, because a contract cannot send a transaction. And the inputs are injected rather
/// than set with `vm.setEnv`, which Foundry does not roll back between cases — a variable one
/// test writes stays written for every case after it and every suite beside it.
///
/// Everything the seams do not touch is the production path: the anchored factory address,
/// the hook mining, the order of the five phases, and every assertion the script makes when
/// they are done. That is only true because no address in the script comes from an operator's
/// transaction count — see `FactoryOrigin` — so what this harness deploys is arithmetically
/// the same deployment an operator would get.
///
/// Two instances of this contract have two addresses, so they create two origins at two
/// addresses, which is how a test varies the operator: the anchor derives the factory's
/// address from the origin's, and the origin's comes from whoever created it. Nothing has to
/// be stubbed to make that true.
contract InjectedEngineDeployHarness is DeployAgenEngine {
    Inputs private injected;

    constructor(address poolManager, address positionManager, address treasury) {
        injected = Inputs({
            sender: address(this), poolManager: poolManager, positionManager: positionManager, treasury: treasury
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

    // --- what the script keeps `internal` -------------------------------------

    /// @dev Exposed so a test asserts against the script's own constants rather than
    /// against a second copy of them written in the test. A restated `0x38cc` that drifted
    /// from the script's would make the test pass and the deployment wrong.
    function requiredBits() external pure returns (uint160) {
        return REQUIRED_BITS;
    }

    function create2Deployer() external pure returns (address) {
        return CREATE2_DEPLOYER;
    }
}
