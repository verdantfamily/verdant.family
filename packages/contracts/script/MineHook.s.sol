// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import {VerdantHook} from "../src/VerdantHook.sol";
import {HookMiner} from "../test/utils/HookMiner.sol";

/// @title MineHook
/// @notice Prints the salt and address `VerdantHook` gets for a given factory,
/// without deploying anything.
///
/// @dev This is a reviewer's tool, not a deployment path — `Deploy.s.sol` mines and
/// deploys the hook as part of bringing up the system, and it is the only thing that
/// should ever create one. A hook deployed on its own is a hook whose factory does
/// not know it and whose pools nobody can open, and it is not recoverable: the
/// permission bits live in the address.
///
/// What it is for is checking the claim. Salts count up from zero, so the mining is
/// reproducible: given a factory address, anyone can run this and confirm that the
/// hook deployed on chain is the first address that carries `0x3880` for that
/// factory, rather than one chosen for some other property.
///
///   POOL_MANAGER=0x... POSITION_MANAGER=0x... FACTORY=0x... \
///   forge script script/MineHook.s.sol
contract MineHook is Script {
    /// @dev The canonical deterministic CREATE2 deployer, verified byte-identical on
    /// both Robinhood chains — see docs/verification.md.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev beforeInitialize | afterInitialize | beforeAddLiquidity | beforeSwap.
    uint160 internal constant REQUIRED_BITS = 0x3880;

    function run() external view {
        address poolManager = vm.envAddress("POOL_MANAGER");
        address positionManager = vm.envAddress("POSITION_MANAGER");
        address factory = vm.envAddress("FACTORY");

        require(poolManager != address(0), "POOL_MANAGER must be set");
        require(positionManager != address(0), "POSITION_MANAGER must be set");
        require(factory != address(0), "FACTORY must be set");

        bytes memory initcode = abi.encodePacked(
            type(VerdantHook).creationCode, abi.encode(IPoolManager(poolManager), factory, positionManager)
        );
        (address hookAddress, bytes32 salt) = HookMiner.findFromInitcode(CREATE2_DEPLOYER, REQUIRED_BITS, initcode);

        // Restated rather than trusted from the miner: the loop and this check would
        // have to be wrong in the same way for a wrong address to be reported as
        // right.
        uint160 bits = uint160(hookAddress) & Hooks.ALL_HOOK_MASK;
        require(bits == REQUIRED_BITS, "mined address does not carry 0x3880");

        console.log("pool manager   ", poolManager);
        console.log("posn manager   ", positionManager);
        console.log("factory        ", factory);
        console.log("hook address   ", hookAddress);
        console.log("hook salt      ", vm.toString(salt));
        console.log("initcode hash  ", vm.toString(keccak256(initcode)));
        console.log("already on chain", hookAddress.code.length > 0);
    }
}
