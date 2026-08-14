// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {InstantFeeVault} from "../src/InstantFeeVault.sol";
import {InstantHook} from "../src/InstantHook.sol";
import {InstantFees} from "../src/libraries/InstantFees.sol";
import {VerdantConstants} from "../src/libraries/VerdantConstants.sol";
import {GeneratedToken} from "./agen/fixtures/GeneratedToken.sol";

/// @title The Instant hook, against a real pool
/// @notice ADR-014 promises a creator that their fee arrives in ether whichever way the
/// market is traded, and promises a trader that a swap costs 1.50% and nothing else.
/// Both are claims about balances after a swap, so this asserts balances after swaps.
///
/// @dev The four cases are the point. Ether is `currency0`, so it is the swap's
/// *specified* currency on a buy priced by its input and a sell priced by its output, and
/// the *unspecified* one on the other two — which decides whether the hook can charge in
/// `beforeSwap` or has to wait for `afterSwap`. A hook that handled only one pair would
/// pass a careless test suite and let any trader avoid the fee by routing the other kind,
/// so all four are exercised and the fee is asserted in each.
contract InstantHookTest is Deployers {
    InstantHook internal hook;
    InstantFeeVault internal vault;
    PositionManager internal posm;
    GeneratedToken internal token;

    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal trader = makeAddr("trader");

    /// A billion tokens, as every Instant market has.
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    /// Where a billion tokens open at 1.5 ether. The tick Instant actually launches at.
    int24 internal constant INITIAL_TICK = 203_200;

    /// beforeInitialize | afterInitialize | beforeAddLiquidity | beforeSwap | afterSwap
    /// | beforeSwapReturnDelta | afterSwapReturnDelta.
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    function setUp() public {
        deployFreshManagerAndRouters();

        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        // This contract stands in for the factory, which is the role that registers a
        // market and mints its one position.
        address hookAt = address(uint160(FLAGS) | uint160(uint256(0x4444) << 144));
        deployCodeTo("InstantHook.sol:InstantHook", abi.encode(manager, address(this), address(posm)), hookAt);
        hook = InstantHook(hookAt);

        token = new GeneratedToken("Instant", "INST", SUPPLY, address(this));

        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(hookAt)
        });

        vault = new InstantFeeVault(hookAt, manager, creator, treasury);
        hook.register(key, vault);

        manager.initialize(key, TickMath.getSqrtPriceAtTick(INITIAL_TICK));
        _mintLockedPosition();

        vm.deal(trader, 1_000 ether);
    }

    /// @dev The whole supply into one one-sided position, exactly as the factory does it.
    function _mintLockedPosition() private {
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(VerdantConstants.MIN_USABLE_TICK);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(INITIAL_TICK);
        uint256 liquidity = LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, SUPPLY);

        require(token.transfer(address(posm), SUPPLY), "setup: token to posm");

        bytes memory actions =
            abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE), uint8(Actions.SWEEP));

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            key,
            VerdantConstants.MIN_USABLE_TICK,
            INITIAL_TICK,
            liquidity,
            uint128(0),
            uint128(SUPPLY),
            address(this),
            bytes("")
        );
        params[1] = abi.encode(key.currency1, ActionConstants.OPEN_DELTA, false);
        params[2] = abi.encode(key.currency1, address(this));

        posm.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    function _settings() private pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    /// @dev What the vault is holding, in whichever form. A fee taken during a swap
    /// arrives as an ERC-6909 claim on ether and only becomes ether when somebody
    /// claims, so a test that looked only at `balance` would read zero after a trade and
    /// conclude the fee had not been charged.
    function _feeHeld() private view returns (uint256) {
        return vault.claims() + address(vault).balance;
    }

    /// @dev Buys the trader a balance to sell later, and returns what they received.
    function _buyExactIn(uint256 amountIn) private returns (uint256 received) {
        uint256 before = token.balanceOf(trader);

        vm.prank(trader);
        swapRouter.swap{value: amountIn}(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- a literal ether amount
            SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            bytes("")
        );

        received = token.balanceOf(trader) - before;
    }

    // --- the pool charges nothing --------------------------------------------

    function test_theStoredLpFeeIsZero() public view {
        (,,, uint24 lpFee) = StateLibrary.getSlot0(manager, key.toId());
        assertEq(lpFee, 0, "the pool charges an LP fee on top of the Instant fee");
    }

    // --- the four cases -------------------------------------------------------

    function test_aBuyPricedByItsInputPaysTheFeeInEther() public {
        uint256 amountIn = 1 ether;
        (uint256 expectedCreator, uint256 expectedPlatform, uint256 expectedFee) = InstantFees.split(amountIn);

        uint256 spentBefore = trader.balance;
        _buyExactIn(amountIn);

        assertEq(spentBefore - trader.balance, amountIn, "an exact-input trader paid more than they specified");
        assertEq(_feeHeld(), expectedFee, "the vault did not receive 1.50% of the input");
        assertEq(vault.creatorAccrued(), expectedCreator, "the creator's ledger is wrong");
        assertEq(vault.platformAccrued(), expectedPlatform, "the platform's ledger is wrong");
    }

    function test_aBuyPricedByItsOutputPaysTheFeeInEther() public {
        // Ether is the unspecified currency here, so the charge happens in `afterSwap`.
        // This is the case a hook that only implemented `beforeSwap` would let through
        // for free.
        uint256 wantTokens = 1_000_000e18;

        uint256 spentBefore = trader.balance;
        vm.prank(trader);
        swapRouter.swap{value: 100 ether}(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- a literal token amount
            SwapParams({zeroForOne: true, amountSpecified: int256(wantTokens), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            bytes("")
        );

        assertEq(token.balanceOf(trader), wantTokens, "the trader did not receive what they asked for");
        assertGt(_feeHeld(), 0, "an exact-output buy paid no fee");

        // The fee is 1.50% of the ether the pool actually consumed, and the trader paid
        // it on top of that — which is what an exact-output swap means.
        uint256 spent = spentBefore - trader.balance;
        (,, uint256 feeOnLeg) = InstantFees.split(spent - _feeHeld());
        assertApproxEqAbs(_feeHeld(), feeOnLeg, 2, "the fee is not 1.50% of the ether leg");
    }

    function test_aSellPricedByItsInputPaysTheFeeInEther() public {
        uint256 held = _buyExactIn(10 ether);
        uint256 vaultAfterBuy = _feeHeld();

        vm.prank(trader);
        token.approve(address(swapRouter), held);

        uint256 etherBefore = trader.balance;
        vm.prank(trader);
        swapRouter.swap(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- bounded by the balance above
            SwapParams({zeroForOne: false, amountSpecified: -int256(held), sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            _settings(),
            bytes("")
        );

        uint256 feeOnSell = _feeHeld() - vaultAfterBuy;
        uint256 receivedByTrader = trader.balance - etherBefore;

        assertGt(feeOnSell, 0, "a sell paid no fee");
        assertEq(token.balanceOf(trader), 0, "the trader kept tokens they sold");

        // The whole point of the design: a sell is charged in ether, not in the token.
        // The pool produced `received + fee` ether and the trader kept the rest.
        (,, uint256 expected) = InstantFees.split(receivedByTrader + feeOnSell);
        assertApproxEqAbs(feeOnSell, expected, 2, "a sell's fee is not 1.50% of the ether leg");
    }

    function test_aSellPricedByItsOutputPaysTheFeeInEther() public {
        uint256 held = _buyExactIn(10 ether);
        uint256 vaultAfterBuy = _feeHeld();

        vm.prank(trader);
        token.approve(address(swapRouter), held);

        uint256 wantEther = 1 ether;
        (,, uint256 expectedFee) = InstantFees.split(wantEther);

        uint256 etherBefore = trader.balance;
        vm.prank(trader);
        swapRouter.swap(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- a literal ether amount
            SwapParams({zeroForOne: false, amountSpecified: int256(wantEther), sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            _settings(),
            bytes("")
        );

        assertEq(trader.balance - etherBefore, wantEther, "the trader did not receive the ether they asked for");
        assertEq(_feeHeld() - vaultAfterBuy, expectedFee, "an exact-output sell paid the wrong fee");
    }

    // --- what the creator never receives --------------------------------------

    function test_theVaultNeverHoldsTheLaunchedToken() public {
        uint256 held = _buyExactIn(10 ether);
        vm.prank(trader);
        token.approve(address(swapRouter), held);
        vm.prank(trader);
        swapRouter.swap(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- bounded by the balance above
            SwapParams({zeroForOne: false, amountSpecified: -int256(held), sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            _settings(),
            bytes("")
        );

        // The claim ADR-014 makes, asserted directly: after trading in both directions
        // the creator's fee is entirely ether and none of it is the launched token.
        assertEq(token.balanceOf(address(vault)), 0, "the vault accrued the launched token");
        assertGt(_feeHeld(), 0, "the vault accrued no ether");
    }

    function test_theCreatorClaimsEtherAndOnlyEther() public {
        _buyExactIn(10 ether);

        uint256 owed = vault.claimable(creator);
        assertGt(owed, 0, "nothing accrued to the creator");

        vault.claimCreator();

        assertEq(creator.balance, owed, "the creator was not paid in ether");
        assertEq(token.balanceOf(creator), 0, "the creator was paid in the launched token");
    }

    // --- conservation ---------------------------------------------------------

    /// Every wei the trader spent reached the PoolManager, and the vault's claim is a
    /// share of that rather than something conjured beside it. A hook funding its fee out
    /// of the locked position's own liquidity would pass every assertion above and fail
    /// here, because redeeming the claim would leave the pool short.
    function test_theFeeIsPaidByTheTraderAndNotByThePosition() public {
        uint256 amountIn = 1 ether;
        (,, uint256 expectedFee) = InstantFees.split(amountIn);

        uint256 managerBefore = address(manager).balance;
        uint256 traderBefore = trader.balance;

        _buyExactIn(amountIn);

        uint256 spent = traderBefore - trader.balance;

        assertEq(spent, amountIn, "the trader spent something other than what they specified");
        assertEq(address(manager).balance - managerBefore, spent, "ether went somewhere other than the manager");
        assertEq(_feeHeld(), expectedFee, "the vault's claim is not the fee the trader paid");

        // And the claim is backed: redeeming it moves that ether out of the manager for
        // good, leaving it holding exactly the trade less the fee.
        vault.claimCreator();
        vault.claimPlatform();

        assertEq(creator.balance + treasury.balance, expectedFee, "the claim did not redeem for the whole fee");
        assertEq(address(manager).balance - managerBefore, spent - expectedFee, "the pool kept part of the fee");
    }

    function testFuzz_everyBuyIsChargedExactlyOnePointFivePercent(uint96 amountIn) public {
        vm.assume(amountIn > 1e12 && amountIn < 100 ether);

        (,, uint256 expected) = InstantFees.split(amountIn);
        _buyExactIn(amountIn);

        assertEq(_feeHeld(), expected, "a buy was charged something other than 1.50%");
    }

    // --- permissions ----------------------------------------------------------

    function test_onlyTheFactoryCanRegisterAMarket() public {
        InstantFeeVault other = new InstantFeeVault(address(hook), manager, creator, treasury);

        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(InstantHook.NotFactory.selector, trader));
        hook.register(key, other);
    }

    function test_aMarketCannotBeRegisteredTwice() public {
        InstantFeeVault other = new InstantFeeVault(address(hook), manager, creator, treasury);

        vm.expectRevert(abi.encodeWithSelector(InstantHook.AlreadyRegistered.selector, key.toId()));
        hook.register(key, other);
    }

    function test_theCallbacksRefuseAnyCallerButThePoolManager() public {
        vm.expectRevert(abi.encodeWithSelector(InstantHook.NotPoolManager.selector, address(this)));
        hook.beforeSwap(
            address(this), key, SwapParams({zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: 0}), bytes("")
        );
    }

    function test_nobodyElseCanAddLiquidity() public {
        // The position is the launch's, and there is exactly one of it. A second is
        // refused at the hook rather than merely discouraged — the router is not the
        // pinned PositionManager, so the hook stops it before it can be believed.
        vm.expectRevert();
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: VerdantConstants.MIN_USABLE_TICK, tickUpper: INITIAL_TICK, liquidityDelta: 1e18, salt: 0
            }),
            bytes("")
        );
    }
}
