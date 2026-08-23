// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";

/// @dev Same harness shape as the vectors suite, kept separate so this file can be read
/// without the JSON machinery.
contract Harness {
    AgenRuleLib.Stored internal _rules;

    function store(AgenRuleLib.Config memory config) external {
        AgenRuleLib.store(_rules, config);
    }

    function validate(AgenRuleLib.Config memory config) external pure {
        AgenRuleLib.validate(config);
    }

    function recordInitTime(uint40 initTime) external {
        AgenRuleLib.recordInitTime(_rules, initTime);
    }

    function feePpmFor(AgenRuleLib.Side side, uint256 tokenAmount, uint256 progress) external view returns (uint24) {
        return AgenRuleLib.feePpmFor(_rules, side, tokenAmount, progress);
    }

    function activeStage(uint256 progress) external view returns (uint256) {
        return AgenRuleLib.activeStage(_rules, progress);
    }

    function progressOf(uint256 blockTimestamp) external view returns (uint256) {
        return AgenRuleLib.progressOf(_rules, blockTimestamp);
    }

    function accumulate(uint256 quoteAmount) external {
        AgenRuleLib.accumulate(_rules, quoteAmount);
    }

    function volume() external view returns (uint128) {
        return _rules.cumulativeQuoteVolume;
    }

    function configured() external view returns (bool) {
        return _rules.configured;
    }
}

/// @title AgenRuleLib unit and property tests
/// @notice What the library refuses, and the properties it holds for every input.
///
/// The vectors suite proves the Solidity agrees with the TypeScript. This one proves the
/// things a vector cannot: that an invalid configuration cannot reach storage, that a
/// configured market can never be reconfigured, and that the swap path has no input that
/// makes it revert.
contract AgenRuleLibTest is Test {
    Harness internal harness;

    uint128 internal constant SUPPLY = 1_000_000_000e18;
    uint128 internal constant ONE_PERCENT = SUPPLY / 100;

    function setUp() public {
        harness = new Harness();
    }

    // --- builders -----------------------------------------------------------

    function _flat(uint24 feePpm) internal pure returns (AgenRuleLib.Config memory config) {
        config.engineVersion = 1;
        config.referenceSupply = SUPPLY;
        config.quoteAsset = address(0);
        config.feeCurrency = uint8(AgenRuleLib.FeeCurrency.Quote);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.None);

        config.stages = new AgenRuleLib.Stage[](1);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: feePpm, sellFeePpm: feePpm});

        config.buyTiers = new AgenRuleLib.Tier[](0);
        config.sellTiers = new AgenRuleLib.Tier[](0);

        config.distribution = new AgenRuleLib.Share[](1);
        config.distribution[0] = AgenRuleLib.Share({
            kind: AgenRuleLib.RecipientKind.Creator,
            recipient: address(0),
            sharePpm: uint24(AgenRuleLib.PPM_ONE)
        });
    }

    function _withSellTier(AgenRuleLib.Config memory config, uint128 threshold, uint24 feePpm)
        internal
        pure
        returns (AgenRuleLib.Config memory)
    {
        AgenRuleLib.Tier[] memory tiers = new AgenRuleLib.Tier[](config.sellTiers.length + 1);
        for (uint256 i = 0; i < config.sellTiers.length; i++) {
            tiers[i] = config.sellTiers[i];
        }
        tiers[config.sellTiers.length] = AgenRuleLib.Tier({thresholdTokens: threshold, feePpm: feePpm});
        config.sellTiers = tiers;
        config.feeCurrency = uint8(AgenRuleLib.FeeCurrency.Token);
        return config;
    }

    // --- what it refuses ----------------------------------------------------

    function test_refuses_an_unknown_engine_version() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.engineVersion = 2;

        // A market is never reinterpreted under a version other than the one it was
        // written for.
        vm.expectRevert(abi.encodeWithSelector(AgenRuleLib.InvalidEngineVersion.selector, 2));
        harness.validate(config);
    }

    function test_refuses_a_rate_above_the_ceiling() public {
        // Nothing clamps. A market that asked for 40% did not ask for 10%.
        AgenRuleLib.Config memory config = _flat(400_000);

        vm.expectRevert(
            abi.encodeWithSelector(AgenRuleLib.FeeOutOfBounds.selector, 400_000, AgenRuleLib.MAX_FEE_PPM)
        );
        harness.validate(config);
    }

    function test_accepts_a_rate_exactly_at_the_ceiling() public {
        harness.store(_flat(uint24(AgenRuleLib.MAX_FEE_PPM)));
        assertTrue(harness.configured());
    }

    function test_refuses_a_zero_reference_supply() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.referenceSupply = 0;

        vm.expectRevert(AgenRuleLib.ZeroReferenceSupply.selector);
        harness.validate(config);
    }

    function test_refuses_no_stages() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.stages = new AgenRuleLib.Stage[](0);

        vm.expectRevert(abi.encodeWithSelector(AgenRuleLib.InvalidStageCount.selector, 0, AgenRuleLib.MAX_STAGES));
        harness.validate(config);
    }

    function test_refuses_more_stages_than_it_evaluates() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.Time);
        config.stages = new AgenRuleLib.Stage[](AgenRuleLib.MAX_STAGES + 1);
        for (uint256 i = 0; i <= AgenRuleLib.MAX_STAGES; i++) {
            config.stages[i] =
                AgenRuleLib.Stage({threshold: uint128(i * 3600), buyFeePpm: 10_000, sellFeePpm: 10_000});
        }

        vm.expectRevert(
            abi.encodeWithSelector(AgenRuleLib.InvalidStageCount.selector, AgenRuleLib.MAX_STAGES + 1, AgenRuleLib.MAX_STAGES)
        );
        harness.validate(config);
    }

    function test_refuses_a_first_stage_that_does_not_start_at_zero() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.stages[0].threshold = 1;

        vm.expectRevert(abi.encodeWithSelector(AgenRuleLib.FirstStageThresholdNonZero.selector, 1));
        harness.validate(config);
    }

    function test_refuses_stages_that_do_not_advance() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.Time);
        config.stages = new AgenRuleLib.Stage[](3);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 10_000, sellFeePpm: 10_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 3600, buyFeePpm: 20_000, sellFeePpm: 20_000});
        config.stages[2] = AgenRuleLib.Stage({threshold: 3600, buyFeePpm: 30_000, sellFeePpm: 30_000});

        // Equal thresholds make the active stage depend on the order they were written in.
        vm.expectRevert(abi.encodeWithSelector(AgenRuleLib.StagesNotIncreasing.selector, 2, 3600, 3600));
        harness.validate(config);
    }

    function test_refuses_time_stages_closer_than_the_minimum_gap() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.Time);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 10_000, sellFeePpm: 10_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 100, buyFeePpm: 20_000, sellFeePpm: 20_000});

        vm.expectRevert(
            abi.encodeWithSelector(AgenRuleLib.StageGapTooSmall.selector, 1, 100, AgenRuleLib.MIN_TIME_STAGE_GAP)
        );
        harness.validate(config);
    }

    function test_refuses_a_ladder_axis_with_only_one_stage() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.Time);

        // An axis with one stage claims a progression that does not exist.
        vm.expectRevert(
            abi.encodeWithSelector(AgenRuleLib.LadderAxisWithoutStages.selector, uint8(AgenRuleLib.LadderAxis.Time))
        );
        harness.validate(config);
    }

    function test_refuses_several_stages_with_no_axis() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 10_000, sellFeePpm: 10_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 3600, buyFeePpm: 20_000, sellFeePpm: 20_000});

        // Several stages and nothing to decide which is active.
        vm.expectRevert(abi.encodeWithSelector(AgenRuleLib.StagesWithoutLadderAxis.selector, 2));
        harness.validate(config);
    }

    function test_refuses_a_zero_tier_threshold() public {
        AgenRuleLib.Config memory config = _withSellTier(_flat(10_000), 0, 40_000);

        // A tier matching every trade is the base rate, not a tier.
        vm.expectRevert(abi.encodeWithSelector(AgenRuleLib.ZeroTierThreshold.selector, 0));
        harness.validate(config);
    }

    function test_refuses_a_tier_above_the_whole_supply() public {
        AgenRuleLib.Config memory config = _withSellTier(_flat(10_000), SUPPLY + 1, 40_000);

        // No trade could reach it, so the rule could never fire.
        vm.expectRevert(abi.encodeWithSelector(AgenRuleLib.TierAboveSupply.selector, 0, SUPPLY + 1, SUPPLY));
        harness.validate(config);
    }

    function test_refuses_tiers_that_do_not_advance() public {
        AgenRuleLib.Config memory config = _withSellTier(_withSellTier(_flat(10_000), ONE_PERCENT, 40_000), ONE_PERCENT, 50_000);

        vm.expectRevert(
            abi.encodeWithSelector(AgenRuleLib.TiersNotIncreasing.selector, 1, ONE_PERCENT, ONE_PERCENT)
        );
        harness.validate(config);
    }

    function test_refuses_a_tier_its_own_ceiling_makes_unreachable() public {
        AgenRuleLib.Config memory config = _withSellTier(_flat(10_000), ONE_PERCENT * 5, 40_000);
        config.maxSellTokens = ONE_PERCENT * 2;

        // One of the two rules is not what was meant.
        vm.expectRevert(
            abi.encodeWithSelector(
                AgenRuleLib.TierAboveCeiling.selector, 0, ONE_PERCENT * 5, uint128(ONE_PERCENT * 2)
            )
        );
        harness.validate(config);
    }

    function test_refuses_more_tiers_than_it_evaluates() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.sellTiers = new AgenRuleLib.Tier[](AgenRuleLib.MAX_TIERS_PER_SIDE + 1);
        for (uint256 i = 0; i <= AgenRuleLib.MAX_TIERS_PER_SIDE; i++) {
            config.sellTiers[i] = AgenRuleLib.Tier({thresholdTokens: uint128((i + 1) * 1e18), feePpm: 40_000});
        }

        vm.expectRevert(
            abi.encodeWithSelector(
                AgenRuleLib.InvalidTierCount.selector, AgenRuleLib.MAX_TIERS_PER_SIDE + 1, AgenRuleLib.MAX_TIERS_PER_SIDE
            )
        );
        harness.validate(config);
    }

    function test_refuses_shares_that_do_not_total_one_whole() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.distribution[0].sharePpm = 900_000;

        // 90% is not a rounding problem: it is a tenth of every fee going nowhere.
        vm.expectRevert(
            abi.encodeWithSelector(AgenRuleLib.SharesDoNotTotalOne.selector, 900_000, AgenRuleLib.PPM_ONE)
        );
        harness.validate(config);
    }

    function test_refuses_shares_that_total_more_than_one_whole() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.distribution = new AgenRuleLib.Share[](2);
        config.distribution[0] = AgenRuleLib.Share({
            kind: AgenRuleLib.RecipientKind.Creator,
            recipient: address(0),
            sharePpm: 800_000
        });
        config.distribution[1] = AgenRuleLib.Share({
            kind: AgenRuleLib.RecipientKind.Treasury,
            recipient: address(0),
            sharePpm: 300_000
        });

        vm.expectRevert(
            abi.encodeWithSelector(AgenRuleLib.SharesDoNotTotalOne.selector, 1_100_000, AgenRuleLib.PPM_ONE)
        );
        harness.validate(config);
    }

    function test_refuses_a_zero_share() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.distribution = new AgenRuleLib.Share[](2);
        config.distribution[0] = AgenRuleLib.Share({
            kind: AgenRuleLib.RecipientKind.Creator,
            recipient: address(0),
            sharePpm: uint24(AgenRuleLib.PPM_ONE)
        });
        config.distribution[1] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Treasury, recipient: address(0), sharePpm: 0});

        vm.expectRevert(abi.encodeWithSelector(AgenRuleLib.ZeroShare.selector, 1));
        harness.validate(config);
    }

    function test_refuses_the_zero_address_as_a_recipient() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.distribution[0] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Address, recipient: address(0), sharePpm: uint24(AgenRuleLib.PPM_ONE)});

        // Sending a fee there destroys it, which is a burn written as a payout.
        vm.expectRevert(abi.encodeWithSelector(AgenRuleLib.ZeroRecipient.selector, 0));
        harness.validate(config);
    }

    function test_refuses_an_address_carried_on_a_role() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.distribution[0].recipient = address(0xBEEF);

        // The vault resolves who the creator is; a second answer here could disagree.
        vm.expectRevert(abi.encodeWithSelector(AgenRuleLib.RecipientNotZeroForRole.selector, 0));
        harness.validate(config);
    }

    function test_allows_no_distribution_when_the_market_charges_nothing() public {
        AgenRuleLib.Config memory config = _flat(0);
        config.distribution = new AgenRuleLib.Share[](0);

        harness.store(config);
        assertTrue(harness.configured());
    }

    // --- immutability -------------------------------------------------------

    function test_a_configured_market_cannot_be_reconfigured() public {
        harness.store(_flat(10_000));

        // There is no owner, no setter and no upgrade path. This is the whole guarantee: a
        // creator's economics cannot be changed out from under them after launch.
        vm.expectRevert(AgenRuleLib.AlreadyConfigured.selector);
        harness.store(_flat(20_000));
    }

    function test_reconfiguring_with_the_identical_configuration_still_reverts() public {
        // Idempotence is not a defence. A second write is a bug in the caller, and the
        // library says so rather than silently accepting it.
        harness.store(_flat(10_000));

        vm.expectRevert(AgenRuleLib.AlreadyConfigured.selector);
        harness.store(_flat(10_000));
    }

    function test_the_init_time_is_recorded_once() public {
        harness.store(_flat(10_000));
        harness.recordInitTime(1000);

        // Every time threshold is measured from it, so moving it would silently reschedule
        // every transition of a live market.
        vm.expectRevert(AgenRuleLib.AlreadyConfigured.selector);
        harness.recordInitTime(2000);
    }

    // --- the swap path has no failure mode ----------------------------------

    function testFuzz_evaluation_never_reverts(uint8 sideRaw, uint256 tokenAmount, uint256 progress) public {
        harness.store(_withSellTier(_flat(5_000), ONE_PERCENT, 40_000));

        AgenRuleLib.Side side = AgenRuleLib.Side(sideRaw % 2);

        // A schedule that could revert in `beforeSwap` is a market that cannot be traded,
        // which is worse than any fee it might have returned.
        uint24 fee = harness.feePpmFor(side, tokenAmount, progress);
        assertLe(uint256(fee), AgenRuleLib.MAX_FEE_PPM);
    }

    function testFuzz_the_rate_is_always_one_the_configuration_contains(uint256 tokenAmount) public {
        harness.store(_withSellTier(_withSellTier(_flat(5_000), ONE_PERCENT, 30_000), ONE_PERCENT * 2, 50_000));

        uint24 fee = harness.feePpmFor(AgenRuleLib.Side.Sell, tokenAmount, 0);
        assertTrue(fee == 5_000 || fee == 30_000 || fee == 50_000, "a rate nobody configured");
    }

    function testFuzz_the_highest_matching_tier_always_wins(uint256 tokenAmount) public {
        harness.store(_withSellTier(_withSellTier(_flat(5_000), ONE_PERCENT, 30_000), ONE_PERCENT * 2, 50_000));

        uint24 fee = harness.feePpmFor(AgenRuleLib.Side.Sell, tokenAmount, 0);

        if (tokenAmount >= ONE_PERCENT * 2) assertEq(fee, 50_000);
        else if (tokenAmount >= ONE_PERCENT) assertEq(fee, 30_000);
        else assertEq(fee, 5_000);
    }

    function testFuzz_a_tier_never_leaks_to_the_other_side(uint256 tokenAmount) public {
        harness.store(_withSellTier(_flat(5_000), ONE_PERCENT, 40_000));

        // The tier is a sell rule. A buy of any size pays the base rate.
        assertEq(harness.feePpmFor(AgenRuleLib.Side.Buy, tokenAmount, 0), 5_000);
    }

    function test_the_boundary_triple() public {
        harness.store(_withSellTier(_flat(5_000), ONE_PERCENT, 40_000));

        // The sentence the original Exact Flow build shipped with no test for.
        assertEq(harness.feePpmFor(AgenRuleLib.Side.Sell, ONE_PERCENT - 1, 0), 5_000);
        assertEq(harness.feePpmFor(AgenRuleLib.Side.Sell, ONE_PERCENT, 0), 40_000);
        assertEq(harness.feePpmFor(AgenRuleLib.Side.Sell, ONE_PERCENT + 1, 0), 40_000);
    }

    // --- the ladder ---------------------------------------------------------

    function test_progress_is_zero_before_the_pool_opens() public {
        AgenRuleLib.Config memory config = _flat(10_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.Time);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 10_000, sellFeePpm: 10_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 3600, buyFeePpm: 20_000, sellFeePpm: 20_000});
        harness.store(config);
        harness.recordInitTime(1000);

        // Guarded rather than relying on checked arithmetic, because the revert that would
        // produce is exactly the revert the swap path must not have.
        assertEq(harness.progressOf(500), 0);
        assertEq(harness.progressOf(1000), 0);
        assertEq(harness.progressOf(1600), 600);
    }

    function test_a_flat_market_reports_no_progress_and_stays_on_stage_zero() public {
        harness.store(_flat(10_000));
        assertEq(harness.progressOf(type(uint40).max), 0);
        assertEq(harness.activeStage(type(uint256).max), 0);
    }

    function test_volume_only_accumulates_on_a_volume_ladder() public {
        // A time-laddered or flat market pays nothing for a counter it never reads.
        harness.store(_flat(10_000));
        harness.accumulate(1e18);
        assertEq(harness.volume(), 0);
    }

    function test_volume_accumulates_and_saturates() public {
        AgenRuleLib.Config memory config = _flat(20_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.QuoteVolume);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 20_000, sellFeePpm: 20_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 100e18, buyFeePpm: 10_000, sellFeePpm: 10_000});
        harness.store(config);

        harness.accumulate(60e18);
        assertEq(harness.volume(), 60e18);
        assertEq(harness.activeStage(harness.volume()), 0);

        harness.accumulate(40e18);
        assertEq(harness.activeStage(harness.volume()), 1);

        // Saturating rather than reverting: a market whose lifetime volume exceeds 2^128
        // has stopped advancing its ladder, which is strictly better than a pool that can
        // no longer be traded.
        harness.accumulate(type(uint256).max - 1e30);
        assertEq(harness.volume(), type(uint128).max);
    }

    function testFuzz_accumulate_never_reverts(uint256 first, uint256 second) public {
        AgenRuleLib.Config memory config = _flat(20_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.QuoteVolume);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 20_000, sellFeePpm: 20_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 100e18, buyFeePpm: 10_000, sellFeePpm: 10_000});
        harness.store(config);

        harness.accumulate(first);
        harness.accumulate(second);
        assertLe(uint256(harness.volume()), uint256(type(uint128).max));
    }

    // --- arithmetic ---------------------------------------------------------

    function testFuzz_a_fee_never_exceeds_the_leg_it_comes_out_of(uint128 amount, uint24 feePpm) public pure {
        vm.assume(feePpm <= AgenRuleLib.PPM_ONE);
        assertLe(AgenRuleLib.feeOf(amount, feePpm), amount);
    }

    function testFuzz_a_fee_rounds_down(uint128 amount, uint24 feePpm) public pure {
        vm.assume(feePpm <= AgenRuleLib.PPM_ONE);
        // A fee rounding up charges a rate that was never published.
        assertLe(AgenRuleLib.feeOf(amount, feePpm) * AgenRuleLib.PPM_ONE, uint256(amount) * feePpm);
    }

    function testFuzz_shares_never_exceed_the_whole(uint128 amount) public pure {
        // Two thirds and a third, rounded down each, cannot exceed the whole.
        uint256 a = AgenRuleLib.shareOf(amount, 666_666);
        uint256 b = AgenRuleLib.shareOf(amount, 333_334);
        assertLe(a + b, amount);
    }
}
