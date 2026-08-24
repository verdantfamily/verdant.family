// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgenRuleLib} from "./AgenRuleLib.sol";

/// @title AgenRuleLibV2
/// @notice Engine v2's rules: everything v1 evaluates, plus a per-wallet buy limit that
/// applies for a window after launch.
///
/// @dev The Solidity twin of the engine-v2 half of `packages/market-engine`. Same contract
/// with the reader as `AgenRuleLib`: the TypeScript is authoritative, and a vector test holds
/// this file to it.
///
/// ## Why a second library rather than an edit
///
/// `AgenRuleLib` is deployed, verified and inside the commitment of every live engine-v1
/// market. Its `Config` struct *is* the preimage those markets' `configHash` was taken over,
/// so adding a field to it would not extend v1 — it would silently invalidate every
/// commitment already signed. ADR-018 settled the general form of this: a market already
/// launched is never reinterpreted under rules written later.
///
/// ## Why it is not a copy either
///
/// Almost none of v1 is duplicated here, and specifically not the part where duplication
/// would be dangerous. The evaluation path — `activeStage`, `progressOf`, `feePpmFor`,
/// `ceilingFor`, `accumulate` — is *the same code*, called through the embedded
/// `AgenRuleLib.Stored`. There is no second implementation of how a fee is decided, so
/// there is nothing for a v2 rewrite to get subtly wrong.
///
/// The shared half of validation is likewise the same code: `validate` hands v1's validator
/// a view of the fields v1 knows about. What is written here is the field copying, which is
/// mechanical, and the wallet limit, which is genuinely new.
///
/// ## The limit is on buying, and only on buying
///
/// There is no per-wallet sell limit and there will not be one. A market that caps how much
/// a particular wallet may sell is a market that can take money and refuse to give it back,
/// and it is indistinguishable — from the outside, before the fact — from one that intends
/// to. The engine can express "this trade is too large" for either side, because that is a
/// statement about trades; it cannot express "you, specifically, may not leave".
/// @title IAgenRuleValidatorV2
/// @notice The engine-v2 rule validator, as `store` and the hook hold it.
///
/// @dev Declared in this file rather than its own because the two definitions need each
/// other: the interface's only method takes `AgenRuleLibV2.Config`, and `store` takes the
/// interface. Two files would import each other, which Solidity resolves inconsistently —
/// it failed here with "Identifier not found or not unique" at the use site rather than at
/// the cycle. One file, no cycle, and the type and its validator are read together.
interface IAgenRuleValidatorV2 {
    /// @notice Reverts unless `config` is a market engine v2 will evaluate.
    function validate(AgenRuleLibV2.Config calldata config) external pure;
}

library AgenRuleLibV2 {
    // --- bounds -------------------------------------------------------------

    /// @notice The longest a wallet limit may last, in seconds.
    /// @dev The same horizon a time ladder gets. A limit with no end is expressible — it is
    /// `windowSeconds == 0` — so this bounds only the ones that claim to end.
    uint256 internal constant MAX_WALLET_WINDOW = 730 days;

    /// @notice The same recipient bound v1 settles, restated as a literal.
    /// @dev `AgenRuleLib.MAX_RECIPIENTS` is not a compile-time constant expression to a
    /// fixed-array declaration in another file, so it cannot size the array below. The two
    /// are asserted equal by `RuleLibV2.t.sol` rather than left to agree by inspection.
    uint256 internal constant MAX_RECIPIENTS = 4;

    // --- types --------------------------------------------------------------

    /// @notice How much of the supply one wallet may buy, and for how long that holds.
    ///
    /// @dev Two fields with a deliberate asymmetry in what zero means, because the two
    /// zeros are asked about at different times:
    ///
    /// - `maxBuyTokens == 0` — no limit at all. The market is a v1 market in this respect
    ///   and never needs to know who is trading.
    /// - `windowSeconds == 0` with a limit set — the limit is permanent.
    ///
    /// A window with no limit is refused rather than treated as either, because it is not a
    /// configuration with an obvious reading: it says a rule applies until Tuesday without
    /// saying what the rule is.
    struct WalletBuyLimit {
        uint128 maxBuyTokens;
        uint32 windowSeconds;
    }

    // --- recipient kinds ------------------------------------------------------

    /// @dev v1's three, at v1's values, plus v2's two.
    ///
    /// A `uint8` rather than an extension of `AgenRuleLib.RecipientKind`, and that is the
    /// whole point. `AgenRuleLib` is inlined into the deployed v1 hook, so adding a variant
    /// to its enum changes the bytecode this repository compiles and the verified v1 source
    /// stops reproducing — a live market would be described by source that no longer builds
    /// it. Declaring the widened vocabulary here leaves v1 untouched.
    ///
    /// The ABI is unaffected: an enum and a `uint8` encode identically, so `CONFIG_V2_ABI`
    /// in `packages/market-engine/src/encode.ts` is the same tuple either way and no hash
    /// moves. What changes is only which file owns the meaning of the value.
    uint8 internal constant KIND_CREATOR = 0;
    uint8 internal constant KIND_TREASURY = 1;
    uint8 internal constant KIND_ADDRESS = 2;
    /// @notice The time-weighted largest holder of each epoch.
    uint8 internal constant KIND_LARGEST_HOLDER = 3;
    /// @notice The deferred buyback pot.
    uint8 internal constant KIND_BUYBACK = 4;

    /// @notice One leg of the split, over v2's wider set of recipients.
    /// @dev Field-for-field the same encoding as `AgenRuleLib.Share`.
    struct Share {
        uint8 kind;
        /// The zero address for every role. Only `KIND_ADDRESS` carries one.
        address recipient;
        uint24 sharePpm;
    }

    /// @notice A market's rules, as they arrive at registration.
    ///
    /// @dev Field order matches the tuple in `packages/market-engine/src/encode.ts` for
    /// engine v2 exactly, so `abi.encode` of this struct is the preimage the commitment hash
    /// is taken over. The first eleven fields are v1's, in v1's order, and the wallet limit
    /// is appended — which means a v2 configuration with no wallet limit still hashes
    /// differently from the v1 configuration with the same economics. That is correct: the
    /// two are evaluated by different code, and `implementationHash` binds the engine
    /// address for the same reason.
    struct Config {
        uint8 engineVersion;
        uint256 referenceSupply;
        address quoteAsset;
        uint8 feeCurrency;
        uint8 ladderAxis;
        AgenRuleLib.Stage[] stages;
        AgenRuleLib.Tier[] buyTiers;
        AgenRuleLib.Tier[] sellTiers;
        Share[] distribution;
        uint256 maxBuyTokens;
        uint256 maxSellTokens;
        WalletBuyLimit walletLimit;
        uint32 epochPeriodSeconds;
        uint128 buybackTriggerTokens;
    }

    /// @notice A market's rules in storage, plus the state the ladder and the limit need.
    ///
    /// @dev `base` is v1's storage struct, unmodified, so every v1 reader works on a v2
    /// market without a v2 overload existing. The nesting is not an optimisation; it is what
    /// makes "the fee is decided by the same code" true rather than claimed.
    struct Stored {
        AgenRuleLib.Stored base;
        uint128 walletMaxBuyTokens;
        uint32 walletWindowSeconds;
        uint32 epochPeriodSeconds;
        uint128 buybackTriggerTokens;
        /// @dev The split, over v2's wider vocabulary.
        ///
        /// Held here rather than in `base.distribution`, which is deliberately left empty on
        /// a v2 market: v1's `Share` types its kind as a three-valued enum and cannot hold
        /// `KIND_LARGEST_HOLDER` or `KIND_BUYBACK` at all. Writing a substituted kind there
        /// would leave a reader with a confident wrong answer about who gets paid, which is
        /// worse than an absence it has to notice. `base.shareCount` is still written, so a
        /// reader learns there are recipients and that it is looking in the wrong place.
        /// Nothing on the swap path reads either: the vault owns the split.
        Share[MAX_RECIPIENTS] distribution;
        /// @dev Tokens each wallet has bought while the window was open. Never cleared:
        /// after the window closes it is not read, and clearing it would cost every trader
        /// gas to erase a number nothing consults.
        mapping(address wallet => uint128 bought) boughtInWindow;
    }

    // --- errors -------------------------------------------------------------

    error InvalidEngineVersion(uint8 provided);
    error WalletWindowWithoutLimit(uint32 windowSeconds);
    error WalletLimitAboveSupply(uint128 limit, uint256 referenceSupply);
    error WalletWindowTooLong(uint32 windowSeconds, uint256 max);
    error AlreadyConfigured();
    error EpochPeriodOutOfBounds(uint32 periodSeconds, uint256 min, uint256 max);
    error EpochPeriodWithoutHolder();
    error BuybackTriggerWithoutShare();
    error BuybackShareWithoutTrigger();
    error V2RoleNotZero(uint256 index);
    error UnknownRecipientKind(uint256 index, uint8 kind);

    /// @notice This wallet has bought as much as it is allowed to while the window is open.
    /// @dev Carries every figure the trader needs to understand the refusal: what they have
    /// already bought, what they asked for, and the limit the two exceed together.
    error WalletBuyLimitReached(address wallet, uint128 alreadyBought, uint256 requested, uint128 limit);

    // --- identity -----------------------------------------------------------

    /// @notice The canonical hash of an engine-v2 configuration.
    /// @dev `abi.encode` of the struct, exactly as v1 does it, over v2's tuple.
    function hashConfig(Config memory config) internal pure returns (bytes32) {
        return keccak256(abi.encode(config));
    }

    /// @notice The domain engine-v2 commitments live in.
    /// @dev `keccak256("agen.engine.config.v2")`. Distinct from v1's domain so that a v1
    /// commitment can never be replayed against v2, even for a configuration whose economics
    /// are identical and whose encoding happened to collide.
    bytes32 internal constant CONFIG_V2_DOMAIN = keccak256("agen.engine.config.v2");

    /// @notice The commitment a creator signs, recomputed on chain.
    function implementationHash(bytes32 configHash_, uint256 chainId, address engine, uint256 engineVersion)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(CONFIG_V2_DOMAIN, chainId, engine, engineVersion, configHash_));
    }

    // --- validation ---------------------------------------------------------

    /// @notice Reverts unless `config` is a market this library will evaluate.
    ///
    /// @dev The shared half is checked by `AgenRuleLib.validate` itself rather than by a
    /// second implementation of the same rules. The view handed to it carries
    /// `engineVersion: 1` because that is the only value v1's validator accepts, and the
    /// field is the one thing about the view that is not what v2 will store — v2's own
    /// version check happens here, first, so there is no path on which a version other than
    /// 2 reaches storage.
    function validate(Config memory config) internal pure {
        if (config.engineVersion != 2) revert InvalidEngineVersion(config.engineVersion);

        AgenRuleLib.validate(_shared(config));
        _validateV2Roles(config);

        WalletBuyLimit memory limit = config.walletLimit;

        if (limit.maxBuyTokens == 0) {
            if (limit.windowSeconds != 0) revert WalletWindowWithoutLimit(limit.windowSeconds);
            return;
        }

        // A limit at or above the whole supply cannot refuse a trade the pool could fill,
        // so it is a rule that does nothing — and a rule that does nothing in a commitment
        // a creator signed is a rule they were told about and did not get.
        if (limit.maxBuyTokens >= config.referenceSupply) {
            revert WalletLimitAboveSupply(limit.maxBuyTokens, config.referenceSupply);
        }

        if (limit.windowSeconds > MAX_WALLET_WINDOW) {
            revert WalletWindowTooLong(limit.windowSeconds, MAX_WALLET_WINDOW);
        }
    }

    /// @dev v2's configuration as the fields v1 knows about. Memory-only, never stored.
    ///
    /// v2's two roles are presented to v1's validator as `Creator`, because v1 has no name
    /// for them and would refuse the kind outright. Only the *kind* is substituted: the
    /// share amounts pass through untouched, so "exactly one whole", the recipient count and
    /// the zero-address rules are still checked by v1's own code rather than by a copy.
    /// `_validateV2Roles` then checks what the substitution hid. `store` writes the real
    /// kinds, so nothing downstream ever sees the stand-in.
    function _shared(Config memory config) private pure returns (AgenRuleLib.Config memory) {
        AgenRuleLib.Share[] memory shares = new AgenRuleLib.Share[](config.distribution.length);
        for (uint256 i = 0; i < config.distribution.length; i++) {
            Share memory share = config.distribution[i];

            AgenRuleLib.RecipientKind kind;
            if (share.kind == KIND_CREATOR || share.kind == KIND_LARGEST_HOLDER || share.kind == KIND_BUYBACK) {
                kind = AgenRuleLib.RecipientKind.Creator;
            } else if (share.kind == KIND_TREASURY) {
                kind = AgenRuleLib.RecipientKind.Treasury;
            } else if (share.kind == KIND_ADDRESS) {
                kind = AgenRuleLib.RecipientKind.Address;
            } else {
                revert UnknownRecipientKind(i, share.kind);
            }

            shares[i] = AgenRuleLib.Share({kind: kind, recipient: share.recipient, sharePpm: share.sharePpm});
        }

        return AgenRuleLib.Config({
            engineVersion: 1,
            referenceSupply: config.referenceSupply,
            quoteAsset: config.quoteAsset,
            feeCurrency: config.feeCurrency,
            ladderAxis: config.ladderAxis,
            stages: config.stages,
            buyTiers: config.buyTiers,
            sellTiers: config.sellTiers,
            distribution: shares,
            maxBuyTokens: config.maxBuyTokens,
            maxSellTokens: config.maxSellTokens
        });
    }

    function _validateV2Roles(Config memory config) private pure {
        bool holder;
        bool buyback;

        for (uint256 i = 0; i < config.distribution.length; i++) {
            Share memory share = config.distribution[i];
            if (share.kind == KIND_LARGEST_HOLDER) {
                if (share.recipient != address(0)) revert V2RoleNotZero(i);
                holder = true;
            } else if (share.kind == KIND_BUYBACK) {
                if (share.recipient != address(0)) revert V2RoleNotZero(i);
                buyback = true;
            }
        }

        if (holder) {
            if (config.epochPeriodSeconds < 60 || config.epochPeriodSeconds > uint32(MAX_WALLET_WINDOW)) {
                revert EpochPeriodOutOfBounds(config.epochPeriodSeconds, 60, MAX_WALLET_WINDOW);
            }
        } else if (config.epochPeriodSeconds != 0) {
            revert EpochPeriodWithoutHolder();
        }

        if (buyback) {
            if (config.buybackTriggerTokens == 0) revert BuybackShareWithoutTrigger();
        } else if (config.buybackTriggerTokens != 0) {
            revert BuybackTriggerWithoutShare();
        }
    }

    // --- writing ------------------------------------------------------------

    /// @notice Validate and write a market's rules. Once per market, ever.
    ///
    /// @dev The validator is an argument rather than an inlined call, so that the checks
    /// live on their own address instead of inside every contract that stores a
    /// configuration — see `AgenRuleValidatorV2` for the size argument.
    ///
    /// Validation still happens *here*, inside `store`, before a single field is written.
    /// That ordering is the invariant and it is deliberately not left to the caller: an
    /// invalid configuration cannot reach storage by any path, because the only function
    /// that writes one is this, and it reverts first.
    function store(Stored storage stored, Config memory config, IAgenRuleValidatorV2 validator) internal {
        if (stored.base.configured) revert AlreadyConfigured();
        validator.validate(config);

        AgenRuleLib.Stored storage base = stored.base;

        base.engineVersion = config.engineVersion;
        base.feeCurrency = AgenRuleLib.FeeCurrency(config.feeCurrency);
        base.ladderAxis = AgenRuleLib.LadderAxis(config.ladderAxis);
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        base.referenceSupply = uint128(config.referenceSupply);
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        base.maxBuyTokens = uint128(config.maxBuyTokens);
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        base.maxSellTokens = uint128(config.maxSellTokens);

        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        base.stageCount = uint8(config.stages.length);
        for (uint256 i = 0; i < config.stages.length; i++) {
            base.stages[i] = config.stages[i];
        }

        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        base.buyTierCount = uint8(config.buyTiers.length);
        for (uint256 i = 0; i < config.buyTiers.length; i++) {
            base.buyTiers[i] = config.buyTiers[i];
        }

        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        base.sellTierCount = uint8(config.sellTiers.length);
        for (uint256 i = 0; i < config.sellTiers.length; i++) {
            base.sellTiers[i] = config.sellTiers[i];
        }

        // The count goes on `base` and the shares go on v2's own array. See `Stored`.
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by validate
        base.shareCount = uint8(config.distribution.length);
        for (uint256 i = 0; i < config.distribution.length; i++) {
            stored.distribution[i] = config.distribution[i];
        }

        stored.walletMaxBuyTokens = config.walletLimit.maxBuyTokens;
        stored.walletWindowSeconds = config.walletLimit.windowSeconds;
        stored.epochPeriodSeconds = config.epochPeriodSeconds;
        stored.buybackTriggerTokens = config.buybackTriggerTokens;

        base.configured = true;
    }

    // --- reading ------------------------------------------------------------

    /// @notice One leg of this market's split, over v2's vocabulary.
    function shareAt(Stored storage stored, uint256 index) internal view returns (Share memory) {
        return stored.distribution[index];
    }

    /// @notice Whether this market limits how much one wallet may buy.
    /// @dev The question the hook asks before it needs a trader at all. A market answering
    /// false never reads hook data and trades exactly as a v1 market does.
    function hasWalletLimit(Stored storage stored) internal view returns (bool) {
        return stored.walletMaxBuyTokens != 0;
    }

    /// @notice Whether the limit is in force at this moment.
    ///
    /// @dev **Never reverts.** Three cases, and the ordering matters: no limit is answered
    /// before the clock is consulted, so a market without one does not depend on having been
    /// initialised.
    ///
    /// A permanent limit is `windowSeconds == 0`. Before `initTime` is recorded the window
    /// is treated as open, which is the safe direction: the pool cannot be swapped before
    /// `afterInitialize` anyway, and answering "closed" for an uninitialised market would
    /// make the limit's first moments the ones it did not apply to.
    function walletWindowOpen(Stored storage stored, uint256 blockTimestamp) internal view returns (bool) {
        if (stored.walletMaxBuyTokens == 0) return false;

        uint32 window = stored.walletWindowSeconds;
        if (window == 0) return true;

        uint256 initTime = stored.base.initTime;
        if (initTime == 0 || blockTimestamp <= initTime) return true;

        return blockTimestamp - initTime < window;
    }

    /// @notice What this wallet has bought so far under the limit.
    function boughtBy(Stored storage stored, address wallet) internal view returns (uint128) {
        return stored.boughtInWindow[wallet];
    }

    /// @notice Charge this buy against the wallet's allowance, or refuse it.
    ///
    /// @dev The one function here that writes on the swap path, and the one that can revert.
    /// It reverts on purpose: the market's own rule is that this trade does not happen.
    ///
    /// The caller decides whether the window is open. Splitting it that way keeps this
    /// function total with respect to time — it cannot be called for a closed window and
    /// then disagree with the check that let it through.
    ///
    /// Saturating rather than reverting on the accumulator, for `accumulate`'s reason: the
    /// only way to reach `type(uint128).max` here is a limit that has already refused
    /// everything, and a pool that cannot be traded is a worse outcome than a counter that
    /// has stopped counting. The limit is below the reference supply by `validate`, so the
    /// comparison below has already refused any amount that could get near it.
    function chargeWalletBuy(Stored storage stored, address wallet, uint256 tokens) internal {
        uint128 limit = stored.walletMaxBuyTokens;
        uint128 already = stored.boughtInWindow[wallet];

        uint256 total = uint256(already) + tokens;
        if (total > limit) revert WalletBuyLimitReached(wallet, already, tokens, limit);

        // forge-lint: disable-next-line(unsafe-typecast) -- `total <= limit`, a uint128
        stored.boughtInWindow[wallet] = uint128(total);
    }

    /// @notice Whether this market pays a largest-holder pot.
    function hasLargestHolder(Stored storage stored) internal view returns (bool) {
        return stored.epochPeriodSeconds != 0;
    }

    /// @notice Whether this market arms a buyback on a large sell.
    function hasBuyback(Stored storage stored) internal view returns (bool) {
        return stored.buybackTriggerTokens != 0;
    }

    /// @notice The lazy epoch at `blockTimestamp`. Epoch 0 is the first period after launch.
    /// @dev **Never reverts.** An uninitialised market or a market with no period is epoch 0.
    function epochOf(Stored storage stored, uint256 blockTimestamp) internal view returns (uint256) {
        uint32 period = stored.epochPeriodSeconds;
        if (period == 0) return 0;

        uint256 initTime = stored.base.initTime;
        if (initTime == 0 || blockTimestamp <= initTime) return 0;

        return (blockTimestamp - initTime) / period;
    }
}
