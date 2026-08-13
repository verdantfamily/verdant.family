// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import {AgenRouter} from "../src/agen/AgenRouter.sol";

/// @title DeployAgenRouter
/// @notice Brings up `AgenRouter` on a chain that already has the rest of Agen.
///
/// @dev `DeployAgen.s.sol` deploys the router alongside everything else, which is right
/// for a chain starting from nothing. This is for the other case, which is the one that
/// actually occurred: Agen was already live on 4663 when the router was written, and the
/// factory, deployer and registry did not change. Redeploying them to gain a router
/// would abandon every market launched through the existing factory — they hold its
/// address in immutables — to add a contract that names none of them.
///
/// The router shares nothing with those three. It holds the PoolManager and no more, it
/// is named by generated hooks rather than by the factory, and the factory does not know
/// it exists. So it can be deployed on its own, and this is what that looks like.
///
/// ## Once, and then never
///
/// A hook that authenticates its trades holds this address in an immutable. Deploying a
/// second router does not migrate anything: it strands every market built against the
/// first, permanently, because a deployed hook cannot be told a new one. Before running
/// this, check that `agen.router` in `packages/config/src/deployments.ts` is null for the
/// chain. If it is not, the chain has a router and this is not the script to run.
///
/// ## Running it
///
///   POOL_MANAGER=0x... forge script script/DeployAgenRouter.s.sol \
///     --rpc-url robinhood --sender 0xYOU
///
/// and again with `--broadcast` once the simulation reads correctly.
contract DeployAgenRouter is Script {
    function run() external returns (AgenRouter router) {
        address poolManager = vm.envAddress("POOL_MANAGER");
        address sender = msg.sender;

        // The one mistake that cannot be corrected and would not be noticed: a router
        // pointed at something that is not the PoolManager the markets are on would
        // accept trades, settle nothing, and revert every swap — after markets had
        // already been deployed trusting its address.
        require(poolManager.code.length > 0, "POOL_MANAGER has no code on this chain");
        require(sender != address(0), "no sender");

        vm.startBroadcast(sender);
        router = new AgenRouter(IPoolManager(poolManager));
        vm.stopBroadcast();

        require(address(router.poolManager()) == poolManager, "router names a different pool manager");
        require(address(router).code.length > 0, "router has no code");

        console.log("");
        console.log("AgenRouter deployed. Record it and never replace it:");
        console.log("");
        console.log("NEXT_PUBLIC_AGEN_ROUTER", address(router));
        console.log("pool manager           ", poolManager);
        console.log("runtime code hash      ", vm.toString(address(router).codehash));
        console.log("");
        console.log("Set `router` on this chain's record in packages/config/src/deployments.ts.");
    }
}
