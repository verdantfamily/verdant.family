// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {InstantFeeVault} from "../src/InstantFeeVault.sol";
import {InstantHook} from "../src/InstantHook.sol";
import {VerdantConstants} from "../src/libraries/VerdantConstants.sol";
import {GeneratedToken} from "./agen/fixtures/GeneratedToken.sol";

/// @title What an Instant market actually does to a buyer
/// @notice Instant is the classic Verdant shape — one one-sided locked position holding
/// the whole supply — with the ether-only 1.50% hook on top. This drives a real pool to a
/// series of valuations and measures what a fixed $1 000 buy does from each.
///
/// @dev The point of the file is that those two halves compose. `InstantHook.t.sol` proves
/// the fee arithmetic against a bare pool; this proves the fee behaves the same way on the
/// liquidity Instant actually launches with, and that the liquidity is ordinary.
///
/// There was, briefly, a bespoke `g = 0.35` liquidity ladder here designed to make Instant
/// tokens easier to push. It was deleted; ADR-014 records why. The characterisation below
/// is the guard against it coming back by accident: these are constant-product numbers,
/// and a curve tuned for aggression cannot pass them.
///
/// Valuations are quoted in dollars at $1 900 an ether because that is how ADR-014
/// discusses them. Nothing on chain knows about dollars — the rate is a constant here and
/// only decides which market caps get sampled.
contract InstantMarketTest is Deployers {
    InstantHook internal hook;
    InstantFeeVault internal vault;
    PositionManager internal posm;
    GeneratedToken internal token;

    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal trader = makeAddr("trader");
    address internal locker = makeAddr("locker");

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    int24 internal constant INITIAL_TICK = 203_200;

    /// @dev Only used to pick the market caps this test samples.
    uint256 internal constant ETH_USD = 1900;

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

    /// @dev The whole supply into one position owned by a locker that never releases.
    ///
    /// Deliberately the same three actions and the same range as
    /// `VerdantFactory._mintLockedPosition`, because that is the code the Instant factory
    /// will use. `amount0Max: 0` is the assertion that the position needs no ether: the
    /// pool opens exactly at the top of the range, and v4 puts a position whose upper tick
    /// is at or below the current tick entirely in `currency1`.
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
            locker,
            bytes("")
        );
        params[1] = abi.encode(key.currency1, ActionConstants.OPEN_DELTA, false);
        params[2] = abi.encode(key.currency1, address(this));

        posm.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    // --- reading the market ---------------------------------------------------

    /// @dev Market cap in wei: the whole supply valued at the pool's current price. Ether
    /// is `currency0`, so the pool's price is token-per-ether and this is its reciprocal
    /// times the supply. Two `mulDiv`s because `supply << 192` does not fit a word.
    function _marketCap() private view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(manager, key.toId());
        uint256 half = FullMath.mulDiv(SUPPLY, FixedPoint96.Q96, sqrtPriceX96);
        return FullMath.mulDiv(half, FixedPoint96.Q96, sqrtPriceX96);
    }

    /// @dev The sqrt price at which the market would be worth `capWei`. Used as a swap
    /// limit, so a buy can be told to stop at a valuation rather than at an amount.
    function _sqrtPriceForCap(uint256 capWei) private pure returns (uint160) {
        return uint160(Math.sqrt(FullMath.mulDiv(SUPPLY, FixedPoint96.Q96, capWei) << 96));
    }

    function _usdToWei(uint256 usd) private pure returns (uint256) {
        return (usd * 1e18) / ETH_USD;
    }

    function _settings() private pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    /// @dev Buy until the market is worth `capWei`, whatever that costs. The price limit
    /// stops the swap exactly there and the router refunds what it did not spend.
    function _pushToCap(uint256 capWei) private {
        vm.prank(trader);
        swapRouter.swap{value: 500 ether}(
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(500 ether), sqrtPriceLimitX96: _sqrtPriceForCap(capWei)
            }),
            _settings(),
            bytes("")
        );
    }

    /// @dev A buy of `ethIn`, returning what it did to the market cap, in basis points of
    /// the cap it started from.
    function _buyAndMeasure(uint256 ethIn) private returns (uint256 bps) {
        uint256 before = _marketCap();

        vm.prank(trader);
        swapRouter.swap{value: ethIn}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            bytes("")
        );

        return (_marketCap() * 10_000) / before;
    }

    /// @dev What a $1 000 buy does to a market currently worth `capUsd`, in basis points.
    function _measureAt(uint256 capUsd) private returns (uint256) {
        _pushToCap(_usdToWei(capUsd));
        return _buyAndMeasure(_usdToWei(1000));
    }

    // --- the opening ----------------------------------------------------------

    function test_theMarketOpensAtOnePointFiveEther() public view {
        assertApproxEqRel(_marketCap(), 1.5 ether, 0.005e18, "the opening valuation moved");
    }

    /// All of it, to within the rounding of a single division.
    ///
    /// `getLiquidityForAmount1` converts the supply into a whole number of liquidity
    /// units and the remainder — about 19 000 wei, or 2e-23 of the supply — cannot be
    /// expressed as liquidity, so `SWEEP` hands it back. That is the existing
    /// `VerdantFactory` behaviour rather than anything new; what matters is that it is
    /// dust and not a share.
    function test_theWholeSupplyIsInThePool() public view {
        assertLt(token.balanceOf(address(this)), 1e6, "the launch left real token behind");
        assertApproxEqAbs(token.balanceOf(address(manager)), SUPPLY, 1e6, "the pool does not hold the supply");
    }

    function test_theLiquidityIsOnePositionOwnedByTheLocker() public view {
        assertEq(posm.nextTokenId(), 2, "the launch minted something other than one position");
        assertEq(posm.ownerOf(1), locker, "the position is not the locker's");
    }

    // --- the market, measured -------------------------------------------------

    /// **What Instant is.** Each entry is what a $1 000 buy does to the market cap, in
    /// basis points of where it started, at $1 900 an ether with the 1.50% fee charged:
    ///
    ///     $3k  -> +79%      $25k  -> +25%
    ///     $5k  -> +58%      $50k  -> +17%
    ///     $10k -> +40%      $100k -> +12%
    ///
    /// This is ordinary constant-product behaviour and that is the intent, not a
    /// limitation: one position spanning the whole reachable range is `x*y=k`, so an
    /// Instant token trades like any other Uniswap token from its first block.
    ///
    /// Pinned because it is the economic contract with a buyer, and because it is what a
    /// reintroduced aggression curve would break. Treat a failure here as a change to the
    /// product rather than to a test.
    function test_aThousandDollarBuyAtThreeThousand() public {
        assertApproxEqRel(_measureAt(3000), 17_880, 0.01e18, "a $1k buy at $3k no longer adds 79%");
    }

    function test_aThousandDollarBuyAtFiveThousand() public {
        assertApproxEqRel(_measureAt(5000), 15_790, 0.01e18, "a $1k buy at $5k no longer adds 58%");
    }

    function test_aThousandDollarBuyAtTenThousand() public {
        assertApproxEqRel(_measureAt(10_000), 14_030, 0.01e18, "a $1k buy at $10k no longer adds 40%");
    }

    function test_aThousandDollarBuyAtTwentyFiveThousand() public {
        assertApproxEqRel(_measureAt(25_000), 12_470, 0.01e18, "a $1k buy at $25k no longer adds 25%");
    }

    function test_aThousandDollarBuyAtFiftyThousand() public {
        assertApproxEqRel(_measureAt(50_000), 11_720, 0.01e18, "a $1k buy at $50k no longer adds 17%");
    }

    function test_aThousandDollarBuyAtOneHundredThousand() public {
        assertApproxEqRel(_measureAt(100_000), 11_190, 0.01e18, "a $1k buy at $100k no longer adds 12%");
    }

    /// The liquidity is ordinary, asserted as a property rather than as six numbers: a
    /// fixed buy gets steadily weaker as the market grows, and never stops working. A
    /// bespoke curve tuned for aggression would clear the second bound and miss the first.
    function test_theMarketGetsHarderToPushAsItGrows() public {
        uint256 low = _measureAt(3000);
        uint256 mid = _measureAt(25_000);
        uint256 high = _measureAt(100_000);

        assertGt(low, mid, "a $1k buy is not more powerful at $3k than at $25k");
        assertGt(mid, high, "a $1k buy is not more powerful at $25k than at $100k");
        assertGt(high, 10_000, "a $1k buy stopped moving the market at all");
    }

    /// There is no ceiling and no band edge anywhere in the range: the single position
    /// runs to the bottom of usable tick space, so a large enough buy keeps working long
    /// past any valuation Instant is for. The ladder that was deleted could not do this —
    /// its deep tail stopped the market near $100M — and this is the cheapest assertion
    /// that distinguishes the two shapes.
    function test_thereIsNoCeilingOnTheMarket() public {
        _pushToCap(_usdToWei(100_000_000));
        assertApproxEqRel(_marketCap(), _usdToWei(100_000_000), 0.01e18, "the market hit a ceiling below $100M");
    }

    // --- symmetry -------------------------------------------------------------

    /// A buy and an immediate sell of everything it produced returns the market to
    /// **exactly** where it started, and costs the trader both fees.
    ///
    /// That the price is unchanged is a consequence of where the fee is taken. Because
    /// the hook charges the ether leg rather than the pool, the swap the pool sees is a
    /// buy of N tokens followed by a sell of the same N, which is a round trip in its own
    /// reserves. A fee charged as an LP fee would instead be left behind in the pool and
    /// the market cap would drift up on every round trip — a market that rises when
    /// somebody breaks even. It is worth pinning that this one does not.
    function test_aRoundTripMovesThePriceNowhereAndCostsBothFees() public {
        _pushToCap(_usdToWei(10_000));

        uint256 capBefore = _marketCap();
        uint256 etherBefore = trader.balance;
        uint256 vaultBefore = vault.claims() + address(vault).balance;

        uint256 heldBefore = token.balanceOf(trader);
        vm.prank(trader);
        swapRouter.swap{value: 1 ether}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(1 ether), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            bytes("")
        );
        uint256 bought = token.balanceOf(trader) - heldBefore;

        vm.prank(trader);
        token.approve(address(swapRouter), bought);
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(bought), sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            _settings(),
            bytes("")
        );

        assertApproxEqAbs(_marketCap(), capBefore, 1e12, "a round trip moved the market");
        assertEq(token.balanceOf(trader), heldBefore, "the trader did not sell everything they bought");

        // Roughly 1.50% on the way in and 1.50% on the way out, all of it in ether and
        // all of it in the vault rather than in the pool.
        uint256 lost = etherBefore - trader.balance;
        uint256 collected = vault.claims() + address(vault).balance - vaultBefore;

        // To within a few wei of swap rounding, which the pool keeps.
        assertApproxEqAbs(lost, collected, 100, "the trader lost ether that did not reach the vault");
        assertApproxEqRel(lost, 0.03 ether, 0.02e18, "a round trip did not cost two 1.50% fees");
    }
}
