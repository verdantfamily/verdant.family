// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {AgenEngineDeployer} from "../../../src/agen/engine/AgenEngineDeployer.sol";
import {AgenEngineFactory} from "../../../src/agen/engine/AgenEngineFactory.sol";
import {AgenEngineHook} from "../../../src/agen/engine/AgenEngineHook.sol";
import {AgenEngineVault} from "../../../src/agen/engine/AgenEngineVault.sol";

/// @title Every engine contract fits on chain
///
/// @notice A guard against the failure that would otherwise surface as a failed mainnet
/// deployment.
///
/// @dev Foundry does not enforce EIP-170 when it runs tests. It deploys whatever it is given
/// and the suite passes, so a contract can grow past 24 576 bytes with every test green and
/// nothing saying a word — and the first time anybody finds out is the deployment
/// transaction, at which point the mined hook address and every wiring that depends on it
/// have to be discarded and redone.
///
/// The engine hit this. The factory carried the creation code of the token, the vault and the
/// locker and came to 32 599 bytes: undeployable, with twenty-one passing integration tests.
/// `AgenEngineDeployer` now holds that bytecode, which is the same reason `VerdantDeployer`
/// exists.
///
/// So the limit is asserted here rather than left to `forge build --sizes`, which is a thing
/// somebody has to remember to look at.
contract EngineSizesTest is Test {
    /// @notice EIP-170's runtime limit.
    uint256 internal constant MAX_RUNTIME = 24_576;

    /// @notice EIP-3860's initcode limit, which is twice the runtime one.
    uint256 internal constant MAX_INITCODE = 49_152;

    /// @notice The headroom every engine contract must keep below EIP-170.
    ///
    /// @dev 2 000 bytes, chosen against what is actually expected to grow rather than as a
    /// round number.
    ///
    /// `AgenEngineDeployer` is the binding one and the only one whose growth is lumpy: it
    /// carries whole contracts' creation code, so the next thing added to it is not a few
    /// hundred bytes but a few thousand. A budget smaller than one small contract would let
    /// it pass right up to the edge and then fail on the addition after — which is the
    /// failure this whole file exists to prevent, moved one commit later.
    ///
    /// The factory grows differently: it gains launch logic, a few hundred bytes at a time,
    /// and has nine kilobytes spare. So 2 000 binds the deployer and is slack for everything
    /// else, which is the right shape.
    ///
    /// If native support or anything after it pushes the deployer past this, the answer is to
    /// move bytecode into a second deployer rather than to lower the number. Weakening this
    /// test is a decision about mainnet, not about a test.
    uint256 internal constant SAFETY_BUDGET = 2_000;

    /// @notice The largest runtime size any engine contract may have.
    uint256 internal constant MAX_SAFE_RUNTIME = MAX_RUNTIME - SAFETY_BUDGET;

    /// @notice Asserts a contract's *measured* runtime size fits, with the budget to spare.
    ///
    /// @dev `artefact` is a `File.sol:Contract` identifier that `vm.getDeployedCode` resolves
    /// against the compiled output. That is what makes this a measurement rather than a claim.
    ///
    /// It was a claim. This function used to take the runtime size as an argument — a constant
    /// written by hand at the top of each test — and assert that the constant was below the
    /// limit. Which it always was, because somebody had typed a number that was. A contract
    /// could have grown to thirty kilobytes with all five tests green, since nothing in the
    /// file ever asked the compiler how large anything actually was.
    ///
    /// Two of the four constants had already drifted when this was found: the factory was
    /// recorded as 14 745 and measured 14 651, the hook as 17 988 and measured 18 007. Neither
    /// drift mattered on its own. Both showed the numbers were decorative, which is the exact
    /// condition under which the failure this file exists to prevent walks straight through it.
    function _assertFits(string memory name, string memory artefact, bytes memory creationCode) private view {
        uint256 runtime = vm.getDeployedCode(artefact).length;

        // The hard limit. Breaching it means the contract cannot be deployed at all.
        assertLt(
            runtime,
            MAX_RUNTIME,
            string.concat(name, " exceeds EIP-170 and cannot be deployed. Move bytecode to a deployer.")
        );

        // And the budget, so the next addition fails here rather than on mainnet.
        assertLt(
            runtime,
            MAX_SAFE_RUNTIME,
            string.concat(
                name,
                " is within 2000 bytes of EIP-170. Move bytecode to a deployer rather than lowering SAFETY_BUDGET."
            )
        );

        assertLt(creationCode.length, MAX_INITCODE, string.concat(name, " exceeds EIP-3860's initcode limit"));
    }

    function test_the_factory_fits() public view {
        // The one that actually broke, before its bytecode moved to the deployer.
        _assertFits("AgenEngineFactory", "AgenEngineFactory.sol:AgenEngineFactory", type(AgenEngineFactory).creationCode);
    }

    function test_the_deployer_fits() public view {
        // The tightest of the four, because it carries three contracts' creation code. A new
        // per-market contract goes here, so this is the number to watch.
        _assertFits("AgenEngineDeployer", "AgenEngineDeployer.sol:AgenEngineDeployer", type(AgenEngineDeployer).creationCode);
    }

    function test_the_hook_fits() public view {
        _assertFits("AgenEngineHook", "AgenEngineHook.sol:AgenEngineHook", type(AgenEngineHook).creationCode);
    }

    function test_the_vault_fits() public view {
        _assertFits("AgenEngineVault", "AgenEngineVault.sol:AgenEngineVault", type(AgenEngineVault).creationCode);
    }

    /// @notice That the measurement above is measuring something.
    ///
    /// @dev A guard against the way `_assertFits` could go quiet: if `vm.getDeployedCode` ever
    /// resolved to nothing — a renamed file, a moved contract, a typo in an artefact path — it
    /// would return empty bytes, every size would be zero, and all four tests would pass while
    /// checking nothing at all. That is the same vacuity the hardcoded constants had, arrived
    /// at by a different route, so it is worth one assertion to close.
    ///
    /// The floor is deliberately loose. It is not a size assertion; it is an "is this reading
    /// a real contract" assertion, and a real contract is kilobytes.
    function test_the_sizes_are_measured_rather_than_assumed() public view {
        string[4] memory artefacts = [
            "AgenEngineFactory.sol:AgenEngineFactory",
            "AgenEngineDeployer.sol:AgenEngineDeployer",
            "AgenEngineHook.sol:AgenEngineHook",
            "AgenEngineVault.sol:AgenEngineVault"
        ];

        for (uint256 i = 0; i < artefacts.length; i++) {
            assertGt(
                vm.getDeployedCode(artefacts[i]).length,
                1_000,
                string.concat(artefacts[i], " measured as almost nothing, so the size checks are not reading it")
            );
        }
    }
}
