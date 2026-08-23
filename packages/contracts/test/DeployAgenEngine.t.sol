// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {DeployAgenEngine} from "../script/DeployAgenEngine.s.sol";
import {FactoryOrigin} from "../src/FactoryOrigin.sol";
import {AgenMarketRegistry} from "../src/agen/AgenMarketRegistry.sol";
import {AgenEngineDeployer} from "../src/agen/engine/AgenEngineDeployer.sol";
import {AgenEngineFactory} from "../src/agen/engine/AgenEngineFactory.sol";
import {AgenEngineHook} from "../src/agen/engine/AgenEngineHook.sol";
import {HookMiner} from "./utils/HookMiner.sol";
import {InjectedEngineDeployHarness} from "./utils/EngineDeployHarness.sol";

/// @title The engine deployment, as a test
/// @notice Runs `script/DeployAgenEngine.s.sol` and then re-derives, independently, every
/// address it produced.
///
/// @dev An engine deployment cannot be corrected. The hook, the deployer and the registry
/// each name the factory in an immutable, the factory checks all three in its constructor,
/// the anchor can create exactly once, and the hook's permissions are its address — so a
/// mistake is not patched, it is abandoned, and any market launched in between is stranded on
/// a factory nothing else points at. So the script is treated as protocol code and tested
/// like it.
///
/// `EngineLaunch.t.sol` already asserts that a hand-written five-phase deployment produces a
/// factory a market can be launched through. What it cannot assert is that *the script* does,
/// and the two are not the same claim: the script's job is to arrive at those addresses from
/// nothing but a pool manager, a position manager, a treasury and an operator, and the way it
/// can fail is by deriving one of them from the wrong input. A hook mined against last week's
/// origin is the case that matters, because every other check in the system still passes for
/// a while — the mining is self-consistent, the hook's bits can be right, and the mismatch
/// only surfaces when the factory's constructor rejects a hook that names somebody else. Or,
/// if the stale salt happens to land on bits that collide, does not surface at all.
///
/// So this file checks the chain link by link, in both directions:
///
///   forward   origin → predicted factory → hook initcode → mined salt → predicted hook →
///             deployed hook → final factory, each equal to the next by re-derivation here
///             rather than by the script's own arithmetic.
///
///   backward  change the operator, the origin, the predicted factory or a hook constructor
///             argument, and the addresses downstream of it must move. A derived address
///             that does not move when its input does is a stale value, which is the whole
///             failure this deployment shape exists to make impossible.
contract DeployAgenEngineScriptTest is Deployers {
    /// @dev RLP of `[address, 1]` — a 22-byte list, a 20-byte string, and the byte 0x01.
    /// Restated from `FactoryOrigin`'s constructor rather than read from it, so that the
    /// anchor's arithmetic is checked by a second implementation instead of trusted.
    bytes internal constant RLP_NONCE_ONE_PREFIX = hex"d694";

    PositionManager internal posm;
    DeployAgenEngine.Deployment internal d;
    InjectedEngineDeployHarness internal harness;

    address internal treasury = makeAddr("engine treasury");

    uint160 internal constant ENGINE_FLAGS = 0x38CC;

    function setUp() public {
        deployFreshManagerAndRouters();
        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        // No environment variable is set anywhere in this file, which is the point: the
        // script needs a pool manager, a position manager, a treasury and an operator, and
        // derives everything else. `HOOK_SALT` used to be a sixth input and is now an output.
        harness = new InjectedEngineDeployHarness(address(manager), address(posm), treasury);
        d = harness.run();
    }

    // --- the chain, forward ---------------------------------------------------

    /// The anchor's published address, recomputed here from the origin that actually exists.
    function test_thePredictedFactoryIsTheAnchorsFirstCreation() public view {
        address recomputed =
            address(uint160(uint256(keccak256(abi.encodePacked(RLP_NONCE_ONE_PREFIX, address(d.origin), hex"01")))));

        assertEq(d.predictedFactory, recomputed, "the anchor published an address it does not derive");
        assertEq(d.origin.factory(), d.predictedFactory, "the deployment carries a different prediction");
        assertEq(d.origin.operator(), address(harness), "the anchor names an operator nobody deployed it for");
        assertTrue(d.origin.used(), "the anchor was never spent");
    }

    /// The salt in the deployment is the salt this test finds for the same initcode. Mined
    /// from the origin that exists, not from one supplied to it.
    function test_theMinedSaltIsTheSaltThisOriginImplies() public view {
        bytes memory initcode = _hookInitcode(address(manager), d.predictedFactory, address(posm));

        (address predicted, bytes32 salt) =
            HookMiner.findFromInitcode(harness.create2Deployer(), harness.requiredBits(), initcode);

        assertEq(salt, d.hookSalt, "the deployment's salt is not the one this initcode mines to");
        assertEq(predicted, d.predictedHook, "the deployment predicted a different hook address");
    }

    /// And the salt lands where the deployment says it does, by the CREATE2 formula rather
    /// than by the miner.
    function test_thePredictedHookIsWhereTheSaltLands() public view {
        bytes memory initcode = _hookInitcode(address(manager), d.predictedFactory, address(posm));

        address computed = HookMiner.computeAddress(harness.create2Deployer(), d.hookSalt, keccak256(initcode));

        assertEq(computed, d.predictedHook, "the salt does not land on the predicted hook");
        assertEq(address(d.hook), d.predictedHook, "the hook did not land where it was mined");
    }

    function test_theDeployedFactoryIsThePredictedFactory() public view {
        assertEq(address(d.factory), d.predictedFactory, "the factory is not at the anchored address");
        assertGt(address(d.factory).code.length, 0, "nothing was deployed at the anchored address");
    }

    /// Both halves of the cycle, from both ends.
    function test_theDeploymentIsWiredToItself() public view {
        assertEq(d.hook.factory(), address(d.factory), "the hook is bound to the factory");
        assertEq(d.deployer.factory(), address(d.factory), "only the factory may deploy market contracts");
        assertEq(d.registry.factory(), address(d.factory), "only the factory may write the record");
        assertEq(address(d.factory.hook()), address(d.hook), "the factory names the deployed hook");
        assertEq(address(d.factory.deployer()), address(d.deployer), "the factory names the deployer");
        assertEq(address(d.factory.registry()), address(d.registry), "the factory names the registry");
        assertEq(address(d.factory.poolManager()), address(manager), "the factory names this PoolManager");
        assertEq(address(d.factory.positionManager()), address(posm), "and this PositionManager");
        assertEq(address(d.hook.poolManager()), address(manager), "the hook names this PoolManager");
        assertEq(d.hook.positionManager(), address(posm), "the hook names this PositionManager");
    }

    /// The seven bits, on the address itself.
    ///
    /// Two of them are the ones worth having a test for. Without `BEFORE_SWAP_RETURNS_DELTA`
    /// and `AFTER_SWAP_RETURNS_DELTA` the PoolManager never reads the delta the hook returns,
    /// so a market's fee would go uncharged while every swap still balanced — a deployment
    /// that looks entirely healthy and earns nobody anything.
    function test_theHookAddressCarriesItsPermissions() public view {
        uint160 bits = uint160(address(d.hook)) & Hooks.ALL_HOOK_MASK;

        assertEq(bits, ENGINE_FLAGS, "the mined hook address does not carry 0x38cc");
        assertEq(harness.requiredBits(), ENGINE_FLAGS, "the script mines for a different permission set");
        assertTrue(bits & uint160(Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG) != 0, "the buy-side delta bit is missing");
        assertTrue(bits & uint160(Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG) != 0, "the sell-side delta bit is missing");
    }

    /// The one input nothing else can check. A wrong treasury is unrecoverable: it is
    /// immutable on the factory and every market's vault snapshots it at creation.
    function test_theTreasuryIsTheOneThatWasAskedFor() public view {
        assertEq(d.factory.treasury(), treasury, "the factory pays a different treasury");
    }

    function test_theRegistryStartsEmpty() public view {
        assertEq(d.registry.count(), 0, "a freshly deployed registry already has markets");
    }

    // --- the chain, backward --------------------------------------------------

    /// A different operator is a different origin address, so a different predicted factory,
    /// so different hook initcode, so a different hook. Two harnesses are two addresses,
    /// which is how an operator is varied without stubbing anything.
    function test_aDifferentOperatorMovesEveryDerivedAddress() public {
        InjectedEngineDeployHarness other = new InjectedEngineDeployHarness(address(manager), address(posm), treasury);
        DeployAgenEngine.Deployment memory e = other.run();

        assertTrue(address(e.origin) != address(d.origin), "two operators produced one origin");
        assertTrue(e.predictedFactory != d.predictedFactory, "two origins predicted one factory");
        assertTrue(address(e.factory) != address(d.factory), "two deployments landed on one factory");
        assertTrue(address(e.hook) != address(d.hook), "two predicted factories mined one hook");
        assertTrue(address(e.deployer) != address(d.deployer), "two deployments share a deployer");
        assertTrue(address(e.registry) != address(d.registry), "two deployments share a registry");

        // Each is internally consistent, so neither is a half-failure that merely happens to
        // differ. Both are whole deployments that cannot be confused for each other.
        assertEq(e.hook.factory(), address(e.factory), "the second hook is bound elsewhere");
        assertEq(address(e.factory.hook()), address(e.hook), "the second factory names another hook");
        assertEq(e.origin.operator(), address(other), "the second anchor names another operator");
    }

    /// Two anchors created by the same account still predict different factories, because the
    /// prediction is derived from the origin's address and the origin's comes from the
    /// creator's nonce. This is the property that makes a salt mined for one deployment
    /// worthless for the next one, which is why the salt is no longer carried between runs.
    function test_twoAnchorsFromOneAccountPredictDifferentFactories() public {
        FactoryOrigin first = new FactoryOrigin(address(this));
        FactoryOrigin second = new FactoryOrigin(address(this));

        assertTrue(address(first) != address(second), "one account created one origin twice");
        assertTrue(first.factory() != second.factory(), "two origins predicted the same factory");
    }

    /// The hook's initcode embeds the factory's address, so the factory is a hook constructor
    /// argument in everything but name.
    function test_aDifferentPredictedFactoryMinesToADifferentHook() public view {
        address other = address(uint160(d.predictedFactory) ^ 1);

        (address predicted, bytes32 salt) = HookMiner.findFromInitcode(
            harness.create2Deployer(), harness.requiredBits(), _hookInitcode(address(manager), other, address(posm))
        );

        assertTrue(predicted != d.predictedHook, "two factories mined to one hook address");
        assertTrue(salt != d.hookSalt, "two factories mined to one salt");
    }

    function test_aDifferentPositionManagerMinesToADifferentHook() public view {
        (address predicted,) = HookMiner.findFromInitcode(
            harness.create2Deployer(),
            harness.requiredBits(),
            _hookInitcode(address(manager), d.predictedFactory, address(uint160(address(posm)) ^ 1))
        );

        assertTrue(predicted != d.predictedHook, "the position manager does not reach the hook's address");
    }

    function test_aDifferentPoolManagerMinesToADifferentHook() public view {
        (address predicted,) = HookMiner.findFromInitcode(
            harness.create2Deployer(),
            harness.requiredBits(),
            _hookInitcode(address(uint160(address(manager)) ^ 1), d.predictedFactory, address(posm))
        );

        assertTrue(predicted != d.predictedHook, "the pool manager does not reach the hook's address");
    }

    /// The failure the old `HOOK_SALT` input made possible, demonstrated. A salt mined for
    /// this deployment, used with initcode naming a different factory, does not land on an
    /// address carrying the permission bits — so the hook's own constructor rejects it and
    /// the deployment fails rather than producing a hook v4 would never call.
    function test_aSaltMinedForAnotherFactoryCannotDeployTheHook() public {
        FactoryOrigin other = new FactoryOrigin(address(this));
        bytes memory initcode = _hookInitcode(address(manager), other.factory(), address(posm));

        address wouldLandAt = HookMiner.computeAddress(harness.create2Deployer(), d.hookSalt, keccak256(initcode));

        assertTrue(
            uint160(wouldLandAt) & Hooks.ALL_HOOK_MASK != ENGINE_FLAGS,
            "a stale salt happened to carry the permission bits"
        );

        (bool ok,) = harness.create2Deployer().call(abi.encodePacked(d.hookSalt, initcode));
        assertFalse(ok, "a hook deployed under a stale salt at an address without its permissions");
        assertEq(wouldLandAt.code.length, 0, "the stale deployment left code behind");
    }

    /// And if a stale hook is somehow carried into the factory's initcode instead, the
    /// factory's constructor is the backstop. A whole second deployment, wired to itself
    /// except for the hook, which still names the first factory.
    ///
    /// Through the anchor, the constructor's own error is not what surfaces: `deployFactory`
    /// uses `create`, which returns the zero address rather than bubbling a revert, so the
    /// anchor's "did not land on the published address" is what the operator would see. That
    /// is the production failure mode and it is worth pinning, since it is the one that says
    /// nothing about *why*.
    function test_theAnchorRefusesAFactoryNamingAStaleHook() public {
        FactoryOrigin other = new FactoryOrigin(address(this));
        bytes memory initcode = _staleHookFactoryInitcode(other.factory());
        address expected = other.factory();

        vm.expectRevert(abi.encodeWithSelector(FactoryOrigin.NotDeployed.selector, address(0), expected));
        other.deployFactory(initcode);
    }

    /// The reason it failed, named. Same deployment as above, through an anchor that bubbles
    /// the constructor's revert instead of reporting only that nothing landed — so the check
    /// doing the work is pinned to its own error rather than to a symptom.
    function test_theFactoryConstructorRefusesAHookThatNamesAnotherFactory() public {
        BubblingOrigin other = new BubblingOrigin();
        bytes memory initcode = _staleHookFactoryInitcode(other.factory());

        vm.expectRevert(
            abi.encodeWithSelector(AgenEngineFactory.HookNotOurs.selector, address(d.factory), other.factory())
        );
        other.deployFactory(initcode);
    }

    /// The anchor is spent, so the addresses this deployment published cannot be reoccupied
    /// by a second factory later.
    function test_theAnchorCannotBeUsedTwice() public {
        vm.prank(address(harness));
        vm.expectRevert(abi.encodeWithSelector(FactoryOrigin.AlreadyUsed.selector, d.predictedFactory));
        d.origin.deployFactory(hex"00");
    }

    // --- helpers --------------------------------------------------------------

    /// @dev The hook's initcode, assembled here rather than asked of the script, so that the
    /// script's own concatenation is checked against a second one. Both read
    /// `type(AgenEngineHook).creationCode` because that is the artefact being deployed; what
    /// is independent is the argument encoding and its order.
    function _hookInitcode(address poolManager, address factory, address positionManager)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(AgenEngineHook).creationCode, abi.encode(IPoolManager(poolManager), factory, positionManager)
        );
    }

    /// @dev A second engine deployment, wired to `predictedFactory` in every part except the
    /// hook, which is this test's hook and still names the first factory. The shape a stale
    /// salt would eventually produce if the hook's own constructor had not already refused it.
    function _staleHookFactoryInitcode(address predictedFactory) internal returns (bytes memory) {
        AgenEngineDeployer otherDeployer = new AgenEngineDeployer(predictedFactory);
        AgenMarketRegistry otherRegistry = new AgenMarketRegistry(predictedFactory);

        return abi.encodePacked(
            type(AgenEngineFactory).creationCode,
            abi.encode(
                IPoolManager(address(manager)),
                IPositionManager(address(posm)),
                otherDeployer,
                otherRegistry,
                d.hook,
                treasury
            )
        );
    }
}

/// @title BubblingOrigin
/// @notice `FactoryOrigin`'s arithmetic with its error handling inverted: it forwards
/// whatever the factory's constructor reverted with, rather than reporting only that the
/// creation did not land.
///
/// @dev A test helper, and deliberately not what production does. `FactoryOrigin` uses `create`
/// and reads a zero return as "not where the counterparties were told it would be", which
/// collapses every constructor failure into one error — good for an anchor whose whole surface
/// is one call, and useless for a test that needs to say *which* wiring check failed. This has
/// the same nonce-1 prediction so the factory's `address(this)` is the address its
/// counterparties were told about, which is the only reason the hook check is reached at all.
contract BubblingOrigin {
    address public immutable factory;

    constructor() {
        factory = address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), hex"01")))));
    }

    function deployFactory(bytes calldata initcode) external returns (address deployed) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, initcode.offset, initcode.length)
            deployed := create(0, ptr, initcode.length)
            if iszero(deployed) {
                returndatacopy(ptr, 0, returndatasize())
                revert(ptr, returndatasize())
            }
        }
    }
}
