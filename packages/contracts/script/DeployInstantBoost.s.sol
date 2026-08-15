// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {BoostEscrowFactory} from "../src/BoostEscrowFactory.sol";
import {BoostTreasury} from "../src/BoostTreasury.sol";
import {IAgenRouter, IInstantFactory} from "../src/BoostEscrow.sol";
import {FactoryOrigin} from "../src/FactoryOrigin.sol";
import {InstantDeployer} from "../src/InstantDeployer.sol";
import {InstantFactory} from "../src/InstantFactory.sol";
import {InstantHook} from "../src/InstantHook.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {DeployInstant} from "./DeployInstant.s.sol";

/// @title DeployInstantBoost
/// @notice Brings up an Instant deployment whose platform fee goes into Boost: the four Instant
/// contracts, plus `BoostTreasury` and `BoostEscrowFactory`, in one pass.
///
/// @dev **This exists because the two halves cannot be deployed separately.**
///
/// Boost captures the creator's 1.00% by being the address a launch names as its `feeRecipient`,
/// which is a per-launch argument and needs nothing at deployment time. It captures the platform's
/// 0.50% by being the address the *factory* names as its `treasury` — and that is an immutable
/// every vault snapshots at creation. So `BoostTreasury` has to exist before the Instant factory
/// that pays it, and the factory's address has to be known before the escrow factory that derives
/// pool keys from it. One script, or an ordering mistake nobody can repair.
///
/// Deploying Instant against an ordinary address and adding Boost afterwards produces markets whose
/// platform fee can never be Boosted. Not "not yet" — never, for those markets, because
/// `InstantFactory.treasury` has no setter and the vault snapshots it. See ADR-015.
///
/// ## Why there is nothing to predict
///
/// An earlier cut of this script computed the escrow factory's address from the sender's nonce.
/// `DeployInstant`'s own header explains why that is a bad idea — a contract's nonce counts
/// creations and an account's counts transactions, so an offset that works under `forge test` is
/// not the one that works under `--broadcast`, and the difference surfaces where it cannot be
/// undone.
///
/// It is not needed. Two facts make the order acyclic:
///
///  1. `FactoryOrigin` publishes the address of its own first creation from its constructor, so the
///     Instant factory's address is *readable* before anything else is deployed. That is ADR-007.
///  2. A `BoostEscrow` reads its market's platform-fee route from that market's own vault rather
///     than being told it in a constructor, so the escrow factory does not name the treasury.
///
/// Which leaves one direction of dependency and one order:
///
///   origin → deployer, registry → escrow factory → treasury → hook → factory
///
/// Every address is read off something already deployed. Nothing is guessed, and the factory's own
/// constructor plus the checks below close the loop.
///
/// ## Running it
///
/// Simulate first — no key, real chain state. This prints the whole address book:
///
///   POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951 \
///   POSITION_MANAGER=0x58daec3116aae6D93017bAAea7749052E8a04fA7 \
///   AGEN_ROUTER=0xFaf5734973329797fCD032fa80a8277E906c187A \
///   AGEN_TREASURY=0xabfB34D1C870c7b2334E93b25B1299346209bE38 \
///   forge script script/DeployInstantBoost.s.sol --rpc-url robinhood --sender 0xYOU
///
/// Then add `--broadcast --private-key $KEY`. `TREASURY` is deliberately **not** an input: it is
/// the `BoostTreasury` this script deploys, and accepting one would reintroduce the mistake the
/// script exists to prevent.
contract DeployInstantBoost is DeployInstant {
    struct BoostDeployment {
        BoostTreasury treasury;
        BoostEscrowFactory escrows;
    }

    /// @dev A stand-in for the one input this script produces rather than accepts.
    ///
    /// `_validate` requires a non-zero treasury and phase 5 overwrites this with the `BoostTreasury`
    /// it deployed, so the value is never used for anything. It is a named constant rather than
    /// `address(this)` because Foundry refuses that in a script — a script contract is ephemeral and
    /// its address must not be relied on — and rather than `address(1)` because a reader finding
    /// this in a trace should be told immediately that it is a placeholder and not a treasury.
    address internal constant TREASURY_SET_IN_PHASE_5 = 0x000000000000000000000000000000000000dEaD;

    struct BoostInputs {
        /// @dev Where the platform 0.50% goes when a market's Boost is off. Agen's own address.
        address agenTreasury;
        /// @dev The shared router every buyback trades through. Already deployed; never replaced.
        address agenRouter;
    }

    /// @notice The Boost contracts this run produced.
    /// @dev Storage rather than a second return value, because `run` overrides the base script's
    /// and an override cannot change the return type. Readable after the script has finished, which
    /// is what a harness test needs.
    BoostDeployment public boost;

    function run() public override returns (Deployment memory out) {
        Inputs memory input = _inputs();
        BoostInputs memory boostInput = _boostInputs();

        vm.startBroadcast(input.sender);

        // Phase 1: the anchor. The factory's address is now readable, which is what lets the escrow
        // factory be told it before the factory exists.
        out.origin = new FactoryOrigin(input.sender);
        address factoryAddress = out.origin.factory();
        require(factoryAddress.code.length == 0, "the anchored factory address is already occupied");

        // Phase 2: the two contracts that name the factory.
        out.deployer = new InstantDeployer(factoryAddress);
        out.registry = new MarketRegistry(factoryAddress);

        // Phase 3: Boost. The escrow factory needs the registry and the factory's address, both of
        // which exist; the treasury needs the escrow factory, which now does too.
        boost.escrows = new BoostEscrowFactory(
            out.registry,
            IInstantFactory(factoryAddress),
            IAgenRouter(boostInput.agenRouter),
            IPoolManager(input.poolManager)
        );
        boost.treasury = new BoostTreasury(boostInput.agenTreasury, boost.escrows);

        // Phase 4: the hook, at an address carrying its own permissions.
        bytes memory hookInitcode = abi.encodePacked(
            type(InstantHook).creationCode,
            abi.encode(IPoolManager(input.poolManager), factoryAddress, input.positionManager)
        );
        bytes32 salt = _mine(hookInitcode);
        out.hook = InstantHook(_create2(salt, hookInitcode));

        // Phase 5: the factory, paying the treasury deployed above. This is the line the whole
        // script exists to get right.
        input.treasury = address(boost.treasury);
        out.factory = InstantFactory(payable(out.origin.deployFactory(_factoryInitcode(input, out))));

        vm.stopBroadcast();

        _checkInstant(input, out, factoryAddress);
        _checkBoost(boostInput, out, boost, factoryAddress);
        _reportBoost(boostInput, salt, out, boost);
    }

    /// @dev `DeployInstant`'s own assertions, restated because that script does them inline in a
    /// `run` this one replaces. Every one is a wiring a wrong deployment would satisfy silently.
    function _checkInstant(Inputs memory input, Deployment memory out, address factoryAddress) internal view {
        require(address(out.factory) == factoryAddress, "factory is not at the anchored address");
        require(address(out.factory.hook()) == address(out.hook), "factory does not name the deployed hook");
        require(out.hook.factory() == address(out.factory), "hook is not bound to the factory");
        require(out.deployer.factory() == address(out.factory), "deployer is not bound to the factory");
        require(out.registry.writer() == address(out.factory), "registry writer is not the factory");
        require(address(out.factory.deployer()) == address(out.deployer), "factory names a different deployer");
        require(address(out.factory.marketRegistry()) == address(out.registry), "factory names a different registry");
        require(address(out.factory.poolManager()) == input.poolManager, "factory names a different pool manager");
        require(
            address(out.factory.positionManager()) == input.positionManager,
            "factory names a different position manager"
        );
        require(out.registry.marketCount() == 0, "a freshly deployed registry already has markets in it");
    }

    /// @dev The checks that matter for Boost, and the first is the one that cannot be fixed later.
    function _checkBoost(
        BoostInputs memory boostInput,
        Deployment memory out,
        BoostDeployment memory deployed,
        address factoryAddress
    ) internal view {
        // Without this, every market this factory ever creates pays its platform fee to an address
        // Boost cannot reach, permanently.
        require(out.factory.treasury() == address(deployed.treasury), "the factory does not pay the Boost treasury");

        require(deployed.treasury.agenTreasury() == boostInput.agenTreasury, "treasury pays a different address");
        require(
            address(deployed.treasury.escrowFactory()) == address(deployed.escrows),
            "treasury trusts another escrow factory"
        );

        require(address(deployed.escrows.marketRegistry()) == address(out.registry), "escrows read another registry");
        require(
            address(deployed.escrows.instantFactory()) == factoryAddress, "escrows derive pools from another factory"
        );
        require(address(deployed.escrows.agenRouter()) == boostInput.agenRouter, "escrows trade through another router");
        require(
            address(deployed.escrows.poolManager()) == address(out.factory.poolManager()),
            "escrows read another pool manager"
        );
    }

    function _boostInputs() internal view virtual returns (BoostInputs memory boostInput) {
        boostInput.agenTreasury = vm.envAddress("AGEN_TREASURY");
        boostInput.agenRouter = vm.envAddress("AGEN_ROUTER");

        require(boostInput.agenTreasury != address(0), "AGEN_TREASURY must be set");
        require(boostInput.agenRouter.code.length > 0, "AGEN_ROUTER has no code on this chain");
    }

    /// @dev `TREASURY` is produced rather than consumed, so the base script's requirement that it
    /// be set is satisfied here with a placeholder that phase 5 overwrites. Overriding the whole
    /// input reader rather than the environment keeps `vm.setEnv` out of it, which the base script's
    /// own note explains is not rolled back between test cases.
    function _inputs() internal view virtual override returns (Inputs memory input) {
        input.sender = _sender();
        input.poolManager = vm.envAddress("POOL_MANAGER");
        input.positionManager = vm.envAddress("POSITION_MANAGER");
        input.treasury = TREASURY_SET_IN_PHASE_5;

        _validate(input);
    }

    function _reportBoost(
        BoostInputs memory boostInput,
        bytes32 salt,
        Deployment memory out,
        BoostDeployment memory deployed
    ) internal view {
        console.log("");
        console.log("Instant + Boost are deployed. Record these in packages/config/src/deployments.ts:");
        console.log("");
        console.log("  instant.factory      ", address(out.factory));
        console.log("  instant.deployer     ", address(out.deployer));
        console.log("  instant.registry     ", address(out.registry));
        console.log("  instant.hook         ", address(out.hook));
        console.log("  instant.factoryOrigin", address(out.origin), "(spent)");
        console.log("  instant.treasury     ", address(deployed.treasury), "<- the BoostTreasury, not an EOA");
        console.log("");
        console.log("  deployed.escrowFactory  ", address(deployed.escrows));
        console.log("  deployed.treasury       ", address(deployed.treasury));
        console.log("  deployed.deadAddress     0x000000000000000000000000000000000000dEaD");
        console.log("");
        console.log("  agen treasury (Boost off)", boostInput.agenTreasury);
        console.log("  hook salt                ", vm.toString(salt));
        console.log("  factory runtime code hash", vm.toString(address(out.factory).codehash));
        console.log("  hook runtime code hash   ", vm.toString(address(out.hook).codehash));
        console.log("");
        console.log("Markets created by THIS factory route both fee streams into Boost (1.50%).");
        console.log("Markets from the previous Instant deployment keep 1.00% creator / 0.50% Agen.");
    }
}
