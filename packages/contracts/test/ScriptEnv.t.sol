// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {Verify} from "../script/Verify.s.sol";
import {DeployHarness} from "./utils/DeployHarness.sol";

/// @title The scripts, configured the way an operator configures them
///
/// @notice Both scripts are run from their environment variables here, and nowhere
/// else in the suite.
///
/// @dev Every other test injects its configuration, because `vm.setEnv` writes
/// process-global state that Foundry does not restore between test cases — `setUp`
/// runs once, the EVM is snapshotted and rolled back per case, and the environment is
/// not part of that snapshot. A suite that writes a variable in one case has written it
/// for every case after it, and for every suite running beside it.
///
/// But `vm.envAddress` and `vm.envOr` are how the real deployment is configured, and an
/// untested reading path is one where a mistyped variable name or a missing default
/// only shows up on the day it is used. So the environment path is covered exactly
/// once, here, by a suite that writes the variables in `setUp` and never touches them
/// again. One writer means no interference, and keeping that true is the reason this
/// file is separate and says so.
///
/// What is not covered, and cannot be: `REGISTRY_OWNER`'s default. `vm.setEnv` cannot
/// unset a variable, so the `vm.envOr` fallback to the sender is unreachable from a
/// test. It is one line in `Deploy._inputs`, and a deployment that relied on it would
/// leave the register owned by the deploying key — which the runbook tells the operator
/// to set explicitly for that reason.
contract ScriptEnvTest is Deployers {
    PositionManager internal posm;

    address internal registryOwner = makeAddr("registry owner");
    address internal treasury = makeAddr("treasury");

    Deploy.Deployment internal d;

    function setUp() public {
        deployFreshManagerAndRouters();
        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        vm.setEnv("POOL_MANAGER", vm.toString(address(manager)));
        vm.setEnv("POSITION_MANAGER", vm.toString(address(posm)));
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("REGISTRY_OWNER", vm.toString(registryOwner));

        d = new DeployHarness().run();

        vm.setEnv("FACTORY", vm.toString(address(d.factory)));
        vm.setEnv("ORIGIN", vm.toString(address(d.origin)));
        vm.setEnv("EXPECTED_TREASURY", vm.toString(treasury));
        vm.setEnv("EXPECTED_REGISTRY_OWNER", vm.toString(registryOwner));
    }

    /// @dev The deployment in `setUp` read all four variables. If any name were wrong
    /// the script would have reverted on a missing variable; these assertions are that
    /// each value reached the contract it was meant for, rather than reaching some
    /// other one.
    function test_theDeploymentReadsItsConfigurationFromTheEnvironment() public view {
        assertEq(address(d.factory.poolManager()), address(manager), "POOL_MANAGER");
        assertEq(address(d.factory.positionManager()), address(posm), "POSITION_MANAGER");
        assertEq(d.factory.treasury(), treasury, "TREASURY");
        assertEq(d.modelRegistry.owner(), registryOwner, "REGISTRY_OWNER");

        // The hook is mined against the PositionManager, so this also confirms the
        // variable was read before mining rather than after.
        assertEq(d.hook.positionManager(), address(posm), "the hook was mined for this PositionManager");
    }

    /// @dev And the verifier agrees, reading its own six variables — including the two
    /// optional ones, whose defaults point at the Uniswap deployed on 4663 and are
    /// overridden here.
    function test_theVerifierReadsItsConfigurationFromTheEnvironment() public {
        assertEq(new Verify().run(), 2, "verified, warning about the EOA owner and the foreign quote-asset list");
    }
}
