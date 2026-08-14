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
import {InstantFees} from "../src/libraries/InstantFees.sol";
import {VerdantConstants} from "../src/libraries/VerdantConstants.sol";
import {GeneratedToken} from "./agen/fixtures/GeneratedToken.sol";

/// @title What the opening valuation does to Instant's price impact
///
/// @notice A measurement, not a characterisation. `InstantMarket.t.sol` pins what Instant
/// does today; this asks what it would do at a different opening tick, so that the choice
/// of opening valuation is made against real v4 numbers rather than against a formula.
///
/// @dev The single knob, and why there is only one.
///
/// A one-sided position spanning `MIN_USABLE_TICK` to the opening tick and holding the
/// whole supply is exactly a constant-product pool whose ether side is entirely virtual at
/// launch. Its virtual ether reserve works out to `supply / P_open`, which *is* the
/// opening market cap — so the pool is `x·y = k` with `x₀ = M₀` and `y₀ = supply`, and
/// market cap follows `M = x²/x₀`.
///
/// Two things fall out of that. A buy of `ΔE` multiplies the cap by
/// `(1 + ΔE/√(M·M₀))²`, so the *only* thing that changes the impact profile is `M₀`. And
/// the supply cancels: minting ten billion tokens instead of one billion changes every
/// price by a factor of ten and changes no impact at all.
///
/// This file exists to check that against a real pool, including the parts the formula
/// ignores — tick spacing quantising `M₀`, `MIN_USABLE_TICK` not being zero, and the
/// hook's 1.50% coming out of the ether leg before the pool sees it.
contract InstantDepthTest is Deployers {
    InstantHook internal hook;
    PositionManager internal posm;

    address internal treasury = makeAddr("treasury");
    address internal trader = makeAddr("trader");
    address internal locker = makeAddr("locker");

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant ETH_USD = 1900;

    /// @dev The token of the market most recently opened, for the first-buy measurement.
    GeneratedToken internal opened;

    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    /// @dev Every opening tick sampled, and the valuation each produces. Multiples of 200.
    int24[6] internal TICKS = [int24(203_200), 209_800, 213_400, 217_800, 220_200, 224_000];

    function setUp() public {
        deployFreshManagerAndRouters();

        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        address hookAt = address(uint160(FLAGS) | uint160(uint256(0x4444) << 144));
        deployCodeTo("InstantHook.sol:InstantHook", abi.encode(manager, address(this), address(posm)), hookAt);
        hook = InstantHook(hookAt);

        vm.deal(trader, 100_000 ether);
    }

    /// @dev A fresh market at `openingTick`, returning the valuation it opened at. A new
    /// token gives a new pool, so each sample is independent and nothing has to be unwound
    /// between them.
    function _open(int24 openingTick) private returns (uint256 opening) {
        GeneratedToken token = new GeneratedToken("Instant", "INST", SUPPLY, address(this));
        opened = token;

        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        InstantFeeVault vault = new InstantFeeVault(address(hook), manager, makeAddr("creator"), treasury);
        hook.register(key, vault);

        manager.initialize(key, TickMath.getSqrtPriceAtTick(openingTick));

        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(VerdantConstants.MIN_USABLE_TICK);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(openingTick);
        uint256 liquidity = LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, SUPPLY);

        require(token.transfer(address(posm), SUPPLY), "setup: token to posm");

        bytes memory actions =
            abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE), uint8(Actions.SWEEP));

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            key,
            VerdantConstants.MIN_USABLE_TICK,
            openingTick,
            liquidity,
            uint128(0),
            uint128(SUPPLY),
            locker,
            bytes("")
        );
        params[1] = abi.encode(key.currency1, ActionConstants.OPEN_DELTA, false);
        params[2] = abi.encode(key.currency1, address(this));

        posm.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        opening = _marketCap();
    }

    function _marketCap() private view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(manager, key.toId());
        uint256 half = FullMath.mulDiv(SUPPLY, FixedPoint96.Q96, sqrtPriceX96);
        return FullMath.mulDiv(half, FixedPoint96.Q96, sqrtPriceX96);
    }

    function _usdToWei(uint256 usd) private pure returns (uint256) {
        return (usd * 1e18) / ETH_USD;
    }

    function _settings() private pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    function _buy(uint256 ethIn, uint160 limit) private {
        vm.prank(trader);
        swapRouter.swap{value: ethIn}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: limit}),
            _settings(),
            bytes("")
        );
    }

    function _pushToCap(uint256 capWei) private {
        uint160 limit = uint160(Math.sqrt(FullMath.mulDiv(SUPPLY, FixedPoint96.Q96, capWei) << 96));
        _buy(50_000 ether, limit);
    }

    /// @dev What a $1 000 buy does to a market at `capUsd`, in basis points of where it
    /// started — and, beside it, what the closed form says it should have done.
    ///
    /// `(1 + ΔE/√(M·M₀))²`, with `ΔE` net of the hook's 1.50% because the fee is taken from
    /// the ether leg before the pool sees any of it.
    function _measure(int24 openingTick, uint256 capUsd) private returns (uint256 measured, uint256 predicted) {
        uint256 opening = _open(openingTick);
        _pushToCap(_usdToWei(capUsd));

        uint256 before = _marketCap();
        uint256 gross = _usdToWei(1000);
        (,, uint256 fee) = InstantFees.split(gross);

        _buy(gross, MIN_PRICE_LIMIT);
        measured = (_marketCap() * 10_000) / before;

        uint256 root = Math.sqrt(opening * before);
        predicted = FullMath.mulDiv(10_000, (root + gross - fee) * (root + gross - fee), root * root);
    }

    /// The impact profile of every candidate opening, and the claim that one number sets it.
    ///
    /// The table is the output, but the assertion is the point: at every opening and every
    /// cap, what a real v4 pool does matches `(1 + ΔE/√(M·M₀))²` to within a fraction of a
    /// percent. That is the evidence for "there is one knob and it is the opening
    /// valuation" — and it is what makes a proposed opening tick something that can be
    /// chosen on paper and then confirmed, rather than searched for by trial.
    function test_theOpeningValuationIsTheOnlyKnob() public {
        uint256[5] memory caps = [uint256(3_000), 10_000, 25_000, 50_000, 100_000];

        for (uint256 i = 0; i < TICKS.length; i++) {
            int24 openingTick = TICKS[i];
            uint256 opening = _open(openingTick);

            emit log_string("");
            emit log_named_int("opening tick", openingTick);
            emit log_named_uint("opening market cap, in milli-ether", (opening * 1000) / 1e18);
            emit log_named_uint("opening market cap, in dollars", (opening * ETH_USD) / 1e18);

            for (uint256 c = 0; c < caps.length; c++) {
                (uint256 measured, uint256 predicted) = _measure(openingTick, caps[c]);

                emit log_named_uint(
                    string.concat("  $1k buy at $", vm.toString(caps[c]), " cap, bps of the cap"), measured
                );

                assertApproxEqRel(
                    measured, predicted, 0.005e18, "a real pool departed from the constant-product closed form"
                );
            }
        }
    }

    /// What a $1 000 first buy takes of the supply, at each candidate opening.
    ///
    /// The other half of the trade-off, and the reason the knob cannot simply be turned up.
    /// The same number that decides how far a buy moves a $10 000 market decides how much
    /// of the token the very first buyer gets, because on one constant-product curve they
    /// are the same number. A shallower opening buys mid-cap excitement with launch-instant
    /// concentration.
    function test_theFirstBuyAtEachOpening() public {
        for (uint256 i = 0; i < TICKS.length; i++) {
            uint256 opening = _open(TICKS[i]);

            uint256 before = opened.balanceOf(trader);
            _buy(_usdToWei(1000), MIN_PRICE_LIMIT);
            uint256 share = ((opened.balanceOf(trader) - before) * 10_000) / SUPPLY;

            emit log_named_uint("opening market cap, in dollars", (opening * ETH_USD) / 1e18);
            emit log_named_uint("  a $1k first buy takes, in bps of supply", share);
        }
    }
}
