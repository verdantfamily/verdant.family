// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

import {FactoryOrigin} from "../src/FactoryOrigin.sol";
import {AgenMarketRegistry} from "../src/agen/AgenMarketRegistry.sol";
import {AgenEngineDeployer} from "../src/agen/engine/AgenEngineDeployer.sol";
import {AgenEngineFactory} from "../src/agen/engine/AgenEngineFactory.sol";
import {AgenEngineHook} from "../src/agen/engine/AgenEngineHook.sol";
import {HookMiner} from "../test/utils/HookMiner.sol";

/// @title DeployAgenEngine
/// @notice The five phases that stand up the deterministic engine, in the only order that
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
/// ## Why the salt is mined here rather than supplied
///
/// The hook's initcode embeds the factory's address, so a salt is only meaningful for one
/// specific `FactoryOrigin`. An earlier version of this script read `HOOK_SALT` from the
/// environment and left the mining to a separate run, which made the salt a value a human
/// carried between two invocations — and a salt mined against yesterday's origin is not a
/// failure the environment can catch. It lands the hook at an address whose low fourteen
/// bits are whatever they happen to be, which is a deployment that either reverts in the
/// hook's constructor or, if the bits collide, produces a hook v4 will never call.
///
/// So it is mined in-process, after the real origin exists, exactly as `DeployInstant`
/// mines `InstantHook`'s. The salt becomes an output of the deployment rather than an input
/// to it, which removes the only step that could go stale. Mining is `pure` arithmetic over
/// an initcode hash and costs nothing on chain; the creation that follows is a fixed-cost
/// call to the deterministic deployer no matter which salt the search returned.
///
/// ## The phases
///
/// **1. `FactoryOrigin(operator)`.** Publishes `factory()`, the address the factory will
/// occupy. Nothing else about the deployment is known yet and nothing needs to be.
///
/// **2. `AgenEngineDeployer(predictedFactory)`.** Holds the per-market bytecode. Without it
/// the factory would carry the token, vault and locker creation code and exceed EIP-170 —
/// which Foundry does not enforce in tests, so it would have surfaced first as a failed
/// mainnet deployment. `EngineSizes.t.sol` is the guard.
///
/// **3. `AgenMarketRegistry(predictedFactory)`.** Engine markets get their own registry
/// instance rather than sharing the engine-0 one, which is pinned to `AgenFactory` and could
/// not accept writes from here anyway. The separation is also the cleanest answer to "do not
/// reinterpret old markets": no engine-0 record is read or written by any of this.
///
/// **4. `AgenEngineHook`, CREATE2, salt mined for `0x38CC`.** Its constructor arguments are
/// `(poolManager, predictedFactory, positionManager)`. This is the phase the anchor exists
/// for: the hook's initcode embeds the factory's address, so the factory's address had to be
/// settled first. The salt search is over the initcode hash, and the constructor refuses to
/// deploy anywhere whose low fourteen bits are not exactly the permission set — so a mined
/// address that drifted is a failed deployment rather than a market whose rules silently
/// never run.
///
/// **5. `origin.deployFactory(...)`.** The factory's initcode names the hook. It lands on the
/// published address, and its constructor then checks all three wirings —
/// `deployer.factory()`, `registry.factory()` and `hook.factory()` all equal to
/// `address(this)`. So a wrong ordering, a wrong predicted address, or a hook mined against
/// a different factory is a reverted deployment.
///
/// Every identity ends up immutable and mutually verified, with no setter, no admin, no
/// proxy, and no address anybody has to trust a script to have computed correctly.
///
/// ## Running it
///
/// Simulate — no key, real chain state:
///
///   POOL_MANAGER=0x... POSITION_MANAGER=0x... AGEN_ENGINE_TREASURY=0x... \
///     forge script script/DeployAgenEngine.s.sol --rpc-url robinhood --sender 0xYOU
///
/// Broadcast:
///
///   ... forge script script/DeployAgenEngine.s.sol --rpc-url robinhood --broadcast
///
/// The simulation prints the address book the broadcast will produce, including the mined
/// salt. Read it first. `DeployAgenEngine.t.sol` runs these same five phases through the
/// script itself and asserts every predicted address equals the deployed one.
contract DeployAgenEngine is Script {
    /// @dev The canonical deterministic CREATE2 deployer, verified byte-identical on both
    /// Robinhood chains — see docs/verification.md.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev beforeInitialize | afterInitialize | beforeAddLiquidity | beforeSwap |
    /// afterSwap | beforeSwapReturnsDelta | afterSwapReturnsDelta. `0x38cc`.
    ///
    /// Spelled out from Uniswap's own flags rather than written as the literal, so an
    /// upstream change to a bit's position moves this with it. It is restated from
    /// `AgenEngineHook.REQUIRED_PERMISSIONS`, which is `internal` and cannot be read from
    /// here; the hook's constructor is what makes the restatement safe, since it reverts
    /// unless its own address carries exactly these.
    uint160 internal constant REQUIRED_BITS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    /// @dev The account that creates the production deployment on Robinhood Chain.
    ///
    /// Named here because it is not merely a preference: `FactoryOrigin`'s address, and
    /// therefore every address below it, derives from this account and its nonce. A
    /// deployment sent from anywhere else is a different deployment with a different address
    /// book, whatever else it has in common.
    address internal constant PRODUCTION_OPERATOR = 0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8;

    /// @dev Where a `Treasury` recipient's share of every production engine market accrues.
    ///
    /// Recorded in the repository rather than left to `AGEN_ENGINE_TREASURY` alone, because
    /// it is the one deployment input with nothing on chain to check it against. Every other
    /// address is verified from both ends — the factory names the hook and the hook names the
    /// factory back — so a mistake reverts. The treasury has no counterparty: any address is
    /// structurally valid, `AgenEngineFactory.treasury` is immutable, and each market's vault
    /// snapshots it at creation. A typo would therefore deploy successfully and pay a stranger
    /// forever, for every market ever launched against this factory.
    ///
    /// It stays readable from the environment so that a rig can point it anywhere, and is held
    /// to this value only for the operator above — which is the account that can produce the
    /// production address book and no other. So the local proof harness, which broadcasts the
    /// same script from an anvil account to an anvil treasury, is untouched, while a
    /// production broadcast carrying the wrong value fails in simulation instead of on chain.
    ///
    /// The same address as `InstantDeployment.treasury` in packages/config/src/deployments.ts,
    /// deliberately: it is one platform's takings, and Instant already pays there.
    address internal constant PRODUCTION_TREASURY = 0xabfB34D1C870c7b2334E93b25B1299346209bE38;

    /// @dev The predictions are returned beside the deployments rather than only printed,
    /// so a test can assert the chain the deployment rests on — origin to predicted factory
    /// to salt to predicted hook to deployed hook to final factory — link by link, instead
    /// of only checking that the far end is self-consistent. A stale salt is precisely the
    /// failure that leaves a self-consistent far end.
    struct Deployment {
        FactoryOrigin origin;
        address predictedFactory;
        AgenEngineDeployer deployer;
        AgenMarketRegistry registry;
        bytes32 hookSalt;
        address predictedHook;
        AgenEngineHook hook;
        AgenEngineFactory factory;
    }

    struct Inputs {
        address sender;
        address poolManager;
        address positionManager;
        /// @dev Where a `Treasury` recipient's share of every engine market accrues.
        /// Immutable on the factory.
        address treasury;
    }

    /// @dev `public` rather than `external` so a harness can widen nothing and override the
    /// two seams below. Nothing about this deployment changes between a test and a broadcast.
    function run() public virtual returns (Deployment memory out) {
        Inputs memory input = _inputs();

        vm.startBroadcast(input.sender);

        // Phase 1: the anchor. Everything below is told an address read off it rather than
        // one this script worked out.
        out.origin = new FactoryOrigin(input.sender);
        out.predictedFactory = out.origin.factory();
        require(out.predictedFactory.code.length == 0, "the anchored factory address is already occupied");

        // Phase 2 and 3: the two contracts that name the factory. Neither is usable until it
        // exists — the deployer refuses every caller but the factory, the registry every
        // writer but the factory — so there is no window in which half a deployment can be
        // used for anything.
        out.deployer = new AgenEngineDeployer(out.predictedFactory);
        out.registry = new AgenMarketRegistry(out.predictedFactory);

        // Phase 4: the hook, at an address that carries its own permissions. Mined against
        // the origin that exists, in the same call that deploys it, so there is no salt to
        // carry between invocations and none to go stale.
        bytes memory hookInitcode = abi.encodePacked(
            type(AgenEngineHook).creationCode,
            abi.encode(IPoolManager(input.poolManager), out.predictedFactory, input.positionManager)
        );
        (out.predictedHook, out.hookSalt) = _mine(hookInitcode);
        out.hook = AgenEngineHook(_create2(out.hookSalt, hookInitcode));

        // Phase 5: the factory, at the anchored address, whose constructor closes all three
        // wirings by checking them.
        out.factory = AgenEngineFactory(out.origin.deployFactory(_factoryInitcode(input, out)));

        vm.stopBroadcast();

        // The mined address is the deployed address. Checked here rather than left to the
        // hook's constructor alone, because the constructor can only see the bits — it
        // cannot see that they are the bits this script searched for.
        require(address(out.hook) == out.predictedHook, "the hook did not land where it was mined");
        require(
            uint160(address(out.hook)) & Hooks.ALL_HOOK_MASK == REQUIRED_BITS,
            "the deployed hook's address does not carry 0x38cc"
        );

        // The factory's constructor has checked the half it can see. These check the half
        // it cannot: that it is the factory the other three were told about, and that it
        // holds the addresses this script deployed rather than any others.
        require(address(out.factory) == out.predictedFactory, "factory is not at the anchored address");
        require(address(out.factory.hook()) == address(out.hook), "factory does not name the deployed hook");
        require(out.hook.factory() == address(out.factory), "hook is not bound to the factory");
        require(out.deployer.factory() == address(out.factory), "deployer is not bound to the factory");
        require(out.registry.factory() == address(out.factory), "registry writer is not the factory");
        require(address(out.factory.deployer()) == address(out.deployer), "factory names a different deployer");
        require(address(out.factory.registry()) == address(out.registry), "factory names a different registry");
        require(address(out.factory.poolManager()) == input.poolManager, "factory names a different pool manager");
        require(
            address(out.factory.positionManager()) == input.positionManager,
            "factory names a different position manager"
        );
        require(address(out.hook.poolManager()) == input.poolManager, "hook names a different pool manager");
        require(out.hook.positionManager() == input.positionManager, "hook names a different position manager");

        // The one input with no counterparty to check it against. A wrong treasury is not
        // recoverable — every market's vault snapshots it at creation — so it is compared
        // against what was asked for rather than merely being non-zero.
        require(out.factory.treasury() == input.treasury, "factory pays a different treasury");

        require(out.registry.count() == 0, "a freshly deployed registry already has markets in it");

        _report(input, out);
    }

    /// @dev `virtual` so a test can inject the inputs instead of reaching for the process
    /// environment. `vm.setEnv` is not rolled back between test cases, so a suite that sets
    /// a variable leaks it into every other suite running beside it.
    function _inputs() internal view virtual returns (Inputs memory input) {
        input.sender = _sender();
        input.poolManager = vm.envAddress("POOL_MANAGER");
        input.positionManager = vm.envAddress("POSITION_MANAGER");
        input.treasury = vm.envAddress("AGEN_ENGINE_TREASURY");

        _validate(input);
    }

    /// @dev Applied however the inputs arrived, so an injected deployment is held to the
    /// same preconditions as one configured from the environment.
    function _validate(Inputs memory input) internal view {
        require(input.poolManager.code.length > 0, "POOL_MANAGER has no code on this chain");
        require(input.positionManager.code.length > 0, "POSITION_MANAGER has no code on this chain");
        require(input.treasury != address(0), "AGEN_ENGINE_TREASURY must be set");
        require(input.sender != address(0), "no sender");

        // See `PRODUCTION_TREASURY`. Only the production operator is held to it, so a rig
        // broadcasting this script from a local account may pay wherever it likes.
        if (input.sender == PRODUCTION_OPERATOR) {
            require(
                input.treasury == PRODUCTION_TREASURY, "AGEN_ENGINE_TREASURY is not the recorded production treasury"
            );
        }

        require(CREATE2_DEPLOYER.code.length > 0, "no deterministic deployer on this chain");
    }

    function _sender() internal view virtual returns (address) {
        return msg.sender;
    }

    /// @dev Built as data because `FactoryOrigin` must not embed the factory's bytecode:
    /// the factory is close to the EIP-170 limit, and a contract carrying a copy of it
    /// could not itself be deployed.
    function _factoryInitcode(Inputs memory input, Deployment memory out) internal pure returns (bytes memory) {
        return abi.encodePacked(
            type(AgenEngineFactory).creationCode,
            abi.encode(
                IPoolManager(input.poolManager),
                IPositionManager(input.positionManager),
                out.deployer,
                out.registry,
                out.hook,
                input.treasury
            )
        );
    }

    /// @dev Mining is restated against the result rather than trusted from the miner: the
    /// loop and this check would both have to be wrong in the same way for a hook with the
    /// wrong permission bits to reach a broadcast, and a wrong hook address cannot be
    /// repaired — v4 re-reads the bits on every call.
    function _mine(bytes memory initcode) internal view returns (address hookAddress, bytes32 salt) {
        (hookAddress, salt) = HookMiner.findFromInitcode(CREATE2_DEPLOYER, REQUIRED_BITS, initcode);

        require(uint160(hookAddress) & Hooks.ALL_HOOK_MASK == REQUIRED_BITS, "mined address does not carry 0x38cc");
        require(hookAddress.code.length == 0, "something is already deployed at the mined address");
    }

    /// @dev Through the deterministic deployer by explicit call, so the creating account is
    /// the address the salt was mined against no matter who runs this. `new X{salt: ...}`
    /// would be the script contract under `forge test` and the deployer under
    /// `--broadcast`, which is a difference that would only show up in production.
    function _create2(bytes32 salt, bytes memory initcode) internal returns (address deployed) {
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initcode));
        require(ok, "CREATE2 deployment reverted");
        require(ret.length == 20, "deterministic deployer returned no address");
        // forge-lint: disable-next-line(unsafe-typecast) -- 20 bytes, checked above
        deployed = address(bytes20(ret));
        require(deployed.code.length > 0, "nothing was deployed");
    }

    function _report(Inputs memory input, Deployment memory out) internal view {
        console.log("");
        console.log("The Agen engine is deployed. Record these in packages/config/src/deployments.ts:");
        console.log("");
        console.log("  factory  ", address(out.factory));
        console.log("  deployer ", address(out.deployer));
        console.log("  registry ", address(out.registry));
        console.log("  hook     ", address(out.hook));
        console.log("  origin   ", address(out.origin), "(spent, kept for the record)");
        console.log("");
        console.log("  operator ", input.sender);
        console.log("  treasury ", input.treasury);
        console.log("");
        // The salt is an output of this run. Printed so the mined address is reproducible:
        // the same origin and the same constructor arguments will always yield it again.
        console.log("  hook salt", vm.toString(out.hookSalt));
        console.log("  hook permission bits", uint160(address(out.hook)) & Hooks.ALL_HOOK_MASK);
        console.log("");
        // The identity of the code, not merely of the address.
        console.log("  factory runtime code hash", vm.toString(address(out.factory).codehash));
        console.log("  hook runtime code hash   ", vm.toString(address(out.hook).codehash));
        console.log("");

        // The same addresses again, under the exact names the indexer and the app read them
        // from. `scripts/indexer-proof.sh` greps for these labels, so a rig cannot pick up
        // three quarters of a deployment: the block above is written for a person deciding
        // what to record, and this one for a machine that has to get all four or none.
        console.log("AGEN_ENGINE_FACTORY ", address(out.factory));
        console.log("AGEN_ENGINE_DEPLOYER", address(out.deployer));
        console.log("AGEN_ENGINE_REGISTRY", address(out.registry));
        console.log("AGEN_ENGINE_HOOK    ", address(out.hook));
    }
}
