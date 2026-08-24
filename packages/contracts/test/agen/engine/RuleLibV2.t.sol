// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";
import {AgenRuleLibV2, IAgenRuleValidatorV2} from "../../../src/agen/engine/AgenRuleLibV2.sol";
import {AgenRuleValidatorV2} from "../../../src/agen/engine/AgenRuleValidatorV2.sol";


/// @dev The library's functions are `internal` against `Stored storage`, so they need a
/// contract that actually holds one. Mirrors `RuleHarness` in `RuleLib.vectors.t.sol`.
contract RuleV2Harness {
    AgenRuleLibV2.Stored internal _rules;

    /// @dev The real validator, not a stub. `store` takes it as an argument so the checks
    /// can live on their own address without leaving the write path — see
    /// `AgenRuleValidatorV2` — and a harness that passed something else would be testing a
    /// different contract from the one a market gets.
    IAgenRuleValidatorV2 internal immutable _validator = new AgenRuleValidatorV2();

    function store(AgenRuleLibV2.Config memory config) external {
        AgenRuleLibV2.store(_rules, config, _validator);
    }

    function validate(AgenRuleLibV2.Config memory config) external view {
        _validator.validate(config);
    }

    function shareAt(uint256 index) external view returns (AgenRuleLibV2.Share memory) {
        return AgenRuleLibV2.shareAt(_rules, index);
    }

    function recordInitTime(uint40 initTime) external {
        AgenRuleLib.recordInitTime(_rules.base, initTime);
    }

    function hasWalletLimit() external view returns (bool) {
        return AgenRuleLibV2.hasWalletLimit(_rules);
    }

    function walletWindowOpen(uint256 blockTimestamp) external view returns (bool) {
        return AgenRuleLibV2.walletWindowOpen(_rules, blockTimestamp);
    }

    function boughtBy(address wallet) external view returns (uint128) {
        return AgenRuleLibV2.boughtBy(_rules, wallet);
    }

    function chargeWalletBuy(address wallet, uint256 tokens) external {
        AgenRuleLibV2.chargeWalletBuy(_rules, wallet, tokens);
    }

    /// @dev Proves the point of the embedded struct: a v1 reader, unmodified, on v2 storage.
    function feePpmFor(AgenRuleLib.Side side, uint256 tokenAmount, uint256 progress)
        external
        view
        returns (uint24)
    {
        return AgenRuleLib.feePpmFor(_rules.base, side, tokenAmount, progress);
    }

    function engineVersion() external view returns (uint8) {
        return _rules.base.engineVersion;
    }

    function ceilingFor(AgenRuleLib.Side side) external view returns (uint128) {
        return AgenRuleLib.ceilingFor(_rules.base, side);
    }

    function epochOf(uint256 timestamp) external view returns (uint256) {
        return AgenRuleLibV2.epochOf(_rules, timestamp);
    }

    function hasLargestHolder() external view returns (bool) {
        return AgenRuleLibV2.hasLargestHolder(_rules);
    }

    function hasBuyback() external view returns (bool) {
        return AgenRuleLibV2.hasBuyback(_rules);
    }
}

/// @title RuleLibV2
/// @notice Engine v2's wallet buy limit, and the parts of v1 it inherits by construction.
///
/// @dev Two properties are worth more than the rest of this file. The first is that the fee
/// path is *not* reimplemented: a v1 reader called on v2 storage returns v1's answer, which
/// is asserted rather than assumed. The second is that a v2 configuration with no wallet
/// limit still does not hash like the v1 configuration with the same economics — because it
/// is not the same market, it is the same economics under different code.
contract RuleLibV2Test is Test {
    uint128 internal constant SUPPLY = 1_000_000_000e18;
    /// @dev 2% of supply, the figure in the prompt this engine version exists for.
    uint128 internal constant TWO_PERCENT = SUPPLY / 50;

    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CREATOR = address(0xC0FFEE);

    RuleV2Harness internal harness;

    function setUp() public {
        harness = new RuleV2Harness();
    }

    // --- fixtures -----------------------------------------------------------

    function _flat(uint24 feePpm) internal pure returns (AgenRuleLibV2.Config memory config) {
        config.engineVersion = 2;
        config.referenceSupply = SUPPLY;
        config.quoteAsset = address(0);
        config.feeCurrency = uint8(AgenRuleLib.FeeCurrency.Quote);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.None);

        config.stages = new AgenRuleLib.Stage[](1);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: feePpm, sellFeePpm: feePpm});

        config.buyTiers = new AgenRuleLib.Tier[](0);
        config.sellTiers = new AgenRuleLib.Tier[](0);

        config.distribution = new AgenRuleLibV2.Share[](1);
        config.distribution[0] =
            AgenRuleLibV2.Share({kind: AgenRuleLibV2.KIND_CREATOR, recipient: address(0), sharePpm: 1_000_000});
    }

    function _limited(uint128 limit, uint32 window) internal pure returns (AgenRuleLibV2.Config memory config) {
        config = _flat(30_000);
        config.walletLimit = AgenRuleLibV2.WalletBuyLimit({maxBuyTokens: limit, windowSeconds: window});
    }

    // --- the shared half ----------------------------------------------------

    function test_refusesEngineVersionOne() public {
        AgenRuleLibV2.Config memory config = _flat(30_000);
        config.engineVersion = 1;

        vm.expectRevert(abi.encodeWithSelector(AgenRuleLibV2.InvalidEngineVersion.selector, uint8(1)));
        harness.validate(config);
    }

    /// @dev The version check runs before the shared validation, so a v1 configuration is
    /// refused for being v1 rather than for whatever else it might also be.
    function test_versionIsCheckedBeforeAnythingElse() public {
        AgenRuleLibV2.Config memory config = _flat(30_000);
        config.engineVersion = 1;
        config.referenceSupply = 0;

        vm.expectRevert(abi.encodeWithSelector(AgenRuleLibV2.InvalidEngineVersion.selector, uint8(1)));
        harness.validate(config);
    }

    /// @dev Not a cosmetic check. v2 delegates the shared half to v1's validator, so v1's
    /// rules have to still bite through it — this is the assertion that the delegation is
    /// real rather than a call whose result is discarded.
    function test_v1RulesStillApply() public {
        AgenRuleLibV2.Config memory tooExpensive = _flat(100_001);
        vm.expectRevert(
            abi.encodeWithSelector(AgenRuleLib.FeeOutOfBounds.selector, uint256(100_001), uint256(100_000))
        );
        harness.validate(tooExpensive);

        AgenRuleLibV2.Config memory shortSplit = _flat(30_000);
        shortSplit.distribution[0].sharePpm = 999_999;
        vm.expectRevert(
            abi.encodeWithSelector(AgenRuleLib.SharesDoNotTotalOne.selector, uint256(999_999), uint256(1_000_000))
        );
        harness.validate(shortSplit);
    }

    /// @dev The reason the storage struct is nested rather than copied.
    function test_feePathIsV1sOwnCode() public {
        AgenRuleLibV2.Config memory config = _limited(TWO_PERCENT, 12 hours);
        config.sellTiers = new AgenRuleLib.Tier[](1);
        config.sellTiers[0] = AgenRuleLib.Tier({thresholdTokens: SUPPLY / 100, feePpm: 100_000});
        config.feeCurrency = uint8(AgenRuleLib.FeeCurrency.Token);

        harness.store(config);

        assertEq(harness.engineVersion(), 2, "the stored version is 2");
        assertEq(harness.feePpmFor(AgenRuleLib.Side.Buy, 1e18, 0), 30_000, "base rate, through a v1 reader");
        assertEq(harness.feePpmFor(AgenRuleLib.Side.Sell, SUPPLY / 100, 0), 100_000, "the tier, through a v1 reader");
    }

    function test_hashesDifferentlyFromTheSameEconomicsOnV1() public view {
        AgenRuleLibV2.Config memory two = _flat(30_000);

        AgenRuleLib.Share[] memory shares = new AgenRuleLib.Share[](1);
        shares[0] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Creator, recipient: address(0), sharePpm: 1_000_000});

        AgenRuleLib.Config memory one = AgenRuleLib.Config({
            engineVersion: 1,
            referenceSupply: two.referenceSupply,
            quoteAsset: two.quoteAsset,
            feeCurrency: two.feeCurrency,
            ladderAxis: two.ladderAxis,
            stages: two.stages,
            buyTiers: two.buyTiers,
            sellTiers: two.sellTiers,
            distribution: shares,
            maxBuyTokens: two.maxBuyTokens,
            maxSellTokens: two.maxSellTokens
        });

        assertTrue(
            AgenRuleLibV2.hashConfig(two) != AgenRuleLib.hashConfig(one),
            "a v2 market is not a v1 market with the same numbers"
        );
    }

    function test_commitmentDomainsAreDistinct() public pure {
        bytes32 configHash = keccak256("whatever");
        address engine = address(0xE);

        assertTrue(
            AgenRuleLibV2.implementationHash(configHash, 1, engine, 2)
                != AgenRuleLib.implementationHash(configHash, 1, engine, 2),
            "a v1 commitment cannot be replayed against v2"
        );
    }

    // --- the wallet limit, validated ----------------------------------------

    function test_aWindowWithNoLimitIsRefused() public {
        AgenRuleLibV2.Config memory config = _limited(0, 12 hours);

        vm.expectRevert(abi.encodeWithSelector(AgenRuleLibV2.WalletWindowWithoutLimit.selector, uint32(12 hours)));
        harness.validate(config);
    }

    function test_aLimitAtOrAboveSupplyIsRefused() public {
        vm.expectRevert(
            abi.encodeWithSelector(AgenRuleLibV2.WalletLimitAboveSupply.selector, SUPPLY, uint256(SUPPLY))
        );
        harness.validate(_limited(SUPPLY, 12 hours));
    }

    function test_aWindowBeyondTheHorizonIsRefused() public {
        uint32 tooLong = uint32(730 days + 1);

        vm.expectRevert(
            abi.encodeWithSelector(AgenRuleLibV2.WalletWindowTooLong.selector, tooLong, uint256(730 days))
        );
        harness.validate(_limited(TWO_PERCENT, tooLong));
    }

    function test_aPermanentLimitIsExpressible() public {
        harness.store(_limited(TWO_PERCENT, 0));

        assertTrue(harness.hasWalletLimit(), "the limit is set");
        assertTrue(harness.walletWindowOpen(block.timestamp), "and it never closes");
    }

    function test_noLimitMeansTheMarketNeverAsksWhoIsTrading() public {
        harness.store(_flat(30_000));

        assertFalse(harness.hasWalletLimit(), "no limit");
        assertFalse(harness.walletWindowOpen(block.timestamp), "so no window, at any time");
        assertFalse(harness.walletWindowOpen(block.timestamp + 3650 days), "including much later");
    }

    // --- the window ---------------------------------------------------------

    function test_theWindowOpensAtLaunchAndClosesOnTime() public {
        harness.store(_limited(TWO_PERCENT, 12 hours));
        harness.recordInitTime(uint40(1_000_000));

        assertTrue(harness.walletWindowOpen(1_000_000), "open at the launch instant");
        assertTrue(harness.walletWindowOpen(1_000_000 + 12 hours - 1), "open one second before the end");
        assertFalse(harness.walletWindowOpen(1_000_000 + 12 hours), "closed exactly on time");
        assertFalse(harness.walletWindowOpen(1_000_000 + 365 days), "and stays closed");
    }

    /// @dev The safe direction. A market whose `initTime` is not yet recorded cannot be
    /// swapped, but if that ever changed, the limit applying is the failure that refuses a
    /// trade rather than the one that lets an unlimited buy through.
    function test_theWindowIsOpenBeforeTheClockStarts() public {
        harness.store(_limited(TWO_PERCENT, 12 hours));

        assertTrue(harness.walletWindowOpen(block.timestamp), "open while uninitialised");
    }

    function test_theWindowNeverRevertsForAnyTimestamp(uint256 blockTimestamp) public {
        harness.store(_limited(TWO_PERCENT, 12 hours));
        harness.recordInitTime(uint40(1_000_000));

        // The assertion is that this call returns at all: the swap path reads it.
        harness.walletWindowOpen(blockTimestamp);
    }

    // --- the limit, charged -------------------------------------------------

    function test_aWalletMayBuyUpToItsLimitAcrossSeveralTrades() public {
        harness.store(_limited(TWO_PERCENT, 12 hours));

        harness.chargeWalletBuy(ALICE, TWO_PERCENT / 2);
        assertEq(harness.boughtBy(ALICE), TWO_PERCENT / 2, "half spent");

        harness.chargeWalletBuy(ALICE, TWO_PERCENT / 2);
        assertEq(harness.boughtBy(ALICE), TWO_PERCENT, "all of it, in two trades");
    }

    function test_theTradeThatCrossesTheLimitIsRefusedWhole() public {
        harness.store(_limited(TWO_PERCENT, 12 hours));
        harness.chargeWalletBuy(ALICE, TWO_PERCENT);

        vm.expectRevert(
            abi.encodeWithSelector(
                AgenRuleLibV2.WalletBuyLimitReached.selector, ALICE, TWO_PERCENT, uint256(1), TWO_PERCENT
            )
        );
        harness.chargeWalletBuy(ALICE, 1);

        assertEq(harness.boughtBy(ALICE), TWO_PERCENT, "and nothing was recorded for it");
    }

    /// @dev Exactly at the limit is allowed; one base unit above it is not. The boundary is
    /// the whole point of a limit, so it is asserted from both sides.
    function test_theBoundaryIsInclusive() public {
        harness.store(_limited(TWO_PERCENT, 12 hours));

        harness.chargeWalletBuy(ALICE, TWO_PERCENT);
        assertEq(harness.boughtBy(ALICE), TWO_PERCENT, "exactly the limit is fine");

        vm.expectRevert();
        harness.chargeWalletBuy(BOB, uint256(TWO_PERCENT) + 1);
    }

    function test_walletsAreCountedSeparately() public {
        harness.store(_limited(TWO_PERCENT, 12 hours));

        harness.chargeWalletBuy(ALICE, TWO_PERCENT);
        harness.chargeWalletBuy(BOB, TWO_PERCENT);

        assertEq(harness.boughtBy(ALICE), TWO_PERCENT, "alice");
        assertEq(harness.boughtBy(BOB), TWO_PERCENT, "bob");
        assertEq(harness.boughtBy(CREATOR), 0, "and somebody who has not traded");
    }

    /// @dev The limitation the review card has to state. Two wallets buy twice the cap, and
    /// no on-chain rule can tell that they are one person. Asserted so that the product copy
    /// and the contract cannot drift: if this ever stops being true, this test fails and the
    /// wording has to be revisited.
    function test_theLimitIsPerWalletAndNotPerPerson() public {
        harness.store(_limited(TWO_PERCENT, 12 hours));

        harness.chargeWalletBuy(ALICE, TWO_PERCENT);
        harness.chargeWalletBuy(BOB, TWO_PERCENT);

        assertEq(
            uint256(harness.boughtBy(ALICE)) + harness.boughtBy(BOB),
            uint256(TWO_PERCENT) * 2,
            "one person with two wallets bought twice the cap"
        );
    }

    function test_chargingNeverExceedsTheLimitForAnySplit(uint128 first, uint128 second) public {
        harness.store(_limited(TWO_PERCENT, 12 hours));

        first = uint128(bound(first, 0, TWO_PERCENT));
        second = uint128(bound(second, 0, TWO_PERCENT));

        harness.chargeWalletBuy(ALICE, first);

        if (uint256(first) + second > TWO_PERCENT) {
            vm.expectRevert();
            harness.chargeWalletBuy(ALICE, second);
        } else {
            harness.chargeWalletBuy(ALICE, second);
        }

        assertLe(harness.boughtBy(ALICE), TWO_PERCENT, "the accumulator never passes the limit");
    }

    // --- writing ------------------------------------------------------------

    function test_rulesAreWrittenOnce() public {
        AgenRuleLibV2.Config memory config = _limited(TWO_PERCENT, 12 hours);
        harness.store(config);

        vm.expectRevert(AgenRuleLibV2.AlreadyConfigured.selector);
        harness.store(config);
    }

    function test_theLimitSurvivesStorage() public {
        harness.store(_limited(TWO_PERCENT, 12 hours));
        harness.recordInitTime(uint40(block.timestamp));

        assertTrue(harness.hasWalletLimit(), "set");
        assertTrue(harness.walletWindowOpen(block.timestamp), "open now");
        assertFalse(harness.walletWindowOpen(block.timestamp + 12 hours), "closed after twelve hours");
    }

    // --- the featured prompt ------------------------------------------------

    function _featured() internal pure returns (AgenRuleLibV2.Config memory config) {
        config = _limited(TWO_PERCENT, 12 hours);
        config.epochPeriodSeconds = 3600;
        config.buybackTriggerTokens = SUPPLY / 100;
        config.distribution = new AgenRuleLibV2.Share[](2);
        config.distribution[0] = AgenRuleLibV2.Share({
            kind: AgenRuleLibV2.KIND_LARGEST_HOLDER, recipient: address(0), sharePpm: 500_000
        });
        config.distribution[1] =
            AgenRuleLibV2.Share({kind: AgenRuleLibV2.KIND_BUYBACK, recipient: address(0), sharePpm: 500_000});
    }

    function test_theFeaturedPromptIsAValidMarket() public {
        harness.store(_featured());
        harness.recordInitTime(uint40(1_000_000));

        assertTrue(harness.hasWalletLimit(), "2% wallet cap");
        assertTrue(harness.hasLargestHolder(), "hourly pot");
        assertTrue(harness.hasBuyback(), "buyback trigger");
        assertEq(harness.epochOf(1_000_000), 0, "epoch 0 at launch");
        assertEq(harness.epochOf(1_000_000 + 3599), 0, "still epoch 0");
        assertEq(harness.epochOf(1_000_000 + 3600), 1, "rolls on the hour");
    }

    /// @dev v1 cannot express these roles at all, which is stronger than refusing them.
    ///
    /// `AgenRuleLib.RecipientKind` has three variants and is the type of `Share.kind`, so
    /// there is no value a v1 configuration could carry that names a largest holder or a
    /// buyback: the enum bound is enforced by the ABI decoder before any validator runs.
    /// This is what makes leaving v1's source untouched the right call — the vocabulary is
    /// widened in v2's own library, and v1 stays byte-for-byte the deployed contract.
    function test_v1CannotNameAV2Role() public pure {
        assertEq(uint256(type(AgenRuleLib.RecipientKind).max), 2, "v1 knows creator, treasury and address");
        assertEq(uint256(AgenRuleLibV2.KIND_LARGEST_HOLDER), 3, "v2 continues where v1 stops");
        assertEq(uint256(AgenRuleLibV2.KIND_BUYBACK), 4, "and the two do not overlap");
    }

    /// @dev The kinds v1 does share keep v1's values, so the encoding is the same tuple and
    /// a configuration's hash does not depend on which library named the recipient.
    function test_theRecipientBoundIsV1s() public pure {
        assertEq(AgenRuleLibV2.MAX_RECIPIENTS, AgenRuleLib.MAX_RECIPIENTS, "v2 settles what v1 settles");
    }

    function test_theSharedKindsKeepTheirValues() public pure {
        assertEq(uint256(AgenRuleLibV2.KIND_CREATOR), uint256(AgenRuleLib.RecipientKind.Creator), "creator");
        assertEq(uint256(AgenRuleLibV2.KIND_TREASURY), uint256(AgenRuleLib.RecipientKind.Treasury), "treasury");
        assertEq(uint256(AgenRuleLibV2.KIND_ADDRESS), uint256(AgenRuleLib.RecipientKind.Address), "address");
    }

    function test_refusesARecipientKindNothingDefines() public {
        AgenRuleLibV2.Config memory config = _flat(30_000);
        config.distribution[0].kind = 5;

        vm.expectRevert(abi.encodeWithSelector(AgenRuleLibV2.UnknownRecipientKind.selector, uint256(0), uint8(5)));
        harness.validate(config);
    }

    function test_refusesAnEpochPeriodNoHolderAsksFor() public {
        AgenRuleLibV2.Config memory config = _flat(30_000);
        config.epochPeriodSeconds = 3600;

        vm.expectRevert(AgenRuleLibV2.EpochPeriodWithoutHolder.selector);
        harness.validate(config);
    }

    function test_refusesABuybackTriggerNoBuybackAsksFor() public {
        AgenRuleLibV2.Config memory config = _flat(30_000);
        config.buybackTriggerTokens = SUPPLY / 100;

        vm.expectRevert(AgenRuleLibV2.BuybackTriggerWithoutShare.selector);
        harness.validate(config);
    }

    function test_refusesALargestHolderWithNoPeriod() public {
        AgenRuleLibV2.Config memory config = _featured();
        config.epochPeriodSeconds = 0;

        vm.expectRevert(
            abi.encodeWithSelector(
                AgenRuleLibV2.EpochPeriodOutOfBounds.selector, uint32(0), uint256(60), uint256(730 days)
            )
        );
        harness.validate(config);
    }

    function test_refusesABuybackWithNoTrigger() public {
        AgenRuleLibV2.Config memory config = _featured();
        config.buybackTriggerTokens = 0;

        vm.expectRevert(AgenRuleLibV2.BuybackShareWithoutTrigger.selector);
        harness.validate(config);
    }
}
