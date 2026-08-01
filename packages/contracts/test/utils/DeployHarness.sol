// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Deploy} from "../../script/Deploy.s.sol";

/// @title DeployHarness
/// @notice `script/Deploy.s.sol` with one seam, so that the deployment can be run
/// by a test.
///
/// @dev A script's sender is an account named on the command line; in a test it has
/// to be the harness itself, because a contract cannot send a transaction. That is
/// the only override here, and the inputs still come from the environment, which is
/// what makes this the harness that covers the environment-reading path.
///
/// Everything the seam does not touch is the production path — the order of the
/// four phases, the anchored factory address, the hook mining, the CREATE2 call, and
/// every assertion the script makes afterwards. `FactoryOrigin` is what makes that
/// true: with no nonce arithmetic anywhere in the script, the addresses a harness
/// produces are computed the same way as the addresses an operator produces (ADR-007).
contract DeployHarness is Deploy {
    function _sender() internal view override returns (address) {
        return address(this);
    }
}

/// @title InjectedDeployHarness
/// @notice The same deployment, configured directly rather than through the process
/// environment.
///
/// @dev `vm.setEnv` is the obvious way to configure a script from a test and it is a
/// trap. Foundry runs `setUp` once per suite, snapshots the EVM and restores that
/// snapshot before each test case — but the process environment is not part of the
/// snapshot. So a variable a test writes stays written for every case after it, and
/// for every suite running alongside it. That is not a hypothetical: the first
/// version of `test/Verify.t.sol` set `FACTORY` to a codeless address in one negative
/// case and the *positive* case then failed, because it verified an address belonging
/// to a different test.
///
/// Injection removes the shared channel. Each test constructs its own harness with
/// its own PoolManager, and nothing it does is visible to anything else. The
/// environment-reading path stays covered by `DeployHarness` above, exercised by the
/// one suite that is allowed to touch the environment.
contract InjectedDeployHarness is Deploy {
    Inputs private injected;

    constructor(address poolManager, address positionManager, address treasury, address registryOwner) {
        injected = Inputs({
            sender: address(this),
            poolManager: poolManager,
            positionManager: positionManager,
            treasury: treasury,
            registryOwner: registryOwner
        });
    }

    function _sender() internal view override returns (address) {
        return address(this);
    }

    /// @dev Validated with the same function the environment path uses, so an
    /// injected deployment cannot skip a precondition a real one is held to.
    function _inputs() internal view override returns (Inputs memory input) {
        input = injected;
        _validate(input);
    }
}
