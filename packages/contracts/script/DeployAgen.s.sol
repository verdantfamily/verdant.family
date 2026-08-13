// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {AgenDeployer} from "../src/agen/AgenDeployer.sol";
import {AgenFactory} from "../src/agen/AgenFactory.sol";
import {AgenMarketRegistry} from "../src/agen/AgenMarketRegistry.sol";
import {AgenRouter} from "../src/agen/AgenRouter.sol";
import {FactoryOrigin} from "../src/FactoryOrigin.sol";

/// @title DeployAgen
/// @notice Brings up the three shared contracts every generated market is launched
/// through: the deployer, the registry, and the factory that drives both.
///
/// @dev Separate from `Deploy.s.sol` because the two systems are separate on chain.
/// Verdant's factory launches markets whose shape is fixed at its own construction;
/// Agen's launches however many contracts a generated mechanic needs. They share the
/// PoolManager and nothing else, and deploying one must never be able to disturb the
/// other — which is easiest to guarantee when they are not in the same script.
///
/// Nothing here is per-market. A generated market's own contracts are deployed by
/// `AgenFactory.deployMarket`, from a manifest built off chain, in the transaction the
/// creator signs. These three are deployed once per chain and then never again.
///
/// ## The cycle, and why it is anchored rather than predicted
///
/// `AgenDeployer` and `AgenMarketRegistry` each name the factory in a constructor and
/// hold it in an immutable, so both have to exist before the factory does — and the
/// factory's constructor then checks that both name *it*, so a wrong guess is a failed
/// deployment rather than three live contracts that cannot talk to each other.
///
/// The obvious way to know the factory's address in advance is `keccak(rlp(operator,
/// nonce))`, and `test/agen/*` does exactly that because a test knows its own nonce.
/// A script does not: a contract's nonce counts creations and an account's counts
/// transactions, so the offset that works under `forge test` is not the offset that
/// works under `--broadcast`, and the difference only appears in the environment where
/// it cannot be undone. So this reuses `FactoryOrigin`, which publishes the address of
/// its own first creation from its own constructor. The script never computes an
/// address; it reads one. See that contract for the full argument — it is the same one
/// Verdant's deployment settled, and there is no reason for Agen to relearn it.
///
/// ## Running it
///
/// Simulate — no key, real chain state:
///
///   POOL_MANAGER=0x... POSITION_MANAGER=0x... \
///   forge script script/DeployAgen.s.sol --rpc-url robinhood --sender 0xYOU
///
/// Broadcast:
///
///   ... forge script script/DeployAgen.s.sol --rpc-url robinhood --broadcast
///
/// The simulation prints the address book the broadcast will produce, including the
/// three `NEXT_PUBLIC_AGEN_*` variables the interface reads. Read it first.
contract DeployAgen is Script {
    struct Deployment {
        FactoryOrigin origin;
        AgenDeployer deployer;
        AgenMarketRegistry registry;
        AgenFactory factory;
        AgenRouter router;
        /// @dev False when an existing router was adopted rather than deployed.
        bool routerIsNew;
    }

    struct Inputs {
        address sender;
        address poolManager;
        address positionManager;
        /// @dev An AgenRouter already on this chain. Zero to deploy one.
        address router;
    }

    function run() external returns (Deployment memory out) {
        Inputs memory input = _inputs();

        vm.startBroadcast(input.sender);

        // Phase 0: the router, which is not part of the cycle below and must outlive it.
        //
        // A generated hook holds this address in an immutable, so replacing the router
        // orphans every market that authenticates against it — permanently, since a
        // deployed hook cannot be told a new one. The factory has no such constraint and
        // may legitimately be redeployed for an ABI change, so the two are decoupled
        // here: pass `AGEN_ROUTER` and this adopts the existing one, leave it unset and
        // it deploys a fresh one. There is no path that quietly replaces a live router.
        if (input.router == address(0)) {
            out.router = new AgenRouter(IPoolManager(input.poolManager));
            out.routerIsNew = true;
        } else {
            out.router = AgenRouter(payable(input.router));
        }

        // Phase 1: the anchor. Both contracts below are told an address read off it
        // rather than one this script worked out.
        out.origin = new FactoryOrigin(input.sender);
        address factoryAddress = out.origin.factory();
        require(factoryAddress.code.length == 0, "the anchored factory address is already occupied");

        // Phase 2: the two contracts that name the factory. Neither is usable until it
        // exists — the deployer refuses every caller but the factory, and the registry
        // refuses every writer but the factory — so there is no window here in which
        // half a deployment can be used for anything.
        out.deployer = new AgenDeployer(factoryAddress);
        out.registry = new AgenMarketRegistry(factoryAddress);

        // Phase 3: the factory, at the anchored address, whose constructor closes both
        // wirings by checking them.
        out.factory = AgenFactory(
            out.origin.deployFactory(
                abi.encodePacked(
                    type(AgenFactory).creationCode,
                    abi.encode(
                        IPoolManager(input.poolManager),
                        IPositionManager(input.positionManager),
                        out.deployer,
                        out.registry
                    )
                )
            )
        );

        vm.stopBroadcast();

        // The factory's constructor has checked the half it can see. These check the
        // half it cannot: that it is the factory the other two were told about, and
        // that it holds the addresses this script deployed rather than any others.
        require(address(out.factory) == factoryAddress, "factory is not at the anchored address");
        require(out.deployer.factory() == address(out.factory), "deployer is not bound to the factory");
        require(out.registry.factory() == address(out.factory), "registry is not bound to the factory");
        require(address(out.factory.deployer()) == address(out.deployer), "factory names a different deployer");
        require(address(out.factory.registry()) == address(out.registry), "factory names a different registry");
        require(
            address(out.factory.positionManager()) == input.positionManager,
            "factory names a different position manager"
        );
        require(address(out.factory.poolManager()) == input.poolManager, "factory names a different pool manager");
        require(out.registry.count() == 0, "a freshly deployed registry already has markets in it");

        // The router shares only the pool manager with the rest of this. Checked because
        // a router pointed at a different manager would accept trades, settle nothing,
        // and revert every swap on a market that had already been launched against it.
        require(address(out.router).code.length > 0, "the router has no code on this chain");
        require(
            address(out.router.poolManager()) == input.poolManager, "router names a different pool manager"
        );

        _report(out);
    }

    /// @dev `virtual` so a test can inject the inputs instead of reaching for the
    /// process environment. `vm.setEnv` is not rolled back between test cases, so a
    /// suite that sets a variable leaks it into every other suite running beside it —
    /// the same reasoning as `Deploy.s.sol`, and the reason `DeployAgen.t.sol` can run
    /// this against its own PoolManager.
    function _inputs() internal view virtual returns (Inputs memory input) {
        input.sender = _sender();
        input.poolManager = vm.envAddress("POOL_MANAGER");
        input.positionManager = vm.envAddress("POSITION_MANAGER");
        // Optional: set it to keep the router this chain already has.
        input.router = vm.envOr("AGEN_ROUTER", address(0));

        _validate(input);
    }

    /// @dev Applied however the inputs arrived. A PoolManager with no code is the one
    /// mistake that produces a factory which deploys markets nobody can trade: every
    /// component would land, the registry would record them, and `initialize` would
    /// call into nothing.
    function _validate(Inputs memory input) internal view {
        require(input.poolManager.code.length > 0, "POOL_MANAGER has no code on this chain");
        require(input.positionManager.code.length > 0, "POSITION_MANAGER has no code on this chain");
        require(input.sender != address(0), "no sender");
        // Adopting an address with nothing at it would produce a deployment that reports
        // a router and has none, which every later market would trust.
        require(
            input.router == address(0) || input.router.code.length > 0,
            "AGEN_ROUTER has no code on this chain"
        );
    }

    function _sender() internal view virtual returns (address) {
        return msg.sender;
    }

    function _report(Deployment memory out) internal view {
        console.log("");
        console.log("Agen is deployed. The interface reads these four:");
        console.log("");
        console.log("NEXT_PUBLIC_AGEN_FACTORY ", address(out.factory));
        console.log("NEXT_PUBLIC_AGEN_DEPLOYER", address(out.deployer));
        console.log("NEXT_PUBLIC_AGEN_REGISTRY", address(out.registry));
        console.log("NEXT_PUBLIC_AGEN_ROUTER  ", address(out.router));
        console.log("");

        if (out.routerIsNew) {
            console.log("The router is new. Record it: every market built after this");
            console.log("point may hold it immutably, so it must never be replaced.");
        } else {
            console.log("The router was adopted, not deployed. Markets that trust it are unaffected.");
        }

        // The identity of the code, not merely of the address. A router at the expected
        // address running unexpected code is the one failure this deployment could have
        // that nothing else here would notice.
        console.log("router runtime code hash", vm.toString(address(out.router).codehash));
        console.log("");
        console.log("FACTORY_ORIGIN (spent, kept for the record)", address(out.origin));
    }
}
