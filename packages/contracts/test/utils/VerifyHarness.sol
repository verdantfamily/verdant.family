// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Verify} from "../../script/Verify.s.sol";

/// @title VerifyHarness
/// @notice `script/Verify.s.sol` configured directly, so that a test can point it at
/// a deployment it built and at faults it introduced.
///
/// @dev The verifier's whole job is to fail on a deployment that is wrong, so its
/// tests have to build wrong deployments — many of them, each differing from the
/// correct one in a single input. Doing that through `vm.setEnv` does not work:
/// Foundry restores the EVM between test cases but not the process environment, so
/// each fault stays injected for every case that follows. The first version of
/// `test/Verify.t.sol` was written that way and its positive case failed, having
/// verified an address left behind by a negative one.
///
/// The environment path is not abandoned; it is covered once, deliberately, by
/// `test/ScriptEnv.t.sol`, which is the only suite permitted to write to the
/// environment.
contract VerifyHarness is Verify {
    Config private injected;

    constructor(Config memory config) {
        injected = config;
    }

    function _config() internal view override returns (Config memory) {
        return injected;
    }
}
