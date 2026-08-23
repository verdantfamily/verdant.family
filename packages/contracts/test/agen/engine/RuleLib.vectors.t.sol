// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";

/// @dev Exposes the library's internal functions and gives it real storage to read from.
/// The evaluation path is `internal view` against `Stored storage`, so it cannot be
/// exercised from a `pure` test helper — it needs a contract that actually holds one.
contract RuleHarness {
    using AgenRuleLib for AgenRuleLib.Stored;

    AgenRuleLib.Stored internal _rules;

    function store(AgenRuleLib.Config memory config) external {
        AgenRuleLib.store(_rules, config);
    }

    function recordInitTime(uint40 initTime) external {
        AgenRuleLib.recordInitTime(_rules, initTime);
    }

    function setVolume(uint128 volume) external {
        _rules.cumulativeQuoteVolume = volume;
    }

    function feePpmFor(AgenRuleLib.Side side, uint256 tokenAmount, uint256 progress)
        external
        view
        returns (uint24)
    {
        return AgenRuleLib.feePpmFor(_rules, side, tokenAmount, progress);
    }

    function activeStage(uint256 progress) external view returns (uint256) {
        return AgenRuleLib.activeStage(_rules, progress);
    }

    function ceilingFor(AgenRuleLib.Side side) external view returns (uint128) {
        return AgenRuleLib.ceilingFor(_rules, side);
    }

    function progressOf(uint256 blockTimestamp) external view returns (uint256) {
        return AgenRuleLib.progressOf(_rules, blockTimestamp);
    }

    function accumulate(uint256 quoteAmount) external {
        AgenRuleLib.accumulate(_rules, quoteAmount);
    }

    function cumulativeQuoteVolume() external view returns (uint128) {
        return _rules.cumulativeQuoteVolume;
    }

    function feeCurrency() external view returns (AgenRuleLib.FeeCurrency) {
        return _rules.feeCurrency;
    }

    function counts() external view returns (uint8, uint8, uint8, uint8) {
        return (_rules.stageCount, _rules.buyTierCount, _rules.sellTierCount, _rules.shareCount);
    }

    /// @dev The whole distribution, so the split can be checked against the vectors.
    function payouts(uint256 feeAmount) external view returns (uint256[] memory amounts) {
        uint256 count = _rules.shareCount;
        amounts = new uint256[](count);

        uint256 paid;
        for (uint256 i = 0; i < count; i++) {
            amounts[i] = AgenRuleLib.shareOf(feeAmount, _rules.distribution[i].sharePpm);
            paid += amounts[i];
        }

        // The remainder the roundings leave goes to the first recipient in canonical order,
        // which is what makes the payouts sum to the fee exactly. Mirrors `distribute` in
        // evaluate.ts.
        if (count > 0 && feeAmount > paid) amounts[0] += feeAmount - paid;
    }

    function validate(AgenRuleLib.Config memory config) external pure {
        AgenRuleLib.validate(config);
    }

    function hashConfig(AgenRuleLib.Config memory config) external pure returns (bytes32) {
        return AgenRuleLib.hashConfig(config);
    }
}

/// @title RuleLib.vectors
/// @notice Holds `AgenRuleLib.sol` to `packages/market-engine/src/evaluate.ts`.
///
/// @dev The TypeScript is authoritative: it is what the review screen shows, what the
/// simulator runs, and what a creator's signature commits to. This suite asserts the
/// Solidity reaches the same answer for every configuration and every swap the generator
/// emits, including the boundary triple around every threshold in every one of them.
///
/// Each vector's configuration arrives **ABI-encoded**, so a passing run also proves that
/// `encode.ts` and `abi.encode` produce identical bytes. That is not incidental — it is what
/// makes `implementationHash` something a verifier can recompute on chain from the
/// configuration the market is actually running.
contract RuleLibVectorsTest is Test {
    using stdJson for string;

    uint256 internal _vectorCount;
    uint256 internal _chainId;
    address internal _engine;
    uint256 internal _engineVersion;

    function setUp() public {
        string memory index = vm.readFile("../market-engine/vectors/index.json");
        assertEq(index.readUint(".version"), 1, "the vector format changed");
        _vectorCount = index.readUint(".count");
        assertGt(_vectorCount, 0, "no vectors were loaded");

        _chainId = index.readUint(".chainId");
        _engine = index.readAddress(".engine");
        _engineVersion = index.readUint(".engineVersion");
    }

    /// @notice The domain separator is the same string on both sides.
    function test_the_commitment_domain_matches_the_typescript() public pure {
        assertEq(
            AgenRuleLib.CONFIG_V1_DOMAIN,
            keccak256("agen.engine.config.v1"),
            "the domain separator drifted"
        );
    }

    /// @dev One configuration's file. Read fresh per vector rather than held, because
    /// Foundry re-parses the whole document on every path read and holding the lot in
    /// memory is what exhausted it before.
    function _read(uint256 index) private view returns (string memory) {
        return vm.readFile(
            string.concat("../market-engine/vectors/", index < 10 ? "0" : "", vm.toString(index), ".json")
        );
    }

    /// @notice Every vector decodes, stores, and evaluates exactly as the TypeScript did.
    function test_vectors_agree_with_the_typescript_evaluator() public {
        uint256 totalCases;

        for (uint256 v = 0; v < _vectorCount; v++) {
            totalCases += _checkVector(_read(v));
        }

        assertGt(totalCases, 500, "the vector set shrank unexpectedly");
    }

    function _checkVector(string memory json) private returns (uint256) {
        string memory name = json.readString(".name");
        bytes memory encoded = json.readBytes(".encoded");

        // Parity, proven rather than assumed: the bytes viem produced decode into this
        // struct. A field reordered on either side fails here, which is what makes
        // `implementationHash` something a verifier can recompute on chain.
        AgenRuleLib.Config memory config = abi.decode(encoded, (AgenRuleLib.Config));

        bytes32 expected = json.readBytes32(".configHash");
        assertEq(keccak256(encoded), expected, string.concat(name, ": configHash does not match the encoded bytes"));

        RuleHarness harness = new RuleHarness();

        /*
         * Encoding parity, in the direction that matters.
         *
         * The assertion above only says viem's bytes hash to viem's hash, which is
         * tautological. This one re-encodes the *decoded struct* through Solidity's own
         * `abi.encode` and requires the same hash — which is the property the hook depends
         * on when it computes a configuration's identity itself rather than being told it.
         *
         * If these two encodings ever diverge, every commitment issued by the TypeScript
         * becomes unverifiable on chain, silently. So it is checked on all 17 vectors.
         */
        assertEq(
            harness.hashConfig(config),
            expected,
            string.concat(name, ": abi.encode and encodeConfig produce different bytes")
        );

        /*
         * And the commitment built on top of it.
         *
         * This is the value a creator signs and the registry stores, so the two languages
         * agreeing on it is what makes an approval verifiable from the chain alone. Asserted
         * per vector rather than once, because the preimage contains the config hash and a
         * bug in either could be configuration-shaped.
         */
        assertEq(
            AgenRuleLib.implementationHash(expected, _chainId, _engine, _engineVersion),
            json.readBytes32(".implementationHash"),
            string.concat(name, ": implementationHash disagrees with the TypeScript")
        );

        harness.store(config);

        (uint8 stageCount, uint8 buyTiers, uint8 sellTiers, uint8 shares) = harness.counts();
        assertEq(stageCount, json.readUint(".stageCount"), string.concat(name, ": stages"));
        assertEq(buyTiers, json.readUint(".buyTierCount"), string.concat(name, ": buy tiers"));
        assertEq(sellTiers, json.readUint(".sellTierCount"), string.concat(name, ": sell tiers"));
        assertEq(shares, json.readUint(".shareCount"), string.concat(name, ": recipients"));
        assertEq(uint8(harness.feeCurrency()), json.readUint(".feeCurrency"), string.concat(name, ": fee currency"));

        return _checkCases(harness, json, name);
    }

    /// @dev One configuration's cases, read as parallel arrays.
    ///
    /// Read in bulk rather than one path at a time. Foundry's JSON reader resolves a single
    /// path per call and allocates a fresh path string for each, so the first version of
    /// this — 554 cases times six fields — ran the test out of memory before it could
    /// assert anything.
    struct Cases {
        uint256[] sides;
        uint256[] tokenAmounts;
        uint256[] quoteAmounts;
        uint256[] progresses;
        uint256[] expectedFeePpms;
        uint256[] expectedFeeAmounts;
        bool[] expectedBlocked;
        /// @dev Flattened with a stride of `shareCount`.
        uint256[] expectedPayouts;
        uint256 shareCount;
    }

    function _checkCases(RuleHarness harness, string memory json, string memory name)
        private
        view
        returns (uint256 count)
    {
        Cases memory cases = Cases({
            sides: json.readUintArray(".sides"),
            tokenAmounts: json.readUintArray(".tokenAmounts"),
            quoteAmounts: json.readUintArray(".quoteAmounts"),
            progresses: json.readUintArray(".progresses"),
            expectedFeePpms: json.readUintArray(".expectedFeePpms"),
            expectedFeeAmounts: json.readUintArray(".expectedFeeAmounts"),
            expectedBlocked: json.readBoolArray(".expectedBlocked"),
            expectedPayouts: json.readUintArray(".expectedPayouts"),
            shareCount: json.readUint(".shareCount")
        });

        count = json.readUint(".caseCount");
        assertEq(cases.sides.length, count, string.concat(name, ": case arrays disagree with caseCount"));

        bool quoteDenominated = harness.feeCurrency() == AgenRuleLib.FeeCurrency.Quote;

        for (uint256 c = 0; c < count; c++) {
            _checkCase(harness, cases, c, quoteDenominated, name);
        }
    }

    function _checkCase(
        RuleHarness harness,
        Cases memory cases,
        uint256 c,
        bool quoteDenominated,
        string memory name
    ) private view {
        AgenRuleLib.Side side = AgenRuleLib.Side(cases.sides[c]);
        uint256 tokenAmount = cases.tokenAmounts[c];

        uint24 feePpm = harness.feePpmFor(side, tokenAmount, cases.progresses[c]);
        assertEq(uint256(feePpm), cases.expectedFeePpms[c], string.concat(name, ": rate"));

        // The fee comes out of whichever leg the configuration names, which is the
        // constraint that made `feeCurrency` a derived field. See orientation.ts.
        uint256 feeAmount = AgenRuleLib.feeOf(quoteDenominated ? cases.quoteAmounts[c] : tokenAmount, feePpm);
        assertEq(feeAmount, cases.expectedFeeAmounts[c], string.concat(name, ": fee amount"));

        uint128 ceiling = harness.ceilingFor(side);
        assertEq(ceiling != 0 && tokenAmount > ceiling, cases.expectedBlocked[c], string.concat(name, ": ceiling"));

        uint256[] memory actual = harness.payouts(feeAmount);
        assertEq(actual.length, cases.shareCount, string.concat(name, ": recipient count"));

        uint256 paid;
        for (uint256 p = 0; p < cases.shareCount; p++) {
            assertEq(actual[p], cases.expectedPayouts[c * cases.shareCount + p], string.concat(name, ": payout"));
            paid += actual[p];
        }

        // The property a splitter must have, asserted on every case rather than argued for
        // once: the payouts sum to the fee exactly.
        if (cases.shareCount > 0) {
            assertEq(paid, feeAmount, string.concat(name, ": payouts do not sum to the fee"));
        }
    }
}
