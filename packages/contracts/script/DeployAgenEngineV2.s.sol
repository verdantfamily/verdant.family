// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

import {FactoryOrigin} from "../src/FactoryOrigin.sol";
import {AgenMarketRegistry} from "../src/agen/AgenMarketRegistry.sol";
import {AgenEngineDeployerV2} from "../src/agen/engine/AgenEngineDeployerV2.sol";
import {AgenEnginePotDeployerV2} from "../src/agen/engine/AgenEnginePotDeployerV2.sol";
import {AgenEngineFactoryV2} from "../src/agen/engine/AgenEngineFactoryV2.sol";
import {AgenEngineHookV2} from "../src/agen/engine/AgenEngineHookV2.sol";
import {AgenRuleValidatorV2} from "../src/agen/engine/AgenRuleValidatorV2.sol";
import {IAgenRuleValidatorV2} from "../src/agen/engine/AgenRuleLibV2.sol";
import {HookMiner} from "../test/utils/HookMiner.sol";

/// @title DeployAgenEngineV2
/// @notice Parallel stack for wallet-aware markets. Same five phases as v1; the hook
/// constructor also pins `AgenRouter`. Does not touch the live v1 deployment.
contract DeployAgenEngineV2 is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint160 internal constant REQUIRED_BITS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    struct Deployment {
        FactoryOrigin origin;
        address predictedFactory;
        AgenEngineDeployerV2 deployer;
        AgenEnginePotDeployerV2 potDeployer;
        AgenRuleValidatorV2 validator;
        AgenMarketRegistry registry;
        bytes32 hookSalt;
        address predictedHook;
        AgenEngineHookV2 hook;
        AgenEngineFactoryV2 factory;
    }

    struct Inputs {
        address sender;
        address poolManager;
        address positionManager;
        address treasury;
        address agenRouter;
    }

    function run() public virtual returns (Deployment memory out) {
        Inputs memory input = _inputs();
        vm.startBroadcast(input.sender);

        out.origin = new FactoryOrigin(input.sender);
        out.predictedFactory = out.origin.factory();
        require(out.predictedFactory.code.length == 0, "the anchored factory address is already occupied");

        out.deployer = new AgenEngineDeployerV2(out.predictedFactory);
        out.potDeployer = new AgenEnginePotDeployerV2(out.predictedFactory);
        out.registry = new AgenMarketRegistry(out.predictedFactory);

        // Before the hook, because the hook pins it. Stateless and ownerless, so it needs
        // no wiring back — see `AgenRuleValidatorV2`.
        out.validator = new AgenRuleValidatorV2();

        bytes memory hookInitcode = abi.encodePacked(
            type(AgenEngineHookV2).creationCode,
            abi.encode(
                IPoolManager(input.poolManager),
                out.predictedFactory,
                input.positionManager,
                input.agenRouter,
                IAgenRuleValidatorV2(address(out.validator))
            )
        );
        (out.predictedHook, out.hookSalt) = HookMiner.findFromInitcode(CREATE2_DEPLOYER, REQUIRED_BITS, hookInitcode);
        out.hook = AgenEngineHookV2(_create2(out.hookSalt, hookInitcode));
        out.factory = AgenEngineFactoryV2(out.origin.deployFactory(_factoryInitcode(input, out)));

        vm.stopBroadcast();

        require(address(out.hook) == out.predictedHook, "the hook did not land where it was mined");
        require(address(out.factory) == out.predictedFactory, "factory is not at the anchored address");
        require(out.hook.agenRouter() == input.agenRouter, "hook is not bound to the router");
        require(address(out.hook.validator()) == address(out.validator), "hook names a different validator");

        console.log("AGEN_ENGINE_V2_FACTORY ", address(out.factory));
        console.log("AGEN_ENGINE_V2_DEPLOYER", address(out.deployer));
        console.log("AGEN_ENGINE_V2_POT_DEPLOYER", address(out.potDeployer));
        console.log("AGEN_ENGINE_V2_VALIDATOR", address(out.validator));
        console.log("AGEN_ENGINE_V2_REGISTRY", address(out.registry));
        console.log("AGEN_ENGINE_V2_HOOK    ", address(out.hook));
    }

    function _inputs() internal view virtual returns (Inputs memory input) {
        input.sender = _sender();
        input.poolManager = vm.envAddress("POOL_MANAGER");
        input.positionManager = vm.envAddress("POSITION_MANAGER");
        input.treasury = vm.envAddress("AGEN_ENGINE_TREASURY");
        input.agenRouter = vm.envAddress("AGEN_ROUTER");
        _validate(input);
    }

    /// @dev `virtual` for the reason `DeployAgenEngine` has the same seam: a script's sender
    /// is an account named on the command line, and a test has to be its own sender because
    /// a contract cannot send a transaction.
    function _sender() internal view virtual returns (address) {
        return msg.sender;
    }

    /// @dev Applied however the inputs arrived, so an injected deployment is held to the same
    /// preconditions as a broadcast one.
    function _validate(Inputs memory input) internal view {
        require(input.poolManager.code.length > 0, "POOL_MANAGER has no code");
        require(input.positionManager.code.length > 0, "POSITION_MANAGER has no code");
        require(input.treasury != address(0), "AGEN_ENGINE_TREASURY must be set");
        require(input.agenRouter != address(0), "AGEN_ROUTER must be set");
        require(input.sender != address(0), "no sender");
        require(CREATE2_DEPLOYER.code.length > 0, "no deterministic deployer on this chain");
    }

    function _factoryInitcode(Inputs memory input, Deployment memory out) internal pure returns (bytes memory) {
        return abi.encodePacked(
            type(AgenEngineFactoryV2).creationCode,
            abi.encode(
                IPoolManager(input.poolManager),
                IPositionManager(input.positionManager),
                out.deployer,
                out.potDeployer,
                out.registry,
                out.hook,
                input.treasury
            )
        );
    }

    function _create2(bytes32 salt, bytes memory initcode) internal returns (address deployed) {
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initcode));
        require(ok, "CREATE2 deployment reverted");
        require(ret.length == 20, "deterministic deployer returned no address");
        // forge-lint: disable-next-line(unsafe-typecast)
        deployed = address(bytes20(ret));
        require(deployed.code.length > 0, "nothing was deployed");
    }
}
