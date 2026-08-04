// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {FactoryOrigin} from "../src/FactoryOrigin.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";
import {VerdantDeployer} from "../src/VerdantDeployer.sol";
import {VerdantFactory} from "../src/VerdantFactory.sol";
import {VerdantHook} from "../src/VerdantHook.sol";
import {HookMiner} from "../test/utils/HookMiner.sol";

/// @title Deploy
/// @notice Brings up the whole protocol, in the one order that can work.
///
/// @dev ## Why the order is forced
///
/// Verdant has no setters. Every contract learns its counterparties in a constructor
/// and holds them in immutables, which is what makes "the fee split of a live market
/// cannot be changed" a fact about bytecode rather than a promise about an owner. The
/// cost is paid here, once: three contracts name the factory, so they must be
/// deployed before the address they name has code.
///
/// That address comes from `FactoryOrigin`, which computes and publishes it in its
/// own constructor and can create exactly once. Nothing in this script computes an
/// address from an operator nonce, so the same sequence produces the same result
/// whether the sender is an account on Robinhood mainnet or a contract in CI — see
/// `test/Deploy.t.sol`, which runs this script and then launches a market through
/// what it deployed. A deployment path for an unrecoverable deployment should be
/// exercised before it is used.
///
/// The hook is mined rather than predicted: v4 reads a hook's permissions from the
/// low 14 bits of its address, so the address must carry `0x3880` and is reached with
/// `CREATE2` through the canonical deterministic deployer. Mining depends on the
/// constructor arguments, which include the factory — the anchor's published address
/// serves for that too. The deployment is an explicit call to the deployer rather
/// than `new VerdantHook{salt: ...}` so that the creating account is the same one the
/// salt was mined against in every environment.
///
/// ## Running it
///
/// Simulate — no key, real chain state:
///
///   POOL_MANAGER=0x... POSITION_MANAGER=0x... TREASURY=0x... \
///   forge script script/Deploy.s.sol --rpc-url robinhood --sender 0xYOU
///
/// Broadcast:
///
///   ... forge script script/Deploy.s.sol --rpc-url robinhood --broadcast
///
/// The simulation prints the address book the broadcast will produce. Read it first.
/// Verification is Blockscout only on 4663; the hook arrives through the
/// deterministic deployer, so verify it by address with `forge verify-contract`.
///
/// ## Where the parameters come from
///
/// `ModelRegistry` is seeded from `packages/config/generated/bounds.json`, the same
/// projection of the parameter register that `BoundsParity.t.sol` asserts a deployed
/// registry against. Nothing is retyped here, so a deployment that disagrees with the
/// register is one the parity test fails on.
contract Deploy is Script {
    /// @dev The canonical deterministic CREATE2 deployer, verified byte-identical on
    /// both Robinhood chains — see docs/verification.md.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev beforeInitialize | afterInitialize | beforeAddLiquidity | beforeSwap.
    uint160 internal constant REQUIRED_BITS = 0x3880;

    struct Deployment {
        FactoryOrigin origin;
        ModelRegistry modelRegistry;
        MarketRegistry marketRegistry;
        VerdantDeployer deployer;
        VerdantHook hook;
        VerdantFactory factory;
    }

    /// @dev The environment, read once and validated once. A struct because the
    /// alternative is six locals live across the whole of `run`, and this function
    /// runs out of stack slots before it runs out of things to do.
    struct Inputs {
        address sender;
        address poolManager;
        address positionManager;
        address treasury;
        address registryOwner;
    }

    function run() external returns (Deployment memory out) {
        Inputs memory input = _inputs();

        vm.startBroadcast(input.sender);

        // Phase 1: the anchor. Everything downstream is addressed off it.
        out.origin = new FactoryOrigin(input.sender);
        address factoryAddress = out.origin.factory();
        require(factoryAddress.code.length == 0, "the anchored factory address is already occupied");

        // Phase 2: the two contracts that name the factory, plus the model
        // registry, which does not — it is deployed here because a factory pointed
        // at a registry that does not exist yet is not a state worth having.
        out.modelRegistry =
            new ModelRegistry(input.registryOwner, _maxProtocolBps(), _defaultProtocolBps(), _bounds(), _quoteAssets());
        out.marketRegistry = new MarketRegistry(factoryAddress);
        out.deployer = new VerdantDeployer(factoryAddress);

        // Phase 3: the hook, at an address that carries its own permissions.
        bytes memory hookInitcode = abi.encodePacked(
            type(VerdantHook).creationCode,
            abi.encode(IPoolManager(input.poolManager), factoryAddress, input.positionManager)
        );
        bytes32 salt = _mine(hookInitcode);
        out.hook = VerdantHook(_create2(salt, hookInitcode));

        // Phase 4: the factory, at the anchored address, which closes every wiring
        // check in its constructor.
        out.factory = VerdantFactory(out.origin.deployFactory(_factoryInitcode(input, out)));

        vm.stopBroadcast();

        // The constructors have checked their own halves. These check the halves no
        // constructor can see: that the factory is the one the others were told
        // about, and that it names the hook that was actually deployed.
        require(address(out.factory) == factoryAddress, "factory is not at the anchored address");
        require(out.factory.hook() == out.hook, "factory does not name the deployed hook");
        require(out.marketRegistry.writer() == address(out.factory), "registry writer is not the factory");
        require(out.deployer.factory() == address(out.factory), "deployer is not bound to the factory");

        _report(input, salt, out);
    }

    /// @dev `virtual` so that a test can supply the inputs directly instead of through
    /// the process environment. `vm.setEnv` writes state that Foundry does not roll
    /// back between test cases — `setUp` runs once and the EVM is snapshotted, but the
    /// environment is not — so a suite that sets a variable leaks it into every later
    /// case and into every suite running beside it. Injecting is the only way several
    /// tests can each deploy against their own PoolManager without standing on each
    /// other. See `test/utils/DeployHarness.sol`.
    function _inputs() internal view virtual returns (Inputs memory input) {
        input.sender = _sender();
        input.poolManager = vm.envAddress("POOL_MANAGER");
        input.positionManager = vm.envAddress("POSITION_MANAGER");
        input.treasury = vm.envAddress("TREASURY");
        input.registryOwner = vm.envOr("REGISTRY_OWNER", input.sender);

        _validate(input);
    }

    /// @dev Applied to the inputs however they arrived, so that an injected
    /// deployment is held to the same preconditions as one configured from the
    /// environment.
    function _validate(Inputs memory input) internal view {
        require(input.poolManager.code.length > 0, "POOL_MANAGER has no code on this chain");
        require(input.positionManager.code.length > 0, "POSITION_MANAGER has no code on this chain");
        require(input.treasury != address(0), "TREASURY must be set");
        require(input.registryOwner != address(0), "REGISTRY_OWNER must be set");
        require(CREATE2_DEPLOYER.code.length > 0, "no deterministic deployer on this chain");
    }

    /// @dev Built as data because `FactoryOrigin` must not embed the factory's
    /// bytecode: the factory is close to the EIP-170 limit, and a contract carrying
    /// a copy of it could not itself be deployed.
    function _factoryInitcode(Inputs memory input, Deployment memory out) internal pure returns (bytes memory) {
        return abi.encodePacked(
            type(VerdantFactory).creationCode,
            abi.encode(
                IPoolManager(input.poolManager),
                IPositionManager(input.positionManager),
                out.hook,
                out.deployer,
                out.modelRegistry,
                out.marketRegistry,
                input.treasury
            )
        );
    }

    /// @dev The account the deployment is made from and the anchor's operator.
    /// Overridden in `Deploy.t.sol` so that the harness is its own operator; in a
    /// script this is `--sender`.
    function _sender() internal view virtual returns (address) {
        return msg.sender;
    }

    /// @dev Mining is restated against the result rather than trusted from the
    /// miner: the loop and this check would both have to be wrong in the same way
    /// for a hook with the wrong permission bits to reach a broadcast, and a wrong
    /// hook address cannot be repaired — v4 re-reads the bits on every call.
    function _mine(bytes memory initcode) internal view returns (bytes32 salt) {
        address hookAddress;
        (hookAddress, salt) = HookMiner.findFromInitcode(CREATE2_DEPLOYER, REQUIRED_BITS, initcode);

        require(uint160(hookAddress) & Hooks.ALL_HOOK_MASK == REQUIRED_BITS, "mined address does not carry 0x3880");
        require(hookAddress.code.length == 0, "something is already deployed at the mined address");
    }

    /// @dev Through the deterministic deployer by explicit call, so the creating
    /// account is the address the salt was mined against no matter who is running
    /// this. `new X{salt: ...}` would be the script contract under `forge test` and
    /// the deployer under `--broadcast`, which is a difference that would only show
    /// up in production.
    function _create2(bytes32 salt, bytes memory initcode) internal returns (address deployed) {
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initcode));
        require(ok, "CREATE2 deployment reverted");
        require(ret.length == 20, "deterministic deployer returned no address");
        // forge-lint: disable-next-line(unsafe-typecast) -- 20 bytes, checked above
        deployed = address(bytes20(ret));
        require(deployed.code.length > 0, "nothing was deployed");
    }

    // --- the parameter register, as data -------------------------------------

    function _json() internal view returns (string memory) {
        return vm.readFile("../config/generated/bounds.json");
    }

    function _maxProtocolBps() internal view returns (uint16) {
        return _toBps(vm.parseJsonUint(_json(), ".splits.maxProtocolBps"));
    }

    function _defaultProtocolBps() internal view returns (uint16) {
        return _toBps(vm.parseJsonUint(_json(), ".splits.defaultProtocolBps"));
    }

    /// @dev Index-aligned with the model discriminant, in the order the register
    /// lists them. That order *is* the on-chain model id, which is why the arrays
    /// are read positionally rather than by name.
    function _bounds() internal view returns (ModelRegistry.ModelBounds[] memory bounds) {
        string memory json = _json();
        uint256 count = vm.parseJsonUint(json, ".modelCount");

        bool[] memory enabled = vm.parseJsonBoolArray(json, ".modelEnabled");
        uint256[] memory minStages = vm.parseJsonUintArray(json, ".modelMinStages");
        uint256[] memory maxStages = vm.parseJsonUintArray(json, ".modelMaxStages");
        uint256[] memory minReserve = vm.parseJsonUintArray(json, ".modelMinReserveBps");
        uint256[] memory maxReserve = vm.parseJsonUintArray(json, ".modelMaxReserveBps");

        require(enabled.length == count, "modelEnabled length");
        require(minStages.length == count, "modelMinStages length");
        require(maxStages.length == count, "modelMaxStages length");
        require(minReserve.length == count, "modelMinReserveBps length");
        require(maxReserve.length == count, "modelMaxReserveBps length");

        bounds = new ModelRegistry.ModelBounds[](count);
        for (uint256 i = 0; i < count; i++) {
            bounds[i] = ModelRegistry.ModelBounds({
                enabled: enabled[i],
                minStages: _toStages(minStages[i]),
                maxStages: _toStages(maxStages[i]),
                minReserveBps: _toBps(minReserve[i]),
                maxReserveBps: _toBps(maxReserve[i])
            });
        }
    }

    /// @dev The assets a market may be quoted in besides ether, in the register's
    /// order. Read as data for the same reason the bounds are: the reviewed list
    /// lives in `packages/config/src/quote-assets.ts` and retyping thirty addresses
    /// into Solidity is how one of them ends up wrong.
    ///
    /// The addresses are Robinhood Chain's own equity tokens and exist on that chain
    /// only. Seeding them anywhere else admits addresses with no code, which no
    /// launch could use — logged rather than refused, because a local rig deliberately
    /// runs with this chain id and admits a mock of its own afterwards.
    function _quoteAssets() internal view returns (address[] memory assets) {
        string memory json = _json();
        assets = vm.parseJsonAddressArray(json, ".quoteAssets");

        uint256 expected = vm.parseJsonUint(json, ".quoteAssetCount");
        require(assets.length == expected, "quoteAssets length");

        uint256 listChainId = vm.parseJsonUint(json, ".quoteAssetChainId");
        if (listChainId != block.chainid) {
            console.log("WARNING: the reviewed quote assets are for chain", listChainId);
            console.log("         deploying to chain", block.chainid);
        }
    }

    /// @dev Narrowing from the JSON's `uint256` is checked rather than assumed: a
    /// register edit that overflowed a field would otherwise seed a registry with a
    /// value nobody wrote.
    function _toBps(uint256 value) internal pure returns (uint16) {
        require(value <= type(uint16).max, "bps value does not fit uint16");
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded on the line above
        return uint16(value);
    }

    function _toStages(uint256 value) internal pure returns (uint8) {
        require(value <= type(uint8).max, "stage count does not fit uint8");
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded on the line above
        return uint8(value);
    }

    function _report(Inputs memory input, bytes32 salt, Deployment memory out) internal view {
        console.log("--- inputs ---");
        console.log("sender         ", input.sender);
        console.log("registry owner ", input.registryOwner);
        console.log("PoolManager    ", input.poolManager);
        console.log("PositionManager", input.positionManager);
        console.log("treasury       ", input.treasury);
        console.log("");
        console.log("--- deployed ---");
        console.log("FactoryOrigin  ", address(out.origin));
        console.log("ModelRegistry  ", address(out.modelRegistry));
        console.log("MarketRegistry ", address(out.marketRegistry));
        console.log("VerdantDeployer", address(out.deployer));
        console.log("VerdantHook    ", address(out.hook));
        console.log("VerdantFactory ", address(out.factory));
        console.log("");
        console.log("hook salt      ", vm.toString(salt));
        console.log("protocol share ", out.modelRegistry.protocolBps());
        console.log("quote assets   ", out.modelRegistry.admittedQuoteAssets().length);
        console.log("");
        console.log("Record these in packages/config/src/deployments.ts.");
    }
}
