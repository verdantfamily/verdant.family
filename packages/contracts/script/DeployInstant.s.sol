// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

import {FactoryOrigin} from "../src/FactoryOrigin.sol";
import {InstantDeployer} from "../src/InstantDeployer.sol";
import {InstantFactory} from "../src/InstantFactory.sol";
import {InstantHook} from "../src/InstantHook.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {HookMiner} from "../test/utils/HookMiner.sol";

/// @title DeployInstant
/// @notice Brings up the four shared contracts every Instant market is launched through:
/// the hook, the deployer, Instant's own market registry, and the factory that drives all
/// three.
///
/// @dev A third deployment beside Verdant's and Agen's, and ADR-014 is why. Instant
/// promises the creator earns in ether; `VerdantHook` charges an ordinary LP fee taken
/// from whichever currency is going into the pool, which on a sell is the launched token.
/// A hook's permissions are its address, so keeping that promise needs a different hook —
/// and a factory and its hook name each other in immutables, so a different hook needs a
/// different factory. What it did *not* need was different liquidity: the position is
/// `VerdantFactory`'s, unchanged.
///
/// Nothing here is per-market. A market's token, its `InstantFeeVault` and its
/// `PositionLocker` are deployed by `InstantDeployer` inside the creator's own
/// transaction. These four are deployed once per chain and then never again.
///
/// ## The cycle, and why it is anchored rather than predicted
///
/// Four contracts that all name each other. `InstantDeployer` and `MarketRegistry` each
/// take the factory in a constructor; `InstantHook` takes it too; and the factory's own
/// constructor then checks that all three name *it*, so a wrong guess is a failed
/// deployment rather than four live contracts that cannot talk.
///
/// The obvious way to know the factory's address in advance is `keccak(rlp(operator,
/// nonce))`, and `test/InstantFactory.t.sol` does exactly that because a test knows its own
/// nonce. A script does not: a contract's nonce counts creations and an account's counts
/// transactions, so the offset that works under `forge test` is not the offset that works
/// under `--broadcast`, and the difference only appears where it cannot be undone. So this
/// reuses `FactoryOrigin`, which publishes the address of its own first creation from its
/// own constructor. The script never computes an address; it reads one.
///
/// ## The hook's address is its permissions
///
/// `InstantHook` needs seven bits where `VerdantHook` needs four, and the two extra are the
/// ones that matter: without `BEFORE_SWAP_RETURNS_DELTA` and `AFTER_SWAP_RETURNS_DELTA` the
/// PoolManager does not read the delta the hook returns, so the 1.50% would go uncharged
/// while every swap still balanced. That failure is silent, which is why the mined address
/// is checked three times — by the miner, by this script, and by the hook's own
/// constructor, which reverts on a mismatch.
///
/// ## Running it
///
/// Simulate — no key, real chain state:
///
///   POOL_MANAGER=0x... POSITION_MANAGER=0x... TREASURY=0x... \
///   forge script script/DeployInstant.s.sol --rpc-url robinhood --sender 0xYOU
///
/// Broadcast:
///
///   ... forge script script/DeployInstant.s.sol --rpc-url robinhood --broadcast
///
/// Or, with the gates in front of it, `bash scripts/deploy-instant.sh`. The simulation
/// prints the address book the broadcast will produce. Read it first.
contract DeployInstant is Script {
    /// @dev The canonical deterministic CREATE2 deployer, verified byte-identical on both
    /// Robinhood chains — see docs/verification.md.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev beforeInitialize | afterInitialize | beforeAddLiquidity | beforeSwap |
    /// afterSwap | beforeSwapReturnsDelta | afterSwapReturnsDelta. `0x38cc`.
    ///
    /// Spelled out from Uniswap's own flags rather than written as the literal, so an
    /// upstream change to a bit's position moves this with it. It is restated from
    /// `InstantHook.REQUIRED_PERMISSIONS`, which is `internal` and cannot be read from
    /// here; the hook's constructor is what makes the restatement safe, since it reverts
    /// unless its own address carries exactly these.
    uint160 internal constant REQUIRED_BITS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    struct Deployment {
        FactoryOrigin origin;
        InstantDeployer deployer;
        MarketRegistry registry;
        InstantHook hook;
        InstantFactory factory;
    }

    struct Inputs {
        address sender;
        address poolManager;
        address positionManager;
        /// @dev Where the platform's 0.50% accrues. Immutable on the factory.
        address treasury;
    }

    function run() external returns (Deployment memory out) {
        Inputs memory input = _inputs();

        vm.startBroadcast(input.sender);

        // Phase 1: the anchor. Everything below is told an address read off it rather than
        // one this script worked out.
        out.origin = new FactoryOrigin(input.sender);
        address factoryAddress = out.origin.factory();
        require(factoryAddress.code.length == 0, "the anchored factory address is already occupied");

        // Phase 2: the two contracts that name the factory. Neither is usable until it
        // exists — the deployer refuses every caller but the factory, the registry every
        // writer but the factory — so there is no window in which half a deployment can be
        // used for anything.
        out.deployer = new InstantDeployer(factoryAddress);
        out.registry = new MarketRegistry(factoryAddress);

        // Phase 3: the hook, at an address that carries its own permissions.
        bytes memory hookInitcode = abi.encodePacked(
            type(InstantHook).creationCode,
            abi.encode(IPoolManager(input.poolManager), factoryAddress, input.positionManager)
        );
        bytes32 salt = _mine(hookInitcode);
        out.hook = InstantHook(_create2(salt, hookInitcode));

        // Phase 4: the factory, at the anchored address, whose constructor closes all
        // three wirings by checking them.
        out.factory = InstantFactory(payable(out.origin.deployFactory(_factoryInitcode(input, out))));

        vm.stopBroadcast();

        // The factory's constructor has checked the half it can see. These check the half
        // it cannot: that it is the factory the other three were told about, and that it
        // holds the addresses this script deployed rather than any others.
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

        // The one input with no counterparty to check it against. A wrong treasury is not
        // recoverable — every market's vault snapshots it at creation — so it is compared
        // against what was asked for rather than merely being non-zero.
        require(out.factory.treasury() == input.treasury, "factory pays a different treasury");

        require(out.registry.marketCount() == 0, "a freshly deployed registry already has markets in it");

        _report(input, salt, out);
    }

    /// @dev `virtual` so a test can inject the inputs instead of reaching for the process
    /// environment. `vm.setEnv` is not rolled back between test cases, so a suite that sets
    /// a variable leaks it into every other suite running beside it.
    function _inputs() internal view virtual returns (Inputs memory input) {
        input.sender = _sender();
        input.poolManager = vm.envAddress("POOL_MANAGER");
        input.positionManager = vm.envAddress("POSITION_MANAGER");
        input.treasury = vm.envAddress("TREASURY");

        _validate(input);
    }

    /// @dev Applied however the inputs arrived, so an injected deployment is held to the
    /// same preconditions as one configured from the environment.
    function _validate(Inputs memory input) internal view {
        require(input.poolManager.code.length > 0, "POOL_MANAGER has no code on this chain");
        require(input.positionManager.code.length > 0, "POSITION_MANAGER has no code on this chain");
        require(input.treasury != address(0), "TREASURY must be set");
        require(input.sender != address(0), "no sender");
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
            type(InstantFactory).creationCode,
            abi.encode(
                IPoolManager(input.poolManager),
                IPositionManager(input.positionManager),
                out.hook,
                out.deployer,
                out.registry,
                input.treasury
            )
        );
    }

    /// @dev Mining is restated against the result rather than trusted from the miner: the
    /// loop and this check would both have to be wrong in the same way for a hook with the
    /// wrong permission bits to reach a broadcast, and a wrong hook address cannot be
    /// repaired — v4 re-reads the bits on every call.
    function _mine(bytes memory initcode) internal view returns (bytes32 salt) {
        address hookAddress;
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

    function _report(Inputs memory input, bytes32 salt, Deployment memory out) internal view {
        console.log("");
        console.log("Instant is deployed. Record these in packages/config/src/deployments.ts:");
        console.log("");
        console.log("  factory  ", address(out.factory));
        console.log("  deployer ", address(out.deployer));
        console.log("  registry ", address(out.registry));
        console.log("  hook     ", address(out.hook));
        console.log("  origin   ", address(out.origin), "(spent, kept for the record)");
        console.log("");
        console.log("  hook salt", vm.toString(salt));
        console.log("  treasury ", input.treasury);
        console.log("");
        // The identity of the code, not merely of the address.
        console.log("  factory runtime code hash", vm.toString(address(out.factory).codehash));
        console.log("  hook runtime code hash   ", vm.toString(address(out.hook).codehash));
        console.log("");
        console.log("Then set INSTANT_LAUNCHABLE = true in apps/agen/src/app/lib/instant.ts.");
    }
}
