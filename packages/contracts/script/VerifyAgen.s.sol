// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {AgenDeployer} from "../src/agen/AgenDeployer.sol";
import {AgenFactory} from "../src/agen/AgenFactory.sol";
import {AgenMarketRegistry} from "../src/agen/AgenMarketRegistry.sol";
import {FactoryOrigin} from "../src/FactoryOrigin.sol";

/// @title VerifyAgen
/// @notice Reads an Agen deployment off the chain and checks it is the one that was
/// intended. Run it immediately after `DeployAgen.s.sol --broadcast`, before putting
/// the addresses into any environment.
///
/// @dev The argument for this existing separately from the deployment is `Verify.s.sol`'s
/// in full, and it applies here for the same reason: `DeployAgen.s.sol` asserts as it
/// goes, but those assertions run inside the transaction that created the contracts,
/// against values that same script computed. Pointed at the wrong PoolManager it would
/// deploy a perfectly self-consistent Agen wired to a Uniswap that is not the one on
/// this chain, and report success.
///
/// This starts from the other end. It is given the factory and takes everything else
/// from what the factory says its counterparties are, then asks each of them who they
/// think the factory is. Nothing here can repair anything — every wiring in Agen is an
/// immutable, so the only response to a failure is to deploy again at a fresh anchor and
/// abandon what is on chain.
///
/// ## Running it
///
///   FACTORY=0x... forge script script/VerifyAgen.s.sol --rpc-url robinhood
///
/// Optional, and worth setting on the real run:
///
///   ORIGIN=0x...  the anchor, so its one-shot is confirmed spent
///
/// It broadcasts nothing and needs no key.
contract VerifyAgen is Script {
    /// @dev The Uniswap deployment on 4663 (V1 in docs/verification.md). Defaults rather
    /// than requirements, so a run against this chain does not have to restate them and
    /// risk a typo.
    address internal constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEFAULT_POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;

    struct Config {
        address factory;
        address origin;
        address poolManager;
        address positionManager;
    }

    /// @dev Counted rather than reverted on, so one run reports every problem. A
    /// deployment is discarded whole; learning its faults one round trip at a time is
    /// worse than useless when each round trip is a fresh deployment.
    uint256 private failures;
    uint256 private warnings;

    function run() external returns (uint256 warned) {
        Config memory cfg = _config();
        AgenFactory factory = AgenFactory(payable(cfg.factory));

        console.log("chain id    ", block.chainid);
        console.log("AgenFactory ", address(factory));
        console.log("");

        _requireCode("AgenFactory", address(factory));
        if (failures > 0) {
            console.log("");
            console.log("FACTORY has no code on this chain. Nothing else can be checked.");
            revert("verification failed");
        }

        _checkTopology(factory, cfg);
        _checkRegistry(factory);
        _checkBuild(factory);

        console.log("");
        if (failures > 0) {
            console.log("FAILED:", failures, "problem(s). Do not use these addresses.");
            revert("verification failed");
        }
        console.log("Verified.", warnings, "warning(s). See above.");
        return warnings;
    }

    /// @dev `virtual` for the same reason the other scripts' readers are: the process
    /// environment is global and Foundry does not roll it back between test cases.
    function _config() internal view virtual returns (Config memory cfg) {
        cfg.factory = vm.envAddress("FACTORY");
        cfg.origin = vm.envOr("ORIGIN", address(0));
        cfg.poolManager = vm.envOr("POOL_MANAGER", DEFAULT_POOL_MANAGER);
        cfg.positionManager = vm.envOr("POSITION_MANAGER", DEFAULT_POSITION_MANAGER);
    }

    /// @dev Every edge, from both ends.
    function _checkTopology(AgenFactory factory, Config memory cfg) private {
        AgenDeployer deployer = factory.deployer();
        AgenMarketRegistry registry = factory.registry();

        console.log("--- topology ---");
        console.log("AgenDeployer      ", address(deployer));
        console.log("AgenMarketRegistry", address(registry));
        console.log("PoolManager       ", address(factory.poolManager()));
        console.log("PositionManager   ", address(factory.positionManager()));
        console.log("");

        _requireCode("AgenDeployer", address(deployer));
        _requireCode("AgenMarketRegistry", address(registry));

        // The two back-references. Every market's provenance rests on these: the
        // deployer will only build for this factory, and the registry will only let it
        // write. Either pointing elsewhere means markets that cannot be created, or —
        // worse — a registry any address can write entries into.
        _check(deployer.factory() == address(factory), "the deployer is bound to this factory");
        _check(registry.factory() == address(factory), "the registry is bound to this factory");

        _check(
            address(factory.poolManager()) == cfg.poolManager, "the factory's PoolManager is the expected one"
        );
        _check(
            address(factory.positionManager()) == cfg.positionManager,
            "the factory's PositionManager is the expected one"
        );

        _requireCode("PoolManager", cfg.poolManager);
        _requireCode("PositionManager", cfg.positionManager);

        address origin = cfg.origin;
        if (origin == address(0)) {
            _warn("ORIGIN not set, so the anchor's spent one-shot was not confirmed");
        } else {
            _check(FactoryOrigin(origin).factory() == address(factory), "the anchor published this factory's address");
            _check(FactoryOrigin(origin).used(), "the anchor's single creation is spent");
        }
    }

    /// @dev A registry with entries in it before anybody has launched anything is not a
    /// fresh deployment, which means this is being run against the wrong address or a
    /// second launch has already happened through it.
    function _checkRegistry(AgenFactory factory) private {
        AgenMarketRegistry registry = factory.registry();

        console.log("--- registry ---");
        console.log("markets recorded  ", registry.count());
        console.log("");

        if (registry.count() != 0) {
            _warn("the registry already has markets in it, so this is not a fresh deployment");
        }
    }

    /// @dev Whether the code on chain is the length this commit builds. Immutables live
    /// in the runtime code so the bytes cannot be compared against an artefact directly,
    /// but their placeholders occupy the same space and the lengths must agree. A
    /// mismatch means the chain is running a different build from the one being read,
    /// which makes every other check here a statement about the wrong source.
    function _checkBuild(AgenFactory factory) private {
        console.log("--- build ---");
        _compare("AgenFactory", address(factory), "AgenFactory.sol:AgenFactory");
        _compare("AgenDeployer", address(factory.deployer()), "AgenDeployer.sol:AgenDeployer");
        _compare("AgenMarketRegistry", address(factory.registry()), "AgenMarketRegistry.sol:AgenMarketRegistry");
    }

    function _compare(string memory label, address deployed, string memory artifact) private {
        uint256 onChain = deployed.code.length;
        uint256 built = vm.getDeployedCode(artifact).length;

        if (onChain == built) {
            console.log(string.concat("  ", label, ": ", vm.toString(onChain), " bytes, matches this build"));
        } else {
            _warn(
                string.concat(
                    label,
                    ": ",
                    vm.toString(onChain),
                    " bytes on chain, ",
                    vm.toString(built),
                    " in this build \u2014 not the same source"
                )
            );
        }
    }

    function _requireCode(string memory label, address target) private {
        _check(target.code.length > 0, string.concat(label, " has code"));
    }

    function _check(bool ok, string memory what) private {
        if (ok) {
            console.log(string.concat("  ok    ", what));
        } else {
            failures++;
            console.log(string.concat("  FAIL  ", what));
        }
    }

    function _warn(string memory what) private {
        warnings++;
        console.log(string.concat("  warn  ", what));
    }
}
