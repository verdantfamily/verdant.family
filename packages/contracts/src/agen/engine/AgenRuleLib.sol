// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AgenRuleLib
/// @notice Validation, storage and swap-path evaluation of an Agen programmable market's
/// rules.
///
/// @dev The Solidity twin of `packages/market-engine/src/evaluate.ts`. The TypeScript is
/// authoritative — it is what the review screen, the simulator and the creator's approval
/// are computed from — and `RuleLib.vectors.t.sol` holds this file to it over randomised
/// configurations and swaps. Where the two disagree, this one is wrong by definition.
///
/// Built on `ScheduleLib`'s philosophy rather than its encoding: validate at write time so
/// nothing invalid can reach storage, and make the read path total so it cannot revert for
/// any input. A schedule that could revert in `beforeSwap` is a market that cannot be
/// traded, which is worse than any fee it might have returned.
///
/// ## Why this is a struct in storage rather than two packed words
///
/// `ScheduleLib` fits eight stages into two words because a stage is 48 bits. An engine
/// configuration is a stage ladder *and* two tier ladders *and* a distribution, and packing
/// all of it would need shift arithmetic across a dozen fields for the sake of SLOADs on a
/// path that already has to do a `mint` and a settlement. The fields are therefore declared
/// at the widths they need and left to the compiler to pack, which it does tightly enough
/// that a stage, a tier and a share are each one slot.
///
/// What is preserved from `ScheduleLib` is the part that matters: bounded arrays, a
/// validated write, and a read that has no failure mode.
///
/// ## Rounding
///
/// Every fee and every share rounds **down**, stated here once. A fee rounding up charges a
/// rate that was never published. A share rounding up pays out more than was collected,
/// which is the one arithmetic mistake a splitter must be unable to make. The remainder the
/// roundings leave over goes to the first recipient in canonical order — at most
/// `recipients - 1` base units, so at four recipients the favoured party gains at most three.
library AgenRuleLib {
    // --- bounds -------------------------------------------------------------
    // Mirrored in packages/market-engine/src/bounds.ts and asserted equal by
    // RuleLib.vectors.t.sol. These two copies must never disagree.

    uint256 internal constant MAX_STAGES = 8;
    uint256 internal constant MAX_TIERS_PER_SIDE = 4;
    uint256 internal constant MAX_RECIPIENTS = 4;

    /// @notice The engine's fee ceiling, in ppm. 100_000 is 10%.
    /// @dev Matches `MAX_FEE_PPM` in the TypeScript. Nothing clamps to it; a configuration
    /// above it is refused at registration.
    uint256 internal constant MAX_FEE_PPM = 100_000;

    /// @notice One whole, in ppm. Shares must total exactly this.
    uint256 internal constant PPM_ONE = 1_000_000;

    uint256 internal constant MIN_TIME_STAGE_GAP = 300;
    uint256 internal constant MAX_TIME_HORIZON = 730 days;

    // --- enums --------------------------------------------------------------
    // The discriminant values are part of the ABI encoding the commitment hash is
    // computed over, so their order is fixed by `encode.ts` and may never be reordered.

    /// @notice Which axis the stage ladder advances along.
    enum LadderAxis {
        None,
        Time,
        QuoteVolume
    }

    /// @notice Which leg the fee comes out of.
    /// @dev Derived by the compiler, never chosen. A market with size tiers collects in the
    /// launched token, because a tier is measured on the token leg and a fee can only be
    /// taken in the callback that settles its currency — so for a tier to apply to all four
    /// swap shapes, the fee and the tier must read the same leg. See
    /// `packages/market-engine/src/orientation.ts`.
    enum FeeCurrency {
        Quote,
        Token
    }

    /// @notice Who receives a share of the collected fee.
    /// @dev Closed, and none of these carries calldata, a call target or a selector. The
    /// engine credits a recipient and never calls into it, so a recipient cannot reenter,
    /// revert a swap, or consume unbounded gas.
    enum RecipientKind {
        Creator,
        Treasury,
        Address
    }

    /// @notice Which direction a trade goes, by what the trader does with the token.
    enum Side {
        Buy,
        Sell
    }

    // --- types --------------------------------------------------------------

    /// @notice One step of the ladder. Stage 0 has threshold 0 and is the base rate.
    struct Stage {
        /// Seconds since initialisation on `Time`, quote base units on `QuoteVolume`.
        uint128 threshold;
        uint24 buyFeePpm;
        uint24 sellFeePpm;
    }

    /// @notice A size-gated rate. The comparison is always `>=`.
    /// @dev The compiler folds `>` into `>= threshold + 1`, which is exact over integers.
    /// There is no operator here because there is only one.
    struct Tier {
        uint128 thresholdTokens;
        uint24 feePpm;
    }

    /// @notice One leg of the split.
    struct Share {
        RecipientKind kind;
        /// The zero address for `Creator` and `Treasury`, which the vault resolves.
        address recipient;
        uint24 sharePpm;
    }

    /// @notice A market's rules, as they arrive at registration.
    /// @dev Field order matches the tuple in `packages/market-engine/src/encode.ts` exactly,
    /// so `abi.encode` of this struct is the preimage the commitment hash is taken over.
    /// A field added to one and not the other is a failing vector rather than a hash that
    /// quietly stops matching.
    struct Config {
        uint8 engineVersion;
        uint256 referenceSupply;
        address quoteAsset;
        uint8 feeCurrency;
        uint8 ladderAxis;
        Stage[] stages;
        Tier[] buyTiers;
        Tier[] sellTiers;
        Share[] distribution;
        uint256 maxBuyTokens;
        uint256 maxSellTokens;
    }

    /// @notice A market's rules in storage, plus the state the ladder needs.
    struct Stored {
        // --- written once at registration ---
        uint8 engineVersion;
        FeeCurrency feeCurrency;
        LadderAxis ladderAxis;
        uint8 stageCount;
        uint8 buyTierCount;
        uint8 sellTierCount;
        uint8 shareCount;
        /// @dev Set in `afterInitialize`. Every time threshold is measured from it.
        uint40 initTime;
        bool configured;
        uint128 referenceSupply;
        uint128 maxBuyTokens;
        uint128 maxSellTokens;
        Stage[MAX_STAGES] stages;
        Tier[MAX_TIERS_PER_SIDE] buyTiers;
        Tier[MAX_TIERS_PER_SIDE] sellTiers;
        Share[MAX_RECIPIENTS] distribution;
        // --- written on the swap path, and only on a volume ladder ---
        /// @dev Quote volume accumulated by earlier trades. A trade never advances its own
        /// stage: counting it would make its fee depend on its own size, and would charge a
        /// rate no prior trade could have predicted.
        uint128 cumulativeQuoteVolume;
    }

    // --- errors -------------------------------------------------------------
    // Typed and specific, for the same reason `ScheduleLib`'s are: a creator whose market
    // is refused is entitled to know which rule it broke and with which value.

    error InvalidEngineVersion(uint8 provided);
    error InvalidStageCount(uint256 provided, uint256 max);
    error InvalidTierCount(uint256 provided, uint256 max);
    error InvalidRecipientCount(uint256 provided, uint256 max);
    error FirstStageThresholdNonZero(uint128 provided);
    error StagesNotIncreasing(uint256 index, uint128 previous, uint128 threshold);
    error StageGapTooSmall(uint256 index, uint256 gap, uint256 minimum);
    error StageHorizonExceeded(uint256 index, uint128 threshold, uint256 max);
    error FeeOutOfBounds(uint256 feePpm, uint256 max);
    error TiersNotIncreasing(uint256 index, uint128 previous, uint128 threshold);
    error ZeroTierThreshold(uint256 index);
    error TierAboveSupply(uint256 index, uint128 threshold, uint256 referenceSupply);
    error TierAboveCeiling(uint256 index, uint128 threshold, uint128 ceiling);
    error SharesDoNotTotalOne(uint256 total, uint256 expected);
    error ZeroShare(uint256 index);
    error ZeroRecipient(uint256 index);
    error RecipientNotZeroForRole(uint256 index);
    error ZeroReferenceSupply();
    error ReferenceSupplyTooLarge(uint256 provided);
    error LadderAxisWithoutStages(uint8 axis);
    error StagesWithoutLadderAxis(uint256 stageCount);
    error AmountTooLarge(uint256 provided);
    error AlreadyConfigured();

    // --- identity -----------------------------------------------------------

    /// @notice The canonical hash of a configuration.
    ///
    /// @dev **The only definition of a configuration's identity on chain.** Nothing may
    /// accept a hash as an independent input and store it as though it described the
    /// configuration beside it: the invariant is
    ///
    ///   stored configuration -> canonical encoding -> configHash
    ///
    /// and not "the caller claims hash X describes config Y". A hash that can disagree with
    /// the bytes it names is not an identity, it is an assertion — and the one place a
    /// verifier would never think to check.
    ///
    /// `abi.encode` of this struct is byte-identical to `encodeConfig` in
    /// `packages/market-engine/src/encode.ts`, which encodes the same fields as a single
    /// dynamic tuple. That is asserted, not assumed: `RuleLib.vectors.t.sol` re-encodes
    /// every vector through this function and requires the result to equal the hash the
    /// TypeScript produced. A field added on one side and not the other fails there.
    function hashConfig(Config memory config) internal pure returns (bytes32) {
        return keccak256(abi.encode(config));
    }

    /// @notice The domain engine-v1 commitments live in.
    /// @dev `keccak256("agen.engine.config.v1")`, mirroring
    /// `AGEN_ENGINE_CONFIG_V1_DOMAIN` in `packages/market-engine/src/encode.ts`. Asserted
    /// equal by golden vector.
    bytes32 internal constant CONFIG_V1_DOMAIN = keccak256("agen.engine.config.v1");

    /// @notice The commitment a creator signs, recomputed on chain.
    ///
    /// @dev The Solidity twin of `implementationHash` in the market engine, and the reason
    /// the factory does not need its own hashing implementation. It occupies the same
    /// registry field that engine-0 markets use for the hash of their generated Solidity, so
    /// the domain separator and the explicit `engineVersion` are what stop a verifier
    /// checking an engine-1 commitment against an engine-0 preimage and finding it matches.
    ///
    /// `engine` is bound in because the engine is the code that decides what a
    /// configuration *means*: the same economics pointed at a different hook is a different
    /// promise. `chainId` because a market approved on one chain was not approved on another.
    function implementationHash(bytes32 configHash_, uint256 chainId, address engine, uint256 engineVersion)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(CONFIG_V1_DOMAIN, chainId, engine, engineVersion, configHash_));
    }

    // --- validation ---------------------------------------------------------

    /// @notice Reverts unless `config` is a market this library will evaluate.
    ///
    /// @dev Ordered from the most structural to the most local, so the error a creator sees
    /// is the one they have to fix first. Every check here has a counterpart in
    /// `packages/market-engine/src/compile.ts`; this is the second of the two, and it is the
    /// one that runs on chain where nothing above it can be trusted.
    ///
    /// The duplicate is deliberate. The TypeScript refuses a bad configuration before a
    /// creator ever signs; this refuses one that reached the chain by any other route.
    function validate(Config memory config) internal pure {
        if (config.engineVersion != 1) revert InvalidEngineVersion(config.engineVersion);

        if (config.referenceSupply == 0) revert ZeroReferenceSupply();
        if (config.referenceSupply > type(uint128).max) revert ReferenceSupplyTooLarge(config.referenceSupply);
        if (config.maxBuyTokens > type(uint128).max) revert AmountTooLarge(config.maxBuyTokens);
        if (config.maxSellTokens > type(uint128).max) revert AmountTooLarge(config.maxSellTokens);

        uint256 stages = config.stages.length;
        if (stages == 0 || stages > MAX_STAGES) revert InvalidStageCount(stages, MAX_STAGES);
        if (config.buyTiers.length > MAX_TIERS_PER_SIDE) {
            revert InvalidTierCount(config.buyTiers.length, MAX_TIERS_PER_SIDE);
        }
        if (config.sellTiers.length > MAX_TIERS_PER_SIDE) {
            revert InvalidTierCount(config.sellTiers.length, MAX_TIERS_PER_SIDE);
        }
        if (config.distribution.length > MAX_RECIPIENTS) {
            revert InvalidRecipientCount(config.distribution.length, MAX_RECIPIENTS);
        }

        // A ladder axis with one stage claims a progression that does not exist, and more
        // than one stage with no axis has no way to decide which is active. Either is a
        // configuration whose meaning depends on a field the other half contradicts.
        LadderAxis axis = LadderAxis(config.ladderAxis);
        if (axis == LadderAxis.None && stages > 1) revert StagesWithoutLadderAxis(stages);
        if (axis != LadderAxis.None && stages == 1) revert LadderAxisWithoutStages(config.ladderAxis);

        if (config.stages[0].threshold != 0) revert FirstStageThresholdNonZero(config.stages[0].threshold);

        for (uint256 i = 0; i < stages; i++) {
            Stage memory stage = config.stages[i];
            _requireFee(stage.buyFeePpm);
            _requireFee(stage.sellFeePpm);

            if (i > 0) {
                uint128 previous = config.stages[i - 1].threshold;
                if (stage.threshold <= previous) revert StagesNotIncreasing(i, previous, stage.threshold);

                if (axis == LadderAxis.Time) {
                    uint256 gap = stage.threshold - previous;
                    if (gap < MIN_TIME_STAGE_GAP) revert StageGapTooSmall(i, gap, MIN_TIME_STAGE_GAP);
                    if (stage.threshold > MAX_TIME_HORIZON) {
                        revert StageHorizonExceeded(i, stage.threshold, MAX_TIME_HORIZON);
                    }
                }
            }
        }

        // forge-lint: disable-next-line(unsafe-typecast) -- bounded above
        _validateTiers(config.buyTiers, uint128(config.referenceSupply), uint128(config.maxBuyTokens));
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded above
        _validateTiers(config.sellTiers, uint128(config.referenceSupply), uint128(config.maxSellTokens));

        _validateDistribution(config.distribution);
    }

    function _requireFee(uint24 feePpm) private pure {
        if (feePpm > MAX_FEE_PPM) revert FeeOutOfBounds(feePpm, MAX_FEE_PPM);
    }

    /// @dev Ascending, non-zero, reachable. "Reachable" is two checks: a threshold above
    /// the whole supply is a rule no trade could ever trigger, and one above its own side's
    /// ceiling is a rule the market's other rule has made unreachable — in both cases one of
    /// the two statements is not what was meant.
    function _validateTiers(Tier[] memory tiers, uint128 referenceSupply, uint128 ceiling) private pure {
        for (uint256 i = 0; i < tiers.length; i++) {
            Tier memory tier = tiers[i];
            _requireFee(tier.feePpm);

            if (tier.thresholdTokens == 0) revert ZeroTierThreshold(i);
            if (tier.thresholdTokens > referenceSupply) {
                revert TierAboveSupply(i, tier.thresholdTokens, referenceSupply);
            }
            if (ceiling != 0 && tier.thresholdTokens > ceiling) {
                revert TierAboveCeiling(i, tier.thresholdTokens, ceiling);
            }
            if (i > 0) {
                uint128 previous = tiers[i - 1].thresholdTokens;
                // Strictly increasing, so "the highest matching tier" is a total function
                // and does not depend on the order the caller supplied.
                if (tier.thresholdTokens <= previous) revert TiersNotIncreasing(i, previous, tier.thresholdTokens);
            }
        }
    }

    /// @dev Exactly one whole, or nothing at all. 99% is a percent of every fee the market
    /// will ever collect going nowhere; 101% is a splitter that cannot pay what it promised.
    function _validateDistribution(Share[] memory shares) private pure {
        if (shares.length == 0) return;

        uint256 total;
        for (uint256 i = 0; i < shares.length; i++) {
            Share memory share = shares[i];
            if (share.sharePpm == 0) revert ZeroShare(i);

            if (share.kind == RecipientKind.Address) {
                if (share.recipient == address(0)) revert ZeroRecipient(i);
            } else if (share.recipient != address(0)) {
                // A role's address is resolved by the vault, so carrying one here would be
                // a second answer to who the creator is — and the two could disagree.
                revert RecipientNotZeroForRole(i);
            }

            total += share.sharePpm;
        }

        if (total != PPM_ONE) revert SharesDoNotTotalOne(total, PPM_ONE);
    }

    // --- writing ------------------------------------------------------------

    /// @notice Validate and write a market's rules. Once per market, ever.
    ///
    /// @dev `configured` is a distinct flag rather than an inference from some field being
    /// non-zero, because a market may legitimately charge nothing, have no tiers and have no
    /// distribution — a configuration of all zeros is a real market, and "is this slot
    /// empty" cannot tell it apart from an unconfigured one.
    function store(Stored storage stored, Config memory config) internal {
        if (stored.configured) revert AlreadyConfigured();
        validate(config);

        stored.engineVersion = config.engineVersion;
        stored.feeCurrency = FeeCurrency(config.feeCurrency);
        stored.ladderAxis = LadderAxis(config.ladderAxis);
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        stored.referenceSupply = uint128(config.referenceSupply);
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        stored.maxBuyTokens = uint128(config.maxBuyTokens);
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        stored.maxSellTokens = uint128(config.maxSellTokens);

        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        stored.stageCount = uint8(config.stages.length);
        for (uint256 i = 0; i < config.stages.length; i++) {
            stored.stages[i] = config.stages[i];
        }

        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        stored.buyTierCount = uint8(config.buyTiers.length);
        for (uint256 i = 0; i < config.buyTiers.length; i++) {
            stored.buyTiers[i] = config.buyTiers[i];
        }

        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        stored.sellTierCount = uint8(config.sellTiers.length);
        for (uint256 i = 0; i < config.sellTiers.length; i++) {
            stored.sellTiers[i] = config.sellTiers[i];
        }

        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        stored.shareCount = uint8(config.distribution.length);
        for (uint256 i = 0; i < config.distribution.length; i++) {
            stored.distribution[i] = config.distribution[i];
        }

        stored.configured = true;
    }

    /// @notice Record the pool's initialisation time. One-shot.
    /// @dev Every time threshold is measured from this, so moving it would silently
    /// reschedule every transition of a live market. Separate from `store` for the reason
    /// `ScheduleLib.recordInitTime` is: the pool does not exist when its rules are written.
    function recordInitTime(Stored storage stored, uint40 initTime) internal {
        if (stored.initTime != 0) revert AlreadyConfigured();
        stored.initTime = initTime;
    }

    // --- reading ------------------------------------------------------------

    /// @notice The index of the active stage at this point in the ladder.
    ///
    /// @dev Scans backwards and returns the first stage whose threshold has been passed,
    /// which is the last one in ascending order that qualifies. Stage 0's threshold is 0 and
    /// always qualifies, so this is total: there is no input for which no stage is active.
    ///
    /// Backwards because in the common case — a market past its final transition — that
    /// returns on the first comparison.
    function activeStage(Stored storage stored, uint256 progress) internal view returns (uint256) {
        uint256 count = stored.stageCount;
        for (uint256 i = count; i > 1; i--) {
            if (progress >= stored.stages[i - 1].threshold) return i - 1;
        }
        return 0;
    }

    /// @notice How far along the ladder this market is, in its own axis's units.
    /// @dev Zero for a market with no ladder, which makes stage 0 the answer without the
    /// caller needing to branch.
    function progressOf(Stored storage stored, uint256 blockTimestamp) internal view returns (uint256) {
        LadderAxis axis = stored.ladderAxis;
        if (axis == LadderAxis.Time) {
            uint256 initTime = stored.initTime;
            // Guarded rather than relying on checked arithmetic, because the revert this
            // would produce is exactly the revert the swap path must not have.
            return blockTimestamp > initTime ? blockTimestamp - initTime : 0;
        }
        if (axis == LadderAxis.QuoteVolume) return stored.cumulativeQuoteVolume;
        return 0;
    }

    /// @notice The rate this trade pays, in ppm.
    ///
    /// @dev **The swap-path function. Never reverts for any input.**
    ///
    /// Precedence, and there is no other:
    ///   1. the active stage sets the rate for this side;
    ///   2. the highest matching size tier for this side replaces it;
    ///   3. nothing is ever added to anything.
    ///
    /// "Highest matching" is well defined because `validate` refuses tiers that are not
    /// strictly increasing, so the result does not depend on the order they were supplied
    /// in — which is the property that makes a model's arbitrary ordering harmless.
    function feePpmFor(Stored storage stored, Side side, uint256 tokenAmount, uint256 progress)
        internal
        view
        returns (uint24)
    {
        uint256 index = activeStage(stored, progress);
        Stage storage stage = stored.stages[index];
        uint24 fee = side == Side.Buy ? stage.buyFeePpm : stage.sellFeePpm;

        uint256 count = side == Side.Buy ? stored.buyTierCount : stored.sellTierCount;
        for (uint256 i = count; i > 0; i--) {
            Tier storage tier = side == Side.Buy ? stored.buyTiers[i - 1] : stored.sellTiers[i - 1];
            if (tokenAmount >= tier.thresholdTokens) return tier.feePpm;
        }

        return fee;
    }

    /// @notice This side's trade ceiling in tokens, or zero for none.
    function ceilingFor(Stored storage stored, Side side) internal view returns (uint128) {
        return side == Side.Buy ? stored.maxBuyTokens : stored.maxSellTokens;
    }

    /// @notice Whether this side has any size-gated rate.
    /// @dev Read by the hook to decide whether it needs the token leg at all.
    function hasTiers(Stored storage stored, Side side) internal view returns (bool) {
        return (side == Side.Buy ? stored.buyTierCount : stored.sellTierCount) > 0;
    }

    /// @notice A fee taken out of an amount, rounding down.
    function feeOf(uint256 amount, uint24 feePpm) internal pure returns (uint256) {
        return (amount * feePpm) / PPM_ONE;
    }

    /// @notice A share of an amount, rounding down.
    function shareOf(uint256 amount, uint24 sharePpm) internal pure returns (uint256) {
        return (amount * sharePpm) / PPM_ONE;
    }

    /// @notice Add this trade's quote leg to the running total, if the ladder needs it.
    ///
    /// @dev Only written on a `QuoteVolume` market, so a time-laddered or flat market pays
    /// nothing for a counter it never reads. Saturating rather than reverting: a market whose
    /// lifetime volume exceeds 2^128 base units has stopped advancing its ladder, which is
    /// a strictly better failure than a pool that can no longer be traded.
    /// @dev The addition is `unchecked` and the overflow is detected by comparison rather
    /// than left to Solidity's checked arithmetic. That is the whole point: a checked add
    /// reverts, and this sits on the swap path where a revert is a pool that cannot be
    /// traded. A caller passing an amount near `type(uint256).max` is not reachable through
    /// v4 — a swap leg is bounded by `int128` — but "never reverts" is a guarantee this
    /// library makes about its own inputs rather than about its callers' good behaviour, and
    /// a fuzz run found this before a caller could.
    function accumulate(Stored storage stored, uint256 quoteAmount) internal {
        if (stored.ladderAxis != LadderAxis.QuoteVolume) return;

        uint256 current = stored.cumulativeQuoteVolume;
        uint256 total;
        unchecked {
            total = current + quoteAmount;
        }

        // Wrapped, or past the field: either way the ladder has stopped advancing, which is
        // strictly better than a market that can no longer be traded.
        if (total < current || total > type(uint128).max) {
            stored.cumulativeQuoteVolume = type(uint128).max;
            return;
        }

        // forge-lint: disable-next-line(unsafe-typecast) -- bounded immediately above
        stored.cumulativeQuoteVolume = uint128(total);
    }
}
