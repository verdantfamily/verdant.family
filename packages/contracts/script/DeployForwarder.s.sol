// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {FeeForwarderFactory} from "../src/FeeForwarderFactory.sol";

/// @title DeployForwarder
/// @notice Deploys the fee-forwarder factory, which is an addition to a Verdant
/// deployment rather than a part of one.
///
/// @dev A separate script on purpose. `Deploy.s.sol` brings up the protocol in the
/// one order that can work, and every contract in it names the others in
/// immutables — so adding anything to that script means redeploying all of it, and
/// the markets already trading under the current deployment keep their old
/// factory, hook and registries regardless. This contract is wired to none of
/// them. It knows nothing about Verdant beyond the shape of `FeeSplitter.claim`,
/// and a market opts into it by naming a forwarder as its fee recipient at launch.
///
/// So it can be deployed at any time, by anyone, without touching what is live —
/// which is the whole reason the automatic-payout arrangement was built this way
/// instead of as a new splitter.
///
/// ## Running it
///
/// Simulate first. `robinhood` is the endpoint alias in `foundry.toml`, so the URL
/// is not repeated here and cannot drift from the one the fork suite uses:
///
///   forge script script/DeployForwarder.s.sol --rpc-url robinhood --sender $YOU
///
/// Then broadcast. `--interactives 1` prompts for the key rather than taking it as
/// an argument, which is how every other deployment in this repository is done —
/// see `scripts/deploy-mainnet.sh`. A key in argv is a key in `ps` output and in
/// shell history, and one in the environment is a key in every child process:
///
///   forge script script/DeployForwarder.s.sol --rpc-url robinhood \
///     --sender $YOU --interactives 1 --broadcast
///
/// Then record the printed address in `packages/config/src/deployments.ts` under
/// `ADDONS`, which is where the interface reads it from. Until it is recorded the
/// interface offers no automatic payouts, which is the correct behaviour for a
/// build that does not know where the factory is.
///
/// Unlike `Deploy.s.sol` this is recoverable. Nothing points at the factory except
/// that one line of config, and a market only commits to a forwarder address when
/// it launches — so a factory deployed to the wrong chain, or by the wrong key, is
/// abandoned by deploying another one and changing the line.
contract DeployForwarder is Script {
    function run() external returns (FeeForwarderFactory factory) {
        vm.startBroadcast();
        factory = new FeeForwarderFactory();
        vm.stopBroadcast();

        console.log("--- deployed ---");
        console.log("FeeForwarderFactory", address(factory));
        console.log("");
        console.log("Record this in packages/config/src/deployments.ts under ADDONS.");
    }
}
