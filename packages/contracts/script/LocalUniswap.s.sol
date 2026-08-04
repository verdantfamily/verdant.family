// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";

import {Multicall3Lite} from "./Multicall3Lite.sol";

/// @title A Uniswap v4 for a machine with no chain
///
/// @notice Deploys a PoolManager, a PositionManager, a swap router and a quoter to
/// whatever node this is pointed at. **For local rigs only.** Nothing here is ever
/// run against a real chain: 4663 already has Uniswap, and deploying a second one
/// there would create a parallel Uniswap with no liquidity and no users.
///
/// @dev It exists so that the indexer's end-to-end proof can run with no network at
/// all. The alternative is forking 4663, which is slower, needs an RPC that may be
/// down, and makes a CI job depend on somebody else's uptime — the exact property
/// that made the fork suite a warn-only gate rather than a blocking one.
///
/// ## These contracts are not byte-identical to the deployed ones
///
/// This repository compiles PoolManager to 26 988 bytes and PositionManager to
/// 28 210, both over EIP-170, because `foundry.toml` optimises for runtime gas at a
/// million runs. The ones deployed on 4663 are 24 009 and 23 877, built with
/// Uniswap's own settings (V1 in docs/verification.md). So a node running these
/// needs `anvil --disable-code-size-limit`, and a proof that runs here is a proof
/// about Verdant's own logic rather than about the deployed bytecode.
///
/// That is the right division of labour: the fork suite is what asserts things about
/// the real Uniswap, and it does. What the local rig proves is that the indexer, the
/// SDK and the contracts agree — which does not depend on which build of v4 is
/// underneath.
///
/// ## The quoter is deployed here and then moved
///
/// `V4Quoter` is deployed at whatever address the broadcaster's nonce gives it, and
/// `scripts/indexer-proof.sh` copies its runtime code to the address
/// `EXTERNAL_ADDRESSES.v4Quoter` names. That is the address the interface and the SDK
/// read a quote from, by chain id, and the rig runs at chain id 4663 — so without the
/// move the app's own code path could not be exercised at all. The address printed
/// below is where it lands first; see that script for why relocating runtime code is
/// sound.
contract LocalUniswap is Script {
    function run()
        external
        returns (
            PoolManager manager,
            PositionManager positionManager,
            PoolSwapTest swapRouter,
            Multicall3Lite multicall,
            V4Quoter quoter
        )
    {
        vm.startBroadcast();

        // The owner takes no part in anything Verdant does: protocol fees are a v4
        // feature Verdant never turns on, and the local rig has no use for it. The
        // broadcaster is used rather than address(0) so the contract is not
        // ownerless in a way that reads as deliberate configuration.
        manager = new PoolManager(msg.sender);

        // Permit2 and the descriptor are never reached. The factory settles the
        // token side from the PositionManager's own balance rather than through an
        // allowance, and nothing in a headless rig renders a position's SVG. Same
        // arguments as the unit suite's setUp, for the same reasons.
        positionManager = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        swapRouter = new PoolSwapTest(manager);

        // Not Uniswap's, but the same kind of missing furniture: anvil predeploys no
        // Multicall3, and the SDK's read layer batches through one.
        multicall = new Multicall3Lite();

        // The one piece of Uniswap's periphery the *interface* talks to directly. A
        // trade panel takes its number from here and nowhere else, because a Verdant
        // pool's stored fee is stage 0's forever, so anything reading `slot0` would
        // quote the opening fee for the life of the market.
        quoter = new V4Quoter(manager);

        vm.stopBroadcast();

        console.log("POOL_MANAGER    ", address(manager));
        console.log("POSITION_MANAGER", address(positionManager));
        console.log("SWAP_ROUTER     ", address(swapRouter));
        console.log("MULTICALL3      ", address(multicall));
        console.log("V4_QUOTER_STAGED", address(quoter));
    }
}
