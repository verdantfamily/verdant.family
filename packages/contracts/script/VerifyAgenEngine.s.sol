// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

import {FactoryOrigin} from "../src/FactoryOrigin.sol";
import {AgenMarketRegistry} from "../src/agen/AgenMarketRegistry.sol";
import {AgenEngineDeployer} from "../src/agen/engine/AgenEngineDeployer.sol";
import {AgenEngineFactory} from "../src/agen/engine/AgenEngineFactory.sol";
import {AgenEngineHook} from "../src/agen/engine/AgenEngineHook.sol";

/// @title VerifyAgenEngine
/// @notice Reads a deployed engine off the chain and checks it is the one that was intended.
/// Run it immediately after `DeployAgenEngine.s.sol --broadcast`, before the addresses reach
/// any environment file.
///
/// @dev ## Why the deployment script's own checks are not enough
///
/// `DeployAgenEngine.s.sol` asserts every wiring as it goes, and those assertions are worth
/// having — but they run inside the same process that computed the values, against values it
/// computed. Pointed at an address that is not the PoolManager on this chain, it would deploy
/// a perfectly self-consistent engine wired to a Uniswap nobody trades on, satisfy all
/// eleven of its own requires, and report success.
///
/// This starts from the other end. It is given the factory and takes every other address from
/// what the factory says its counterparties are, then asks each counterparty who *they* think
/// the factory is. Two contracts that name each other were deployed together; one that names
/// an address which does not name it back is a deployment that only looks finished.
///
/// Nothing here can repair anything. Every identity in the engine is an immutable, the hook's
/// permissions are its address, and `FactoryOrigin` can create once — so the only response to
/// a failure is to deploy again at a fresh anchor and abandon what is on chain, along with any
/// market launched through it in the meantime. That is why this runs before the addresses are
/// configured anywhere and not after.
///
/// ## Running it
///
///   FACTORY=0x... forge script script/VerifyAgenEngine.s.sol --rpc-url robinhood
///
/// Optional, and all worth setting on the real run:
///
///   ORIGIN=0x...                    the anchor, so its one-shot is confirmed spent
///   EXPECTED_TREASURY=0x...         where a Treasury recipient's share must accrue
///   EXPECTED_FACTORY_CODEHASH=0x... the approved release build's factory runtime hash
///   EXPECTED_HOOK_CODEHASH=0x...    the approved release build's hook runtime hash
///
/// The two code hashes default to the release this commit describes, so an ordinary run needs
/// neither. It broadcasts nothing and needs no key.
contract VerifyAgenEngine is Script {
    /// @dev The Uniswap deployment on 4663 (V1 in docs/verification.md). Defaults rather than
    /// requirements, so a run against this chain does not restate them and risk a typo.
    address internal constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEFAULT_POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;

    /// @dev Where a `Treasury` recipient's share of every engine market accrues. The same
    /// value `DeployAgenEngine.PRODUCTION_TREASURY` holds; restated because this script is
    /// the one that checks it from the other end, and a default that had to be passed in by
    /// hand is a default that gets passed in wrong on the one run that matters.
    address internal constant DEFAULT_EXPECTED_TREASURY = 0xabfB34D1C870c7b2334E93b25B1299346209bE38;

    /// @dev The runtime code hashes the approved release build produces at these addresses.
    ///
    /// Hashes rather than lengths. A length comparison — which is what `VerifyInstant` settles
    /// for — cannot tell two builds apart when they differ in an instruction rather than in
    /// size, and the whole promise of an engine market is that its economics are the code at a
    /// known address. These are the values `DeployAgenEngine.s.sol` printed from the simulation
    /// that was approved, so equality here means the chain is running that exact build with
    /// those exact immutables baked in.
    ///
    /// They cannot be recomputed from a build artefact, which is why they are recorded: the
    /// factory's and hook's immutables live in their runtime code, so the artefact on disk
    /// holds placeholders where the chain holds addresses.
    bytes32 internal constant DEFAULT_FACTORY_CODEHASH =
        0x18ebda0132f2c12d937a318be43bc33e24bf2e8a5638da07c732fbae31ca20fe;
    bytes32 internal constant DEFAULT_HOOK_CODEHASH =
        0x77fbe101096096af54ce3ea0e615ab1d669632b4675d132c60b9b2d64886ee28;

    /// @dev beforeInitialize | afterInitialize | beforeAddLiquidity | beforeSwap | afterSwap |
    /// beforeSwapReturnsDelta | afterSwapReturnsDelta. `0x38cc`. See `DeployAgenEngine`.
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
        bytes32 factoryCodehash;
        bytes32 hookCodehash;
    }

    /// @dev Counted rather than reverted on, so one run reports every problem. A deployment is
    /// discarded whole; learning its faults one round trip at a time is worse than useless
    /// when each round trip is a fresh deployment at a fresh anchor.
    uint256 private failures;
    uint256 private warnings;

    function run() external returns (uint256 warned) {
        Config memory cfg = _config();
        AgenEngineFactory factory = AgenEngineFactory(cfg.factory);

        console.log("chain id         ", block.chainid);
        console.log("AgenEngineFactory", address(factory));
        console.log("");

        _requireCode("AgenEngineFactory", address(factory));
        if (failures > 0) {
            console.log("");
            console.log("FACTORY has no code on this chain. Nothing else can be checked.");
            revert("verification failed");
        }

        _checkTopology(factory, cfg);
        _checkHook(factory);
        _checkTreasury(factory, cfg);
        _checkRegistry(factory);
        _checkBuild(factory, cfg);

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
        cfg.treasury = vm.envOr("EXPECTED_TREASURY", DEFAULT_EXPECTED_TREASURY);
        cfg.factoryCodehash = vm.envOr("EXPECTED_FACTORY_CODEHASH", DEFAULT_FACTORY_CODEHASH);
        cfg.hookCodehash = vm.envOr("EXPECTED_HOOK_CODEHASH", DEFAULT_HOOK_CODEHASH);
    }

    /// @dev Every edge of the graph, from both ends.
    function _checkTopology(AgenEngineFactory factory, Config memory cfg) private {
        AgenEngineHook hook = factory.hook();
        AgenEngineDeployer deployer = factory.deployer();
        AgenMarketRegistry registry = factory.registry();

        console.log("--- topology ---");
        console.log("AgenEngineHook    ", address(hook));
        console.log("AgenEngineDeployer", address(deployer));
        console.log("AgenMarketRegistry", address(registry));
        console.log("PoolManager       ", address(factory.poolManager()));
        console.log("PositionManager   ", address(factory.positionManager()));
        console.log("");

        _requireCode("AgenEngineHook", address(hook));
        _requireCode("AgenEngineDeployer", address(deployer));
        _requireCode("AgenMarketRegistry", address(registry));

        // The three back-references. Every market's provenance rests on these: the hook runs
        // rules only for this factory's pools, the deployer builds only for it, and the
        // registry accepts writes only from it.
        _check(hook.factory() == address(factory), "the hook is bound to this factory");
        _check(deployer.factory() == address(factory), "the deployer is bound to this factory");
        _check(registry.factory() == address(factory), "the registry is writable only by this factory");

        _check(address(factory.poolManager()) == cfg.poolManager, "the factory's PoolManager is the expected one");
        _check(
            address(factory.positionManager()) == cfg.positionManager,
            "the factory's PositionManager is the expected one"
        );

        // Asked of the hook separately rather than inferred from the factory. The hook holds
        // its own copies, and it is the hook that runs on every swap — a hook pointed at a
        // different PoolManager than its factory is a market that launches and never charges.
        _check(address(hook.poolManager()) == cfg.poolManager, "the hook's PoolManager is the same as the factory's");
        _check(
            hook.positionManager() == cfg.positionManager, "the hook's PositionManager is the same as the factory's"
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

    /// @dev The hook's permissions, which are its address and cannot be changed.
    ///
    /// The two delta bits are called out separately because their absence is the failure that
    /// looks like success: v4 would never read the fee the hook returns, every swap would
    /// balance, and every engine market would charge nothing while appearing to work.
    function _checkHook(AgenEngineFactory factory) private {
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

    /// @dev The one input with no counterparty of its own.
    ///
    /// Unrecoverable if wrong: immutable on the factory, and every market's vault resolves it
    /// at creation. A deployment that is perfect in every other respect and pays a stranger is
    /// still abandoned.
    function _checkTreasury(AgenEngineFactory factory, Config memory cfg) private {
        console.log("--- treasury ---");
        console.log("treasury", factory.treasury());
        console.log("expected", cfg.treasury);
        console.log("");

        _check(factory.treasury() != address(0), "the treasury is not the zero address");
        _check(factory.treasury() == cfg.treasury, "the treasury is the one that was intended");
    }

    /// @dev A registry holding markets before anybody has launched one means this is not the
    /// fresh deployment it is being read as — either the wrong address, or a launch has
    /// already happened through it.
    function _checkRegistry(AgenEngineFactory factory) private {
        AgenMarketRegistry registry = factory.registry();

        console.log("--- registry ---");
        console.log("markets recorded", registry.count());
        console.log("");

        if (registry.count() != 0) {
            _warn("the registry already has markets in it, so this is not a fresh deployment");
        }
    }

    /// @dev Whether the code on chain is the code that was approved.
    ///
    /// The factory and the hook are checked by hash, against the release recorded above: an
    /// exact statement that these are those contracts, compiled from that source, holding
    /// those immutables. The deployer and the registry hold no addresses this script has not
    /// already checked from both ends, so their lengths are compared against the local build
    /// instead — enough to catch a different source, and it needs nothing recorded by hand.
    function _checkBuild(AgenEngineFactory factory, Config memory cfg) private {
        console.log("--- build ---");

        _hash("AgenEngineFactory", address(factory), cfg.factoryCodehash);
        _hash("AgenEngineHook", address(factory.hook()), cfg.hookCodehash);
        _size("AgenEngineDeployer", address(factory.deployer()), "AgenEngineDeployer.sol:AgenEngineDeployer");
        _size("AgenMarketRegistry", address(factory.registry()), "AgenMarketRegistry.sol:AgenMarketRegistry");
    }

    function _hash(string memory label, address deployed, bytes32 expected) private {
        bytes32 actual = deployed.codehash;

        console.log(string.concat("  ", label, " runtime hash ", vm.toString(actual)));
        _check(
            actual == expected,
            string.concat(label, ": runtime code is the approved release build (", vm.toString(expected), ")")
        );
    }

    /// @dev Immutables live in the runtime code, so the bytes cannot be compared against an
    /// artefact directly — but their placeholders occupy the same space, so the lengths must
    /// agree. A mismatch means the chain is running a different build from the one being read,
    /// which makes every other check here a statement about the wrong source.
    function _size(string memory label, address deployed, string memory artifact) private {
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
