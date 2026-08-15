// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeployInstantBoost} from "../../script/DeployInstantBoost.s.sol";

/// @title InjectedInstantBoostHarness
/// @notice `script/DeployInstantBoost.s.sol` with the two seams a test needs, and nothing else.
///
/// @dev `InjectedInstantDeployHarness`'s shape, for the same two reasons. A script's sender is an
/// account named on the command line and a test has to be its own sender, because a contract cannot
/// send a transaction. And the inputs are injected rather than set with `vm.setEnv`, which Foundry
/// does not roll back between cases — a variable one test writes stays written for every case after
/// it and every suite beside it.
///
/// Everything the seams do not touch is the production path: the anchored factory address, the hook
/// mining, the order of the five phases, and every assertion the script makes when they are done.
///
/// Note what is deliberately *not* a seam. `TREASURY` is not injectable, because the whole point of
/// the script is that the treasury is the one it deploys — an injected one would let this harness
/// pass while a real deployment produced markets whose platform fee Boost can never reach.
contract InjectedInstantBoostHarness is DeployInstantBoost {
    Inputs private injectedInstant;
    BoostInputs private injectedBoost;

    constructor(address poolManager, address positionManager, address agenTreasury, address agenRouter) {
        injectedInstant = Inputs({
            sender: address(this),
            poolManager: poolManager,
            positionManager: positionManager,
            // A placeholder the script's phase 5 overwrites with the treasury it deployed. That it
            // is ignored is asserted by `DeployInstantBoost.t.sol`.
            treasury: address(this)
        });
        injectedBoost = BoostInputs({agenTreasury: agenTreasury, agenRouter: agenRouter});
    }

    function _sender() internal view override returns (address) {
        return address(this);
    }

    /// @dev Validated through the script's own function, so an injected deployment cannot skip a
    /// precondition a broadcast one is held to.
    function _inputs() internal view override returns (Inputs memory input) {
        input = injectedInstant;
        _validate(input);
    }

    function _boostInputs() internal view override returns (BoostInputs memory boostInput) {
        boostInput = injectedBoost;
        require(boostInput.agenTreasury != address(0), "AGEN_TREASURY must be set");
        require(boostInput.agenRouter.code.length > 0, "AGEN_ROUTER has no code on this chain");
    }
}
