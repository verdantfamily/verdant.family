// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

import {FactoryOrigin} from "../src/FactoryOrigin.sol";
import {InstantDeployer} from "../src/InstantDeployer.sol";
import {InstantFactory} from "../src/InstantFactory.sol";
import {InstantHook} from "../src/InstantHook.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";

/// @title VerifyInstant
/// @notice Reads an Instant deployment off the chain and checks it is the one that was
/// intended. Run it immediately after `DeployInstant.s.sol --broadcast`, before putting the
/// addresses into any environment.
///
/// @dev `DeployInstant.s.sol` asserts as it goes, but those assertions run inside the
/// transaction that created the contracts, against values that same script computed.
/// Pointed at the wrong PoolManager it would deploy a perfectly self-consistent Instant
/// wired to a Uniswap that is not the one on this chain, and report success.
///
/// This starts from the other end. It is given the factory and takes everything else from
/// what the factory says its counterparties are, then asks each of them who they think the
/// factory is. Nothing here can repair anything — every wiring in Instant is an immutable
/// and the hook's permissions are its address, so the only response to a failure is to
/// deploy again at a fresh anchor and abandon what is on chain.
///
/// ## Running it
///
///   FACTORY=0x... forge script script/VerifyInstant.s.sol --rpc-url robinhood
///
/// Optional, and both worth setting on the real run:
///
///   ORIGIN=0x...             the anchor, so its one-shot is confirmed spent
///   EXPECTED_TREASURY=0x...  where the platform's 0.50% must accrue
///
/// It broadcasts nothing and needs no key.
contract VerifyInstant is Script {
    /// @dev The Uniswap deployment on 4663 (V1 in docs/verification.md). Defaults rather
    /// than requirements, so a run against this chain does not have to restate them and
    /// risk a typo.
    address internal constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEFAULT_POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;

    /// @dev The seven bits an Instant hook's address must carry. See `DeployInstant`.
    uint160 internal constant REQUIRED_BITS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    struct Config {
        address factory;
        address origin;
        address poolManager;
        address positionManager;
        address treasury;
    }

    /// @dev Counted rather than reverted on, so one run reports every problem. A deployment
    /// is discarded whole; learning its faults one round trip at a time is worse than
    /// useless when each round trip is a fresh deployment.
    uint256 private failures;
    uint256 private warnings;

    function run() external returns (uint256 warned) {
        Config memory cfg = _config();
        InstantFactory factory = InstantFactory(payable(cfg.factory));

        console.log("chain id      ", block.chainid);
        console.log("InstantFactory", address(factory));
        console.log("");

        _requireCode("InstantFactory", address(factory));
        if (failures > 0) {
            console.log("");
            console.log("FACTORY has no code on this chain. Nothing else can be checked.");
            revert("verification failed");
        }

        _checkTopology(factory, cfg);
        _checkHook(factory);
        _checkEconomics(factory, cfg);
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
        cfg.treasury = vm.envOr("EXPECTED_TREASURY", address(0));
    }

    /// @dev Every edge, from both ends.
    function _checkTopology(InstantFactory factory, Config memory cfg) private {
        InstantHook hook = factory.hook();
        InstantDeployer deployer = factory.deployer();
        MarketRegistry registry = factory.marketRegistry();

        console.log("--- topology ---");
        console.log("InstantHook    ", address(hook));
        console.log("InstantDeployer", address(deployer));
        console.log("MarketRegistry ", address(registry));
        console.log("PoolManager    ", address(factory.poolManager()));
        console.log("PositionManager", address(factory.positionManager()));
        console.log("");

        _requireCode("InstantHook", address(hook));
        _requireCode("InstantDeployer", address(deployer));
        _requireCode("MarketRegistry", address(registry));

        // The three back-references. Every market's provenance rests on these: the hook
        // will only serve this factory's pools, the deployer will only build for it, and
        // the registry will only let it write.
        _check(hook.factory() == address(factory), "the hook is bound to this factory");
        _check(deployer.factory() == address(factory), "the deployer is bound to this factory");
        _check(registry.writer() == address(factory), "the registry is writable only by this factory");

        _check(address(factory.poolManager()) == cfg.poolManager, "the factory's PoolManager is the expected one");
        _check(
            address(factory.positionManager()) == cfg.positionManager,
            "the factory's PositionManager is the expected one"
        );
        _check(address(hook.poolManager()) == cfg.poolManager, "the hook's PoolManager is the same as the factory's");

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

    /// @dev The hook's permissions, which are its address and cannot be changed.
    ///
    /// The two delta bits are called out separately because their absence is the failure
    /// that looks like success: v4 would simply not read the fee the hook returns, every
    /// swap would balance, and Instant would charge nothing while appearing to work.
    function _checkHook(InstantFactory factory) private {
        uint160 bits = uint160(address(factory.hook())) & Hooks.ALL_HOOK_MASK;

        console.log("--- hook permissions ---");
        console.log("address bits", bits);
        console.log("required    ", REQUIRED_BITS);
        console.log("");

        _check(bits == REQUIRED_BITS, "the hook address carries exactly the seven required permissions");
        _check(
            bits & uint160(Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG) != 0,
            "the hook may take a fee from a buy (beforeSwapReturnsDelta)"
        );
        _check(
            bits & uint160(Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG) != 0,
            "the hook may take a fee from a sell (afterSwapReturnsDelta)"
        );
    }

    /// @dev The two constants a creator is never asked about, and the one address that
    /// cannot be corrected afterwards.
    function _checkEconomics(InstantFactory factory, Config memory cfg) private {
        console.log("--- economics ---");
        console.log("supply       ", factory.SUPPLY());
        console.log("opening tick ", factory.INITIAL_TICK());
        console.log("treasury     ", factory.treasury());
        console.log("");

        _check(factory.treasury() != address(0), "the treasury is not the zero address");

        if (cfg.treasury == address(0)) {
            _warn("EXPECTED_TREASURY not set, so the fee destination was not confirmed");
        } else {
            // Unrecoverable if wrong: it is immutable here and every market's vault
            // snapshots it at creation.
            _check(factory.treasury() == cfg.treasury, "the treasury is the one that was intended");
        }
    }

    /// @dev A registry with entries in it before anybody has launched anything is not a
    /// fresh deployment, which means this is being run against the wrong address or a
    /// launch has already happened through it.
    function _checkRegistry(InstantFactory factory) private {
        MarketRegistry registry = factory.marketRegistry();

        console.log("--- registry ---");
        console.log("markets recorded", registry.marketCount());
        console.log("");

        if (registry.marketCount() != 0) {
            _warn("the registry already has markets in it, so this is not a fresh deployment");
        }
    }

    /// @dev Whether the code on chain is the length this commit builds. Immutables live in
    /// the runtime code so the bytes cannot be compared against an artefact directly, but
    /// their placeholders occupy the same space and the lengths must agree. A mismatch
    /// means the chain is running a different build from the one being read, which makes
    /// every other check here a statement about the wrong source.
    function _checkBuild(InstantFactory factory) private {
        console.log("--- build ---");
        _compare("InstantFactory", address(factory), "InstantFactory.sol:InstantFactory");
        _compare("InstantHook", address(factory.hook()), "InstantHook.sol:InstantHook");
        _compare("InstantDeployer", address(factory.deployer()), "InstantDeployer.sol:InstantDeployer");
        _compare("MarketRegistry", address(factory.marketRegistry()), "MarketRegistry.sol:MarketRegistry");
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
