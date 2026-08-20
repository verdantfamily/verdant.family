// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {CreatorSeatFactory} from "../src/CreatorSeatFactory.sol";

/// @title DeployCreatorSeat
/// @notice Deploys the seat factory, which is an addition to a deployment rather than a part of
/// one, and is the single transaction the seat surface is waiting on.
///
/// @dev A separate script for the reason `DeployForwarder.s.sol` gives: `DeployInstant.s.sol`
/// brings up the launch layer in the one order that can work, and every contract in it names the
/// others in immutables, so adding anything to that script means redeploying all of it while the
/// markets already trading keep the old factory anyway. This contract is wired to none of them. A
/// market opts in by naming a seat as its fee recipient at launch, and nothing else points at it.
///
/// ## What is not recoverable
///
/// A seat's address is derived from this factory's address and from `CreatorSeat`'s compiled
/// bytecode, so a second factory — or the same source compiled with different settings — produces
/// different seats at different addresses. Markets that already named a seat from the first factory
/// keep paying it, and `InstantFeeVault.creator` is immutable, so those entitlements cannot be
/// moved to seats from the replacement.
///
/// The practical consequence is that this may be deployed twice only while nothing has launched
/// against it. Once one X launch has named a seat, this factory's address is load-bearing forever.
/// Build with the repository's own settings — the default profile in `foundry.toml`, solc 0.8.26,
/// the optimizer at 1,000,000 runs, `cancun` — and do not deploy from a tree with local changes to
/// `CreatorSeat.sol`.
///
/// ## STEWARD, and why zero is the one input that cannot be corrected
///
/// `steward` is the address permitted to call `propose` on seats from this factory: Agen's CTO
/// path, by which a community can be given a market whose creator has walked away. It is
/// rotatable, through a two-step `offerSteward` / `acceptSteward` handover, and it can be given up
/// one-way with `renounceSteward`.
///
/// What it cannot be is added later. A factory deployed with the zero address has no steward and
/// no way to grow one, so every seat it ever deploys is occupant-only. That may be what you want,
/// and it is not an error — but it is the asymmetric choice, so this script requires the variable
/// to be set explicitly and prints what it means either way. Set it to a Safe rather than to a hot
/// key: the steward cannot take a seat's fees, but it can propose an occupant, and the whole point
/// of the two-step handover is that no single mistake is final.
///
/// The X bot does not need a steward. It seats fees for X launches through `offer` and `take`
/// between the opener and the claimant, which is occupant-to-occupant and never asks the factory.
/// A steward is worth deploying with anyway, because the alternative is permanent.
///
/// ## Running it
///
/// Simulate first. `robinhood` is the endpoint alias in `foundry.toml`, so the URL is not repeated
/// here and cannot drift from the one the fork suite uses:
///
///   STEWARD=0xSAFE forge script script/DeployCreatorSeat.s.sol \
///     --rpc-url robinhood --sender 0xYOU
///
/// Then broadcast. `--interactives 1` prompts for the key rather than taking it as an argument,
/// which is how every other deployment in this repository is done — see `scripts/deploy-mainnet.sh`
/// and `scripts/deploy-instant.sh`. A key in argv is a key in `ps` output and in shell history, and
/// one in the environment is a key in every child process:
///
///   STEWARD=0xSAFE forge script script/DeployCreatorSeat.s.sol \
///     --rpc-url robinhood --sender 0xYOU --interactives 1 --broadcast
///
/// Then record the printed address in `packages/config/src/deployments.ts`, under
/// `ADDONS[ROBINHOOD_MAINNET_ID].creatorSeatFactory`, which is where every consumer reads it from.
/// Until it is recorded the X bot declines to launch and says so, which is the correct behaviour
/// for a build that does not know where the factory is.
contract DeployCreatorSeat is Script {
    function run() external returns (CreatorSeatFactory factory) {
        // Read explicitly rather than defaulting to zero. `vm.envAddress` reverts when the variable
        // is absent, which is what turns "forgot to set STEWARD" into a failed simulation instead of
        // a factory whose CTO path is off forever.
        address steward = vm.envAddress("STEWARD");

        console.log("--- about to deploy ---");
        console.log("steward", steward);
        if (steward == address(0)) {
            console.log("");
            console.log("STEWARD is zero. Seats from this factory will be occupant-only and");
            console.log("`propose` will revert on all of them, permanently. This cannot be undone");
            console.log("on this factory. Stop now unless that is deliberate.");
        }
        console.log("");

        vm.startBroadcast();
        factory = new CreatorSeatFactory(steward);
        vm.stopBroadcast();

        // Asserted rather than assumed: a simulation that printed an address and a broadcast that
        // deployed something else wired differently is the failure this whole section is about.
        require(address(factory).code.length > 0, "nothing was deployed");
        require(factory.steward() == steward, "factory does not name the steward it was given");
        require(factory.pendingSteward() == address(0), "a fresh factory has a steward offer open");

        console.log("--- deployed ---");
        console.log("CreatorSeatFactory", address(factory));
        console.log("steward           ", factory.steward());
        console.log("");
        console.log("Record this in packages/config/src/deployments.ts as");
        console.log("ADDONS[ROBINHOOD_MAINNET_ID].creatorSeatFactory, then verify on Blockscout.");
    }
}
