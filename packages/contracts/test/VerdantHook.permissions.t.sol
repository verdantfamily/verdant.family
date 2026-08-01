// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {VerdantHook} from "../src/VerdantHook.sol";
import {VerdantConstants} from "../src/libraries/VerdantConstants.sol";
import {HookMiner} from "./utils/HookMiner.sol";

/// @title VerdantHook — permissions and address gate
/// @notice The address of this hook is part of its security model: v4 reads the
/// low 14 bits of it to decide which callbacks exist. These tests assert the bits
/// three ways — against Uniswap's flag constants, against the literal 0x3880 in
/// the deployment runbook, and against the permissions struct the contract
/// declares — because agreement between any two of them proves nothing if the
/// third is what v4 actually reads.
contract VerdantHookPermissionsTest is Test {
    /// @dev The canonical deterministic CREATE2 deployer, verified present on
    /// both Robinhood chains in P0 (packages/config/src/chains.ts).
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint160 internal constant REQUIRED_BITS = 0x3880;

    IPoolManager internal manager;
    address internal factory = makeAddr("verdant factory");
    address internal positionManager = makeAddr("position manager");
    VerdantHook internal hook;
    address internal hookAddress;

    function setUp() public {
        manager = IPoolManager(address(new PoolManager(address(this))));
        (hookAddress,) = _mine();
        deployCodeTo("VerdantHook.sol:VerdantHook", _constructorArgs(), hookAddress);
        hook = VerdantHook(hookAddress);
    }

    function _mine() internal view returns (address addr, bytes32 salt) {
        return
            HookMiner.find(
                CREATE2_DEPLOYER, REQUIRED_BITS, vm.getCode("VerdantHook.sol:VerdantHook"), _constructorArgs()
            );
    }

    /// @dev In one place, because the mined address depends on every byte of them:
    /// a test that mined against one encoding and deployed with another would fail
    /// for a reason that has nothing to do with the property it was checking.
    function _constructorArgs() internal view returns (bytes memory) {
        return abi.encode(manager, factory, positionManager);
    }

    // --- the bits -----------------------------------------------------------

    function test_theRequiredPermissionBitsAreExactly0x3880() public pure {
        uint160 composed = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG
        );
        assertEq(composed, REQUIRED_BITS, "the four flags must compose to 0x3880");

        // Bit by bit, so a change to any single flag is reported as that flag
        // rather than as a different total.
        assertEq(uint160(Hooks.BEFORE_INITIALIZE_FLAG), 0x2000, "beforeInitialize");
        assertEq(uint160(Hooks.AFTER_INITIALIZE_FLAG), 0x1000, "afterInitialize");
        assertEq(uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG), 0x0800, "beforeAddLiquidity");
        assertEq(uint160(Hooks.BEFORE_SWAP_FLAG), 0x0080, "beforeSwap");
    }

    function test_theDeployedAddressCarriesExactlyThoseBits() public view {
        assertEq(uint160(hookAddress) & Hooks.ALL_HOOK_MASK, REQUIRED_BITS, "low 14 bits");
    }

    function test_getHookPermissionsGrantsTheFourAndNothingElse() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();

        assertTrue(p.beforeInitialize, "beforeInitialize");
        assertTrue(p.afterInitialize, "afterInitialize");
        assertTrue(p.beforeAddLiquidity, "beforeAddLiquidity");
        assertTrue(p.beforeSwap, "beforeSwap");

        assertFalse(p.afterAddLiquidity, "afterAddLiquidity");
        assertFalse(p.beforeRemoveLiquidity, "beforeRemoveLiquidity");
        assertFalse(p.afterRemoveLiquidity, "afterRemoveLiquidity");
        assertFalse(p.afterSwap, "afterSwap");
        assertFalse(p.beforeDonate, "beforeDonate");
        assertFalse(p.afterDonate, "afterDonate");
    }

    function test_noDeltaReturningPermissionIsGranted() public view {
        // The whole no-custody claim reduces to these four booleans. With every
        // one false, v4 does not read a delta from this hook at all, so the swap
        // accounting cannot be altered from here even by a bug.
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertFalse(p.beforeSwapReturnDelta, "beforeSwapReturnDelta");
        assertFalse(p.afterSwapReturnDelta, "afterSwapReturnDelta");
        assertFalse(p.afterAddLiquidityReturnDelta, "afterAddLiquidityReturnDelta");
        assertFalse(p.afterRemoveLiquidityReturnDelta, "afterRemoveLiquidityReturnDelta");

        // And the same claim read off the address, which is what v4 consults.
        uint160 bits = uint160(hookAddress);
        assertEq(bits & Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG, 0, "beforeSwap delta bit");
        assertEq(bits & Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG, 0, "afterSwap delta bit");
        assertEq(bits & Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG, 0, "addLiquidity delta bit");
        assertEq(bits & Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG, 0, "removeLiquidity delta bit");
    }

    function test_theAddressAndTheDeclaredPermissionsAgree() public view {
        // Uniswap's own cross-check: reverts unless every one of the fourteen
        // declared booleans matches the corresponding address bit. This is the
        // assertion a v4 integrator would make, made against our address.
        Hooks.validateHookPermissions(IHooks(hookAddress), hook.getHookPermissions());
    }

    // --- mining -------------------------------------------------------------

    function test_theMinerFindsAnAddressWithTheRequiredBits() public view {
        (address mined, bytes32 salt) = _mine();
        assertEq(uint160(mined) & HookMiner.FLAG_MASK, REQUIRED_BITS, "mined address bits");
        assertEq(
            mined,
            HookMiner.computeAddress(
                CREATE2_DEPLOYER,
                salt,
                keccak256(abi.encodePacked(vm.getCode("VerdantHook.sol:VerdantHook"), _constructorArgs()))
            ),
            "the salt must reproduce the address"
        );
    }

    function test_miningIsDeterministic() public view {
        (address first, bytes32 firstSalt) = _mine();
        (address second, bytes32 secondSalt) = _mine();
        assertEq(first, second, "same inputs, same address");
        assertEq(firstSalt, secondSalt, "same inputs, same salt");
    }

    // --- deploying anywhere else --------------------------------------------

    function test_deployingAtAWrongAddressReverts() public {
        // A real deployment: the creation code is placed at the wrong address and
        // executed, exactly as CREATE2 would. It is the constructor that refuses.
        address wrong = address(uint160(hookAddress) ^ 1); // low bits 0x3881
        bytes memory creationCode = abi.encodePacked(vm.getCode("VerdantHook.sol:VerdantHook"), _constructorArgs());
        vm.etch(wrong, creationCode);

        (bool ok, bytes memory returned) = wrong.call("");
        assertFalse(ok, "construction at a wrong address must fail");
        assertEq(_selectorOf(returned), VerdantHook.HookAddressMismatch.selector, "and say why");

        (address reported, uint160 actual, uint160 required) =
            abi.decode(_stripSelector(returned), (address, uint160, uint160));
        assertEq(reported, wrong, "reports the offending address");
        assertEq(actual, uint160(wrong) & Hooks.ALL_HOOK_MASK, "reports the bits it got");
        assertEq(required, REQUIRED_BITS, "reports the bits it needs");
    }

    function testFuzz_deployingAtAnyAddressWithoutTheBitsReverts(address wrong) public {
        vm.assume(uint160(wrong) & Hooks.ALL_HOOK_MASK != REQUIRED_BITS);
        vm.assume(wrong.code.length == 0 && uint160(wrong) > 0xffff);

        bytes memory creationCode = abi.encodePacked(vm.getCode("VerdantHook.sol:VerdantHook"), _constructorArgs());
        vm.etch(wrong, creationCode);

        (bool ok, bytes memory returned) = wrong.call("");
        assertFalse(ok, "no address without the exact bits may hold this code");
        assertEq(_selectorOf(returned), VerdantHook.HookAddressMismatch.selector);
    }

    function test_aWrongAddressCannotInitialiseAPool() public {
        // The other half of the claim. Copying the *runtime* code sidesteps the
        // constructor, which is the only way code can exist at an unmined
        // address, so this is what the runtime check in beforeInitialize is for.
        //
        // v4 does not catch this itself: Hooks.isValidHookAddress only rejects
        // structurally impossible flag combinations, so a hook whose address
        // grants the wrong callbacks is accepted by the PoolManager and then
        // silently under- or over-called. Here the address keeps the
        // beforeInitialize bit (so v4 calls the hook) but drops beforeSwap.
        address wrong = address((uint160(hookAddress) & ~uint160(0x3FFF)) | 0x3800);
        vm.etch(wrong, hookAddress.code);
        assertEq(uint160(wrong) & Hooks.ALL_HOOK_MASK, 0x3800, "the impostor keeps beforeInitialize");

        PoolKey memory badKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(makeAddr("token")),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(wrong)
        });

        vm.prank(factory);
        (bool ok, bytes memory returned) =
            address(manager).call(abi.encodeCall(IPoolManager.initialize, (badKey, uint160(1 << 96))));
        assertFalse(ok, "a pool must not be initialisable against an unmined hook");
        assertTrue(_mentions(returned, VerdantHook.HookAddressMismatch.selector), "for the stated reason");
    }

    // --- helpers ------------------------------------------------------------

    /// @dev The first four bytes of revert data. The cast is a read of the
    /// selector, not a narrowing of a number: revert data always begins with one.
    function _selectorOf(bytes memory data) internal pure returns (bytes4) {
        // forge-lint: disable-next-line(unsafe-typecast) -- reading a selector, not truncating a value
        return bytes4(data);
    }

    function _stripSelector(bytes memory data) internal pure returns (bytes memory body) {
        body = new bytes(data.length - 4);
        for (uint256 i = 4; i < data.length; i++) {
            body[i - 4] = data[i];
        }
    }

    /// @dev v4 wraps a reverting hook call in its own error, so the inner reason
    /// is searched for rather than compared. Comparing the whole payload would
    /// couple these tests to the shape of Uniswap's wrapper.
    function _mentions(bytes memory haystack, bytes4 needle) internal pure returns (bool) {
        if (haystack.length < 4) return false;
        for (uint256 i = 0; i + 4 <= haystack.length; i++) {
            if (
                haystack[i] == needle[0] && haystack[i + 1] == needle[1] && haystack[i + 2] == needle[2]
                    && haystack[i + 3] == needle[3]
            ) return true;
        }
        return false;
    }
}
