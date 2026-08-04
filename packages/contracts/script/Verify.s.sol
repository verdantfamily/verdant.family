// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

import {FactoryOrigin} from "../src/FactoryOrigin.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";
import {VerdantDeployer} from "../src/VerdantDeployer.sol";
import {VerdantFactory} from "../src/VerdantFactory.sol";
import {VerdantHook} from "../src/VerdantHook.sol";

/// @title Verify
/// @notice Reads a deployment off the chain and checks it is the one that was
/// intended. Run it immediately after `Deploy.s.sol --broadcast`, before telling
/// anybody the addresses.
///
/// @dev ## Why this exists separately from the deployment
///
/// `Deploy.s.sol` asserts as it goes, and every constructor checks its own wiring.
/// But those checks run inside the transaction that creates the contracts, against
/// values that same script just computed. If the script were pointed at the wrong
/// PositionManager, or seeded from a `bounds.json` that had drifted, it would deploy
/// a self-consistent protocol wired to the wrong things and report success.
///
/// This script starts from the other end. It is given one address — the factory —
/// and takes everything else from what the factory itself says its counterparties
/// are. Then it asks each of those contracts who *they* think the factory is. A
/// deployment passes only if every edge is confirmed from both ends, which is a
/// different question from the one the deployment answered.
///
/// Nothing here can repair anything. Verdant has no setters on the launch path, so
/// the only response to a failure is to deploy again at a fresh anchor and abandon
/// what is on chain. That is exactly why this runs before the addresses are
/// published rather than after somebody launches a market.
///
/// ## Running it
///
///   FACTORY=0x... forge script script/Verify.s.sol --rpc-url robinhood
///
/// Optional, and worth setting on the real run, because without them the intent
/// they encode is not checked at all:
///
///   ORIGIN=0x...                  the anchor, so its one-shot is confirmed spent
///   EXPECTED_TREASURY=0x...       what the fee split should pay
///   EXPECTED_REGISTRY_OWNER=0x... who may move a bound for future markets
///
/// It broadcasts nothing and needs no key.
contract Verify is Script {
    /// @dev beforeInitialize | afterInitialize | beforeAddLiquidity | beforeSwap.
    uint160 internal constant REQUIRED_BITS = 0x3880;

    /// @dev The Uniswap deployment on 4663 (V1 in docs/verification.md). Defaults
    /// rather than requirements: a run against another chain overrides them, and a
    /// run against this one should not have to restate them and risk a typo.
    address internal constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEFAULT_POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;

    /// @dev Everything the verifier is told, in one place. A struct because the
    /// alternative is reading the environment from six different functions, and
    /// because a test needs to replace all of it at once — see
    /// `test/utils/VerifyHarness.sol` for why it cannot do that through `vm.setEnv`.
    struct Config {
        address factory;
        address origin;
        address expectedTreasury;
        address expectedRegistryOwner;
        address poolManager;
        address positionManager;
    }

    /// @dev Counted rather than reverted on, so that one run reports every problem.
    /// A deployment is discarded whole; learning about its faults one `forge script`
    /// at a time is worse than useless when each round trip is a fresh deployment.
    uint256 private failures;
    uint256 private warnings;

    /// @return warned The number of warnings. Returned rather than only printed so
    /// that `test/Verify.t.sol` can assert a warning fires, which is the only way to
    /// know the difference between a check that passed and a check that is not there.
    function run() external returns (uint256 warned) {
        Config memory cfg = _config();
        VerdantFactory factory = VerdantFactory(cfg.factory);

        console.log("chain id       ", block.chainid);
        console.log("VerdantFactory ", address(factory));
        console.log("");

        _requireCode("VerdantFactory", address(factory));
        if (failures > 0) {
            // Everything below reads through the factory. Without it there is
            // nothing to verify and every subsequent check would fail for the same
            // one reason.
            console.log("");
            console.log("FACTORY has no code on this chain. Nothing else can be checked.");
            revert("verification failed");
        }

        _checkTopology(factory, cfg);
        _checkHook(factory);
        _checkRegister(factory.modelRegistry());
        _checkQuoteAssets(factory.modelRegistry());
        _checkIntent(factory, cfg);
        _checkBuild(factory);

        console.log("");
        if (failures > 0) {
            console.log("FAILED:", failures, "problem(s). Do not publish these addresses.");
            revert("verification failed");
        }
        console.log("Verified.", warnings, "warning(s). See above.");
        return warnings;
    }

    /// @dev `virtual` for the same reason `Deploy._inputs` is: the environment is
    /// process-global and Foundry does not roll it back between test cases, so it
    /// cannot carry per-test values.
    function _config() internal view virtual returns (Config memory cfg) {
        cfg.factory = vm.envAddress("FACTORY");
        cfg.origin = vm.envOr("ORIGIN", address(0));
        cfg.expectedTreasury = vm.envOr("EXPECTED_TREASURY", address(0));
        cfg.expectedRegistryOwner = vm.envOr("EXPECTED_REGISTRY_OWNER", address(0));
        cfg.poolManager = vm.envOr("POOL_MANAGER", DEFAULT_POOL_MANAGER);
        cfg.positionManager = vm.envOr("POSITION_MANAGER", DEFAULT_POSITION_MANAGER);
    }

    /// @dev Every edge, from both ends. The factory names five contracts; each of
    /// the three that can name it back is asked to.
    function _checkTopology(VerdantFactory factory, Config memory cfg) private {
        VerdantHook hook = factory.hook();
        VerdantDeployer deployer = factory.deployer();
        MarketRegistry marketRegistry = factory.marketRegistry();
        ModelRegistry modelRegistry = factory.modelRegistry();

        console.log("--- topology ---");
        console.log("VerdantHook    ", address(hook));
        console.log("VerdantDeployer", address(deployer));
        console.log("MarketRegistry ", address(marketRegistry));
        console.log("ModelRegistry  ", address(modelRegistry));
        console.log("PoolManager    ", address(factory.poolManager()));
        console.log("PositionManager", address(factory.positionManager()));
        console.log("treasury       ", factory.treasury());
        console.log("");

        _requireCode("VerdantHook", address(hook));
        _requireCode("VerdantDeployer", address(deployer));
        _requireCode("MarketRegistry", address(marketRegistry));
        _requireCode("ModelRegistry", address(modelRegistry));

        // The three back-references. A market's provenance rests on these: the hook
        // will only let this factory open a pool, the registry will only let it
        // write, and the deployer will only build for it.
        _check(hook.factory() == address(factory), "the hook names this factory");
        _check(marketRegistry.writer() == address(factory), "the market registry's writer is this factory");
        _check(deployer.factory() == address(factory), "the deployer is bound to this factory");

        // Uniswap, from both sides: the factory and the hook must be pointed at the
        // same PoolManager, or a pool could be opened somewhere the hook does not
        // guard.
        address expectedPoolManager = cfg.poolManager;
        address expectedPositionManager = cfg.positionManager;

        _check(address(factory.poolManager()) == expectedPoolManager, "the factory's PoolManager is the expected one");
        _check(address(hook.poolManager()) == expectedPoolManager, "the hook's PoolManager is the same one");
        _check(
            address(factory.positionManager()) == expectedPositionManager,
            "the factory's PositionManager is the expected one"
        );
        _check(hook.positionManager() == expectedPositionManager, "the hook's PositionManager is the same one");

        _requireCode("PoolManager", expectedPoolManager);
        _requireCode("PositionManager", expectedPositionManager);

        address origin = cfg.origin;
        if (origin == address(0)) {
            _warn("ORIGIN not set, so the anchor's spent one-shot was not confirmed");
        } else {
            _check(FactoryOrigin(origin).factory() == address(factory), "the anchor published this factory's address");
            _check(FactoryOrigin(origin).used(), "the anchor's single creation is spent");
        }
    }

    /// @dev The hook's address *is* its permissions in v4 — the low 14 bits are read
    /// on every call, and no code anywhere can compensate for the wrong ones.
    function _checkHook(VerdantFactory factory) private {
        uint160 bits = uint160(address(factory.hook())) & Hooks.ALL_HOOK_MASK;

        console.log("--- hook permissions ---");
        console.log("address bits   ", bits);
        console.log("required       ", REQUIRED_BITS);
        console.log("");

        _check(
            bits == REQUIRED_BITS,
            "the hook's address carries exactly beforeInitialize|afterInitialize|beforeAddLiquidity|beforeSwap"
        );
    }

    /// @dev The register on chain against the register in the repository. The
    /// registry has an owner and setters, so this is a snapshot rather than a
    /// guarantee — but a deployment that starts out disagreeing with
    /// `bounds.json` was seeded from something nobody reviewed.
    function _checkRegister(ModelRegistry registry) private {
        string memory json = vm.readFile("../config/generated/bounds.json");
        uint256 count = vm.parseJsonUint(json, ".modelCount");
        bool[] memory enabled = vm.parseJsonBoolArray(json, ".modelEnabled");
        uint256[] memory minStages = vm.parseJsonUintArray(json, ".modelMinStages");
        uint256[] memory maxStages = vm.parseJsonUintArray(json, ".modelMaxStages");
        uint256[] memory minReserve = vm.parseJsonUintArray(json, ".modelMinReserveBps");
        uint256[] memory maxReserve = vm.parseJsonUintArray(json, ".modelMaxReserveBps");

        console.log("--- parameter register ---");
        console.log("model count    ", registry.modelCount());
        console.log("protocol share ", registry.protocolBps());
        console.log("max protocol   ", registry.maxProtocolBps());
        console.log("");

        _check(registry.modelCount() == count, "the model count matches bounds.json");
        _check(
            registry.maxProtocolBps() == vm.parseJsonUint(json, ".splits.maxProtocolBps"),
            "the protocol cap matches bounds.json"
        );
        _check(
            registry.protocolBps() == vm.parseJsonUint(json, ".splits.defaultProtocolBps"),
            "the protocol share matches bounds.json"
        );

        for (uint256 i = 0; i < count && i < registry.modelCount(); i++) {
            // forge-lint: disable-next-line(unsafe-typecast) -- bounded by modelCount, a uint8
            uint8 model = uint8(i);
            ModelRegistry.ModelBounds memory on = registry.boundsOf(model);

            _check(on.enabled == enabled[i], string.concat("model ", vm.toString(i), ": enabled matches"));
            _check(on.minStages == minStages[i], string.concat("model ", vm.toString(i), ": minStages matches"));
            _check(on.maxStages == maxStages[i], string.concat("model ", vm.toString(i), ": maxStages matches"));
            _check(
                on.minReserveBps == minReserve[i], string.concat("model ", vm.toString(i), ": minReserveBps matches")
            );
            _check(
                on.maxReserveBps == maxReserve[i], string.concat("model ", vm.toString(i), ": maxReserveBps matches")
            );

            // v1's factory passes a reserve share of zero, so a model that demands
            // one is enabled and uncreatable — the inconsistency that took Evergreen
            // out of the register. Asked of the deployed registry, at its minimum
            // stage count, because that is the launch the factory would attempt.
            if (on.enabled) {
                _check(
                    registry.creationAllowed(model, on.minStages, 0),
                    string.concat("model ", vm.toString(i), " is enabled and can actually be created")
                );
            }
        }
    }

    /// @dev The admitted quote assets, which decide whether a stock-paired market can
    /// be created at all. They are seeded in `ModelRegistry`'s constructor, so a
    /// deployment that read a different `bounds.json` — or none — produces a factory
    /// that refuses every equity-quoted launch with `QuoteAssetNotAdmitted` and is
    /// otherwise indistinguishable from a correct one.
    function _checkQuoteAssets(ModelRegistry registry) private {
        string memory json = vm.readFile("../config/generated/bounds.json");
        address[] memory reviewed = vm.parseJsonAddressArray(json, ".quoteAssets");
        string[] memory symbols = vm.parseJsonStringArray(json, ".quoteAssetSymbols");
        uint256 listChainId = vm.parseJsonUint(json, ".quoteAssetChainId");

        console.log("--- quote assets ---");
        console.log("reviewed       ", reviewed.length);
        console.log("admitted       ", registry.admittedQuoteAssets().length);
        console.log("");

        _check(registry.quoteAllowed(address(0)), "ether is an allowed quote asset");
        _check(
            registry.admittedQuoteAssets().length == reviewed.length,
            "the admitted set is exactly the size of the reviewed list"
        );

        if (listChainId != block.chainid) {
            // The addresses are chain-specific. Somewhere other than the chain they
            // were reviewed on they name nothing in particular, so whether they are
            // admitted is not a fact worth failing a deployment over.
            _warn(
                string.concat(
                    "the reviewed quote assets belong to chain ",
                    vm.toString(listChainId),
                    ", not ",
                    vm.toString(block.chainid),
                    ": their admission was not checked"
                )
            );
            return;
        }

        uint256 missingCode;
        for (uint256 i = 0; i < reviewed.length; i++) {
            _check(
                registry.quoteAllowed(reviewed[i]),
                string.concat(symbols[i], " (", vm.toString(reviewed[i]), ") is admitted")
            );
            if (reviewed[i].code.length == 0) missingCode++;
        }

        // An admitted address with no code is admitted and unusable: the launch would
        // revert when the pool tried to settle it. That is a fault in the reviewed
        // list rather than in the deployment, which is why it warns.
        if (missingCode > 0) {
            _warn(
                string.concat(
                    vm.toString(missingCode), " admitted quote asset(s) have no code on this chain and cannot be traded"
                )
            );
        }
    }

    /// @dev The values that encode what somebody meant, which no amount of internal
    /// consistency can check. Both are immutable in the contracts that hold them:
    /// a market created against the wrong treasury pays the wrong address for as
    /// long as it trades, and cannot be corrected.
    function _checkIntent(VerdantFactory factory, Config memory cfg) private {
        console.log("--- intent ---");

        address expectedTreasury = cfg.expectedTreasury;
        if (expectedTreasury == address(0)) {
            _warn("EXPECTED_TREASURY not set, so the fee recipient was not checked against intent");
        } else {
            _check(factory.treasury() == expectedTreasury, "the treasury is the intended address");
        }

        address owner = ModelRegistry(factory.modelRegistry()).owner();
        console.log("registry owner ", owner);

        address expectedOwner = cfg.expectedRegistryOwner;
        if (expectedOwner == address(0)) {
            _warn("EXPECTED_REGISTRY_OWNER not set, so the registry's owner was not checked against intent");
        } else {
            _check(owner == expectedOwner, "the registry owner is the intended address");
        }

        // The owner can move bounds and the protocol share for future markets. It
        // cannot touch a live market — that is what the immutables are for — but it
        // is the one live privilege in the system, and an EOA holding it is a single
        // key. Canonical Safe factories exist on 4663 (V15).
        if (owner.code.length == 0) {
            _warn("the registry owner is an EOA, not a contract: the one live privilege rests on a single key");
        }

        _check(!ModelRegistry(factory.modelRegistry()).creationPaused(), "creation is not paused");
        console.log("");
    }

    /// @dev Whether the code on chain is the length this commit builds. Immutables
    /// are stored in the runtime code, so the bytes cannot be compared directly
    /// against an artifact — but their placeholders occupy the same space, so the
    /// lengths must agree. A mismatch means the chain is running a different build
    /// from the one being read, which makes every other check in this file a
    /// statement about the wrong source.
    ///
    /// A warning rather than a failure: recompiling with different settings, or
    /// reading this at a later commit, both change the length without anything being
    /// wrong with the deployment.
    function _checkBuild(VerdantFactory factory) private {
        console.log("--- build ---");
        _compare("VerdantFactory", address(factory), "VerdantFactory.sol:VerdantFactory");
        _compare("VerdantHook", address(factory.hook()), "VerdantHook.sol:VerdantHook");
        _compare("VerdantDeployer", address(factory.deployer()), "VerdantDeployer.sol:VerdantDeployer");
        _compare("MarketRegistry", address(factory.marketRegistry()), "MarketRegistry.sol:MarketRegistry");
        _compare("ModelRegistry", address(factory.modelRegistry()), "ModelRegistry.sol:ModelRegistry");
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
