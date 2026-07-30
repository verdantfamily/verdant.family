// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

// v4-core
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

// v4-periphery
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

// openzeppelin (shared pin with v4-core)
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

import {VerdantConstants} from "../src/libraries/VerdantConstants.sol";

/// @notice P0 acceptance: proves every remapping Verdant depends on resolves, and
/// pins the handful of upstream constants the architecture is built on so an
/// unnoticed dependency bump fails here rather than in the hook.
contract RemappingsTest is Test {
    /// @dev The permission set Verdant's hook must be mined for:
    /// beforeInitialize | afterInitialize | beforeAddLiquidity | beforeSwap.
    uint160 internal constant VERDANT_HOOK_FLAGS = 0x3880;

    function test_hookFlagLayoutMatchesArchitecture() public pure {
        // Recomputing 0x3880 from upstream's own constants rather than trusting
        // the literal. If Uniswap ever renumbers a flag, this fails loudly.
        uint160 expected = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG;
        assertEq(expected, VERDANT_HOOK_FLAGS, "hook permission bits drifted from 0x3880");
    }

    function test_noReturnsDeltaFlagInVerdantPermissions() public pure {
        // D2: the hook never takes custody, so no *_RETURNS_DELTA bit may be set.
        assertEq(VERDANT_HOOK_FLAGS & Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG, 0);
        assertEq(VERDANT_HOOK_FLAGS & Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG, 0);
        assertEq(VERDANT_HOOK_FLAGS & Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG, 0);
        assertEq(VERDANT_HOOK_FLAGS & Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG, 0);
    }

    function test_verdantPermissionsExcludeBeforeRemoveLiquidity() public pure {
        // Load-bearing for the collect() claim: a zero-liquidity decreaseLiquidity
        // routes to beforeRemoveLiquidity, which Verdant does not hold, so fee
        // collection invokes no Verdant hook callback at all.
        assertEq(VERDANT_HOOK_FLAGS & Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG, 0);
    }

    function test_dynamicFeeAndOverrideFlagsMatchConfig() public pure {
        // Mirrored in packages/config/src/bounds.ts; must not diverge.
        assertEq(uint256(LPFeeLibrary.DYNAMIC_FEE_FLAG), 0x800000);
        assertEq(uint256(LPFeeLibrary.OVERRIDE_FEE_FLAG), 0x400000);
        assertEq(uint256(LPFeeLibrary.MAX_LP_FEE), 1_000_000);
    }

    function test_nativeCurrencyIsCurrencyZero() public pure {
        // D4: address(0) < every token address, so ETH is always currency0 and
        // there is no sort step anywhere in the codebase to get wrong.
        assertTrue(Currency.wrap(address(0)) < Currency.wrap(address(1)));
    }

    function test_peripheryInterfacesResolve() public pure {
        // Referencing the selectors keeps the imports load-bearing.
        assertTrue(IMsgSender.msgSender.selector != bytes4(0));
        assertTrue(IPositionManager.modifyLiquidities.selector != bytes4(0));
        assertTrue(IPoolManager.initialize.selector != bytes4(0));
        assertTrue(IHooks.beforeSwap.selector != bytes4(0));
        assertTrue(uint256(Actions.INCREASE_LIQUIDITY) >= 0);
        assertTrue(LiquidityAmounts.getLiquidityForAmounts(1 << 96, 1 << 95, 1 << 97, 0, 0) == 0);
    }

    function test_openzeppelinResolves() public pure {
        assertTrue(ERC20.transfer.selector != bytes4(0));
        assertTrue(ERC20Permit.permit.selector != bytes4(0));
    }

    function test_poolKeyStructIsConstructible() public pure {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(0xBEEF)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(address(0))
        });
        assertEq(key.tickSpacing, VerdantConstants.TICK_SPACING);
    }
}
