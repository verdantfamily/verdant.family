// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {FactoryOrigin} from "../src/FactoryOrigin.sol";
import {AgenMarketRegistry} from "../src/agen/AgenMarketRegistry.sol";
import {AgenEngineDeployer} from "../src/agen/engine/AgenEngineDeployer.sol";
import {AgenEngineFactory} from "../src/agen/engine/AgenEngineFactory.sol";
import {AgenEngineHook} from "../src/agen/engine/AgenEngineHook.sol";

/// @title DeployAgenEngine
/// @notice The four steps that stand up the deterministic engine, in the only order that
/// works.
///
/// @dev ## The dependency this exists to resolve
///
/// `AgenEngineHook` names the factory in its constructor. `AgenEngineFactory` names the hook
/// in its own. Both are immutable, deliberately — a setter on either would mean a launched
/// market's economics could be pointed at different code afterwards, which is the one thing
/// a creator is promised cannot happen.
///
/// That is a real cycle, and it cannot be broken by ordering alone: whichever is deployed
/// second needs the first's address, and the hook's address is *mined*, so it cannot be
/// predicted from anything but its own initcode — which contains the factory's address.
///
/// It is broken by anchoring the factory to an address that does not depend on the factory's
/// code at all. `FactoryOrigin` computes `keccak(rlp(address(this), 1))` in its own
/// constructor — the address of its first and only creation — and publishes it. A contract's
/// nonce starts at 1 and `used` makes the creation unique, so that address is knowable
/// before the factory's initcode exists. See ADR-007, and `FactoryOrigin`'s own header for
/// why an operator nonce was rejected as the anchor.
///
/// ## The steps
///
/// **1. `FactoryOrigin(operator)`.** Publishes `factory()`, the address the factory will
/// occupy. Nothing else about the deployment is known yet and nothing needs to be.
///
/// **2. `AgenMarketRegistry(predictedFactory)`.** Engine markets get their own registry
/// instance rather than sharing the engine-0 one, which is pinned to `AgenFactory` and could
/// not accept writes from here anyway. The separation is also the cleanest answer to "do not
/// reinterpret old markets": no engine-0 record is read or written by any of this.
///
/// **3. `AgenEngineHook`, CREATE2, salt mined for `0x38CC`.** Its constructor arguments are
/// `(poolManager, predictedFactory, positionManager)`. This is the step the anchor exists
/// for: the hook's initcode embeds the factory's address, so the factory's address had to be
/// settled first. The salt search is over the initcode hash, and the constructor refuses to
/// deploy anywhere whose low fourteen bits are not exactly the permission set — so a mined
/// address that drifted is a failed deployment rather than a market whose rules silently
/// never run.
///
/// **4. `origin.deployFactory(...)`.** The factory's initcode names the hook. It lands on the
/// published address, and its constructor then checks both wirings — `registry.factory() ==
/// address(this)` and `hook.factory() == address(this)`. So a wrong ordering, a wrong
/// predicted address, or a hook mined against a different factory is a reverted deployment.
///
/// Both identities end up immutable and mutually verified, with no setter, no admin, no
/// proxy, and no address anybody has to trust a script to have computed correctly.
///
/// ## Running it
///
/// Reads addresses from the environment rather than hardcoding them, so the same script runs
/// against a fork and against the chain:
///
/// ```
/// POOL_MANAGER=0x… POSITION_MANAGER=0x… AGEN_ENGINE_TREASURY=0x… \
///   forge script script/DeployAgenEngine.s.sol --rpc-url robinhood
/// ```
///
/// Without `--broadcast` this simulates and prints. `EngineLaunch.t.sol` runs the same four
/// steps in a test and asserts every predicted address equals the deployed one, which is
/// what makes this path exercised rather than merely written down.
contract DeployAgenEngine is Script {
    function run() external {
        IPoolManager poolManager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        IPositionManager positionManager = IPositionManager(vm.envAddress("POSITION_MANAGER"));
        address treasury = vm.envAddress("AGEN_ENGINE_TREASURY");
        address operator = msg.sender;

        vm.startBroadcast();

        // 1. The anchor.
        FactoryOrigin origin = new FactoryOrigin(operator);
        address predictedFactory = origin.factory();
        console2.log("origin", address(origin));
        console2.log("factory will be", predictedFactory);
        require(predictedFactory.code.length == 0, "something already occupies the factory's address");

        // 2. The deployer, holding the per-market bytecode. Without it the factory would
        //    carry the token, vault and locker creation code and exceed EIP-170 — which
        //    Foundry does not enforce in tests, so it would have surfaced first as a failed
        //    mainnet deployment. `EngineSizes.t.sol` is the guard.
        AgenEngineDeployer deployer = new AgenEngineDeployer(predictedFactory);
        console2.log("deployer", address(deployer));

        // 3. The registry, naming the factory it will only accept writes from.
        AgenMarketRegistry registry = new AgenMarketRegistry(predictedFactory);
        console2.log("registry", address(registry));

        // 4. The hook, mined against the predicted factory.
        //
        // The salt is searched off chain and supplied, rather than searched here: a mining
        // loop inside a broadcast would be a transaction whose gas depends on how lucky it
        // got. `HOOK_SALT` comes from `MineEngineHook.s.sol`, and the constructor is what
        // guarantees the salt was right.
        bytes32 hookSalt = vm.envBytes32("HOOK_SALT");
        AgenEngineHook hook =
            new AgenEngineHook{salt: hookSalt}(poolManager, predictedFactory, address(positionManager));
        console2.log("hook", address(hook));

        // 5. The factory, through the anchor. Its constructor checks all three wirings.
        bytes memory initcode = abi.encodePacked(
            type(AgenEngineFactory).creationCode,
            abi.encode(poolManager, positionManager, deployer, registry, hook, treasury)
        );
        address factory = origin.deployFactory(initcode);
        console2.log("factory", factory);

        vm.stopBroadcast();

        require(factory == predictedFactory, "the factory did not land on the published address");
        require(AgenEngineHook(hook).factory() == factory, "the hook does not name the factory");
        require(address(AgenEngineFactory(factory).hook()) == address(hook), "the factory does not name the hook");
    }
}

/// @title MineEngineHook
/// @notice Finds the CREATE2 salt for the engine hook, off chain.
///
/// @dev Separate from the deployment because mining is a search and a search inside a
/// broadcast is a transaction whose cost depends on luck. Run this first, read the salt, pass
/// it in as `HOOK_SALT`.
///
/// The factory address it mines against has to be the one the real deployment will use, which
/// means the anchor must already exist — so this runs *between* steps 1 and 3.
contract MineEngineHook is Script {
    /// @dev The permission set the hook implements. Composed in the contract from Uniswap's
    /// own flags; written here as the literal the search targets.
    uint160 internal constant ENGINE_FLAGS = 0x38CC;

    /// @dev v4's canonical CREATE2 deployer, which is what `new X{salt:}` resolves against
    /// when the caller is an EOA-driven script. Mining has to use the same deployer the
    /// deployment will, or the address will not match.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external view {
        IPoolManager poolManager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        address positionManager = vm.envAddress("POSITION_MANAGER");
        address predictedFactory = vm.envAddress("PREDICTED_FACTORY");

        bytes memory initcode = abi.encodePacked(
            type(AgenEngineHook).creationCode, abi.encode(poolManager, predictedFactory, positionManager)
        );
        bytes32 initcodeHash = keccak256(initcode);

        for (uint256 i = 0; i < 1_000_000; i++) {
            bytes32 salt = bytes32(i);
            address candidate = address(
                uint160(uint256(keccak256(abi.encodePacked(hex"ff", CREATE2_DEPLOYER, salt, initcodeHash))))
            );

            if (uint160(candidate) & 0x3FFF == ENGINE_FLAGS) {
                console2.log("salt");
                console2.logBytes32(salt);
                console2.log("hook will be", candidate);
                return;
            }
        }

        revert("no salt found in a million tries");
    }
}
