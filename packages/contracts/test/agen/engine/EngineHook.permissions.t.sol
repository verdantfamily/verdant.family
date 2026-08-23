// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import {AgenEngineHook} from "../../../src/agen/engine/AgenEngineHook.sol";
import {HookMiner} from "../../utils/HookMiner.sol";

/// @title AgenEngineHook permissions
/// @notice The address is part of the security model, so it is asserted bit by bit.
///
/// @dev v4 decides which callbacks a hook has by reading the low fourteen bits of its
/// address and never asking the contract. A hook deployed to an address missing a bit it
/// implements is not a hook with a bug — it is a market whose rule silently never runs,
/// trading normally, indefinitely, with nothing reverting. And a hook holding a bit it does
/// *not* implement is a callback v4 will call into a function that reverts.
///
/// So this file asserts the exact value, each granted bit individually, and each withheld
/// bit individually — rather than one comparison against a literal, which would pass just as
/// happily against a wrong literal.
contract EngineHookPermissionsTest is Test {
    /// @dev Mirrors the constant inside the hook. Deliberately written as a literal here
    /// and composed from flags there, so the two can disagree and a test can say so.
    uint160 internal constant EXPECTED = 0x38CC;

    AgenEngineHook internal hook;

    function setUp() public {
        // Mined the same way the deployment will be, against the canonical CREATE2 deployer.
        // If no salt existed for this permission set, this is where that would surface.
        bytes memory creationCode = type(AgenEngineHook).creationCode;
        bytes memory args = abi.encode(IPoolManager(address(0xdead)), address(0xbeef), address(0xcafe));

        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), EXPECTED, creationCode, args);

        hook = new AgenEngineHook{salt: salt}(IPoolManager(address(0xdead)), address(0xbeef), address(0xcafe));
        assertEq(address(hook), predicted, "the mined address is not where the hook landed");
    }

    function test_the_address_carries_exactly_the_required_bits() public view {
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, EXPECTED, "wrong permission bits");
    }

    function test_the_constant_is_0x38CC() public pure {
        // Composed from Uniswap's own flags, so a change to their meaning upstream is a
        // compile-time change rather than a silent one.
        uint160 composed = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        assertEq(composed, EXPECTED, "the flag composition drifted from 0x38CC");
    }

    // --- each granted bit, individually --------------------------------------

    function test_grants_beforeInitialize() public view {
        // Refuses a pool whose rules have not been written.
        assertTrue(_has(Hooks.BEFORE_INITIALIZE_FLAG));
        assertTrue(hook.getHookPermissions().beforeInitialize);
    }

    function test_grants_afterInitialize() public view {
        // Records the origin every time threshold is measured from, and zeroes the LP fee.
        assertTrue(_has(Hooks.AFTER_INITIALIZE_FLAG));
        assertTrue(hook.getHookPermissions().afterInitialize);
    }

    function test_grants_beforeAddLiquidity() public view {
        // What makes the launch position the only position.
        assertTrue(_has(Hooks.BEFORE_ADD_LIQUIDITY_FLAG));
        assertTrue(hook.getHookPermissions().beforeAddLiquidity);
    }

    function test_grants_beforeSwap() public view {
        // Charges when the fee currency is the specified one; enforces the ceiling when the
        // launched token is.
        assertTrue(_has(Hooks.BEFORE_SWAP_FLAG));
        assertTrue(hook.getHookPermissions().beforeSwap);
    }

    function test_grants_afterSwap() public view {
        // Charges in the other case, enforces the ceiling in the other case, and accumulates
        // quote volume in every case.
        assertTrue(_has(Hooks.AFTER_SWAP_FLAG));
        assertTrue(hook.getHookPermissions().afterSwap);
    }

    function test_grants_beforeSwapReturnDelta() public view {
        // Without it v4 does not read the returned delta, so the fee would be uncharged
        // while the mint left the swap unbalanced.
        assertTrue(_has(Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG));
        assertTrue(hook.getHookPermissions().beforeSwapReturnDelta);
    }

    function test_grants_afterSwapReturnDelta() public view {
        assertTrue(_has(Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG));
        assertTrue(hook.getHookPermissions().afterSwapReturnDelta);
    }

    // --- each withheld bit, individually -------------------------------------

    function test_withholds_afterAddLiquidity() public view {
        assertFalse(_has(Hooks.AFTER_ADD_LIQUIDITY_FLAG));
        assertFalse(hook.getHookPermissions().afterAddLiquidity);
    }

    function test_withholds_beforeRemoveLiquidity() public view {
        assertFalse(_has(Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG));
        assertFalse(hook.getHookPermissions().beforeRemoveLiquidity);
    }

    function test_withholds_afterRemoveLiquidity() public view {
        assertFalse(_has(Hooks.AFTER_REMOVE_LIQUIDITY_FLAG));
        assertFalse(hook.getHookPermissions().afterRemoveLiquidity);
    }

    function test_withholds_beforeDonate() public view {
        assertFalse(_has(Hooks.BEFORE_DONATE_FLAG));
        assertFalse(hook.getHookPermissions().beforeDonate);
    }

    function test_withholds_afterDonate() public view {
        assertFalse(_has(Hooks.AFTER_DONATE_FLAG));
        assertFalse(hook.getHookPermissions().afterDonate);
    }

    function test_withholds_the_liquidity_delta_bits() public view {
        // The hook takes no custody on a liquidity change, so these would be authority it
        // does not use — and authority a contract does not use is authority nobody reviews.
        assertFalse(_has(Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG));
        assertFalse(hook.getHookPermissions().afterAddLiquidityReturnDelta);
        assertFalse(_has(Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG));
        assertFalse(hook.getHookPermissions().afterRemoveLiquidityReturnDelta);
    }

    // --- the address is enforced, not merely mined ---------------------------

    function test_refuses_to_deploy_at_an_unmined_address() public {
        // v4 itself does not check this, so the constructor does. Failing at deployment is
        // the earliest point it can be caught and the only one that catches an address with
        // no permission bits at all.
        vm.expectRevert();
        new AgenEngineHook(IPoolManager(address(0xdead)), address(0xbeef), address(0xcafe));
    }

    function test_the_permission_struct_agrees_with_the_address() public view {
        // Two independent statements of the same fact, asserted equal. Nothing on chain reads
        // `getHookPermissions`, so without this it could drift from the bits forever.
        Hooks.Permissions memory declared = hook.getHookPermissions();
        uint160 fromStruct = uint160(
            (declared.beforeInitialize ? Hooks.BEFORE_INITIALIZE_FLAG : 0)
                | (declared.afterInitialize ? Hooks.AFTER_INITIALIZE_FLAG : 0)
                | (declared.beforeAddLiquidity ? Hooks.BEFORE_ADD_LIQUIDITY_FLAG : 0)
                | (declared.afterAddLiquidity ? Hooks.AFTER_ADD_LIQUIDITY_FLAG : 0)
                | (declared.beforeRemoveLiquidity ? Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG : 0)
                | (declared.afterRemoveLiquidity ? Hooks.AFTER_REMOVE_LIQUIDITY_FLAG : 0)
                | (declared.beforeSwap ? Hooks.BEFORE_SWAP_FLAG : 0)
                | (declared.afterSwap ? Hooks.AFTER_SWAP_FLAG : 0)
                | (declared.beforeDonate ? Hooks.BEFORE_DONATE_FLAG : 0)
                | (declared.afterDonate ? Hooks.AFTER_DONATE_FLAG : 0)
                | (declared.beforeSwapReturnDelta ? Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG : 0)
                | (declared.afterSwapReturnDelta ? Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG : 0)
                | (declared.afterAddLiquidityReturnDelta ? Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG : 0)
                | (declared.afterRemoveLiquidityReturnDelta ? Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG : 0)
        );

        assertEq(fromStruct, uint160(address(hook)) & Hooks.ALL_HOOK_MASK, "struct and address disagree");
    }

    function _has(uint256 flag) private view returns (bool) {
        return uint160(address(hook)) & uint160(flag) != 0;
    }
}
