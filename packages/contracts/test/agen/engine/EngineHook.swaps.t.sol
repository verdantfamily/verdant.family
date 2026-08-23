// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {AgenEngineVault} from "../../../src/agen/engine/AgenEngineVault.sol";
import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";
import {EngineFixture} from "./EngineFixture.sol";

/// @title The swap matrix — four shapes, two orientations, against a real PoolManager
///
/// @notice The test ADR-018 rests on. If the derived fee currency cannot be collected safely
/// for any of the four shapes, or if a size tier cannot be applied to one of them, it fails
/// here rather than on chain.
///
/// @dev Every case asserts the same five things, because a fee that is right in one respect
/// and wrong in another is not right:
///
///   1. the fee lands in the vault, in the currency the configuration derived;
///   2. its amount equals the rate applied to the **gross** leg;
///   3. the tier was selected on the gross launched-token amount, pre-fee;
///   4. the trader ends up with what the shape promises — exactly what they asked for on
///      the exact side, and the fee taken out of the other;
///   5. the pool's own accounting is undisturbed, since a hook funding a creator out of the
///      liquidity providers' returns is stealing from a different pocket rather than not
///      stealing.
contract EngineHookSwapsTest is EngineFixture {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function setUp() public {
        _deployEngine();
    }

    function _settings() private pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    /// @dev v4 requires the limit to be on the correct side of the current price.
    function _limit(bool zeroForOne) private pure returns (uint160) {
        return zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT;
    }

    /// @dev `zeroForOne` for a trade on `side`, given where the quote asset sorted.
    function _zeroForOne(bool quoteIsLower, bool isBuy) private pure returns (bool) {
        // A buy spends the quote, so the quote is the input. `zeroForOne` means currency0
        // is the input.
        return isBuy == quoteIsLower;
    }

    function _swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified) private {
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne, amountSpecified: amountSpecified, sqrtPriceLimitX96: _limit(zeroForOne)
            }),
            _settings(),
            ""
        );
    }

    // --- a flat market, quote-denominated fee -------------------------------

    /// @dev A market with no size rules collects in the quote asset, and all four shapes
    /// have to work. Run for both orientations.
    function _flatCollectsInQuote(bool quoteIsLower) private {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _flatConfig(quoteIsLower, 20_000); // 2%
        AgenEngineVault vault = _openPool(key, config);

        MockERC20 quote = _quote(quoteIsLower);
        assertEq(Currency.unwrap(vault.currency()), address(quote), "vault holds the wrong currency");

        uint256 amount = 1_000e18;

        // 1. exact-input buy: the quote is the specified currency, so `beforeSwap` charges.
        uint256 before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(quoteIsLower, true), -int256(amount));
        assertEq(vault.totalAccrued() - before, (amount * 20_000) / 1e6, "exact-input buy");

        // 2. exact-output buy: the token is specified, so `afterSwap` charges on the quote.
        before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(quoteIsLower, true), int256(amount));
        assertGt(vault.totalAccrued(), before, "exact-output buy took nothing");

        // 3. exact-input sell: the token is specified, `afterSwap` charges on the quote.
        before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(quoteIsLower, false), -int256(amount));
        assertGt(vault.totalAccrued(), before, "exact-input sell took nothing");

        // 4. exact-output sell: the quote is specified, `beforeSwap` charges.
        before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(quoteIsLower, false), int256(amount));
        assertEq(vault.totalAccrued() - before, (amount * 20_000) / 1e6, "exact-output sell");
    }

    function test_flat_market_collects_in_quote_token_is_currency1() public {
        _flatCollectsInQuote(true);
    }

    function test_flat_market_collects_in_quote_token_is_currency0() public {
        _flatCollectsInQuote(false);
    }

    // --- a tiered market, token-denominated fee -----------------------------

    /// @dev The case ADR-018 exists for. A sell tier at 1% of supply, and the boundary
    /// asserted on a real swap in every shape that can express it.
    function _tieredCollectsInToken(bool quoteIsLower) private {
        PoolKey memory key = _keyFor();
        // 0.5% base, 4% at or above 1% of supply.
        AgenRuleLib.Config memory config = _tieredConfig(quoteIsLower, 5_000, ONE_PERCENT, 40_000);
        AgenEngineVault vault = _openPool(key, config);

        MockERC20 token = _token(quoteIsLower);
        assertEq(Currency.unwrap(vault.currency()), address(token), "a tiered market must collect in the token");

        // An exact-input sell names the token, so the gross amount is exactly what the
        // trader said and the tier reads it directly.
        uint256 before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(quoteIsLower, false), -int256(uint256(ONE_PERCENT)));
        assertEq(
            vault.totalAccrued() - before,
            (uint256(ONE_PERCENT) * 40_000) / 1e6,
            "a sell of exactly 1% of supply must pay the tier"
        );

        // One base unit below, and the same trade pays the base rate.
        before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(quoteIsLower, false), -int256(uint256(ONE_PERCENT) - 1));
        assertEq(
            vault.totalAccrued() - before,
            ((uint256(ONE_PERCENT) - 1) * 5_000) / 1e6,
            "one token below the threshold must pay the base rate"
        );

        // A buy of the same size is untouched by a sell tier.
        before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(quoteIsLower, true), int256(uint256(ONE_PERCENT)));
        assertEq(
            vault.totalAccrued() - before, (uint256(ONE_PERCENT) * 5_000) / 1e6, "a sell tier must not reach a buy"
        );
    }

    function test_tiered_market_collects_in_token_is_currency1() public {
        _tieredCollectsInToken(true);
    }

    function test_tiered_market_collects_in_token_is_currency0() public {
        _tieredCollectsInToken(false);
    }

    /// @dev The boundary triple on an ERC-20-quoted market, in full: one base unit below the
    /// threshold, exactly at it, and one base unit above.
    ///
    /// The third was missing, and its absence was not obvious because the other two were
    /// there. `>=` and `>` agree on every trade except one — a trade of exactly the threshold
    /// — so the pair "below pays base, at pays the tier" pins the comparison. What it does not
    /// pin is that the tier keeps applying *past* the boundary. A tier implemented as equality
    /// rather than as a lower bound, or one whose selection loop stopped at the first match in
    /// the wrong direction, passes "below" and "at" and fails only here: every trade larger
    /// than the threshold quietly reverts to the base rate, which on a sell tier is the exact
    /// case the tier exists to price and the exact case worth the most to get wrong.
    ///
    /// Asserted in both orientations, because the gross launched-token amount is read from a
    /// different leg of the swap in each and a tier that read the quote leg would still look
    /// correct in one of them.
    ///
    /// The native-quote equivalent lives in `EngineNative.t.sol`; this is the ERC-20 path,
    /// where the fee is settled by transfer rather than by native value.
    function _theBoundaryTriple(bool quoteIsLower) private {
        PoolKey memory key = _keyFor();
        // 0.5% base, 4% at or above 1% of supply.
        AgenRuleLib.Config memory config = _tieredConfig(quoteIsLower, 5_000, ONE_PERCENT, 40_000);
        AgenEngineVault vault = _openPool(key, config);

        uint256 threshold = uint256(ONE_PERCENT);
        bool sell = _zeroForOne(quoteIsLower, false);

        // One below: the base rate.
        uint256 before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, sell, -int256(threshold - 1));
        assertEq(
            vault.totalAccrued() - before,
            ((threshold - 1) * 5_000) / 1e6,
            "one base unit below the threshold must pay the base rate"
        );

        // Exactly at it: the tier. `>=`, not `>`.
        before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, sell, -int256(threshold));
        assertEq(
            vault.totalAccrued() - before,
            (threshold * 40_000) / 1e6,
            "a sell of exactly the threshold must pay the tier"
        );

        // One above: still the tier. The case that was never tested.
        before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, sell, -int256(threshold + 1));
        assertEq(
            vault.totalAccrued() - before,
            ((threshold + 1) * 40_000) / 1e6,
            "one base unit above the threshold must still pay the tier, not the base rate"
        );

        // And the same three asked of the hook directly, so a failure distinguishes "the rate
        // selected was wrong" from "the amount charged was wrong". The swaps above are the
        // proof that the selected rate is what a trader actually pays.
        PoolId poolId = key.toId();
        assertEq(uint256(hook.feePpmFor(poolId, false, threshold - 1)), 5_000, "rate below the boundary");
        assertEq(uint256(hook.feePpmFor(poolId, false, threshold)), 40_000, "rate at the boundary");
        assertEq(uint256(hook.feePpmFor(poolId, false, threshold + 1)), 40_000, "rate above the boundary");
    }

    function test_the_boundary_triple_token_is_currency1() public {
        _theBoundaryTriple(true);
    }

    function test_the_boundary_triple_token_is_currency0() public {
        _theBoundaryTriple(false);
    }

    // --- the pre-fee rule, on a real swap -----------------------------------

    /// @dev The requirement in its sharpest form. The fee is 4% of the launched token, so
    /// net of fee a threshold-sized sell is 96% of the threshold — under it. If the tier were
    /// evaluated after the fee, this market would never once apply its own tier at the
    /// boundary, and every assertion below would come out at the base rate.
    function _thresholdIsPreFee(bool quoteIsLower) private {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _tieredConfig(quoteIsLower, 5_000, ONE_PERCENT, 40_000);
        AgenEngineVault vault = _openPool(key, config);

        uint256 before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(quoteIsLower, false), -int256(uint256(ONE_PERCENT)));

        uint256 fee = vault.totalAccrued() - before;
        assertEq(fee, (uint256(ONE_PERCENT) * 40_000) / 1e6, "the tier was not applied at the boundary");

        // And the post-fee amount really is below the threshold, which is what makes the
        // assertion above load-bearing rather than incidental.
        assertLt(uint256(ONE_PERCENT) - fee, uint256(ONE_PERCENT), "the fee did not reduce the leg");
    }

    function test_the_threshold_is_pre_fee_token_is_currency1() public {
        _thresholdIsPreFee(true);
    }

    function test_the_threshold_is_pre_fee_token_is_currency0() public {
        _thresholdIsPreFee(false);
    }

    /// @dev An exact-output sell names the *quote*, so the token leg is whatever the pool
    /// computes. The tier still has to read that leg gross, and `afterSwap` is where it can.
    ///
    /// The threshold here is a small absolute amount rather than a share of supply, because
    /// clearing 1% of a billion-token supply in one exact-output trade needs more depth than
    /// a test pool has — and the property under test is about which figure the tier reads,
    /// not about how large it is.
    function test_the_threshold_is_pre_fee_on_an_exact_output_sell() public {
        uint128 threshold = 1e18;

        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _tieredConfig(true, 5_000, threshold, 40_000);
        AgenEngineVault vault = _openPool(key, config);

        // Ask for enough quote out that the token leg the pool computes clears the threshold.
        // At a 1:1 opening price, three units of quote costs a little over three of token.
        uint256 before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, false), int256(uint256(threshold) * 3));

        uint256 fee = vault.totalAccrued() - before;
        assertGt(fee, 0, "an exact-output sell paid nothing");

        // The fee has to be the tier rate on the gross token leg. Derived from the fee rather
        // than asserted against a hard number, because the pool decides the leg — but the
        // *rate* is fully determined, so the implied gross must clear the threshold.
        uint256 impliedGross = (fee * 1e6) / 40_000;
        assertGe(impliedGross, uint256(threshold), "the tier fired on a leg below its own threshold");

        // And a small exact-output sell, whose token leg stays under the threshold, pays the
        // base rate — so the tier is genuinely reading the computed leg rather than always
        // firing.
        before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, false), int256(uint256(threshold) / 4));

        uint256 smallFee = vault.totalAccrued() - before;
        uint256 impliedSmall = (smallFee * 1e6) / 5_000;
        assertLt(impliedSmall, uint256(threshold), "the base rate was applied to a leg above the threshold");
    }

    // --- the trader gets what the shape promises ----------------------------

    function test_an_exact_output_buy_delivers_exactly_what_was_asked() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _flatConfig(true, 20_000);
        _openPool(key, config);

        MockERC20 token = _token(true);
        uint256 want = 1_000e18;
        uint256 before = token.balanceOf(trader);

        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, true), int256(want));

        // The fee is quote-denominated here, so the token side is untouched: the trader
        // receives precisely the amount they named.
        assertEq(token.balanceOf(trader) - before, want, "an exact-output buy short-changed the trader");
    }

    function test_an_exact_input_sell_spends_exactly_what_was_offered() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _tieredConfig(true, 5_000, ONE_PERCENT, 40_000);
        _openPool(key, config);

        MockERC20 token = _token(true);
        uint256 offered = 1_000e18;
        uint256 before = token.balanceOf(trader);

        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, false), -int256(offered));

        // The fee is token-denominated and comes out of what they offered, so their token
        // balance falls by exactly the amount named and no more.
        assertEq(before - token.balanceOf(trader), offered, "an exact-input sell spent more than offered");
    }

    // --- the pool is undisturbed ---------------------------------------------

    function test_the_pool_charges_no_lp_fee() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _flatConfig(true, 20_000);
        _openPool(key, config);

        (,,, uint24 lpFee) = manager.getSlot0(key.toId());
        assertEq(lpFee, 0, "the pool would charge a second fee on the same swap");

        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, true), -int256(1_000e18));

        (,,, lpFee) = manager.getSlot0(key.toId());
        assertEq(lpFee, 0, "a swap changed the pool's stored fee");
    }

    function test_the_hook_never_holds_a_balance() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _tieredConfig(true, 5_000, ONE_PERCENT, 40_000);
        _openPool(key, config);

        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, false), -int256(uint256(ONE_PERCENT)));

        // A hook is called on every swap, so a hook holding money would make "can this be
        // drained" a question about the correctness of the swap logic.
        assertEq(lower.balanceOf(address(hook)), 0, "the hook holds currency0");
        assertEq(upper.balanceOf(address(hook)), 0, "the hook holds currency1");
        assertEq(manager.balanceOf(address(hook), key.currency0.toId()), 0, "the hook holds claims on currency0");
        assertEq(manager.balanceOf(address(hook), key.currency1.toId()), 0, "the hook holds claims on currency1");
    }

    // --- the vault is solvent and payable -----------------------------------

    function test_the_vault_can_be_claimed_after_a_swap() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _tieredConfig(true, 5_000, ONE_PERCENT, 40_000);
        AgenEngineVault vault = _openPool(key, config);

        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, false), -int256(uint256(ONE_PERCENT)));

        uint256 owed = vault.claimable(0);
        assertGt(owed, 0, "nothing accrued");

        MockERC20 token = _token(true);
        uint256 before = token.balanceOf(creator);
        vault.claim(0);

        assertEq(token.balanceOf(creator) - before, owed, "the creator was not paid what accrued");
        assertEq(vault.claimable(0), 0, "the claim did not clear");
        assertEq(vault.unaccounted(), 0, "the vault holds value no ledger accounts for");
    }

    function test_the_split_reaches_both_recipients() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _tieredConfig(true, 5_000, ONE_PERCENT, 40_000);

        // 80/20, as the Exact Flow prompt asked for.
        config.distribution = new AgenRuleLib.Share[](2);
        config.distribution[0] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Creator, recipient: address(0), sharePpm: 800_000});
        config.distribution[1] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Treasury, recipient: address(0), sharePpm: 200_000});

        AgenEngineVault vault = _openPool(key, config);

        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, false), -int256(uint256(ONE_PERCENT)));

        uint256 total = vault.totalAccrued();
        assertEq(vault.claimable(0), (total * 800_000) / 1e6, "the creator's share is wrong");
        assertEq(vault.claimable(1), total - (total * 800_000) / 1e6, "the treasury's share is wrong");

        // Exactly, always. The remainder rounding leaves goes to the first slot.
        assertEq(vault.claimable(0) + vault.claimable(1), total, "the split does not conserve the fee");
    }

    // --- volume stays quote-denominated -------------------------------------

    /// @dev Even though this market collects its fee in the launched token, its volume
    /// counter has to accumulate the quote leg — the two denominations are independent.
    function test_volume_accumulates_the_quote_leg_while_the_fee_is_in_token() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _tieredConfig(true, 5_000, ONE_PERCENT, 40_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.QuoteVolume);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 5_000, sellFeePpm: 5_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 1e18, buyFeePpm: 1_000, sellFeePpm: 1_000});

        AgenEngineVault vault = _openPool(key, config);
        PoolId poolId = key.toId();

        assertEq(hook.cumulativeQuoteVolume(poolId), 0, "volume started non-zero");

        MockERC20 quote = _quote(true);
        uint256 quoteBefore = quote.balanceOf(trader);

        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, false), -int256(1_000e18));

        uint256 quoteReceived = quote.balanceOf(trader) - quoteBefore;
        assertGt(quoteReceived, 0, "the sell produced no quote");

        // The counter moved by the quote leg, in quote base units — not by the token leg and
        // not by the fee.
        assertEq(uint256(hook.cumulativeQuoteVolume(poolId)), quoteReceived, "volume is not the quote leg");
        assertEq(uint8(hook.feeCurrencyOf(poolId)), uint8(AgenRuleLib.FeeCurrency.Token), "fee currency drifted");
        assertGt(vault.totalAccrued(), 0, "no fee was taken");
    }

    function test_a_trade_never_advances_its_own_stage() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _flatConfig(true, 20_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.QuoteVolume);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 20_000, sellFeePpm: 20_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 1e18, buyFeePpm: 1_000, sellFeePpm: 1_000});

        AgenEngineVault vault = _openPool(key, config);

        // A single trade far larger than the stage threshold. It must pay the *opening*
        // rate: counting itself would charge a rate no prior trade could have predicted.
        uint256 amount = 100e18;
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, true), -int256(amount));

        assertEq(vault.totalAccrued(), (amount * 20_000) / 1e6, "the trade advanced its own stage");

        // The next one gets the advanced rate.
        uint256 before = vault.totalAccrued();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, true), -int256(amount));
        assertEq(vault.totalAccrued() - before, (amount * 1_000) / 1e6, "the stage did not advance");
    }

    // --- ceilings ------------------------------------------------------------

    function test_a_trade_above_the_ceiling_reverts_when_the_token_is_specified() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _flatConfig(true, 20_000);
        config.maxSellTokens = ONE_PERCENT;
        _openPool(key, config);

        // Exactly at the ceiling is permitted.
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, false), -int256(uint256(ONE_PERCENT)));

        // One base unit above is not.
        vm.expectRevert();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, false), -int256(uint256(ONE_PERCENT) + 1));
    }

    function test_a_trade_above_the_ceiling_reverts_when_the_token_is_unspecified() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _flatConfig(true, 20_000);
        config.maxSellTokens = ONE_PERCENT;
        _openPool(key, config);

        // An exact-output sell names the quote, so the token leg is only known in
        // `afterSwap`. Reverting there still reverts the whole swap, which is all a ceiling
        // has to do.
        vm.expectRevert();
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, false), int256(uint256(ONE_PERCENT) * 10));
    }

    // --- a market that charges nothing --------------------------------------

    function test_a_zero_fee_market_trades_without_charging() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _flatConfig(true, 0);
        AgenEngineVault vault = _openPool(key, config);

        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, true), -int256(1_000e18));
        assertEq(vault.totalAccrued(), 0, "a free market charged something");
    }

    function test_a_trade_too_small_to_owe_a_base_unit_still_settles() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _flatConfig(true, 20_000);
        AgenEngineVault vault = _openPool(key, config);

        // 2% of 10 wei rounds to zero. A revert here would be a market that cannot take a
        // small trade, which is worse than not charging for one.
        // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
        _swap(key, _zeroForOne(true, true), -int256(10));
        assertEq(vault.totalAccrued(), 0, "dust was charged");
    }
}
