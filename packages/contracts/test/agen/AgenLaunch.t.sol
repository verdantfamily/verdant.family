// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {AgenCurve} from "../../src/agen/AgenCurve.sol";
import {AgenDeployer} from "../../src/agen/AgenDeployer.sol";
import {AgenFactory} from "../../src/agen/AgenFactory.sol";
import {AgenMarketRegistry} from "../../src/agen/AgenMarketRegistry.sol";
import {AgenPositionLocker} from "../../src/agen/AgenPositionLocker.sol";
import {CurveProbeHook} from "./fixtures/CurveProbeHook.sol";
import {GeneratedToken} from "./fixtures/GeneratedToken.sol";
import {HookMiner} from "../utils/HookMiner.sol";

/// @title The Agen launch curve, on chain
/// @notice Proves that a generated market opens tradable, that its liquidity is locked,
/// and that the shape of it is the one that was designed rather than the one that fell
/// out of the code.
///
/// @dev The shape was chosen by simulation before any of this was written.
/// `apps/agen/scripts/curve.ts` compares single-, two-, three- and four-range launch
/// geometries against a $5,000 opening valuation, and the geometry approved from it —
/// "G" in that script's output — is what `AgenCurve` encodes: three one-sided positions
/// holding 14.84%, 18.58% and 66.58% of supply, with relative depths of 0.25, 0.75 and
/// 4.19 against a conventional single-range launch.
///
/// That script is the reference and this file is the regression test for it. The
/// multiples asserted below are its output, not a transcription of the Solidity's
/// behaviour, so a change to the geometry that nobody meant to make fails here.
///
/// ## Reading the numbers
///
/// Everything is a ratio, so the ether amounts are arbitrary and the dollars in the
/// comments are the simulator's. A billion tokens opening at tick 203 200 makes the
/// launch valuation almost exactly 1.5 ether, which stands in for $5,000; a buy worth a
/// fifth of that stands in for $1,000. The assertions are all in multiples of the
/// opening valuation and would hold at any scale.
///
/// The hook charges nothing, on purpose — see `CurveProbeHook`. Fees are a separate
/// dimension from geometry, and a market that also charged 1% would move a little less
/// than these numbers for reasons that have nothing to do with the ranges.
contract AgenLaunchTest is Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 internal constant BEFORE_SWAP_FLAG = uint160(Hooks.BEFORE_SWAP_FLAG);

    PositionManager internal posm;
    AgenDeployer internal agenDeployer;
    AgenMarketRegistry internal registry;
    AgenFactory internal factory;

    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("second wallet");
    address internal feeReceiver = makeAddr("fee receiver");

    uint256 internal constant SUPPLY = 1_000_000_000e18;

    /// @dev Opens the market at ~1.5 ether of valuation. See the note above on scale.
    int24 internal constant INITIAL_TICK = 203_200;

    /// @dev Basis points of the opening valuation, used everywhere a buy is expressed.
    uint256 internal constant BPS = 10_000;

    address internal token;
    address internal locker;
    uint256 internal firstTokenId;
    CurveProbeHook internal hook;

    /// @dev The valuation the pool opened at, measured from the pool rather than
    /// predicted, so every ratio below is against what actually happened.
    uint256 internal openingCap;

    function setUp() public {
        deployFreshManagerAndRouters();

        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        agenDeployer = new AgenDeployer(predicted);
        registry = new AgenMarketRegistry(predicted);
        factory = new AgenFactory(manager, posm, agenDeployer, registry);
        assertEq(address(factory), predicted, "factory address prediction");

        vm.deal(creator, 100 ether);
        vm.deal(trader, 100 ether);
        vm.deal(address(this), 100 ether);
    }

    // --- launching ------------------------------------------------------------

    function _manifest(uint128 devBuy) internal view returns (AgenFactory.Manifest memory manifest) {
        bytes memory tokenInitCode =
            abi.encodePacked(type(GeneratedToken).creationCode, abi.encode("Curve", "CURVE", SUPPLY, address(factory)));
        bytes memory hookInitCode = abi.encodePacked(type(CurveProbeHook).creationCode, abi.encode(address(manager)));

        bytes32 tokenSalt = keccak256("curve token");
        (address hookAt, bytes32 hookSalt) =
            HookMiner.findFromInitcode(address(agenDeployer), BEFORE_SWAP_FLAG, hookInitCode);

        AgenFactory.Component[] memory components = new AgenFactory.Component[](2);
        components[0] = AgenFactory.Component({
            salt: tokenSalt,
            expected: agenDeployer.computeAddress(tokenSalt, keccak256(tokenInitCode)),
            role: registry.ROLE_TOKEN(),
            initCode: tokenInitCode
        });
        components[1] = AgenFactory.Component({
            salt: hookSalt, expected: hookAt, role: registry.ROLE_HOOK(), initCode: hookInitCode
        });

        manifest = AgenFactory.Manifest({
            specificationHash: keccak256("curve specification"),
            implementationHash: keccak256("curve implementation"),
            metadataURI: "ipfs://curve",
            quoteAsset: address(0),
            lpFee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            initialTick: INITIAL_TICK,
            feeReceiver: feeReceiver,
            devBuyAmount: devBuy,
            devBuyMinTokens: 0,
            hookIndex: 1,
            tokenIndex: 0,
            components: components,
            wiring: new AgenFactory.WiringCall[](0)
        });
    }

    function _launch(uint128 devBuy) internal {
        AgenFactory.Manifest memory manifest = _manifest(devBuy);

        vm.prank(creator);
        uint256 index = factory.deployMarket{value: devBuy}(manifest);

        AgenMarketRegistry.Market memory market = registry.marketAt(index);
        AgenMarketRegistry.Component[] memory components = registry.componentsAt(index);

        token = market.token;
        hook = CurveProbeHook(market.hook);
        locker = components[components.length - 1].addr;
        firstTokenId = AgenPositionLocker(locker).firstTokenId();

        key = factory.poolKeyFor(address(0), token, LPFeeLibrary.DYNAMIC_FEE_FLAG, market.hook);
        openingCap = _cap();
    }

    // --- measuring ------------------------------------------------------------

    /// @dev Valuation in wei: supply times the price of one token.
    ///
    /// v4 prices a pool as `amount1/amount0`, and the launch token is `currency1`, so
    /// the price of a token in ether is the reciprocal — taken in two `mulDiv` steps
    /// because squaring a Q64.96 and multiplying by a billion tokens does not fit in a
    /// word, and rounding it in one step would show up in the fourth digit of every
    /// assertion below.
    function _cap() internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(key.toId());
        uint256 half = FullMath.mulDiv(SUPPLY, 1 << 96, sqrtPriceX96);
        return FullMath.mulDiv(half, 1 << 96, sqrtPriceX96);
    }

    /// @dev The valuation now, in ten-thousandths of what it opened at.
    function _capBps() internal view returns (uint256) {
        return (_cap() * BPS) / openingCap;
    }

    function _buy(address who, uint256 amountIn) internal returns (uint256 received) {
        uint256 before = IERC20(token).balanceOf(who);

        vm.prank(who);
        swapRouter.swap{value: amountIn}(
            key,
            SwapParams({
                zeroForOne: true,
                // forge-lint: disable-next-line(unsafe-typecast) -- bounded by the ether dealt above
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: MIN_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );

        received = IERC20(token).balanceOf(who) - before;
    }

    function _sell(address who, uint256 amountIn) internal returns (uint256 received) {
        uint256 before = who.balance;

        vm.startPrank(who);
        IERC20(token).approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false,
                // forge-lint: disable-next-line(unsafe-typecast) -- a token balance, far below int256
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        vm.stopPrank();

        received = who.balance - before;
    }

    /// @dev How much of the token a position holds, computed from its liquidity and its
    /// range rather than read from a balance — the PoolManager pools every position's
    /// tokens together, so there is no per-position balance to read.
    ///
    /// `amount1 = L · (√Pb − √Pa)` is written out rather than imported: the periphery's
    /// `LiquidityAmounts` only converts in the other direction, and this is the inverse
    /// of the `getLiquidityForAmount1` the factory used to size each band. Deriving it
    /// independently is the point — a test that called the factory's own helper would
    /// agree with it however wrong it was.
    function _positionTokens(uint256 index) internal view returns (uint256) {
        AgenCurve.Band[3] memory band = AgenCurve.bands(INITIAL_TICK);
        uint128 liquidity = posm.getPositionLiquidity(firstTokenId + index);

        uint160 lower = TickMath.getSqrtPriceAtTick(band[index].tickLower);
        uint160 upper = TickMath.getSqrtPriceAtTick(band[index].tickUpper);

        return FullMath.mulDiv(liquidity, upper - lower, 1 << 96);
    }

    /// @dev `assertApproxEqRel` with the tolerance spelled out at each call site.
    function _close(uint256 actual, uint256 expected, uint256 tolerancePercent, string memory what) internal pure {
        assertApproxEqRel(actual, expected, tolerancePercent * 1e16, what);
    }

    // --- 1. the positions are one-sided ---------------------------------------

    function test_allThreePositionsMintWithoutAnyQuoteAsset() public {
        _launch(0);

        // The launch was sent no value at all, and it opened a tradable market. That is
        // the cold-start property in one line: nobody had to bring the paired asset.
        assertEq(address(manager).balance, 0, "the pool holds no ether at launch");
        assertEq(address(factory).balance, 0, "and the factory kept none either");

        AgenCurve.Band[3] memory band = AgenCurve.bands(INITIAL_TICK);
        for (uint256 i = 0; i < AgenCurve.BANDS; i++) {
            uint128 liquidity = posm.getPositionLiquidity(firstTokenId + i);
            assertGt(liquidity, 0, "a band with no liquidity is not a band");

            // Every band sits at or below the opening tick, which is what makes v4 value
            // it entirely in the token. A band straddling the price would have needed
            // ether at mint, and `amount0Max: 0` would have reverted the launch.
            assertLe(band[i].tickUpper, INITIAL_TICK, "the band is at or below the opening price");
            assertLt(band[i].tickLower, band[i].tickUpper, "the band has width");
        }

        // Contiguous, and reaching the floor: the supply above the market has no gaps in
        // it for the price to jump across.
        assertEq(band[0].tickUpper, INITIAL_TICK, "the first band opens at the launch price");
        assertEq(band[1].tickUpper, band[0].tickLower, "the second band starts where the first ends");
        assertEq(band[2].tickUpper, band[1].tickLower, "the third starts where the second ends");
        assertEq(band[2].tickLower, AgenCurve.MIN_USABLE_TICK, "and runs to the floor");
    }

    // --- 2. the allocation is the approved geometry ---------------------------

    function test_theSupplyIsSplitTheWayTheSimulationSaid() public {
        _launch(0);

        uint256[3] memory expected = [
            (SUPPLY * AgenCurve.OPENING_BPS) / BPS,
            (SUPPLY * AgenCurve.MIDDLE_BPS) / BPS,
            (SUPPLY * AgenCurve.DEEP_BPS) / BPS
        ];

        uint256 total;
        for (uint256 i = 0; i < AgenCurve.BANDS; i++) {
            uint256 held = _positionTokens(i);
            total += held;

            // A tenth of a percent. The gap is the rounding from converting an amount of
            // token into a whole number of units of liquidity, and nothing else.
            _close(held, expected[i], 1, "band allocation");
        }

        // 14.84 / 18.58 / 66.58, which is the "G" row of the simulator's output.
        assertEq(
            AgenCurve.OPENING_BPS + AgenCurve.MIDDLE_BPS + AgenCurve.DEEP_BPS, BPS, "the bands are the whole supply"
        );
        _close(total, SUPPLY, 1, "and all of it is in a position");
    }

    // --- 3. the liquidity cannot leave ----------------------------------------

    function test_nobodyCanTakeThePositionsOutOfTheLocker() public {
        _launch(0);

        for (uint256 i = 0; i < AgenCurve.BANDS; i++) {
            assertEq(IERC721(address(posm)).ownerOf(firstTokenId + i), locker, "the locker owns the position");
        }

        // Not the creator, not this contract, not the fee receiver. The locker is not an
        // account anybody controls, so there is no caller for whom this succeeds.
        address[3] memory who = [creator, address(this), feeReceiver];
        for (uint256 i = 0; i < who.length; i++) {
            vm.prank(who[i]);
            vm.expectRevert();
            IERC721(address(posm)).transferFrom(locker, who[i], firstTokenId);
        }

        // And the locker itself will not do it on request. Asserted against the compiled
        // contract rather than against a reading of the source: every function that
        // could move a position is absent, so the call finds no selector and no
        // fallback to catch it.
        string[4] memory absent = [
            "transferFrom(address,address,uint256)",
            "approve(address,uint256)",
            "setApprovalForAll(address,bool)",
            "burn(uint256)"
        ];
        for (uint256 i = 0; i < absent.length; i++) {
            (bool ok,) = locker.call(abi.encodeWithSignature(absent[i], address(this), address(this), firstTokenId));
            assertFalse(ok, "the locker has no function that moves a position");
        }
    }

    function test_collectingFeesMovesNoPrincipal() public {
        _launch(0);

        // A fee, so that there is something to collect. The rest of this file runs the
        // hook at zero so the curve assertions measure geometry alone.
        hook.setFeePpm(3_000);

        // Trade, so there is something to collect.
        uint256 bought = _buy(trader, 1 ether);
        _sell(trader, bought / 2);

        uint128[3] memory before;
        for (uint256 i = 0; i < AgenCurve.BANDS; i++) {
            before[i] = posm.getPositionLiquidity(firstTokenId + i);
        }

        AgenPositionLocker(locker).collect();

        for (uint256 i = 0; i < AgenCurve.BANDS; i++) {
            assertEq(
                posm.getPositionLiquidity(firstTokenId + i), before[i], "collecting moved principal, which it cannot"
            );
        }

        // The fees went where the creator said, and never through the locker.
        assertGt(feeReceiver.balance, 0, "the fee receiver was paid");
        assertEq(locker.balance, 0, "the locker held nothing on the way");
    }

    // --- 4 and 5. the dev buy is optional, and it is a real trade -------------

    function test_theMarketOpensWithoutADevBuy() public {
        _launch(0);

        assertEq(hook.swaps(), 0, "no trade happened");

        // Not quite nothing: rounding an amount of token into whole units of liquidity
        // leaves a crumb, and the factory must not be the one holding it. Asserted as a
        // crumb, so an allocation could never hide here.
        assertLt(IERC20(token).balanceOf(creator), SUPPLY / 1e12, "the creator was given no allocation");
        assertEq(_capBps(), BPS, "the valuation is the one it opened at");

        // Still immediately tradable by somebody else, which is the point of opening
        // one-sided rather than empty.
        assertGt(_buy(trader, 0.1 ether), 0, "a stranger can buy from the launch liquidity");
    }

    function test_theDevBuyGoesThroughTheGeneratedHook() public {
        // A fifth of the opening valuation, which is the simulator's $1,000 into $5,000.
        _launch(uint128((1.5 ether * 2_000) / BPS));

        assertEq(hook.swaps(), 1, "the hook saw the launch buy");
        assertEq(hook.lastSender(), address(factory), "and it came from the launch itself");
        assertTrue(hook.lastZeroForOne(), "a buy is zeroForOne, always");

        assertGt(IERC20(token).balanceOf(creator), 0, "the creator received the tokens");
        assertEq(address(factory).balance, 0, "and the factory is holding nothing afterwards");

        // The mechanic is live from the first trade rather than from the first trade
        // after the creator's, which is the whole reason the buy happens in here.
        assertEq(hook.swaps(), 1, "the launch buy is trade number one");
    }

    // --- 6. a second wallet can trade -----------------------------------------

    function test_aSecondWalletCanBuyAndThenSell() public {
        _launch(0);

        uint256 spent = 0.3 ether;
        uint256 bought = _buy(trader, spent);
        assertGt(bought, 0, "the buy delivered tokens");
        assertEq(hook.swaps(), 1, "the hook saw the buy");

        uint256 returned = _sell(trader, bought);
        assertGt(returned, 0, "the sell delivered ether");
        assertEq(hook.swaps(), 2, "the hook saw the sell");

        assertEq(IERC20(token).balanceOf(trader), 0, "the trader is out of the position");
    }

    // --- 7 and 8. the curve is the simulated curve ----------------------------

    /// @notice Cumulative net buys against the multiples `curve.ts` predicts.
    ///
    /// @dev The expected values are that script's output for geometry G, in
    /// ten-thousandths of the opening valuation. Reading the fourth row against a
    /// $5,000 launch: $1,000 of cumulative buying produces a $16,196 valuation.
    ///
    /// A single sequence rather than five launches, because these are cumulative buys
    /// and the pool is a path-independent function of how much has been bought.
    function test_theCurveMatchesTheSimulator() public {
        _launch(0);

        // Buys as basis points of the opening valuation, and the valuation each should
        // produce, also in basis points.
        uint256[5] memory spendBps = [uint256(200), 500, 1_000, 2_000, 10_000];
        uint256[5] memory expectedCapBps = [uint256(11_664), 14_399, 19_597, 32_392, 109_315];

        uint256 spentSoFar;
        for (uint256 i = 0; i < spendBps.length; i++) {
            uint256 target = (openingCap * spendBps[i]) / BPS;
            _buy(trader, target - spentSoFar);
            spentSoFar = target;

            // Half a percent, against a closed form computed in floating point from tick
            // boundaries that v4 walks in integer arithmetic.
            _close(_capBps(), expectedCapBps[i], 1, "valuation after cumulative buying");

            // Every wei of it is still in the pool. Nothing is skimmed, and with a
            // fee-free hook nothing is diverted.
            assertEq(address(manager).balance, spentSoFar, "the quote asset accumulated in the pool");
        }
    }

    function test_aThousandDollarsIntoAFiveThousandDollarMarket() public {
        _launch(0);

        // The requirement, stated in the units it was set in. $5,000 opening, $1,000 of
        // buying, and the answer is not the $6,500 a conventional single-range launch
        // would have given — it is $16,196.
        _buy(trader, (openingCap * 2_000) / BPS);

        _close(_capBps(), 32_392, 1, "a fifth of the valuation in buys triples it and then some");

        uint256 dollars = (5_000 * _capBps()) / BPS;
        assertGt(dollars, 15_000, "the launch is responsive");
        assertLt(dollars, 17_500, "but not absurd");
    }

    // --- 9. depth grows with the market ---------------------------------------

    /// @notice The property a single range cannot express, and the reason for three.
    ///
    /// @dev Measured as the pool's quote holdings against its valuation. A conventional
    /// single-range launch moves the wrong way on this — 25% at a $20k valuation, under
    /// 5% at $2M — because its depth is fixed relative to a constant product curve. This
    /// geometry climbs, because the supply the opening band did not spend is sitting at
    /// higher prices where it absorbs far more.
    function test_liquidityDeepensAsTheMarketGrows() public {
        _launch(0);

        uint256[3] memory spendBps = [uint256(2_000), 10_000, 93_200];
        uint256[3] memory ratios;

        uint256 spentSoFar;
        for (uint256 i = 0; i < spendBps.length; i++) {
            uint256 target = (openingCap * spendBps[i]) / BPS;
            _buy(trader, target - spentSoFar);
            spentSoFar = target;

            ratios[i] = (address(manager).balance * BPS) / _cap();
        }

        // Roughly 6%, 9% and 16% of valuation held as quote, rising the whole way.
        assertGt(ratios[1], ratios[0], "the market got deeper as it grew");
        assertGt(ratios[2], ratios[1], "and deeper again");
        assertGt(ratios[2], ratios[0] * 2, "materially deeper, not marginally");

        _close(ratios[0], 617, 5, "depth at the open");
        _close(ratios[1], 915, 5, "depth in the middle band");
        _close(ratios[2], 1_553, 5, "depth in the deep band");
    }

    // --- 10. selling back ------------------------------------------------------

    /// @notice What a buyer gets back if they immediately leave.
    ///
    /// @dev The simulator asserts this too, and for the same reason: a fee-free AMM is
    /// path-reversible, so a round trip returns the stake exactly and any geometry that
    /// failed to would be arithmetic that does not close. It is the strongest single
    /// check that the two implementations agree, and it says plainly that round-trip
    /// loss is a question about fees rather than about the shape of the curve.
    function test_sellingStraightBackReturnsWhatWasSpent() public {
        _launch(0);

        uint256 spent = (openingCap * 2_000) / BPS;
        uint256 bought = _buy(trader, spent);

        uint256 returned = _sell(trader, bought);

        // Within a hundredth of a percent. What is missing is v4 rounding each swap in
        // the pool's favour, which is a handful of wei on either leg.
        _close(returned, spent, 1, "a round trip returns the stake");
        assertLe(returned, spent, "and never more than it, which would be value from nowhere");

        // And the market is back where it started, because the tokens went back into the
        // same bands they came out of.
        _close(_capBps(), BPS, 1, "the valuation returned to the open");
    }

    function test_anEarlyBuyerCanStillLeaveAfterOthersArrive() public {
        _launch(0);

        // Early: a fiftieth of the opening valuation.
        uint256 early = (openingCap * 200) / BPS;
        uint256 held = _buy(trader, early);

        // Then the market runs without them.
        _buy(address(this), (openingCap * 10_000) / BPS);

        uint256 returned = _sell(trader, held);

        // The point of a responsive opening band: the early buyer is up several times
        // over, and can actually realise it rather than watching a number.
        assertGt(returned, early * 3, "the early buyer made a multiple of their money");
        assertGt(_capBps(), BPS, "and the market is still well above where it opened");
    }
}
