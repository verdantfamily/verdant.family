// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";

import {VerdantConstants} from "../../libraries/VerdantConstants.sol";
import {AgenEngineVault} from "./AgenEngineVault.sol";
import {AgenRuleLib} from "./AgenRuleLib.sol";

/// @title AgenEngineHook
/// @notice One hook, every programmable market. Reads each market's rules from storage and
/// takes the fee they state.
///
/// @dev The shared-hook half of `VerdantHook` joined to the custody half of `InstantHook`.
/// A market's rules are written once, when it is created, and are then readable forever and
/// writable by nobody — including by Agen. There is no owner, no setter, no upgrade path,
/// no `delegatecall` and no `selfdestruct` in this contract, so a creator's economics cannot
/// be changed out from under them after launch.
///
/// What replaces the old design is worth stating: every generated market used to deploy its
/// own hook, mined and CREATE2'd from bytecode a model wrote. This contract is deployed
/// once, reviewed once, and shared. A new market is a `configure` call.
///
/// ## The pool charges nothing
///
/// `beforeSwap` returns a zero LP fee with `OVERRIDE_FEE_FLAG` on every swap, and
/// `afterInitialize` writes zero as the stored fee. That is the invariant rather than a
/// default: the programmable fee is the whole cost of a trade, so any LP fee at all would
/// be a second charge on the same swap and would make the number on the review screen
/// false. It also means the locked position accrues nothing, which is why a programmable
/// market's fees are claimed from its vault.
///
/// ## Where the fee is taken, and why it is two callbacks
///
/// A hook can only move one currency per callback: `beforeSwap`'s `BeforeSwapDelta`
/// specified component lands on the swap's specified currency, and `afterSwap`'s returned
/// `int128` lands on the unspecified one. So a fee denominated in some currency can only be
/// taken in whichever of the two settles that currency:
///
///   specifiedIsCurrency0 = ((amountSpecified < 0) == zeroForOne)
///
/// which is `Hooks.afterSwap`'s own test. Charging on the side it picks is the only way a
/// delta lands where it was intended. Exactly one of the two callbacks charges on any given
/// swap and the other returns zero, which is what makes double-charging structurally
/// impossible rather than merely tested for.
///
/// ## Side is defined by the token, never by `zeroForOne`
///
/// A buy is the trader receiving the launched token. Pool currencies are sorted by address,
/// so the same `zeroForOne` means a buy in one market and a sell in another.
/// `InstantHook` can write `isBuy = zeroForOne` only because it refuses any pool whose
/// `currency0` is not ether; this hook supports equity quotes and either sort order, so it
/// cannot:
///
///   isBuy = (zeroForOne == quoteIsCurrency0)
///
/// ## Trade size is gross, always
///
/// A size threshold is evaluated against the launched-token amount attributable to the
/// underlying pool swap **before** this hook's fee is applied. The fee never participates
/// in deciding whether its own tier activates, because that is circular. Which figure that
/// is depends on the shape:
///
///  - the token is the specified currency — gross is `|amountSpecified|`, the amount the
///    trader named. `BeforeSwapDelta` then adjusts the pool's own swap by exactly the fee,
///    so the named amount *is* the pre-fee figure by construction.
///  - the token is unspecified — gross is the token component of the `BalanceDelta` in
///    `afterSwap`. `beforeSwap` returned no delta in that case, so the pool computed that
///    leg knowing nothing of this hook's fee.
///
/// The same rule governs a trade ceiling, which is enforced in whichever callback first
/// knows the gross token amount.
///
/// ## Custody
///
/// This contract never holds a balance. `poolManager.mint` names the market's own vault as
/// the recipient, and the vault is the only thing with a withdrawal path. A hook is called
/// on every swap, so a hook holding money would make "can this be drained" a question about
/// the correctness of the swap logic above.
contract AgenEngineHook is IHooks {
    using AgenRuleLib for AgenRuleLib.Stored;
    using LPFeeLibrary for uint24;
    using PoolIdLibrary for PoolKey;

    // --- permissions ---------------------------------------------------------

    /// @notice The low 14 bits this contract's address must have: 0x38CC.
    ///
    /// @dev Composed from Uniswap's own flags rather than written as a literal, so a change
    /// to their meaning upstream is a compile-time change here.
    /// `EngineHook.permissions.t.sol` asserts it equals 0x38CC bit by bit and that no flag
    /// beyond these seven is set.
    ///
    /// Every one is load-bearing, which is the test for whether it belongs:
    ///  - `beforeInitialize` refuses a pool whose rules have not been written.
    ///  - `afterInitialize` records the origin every time threshold is measured from, and
    ///    zeroes the pool's stored LP fee.
    ///  - `beforeAddLiquidity` is what makes the launch position the only position.
    ///  - `beforeSwap` charges when the fee currency is the specified one, and enforces a
    ///    ceiling when the token is.
    ///  - `afterSwap` charges when it is not, enforces the ceiling in the other case, and
    ///    accumulates quote volume — which a market needs even when its fee is taken in the
    ///    launched token, since the two denominations are independent.
    ///  - the two `RETURNS_DELTA` bits are what make custody possible at all: without them
    ///    v4 does not read a returned delta, and the fee would be silently uncharged while
    ///    the mint left the swap unbalanced.
    uint160 internal constant REQUIRED_PERMISSIONS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    // --- immutables ----------------------------------------------------------

    IPoolManager public immutable poolManager;

    /// @notice The engine factory, and the only contract that may configure a market.
    address public immutable factory;

    /// @notice The pinned PositionManager, for the reason `VerdantHook` pins one:
    /// `beforeAddLiquidity` reports the PoolManager's caller, and only a known contract's
    /// claim about who asked is worth believing.
    address public immutable positionManager;

    // --- storage -------------------------------------------------------------

    struct Market {
        AgenRuleLib.Stored rules;
        AgenEngineVault vault;
        /// @dev Which side of the sorted pair the quote asset landed on. Every side and leg
        /// question is answered from this.
        bool quoteIsCurrency0;
        /// @dev `keccak256` of the canonical configuration this market was created from, so
        /// a verifier can recompute the creator's commitment from the chain.
        bytes32 configHash;
    }

    mapping(PoolId poolId => Market market) private _markets;

    // --- events --------------------------------------------------------------

    /// @notice A market's rules were written. Emitted exactly once per PoolId.
    /// @dev Carries everything an indexer needs to identify an engine market without
    /// decoding storage, and deliberately never the creator's prompt.
    event MarketConfigured(
        PoolId indexed poolId,
        uint8 engineVersion,
        bytes32 configHash,
        address vault,
        address launchedToken,
        address quoteAsset,
        uint8 feeCurrency
    );

    /// @notice The pool was initialised and the rules' clock started.
    event MarketInitialized(PoolId indexed poolId, uint40 initTime);

    /// @notice A trade paid its programmable fee.
    /// @dev Carries the gross legs as well as the rate, so an indexer never has to infer a
    /// direction or re-derive a tier to reconstruct what happened.
    event FeeTaken(
        PoolId indexed poolId,
        bool isBuy,
        uint256 grossTokenAmount,
        uint256 grossQuoteAmount,
        uint24 feePpm,
        uint256 feeAmount
    );

    // --- errors --------------------------------------------------------------

    error NotPoolManager(address caller);
    error NotFactory(address caller);
    error HookAddressMismatch(address hook, uint160 actualBits, uint160 requiredBits);
    error AlreadyConfigured(PoolId poolId);
    error NotConfigured(PoolId poolId);
    error FeeNotDynamic(uint24 fee);
    error TickSpacingMismatch(int24 provided, int24 required);
    error HookNotThis(IHooks provided, address expected);
    error NotPositionManager(address sender);
    error CallbackNotEnabled();

    /// @notice The key's currencies are not this market's quote asset and launched token.
    error QuoteNotInPool(address quoteAsset, Currency currency0, Currency currency1);

    /// @notice The vault does not belong to this hook, or holds the wrong currency.
    error VaultMismatch(address vault);

    /// @notice The vault's split disagrees with the configuration's.
    /// @dev Checked rather than trusted. The factory writes both from the same canonical
    /// bytes in one transaction, so they agree if it is correct — and this is what catches
    /// it if it is not, at the only moment the disagreement is still harmless.
    error DistributionMismatch(uint256 slot);

    /// @notice A trade larger than the market's ceiling for that side.
    error TradeAboveCeiling(PoolId poolId, bool isBuy, uint256 attempted, uint128 ceiling);

    // --- construction --------------------------------------------------------

    /// @dev The address check is why this constructor exists. v4 does not verify that a
    /// hook's address grants the permissions it implements, so an unmined address would be
    /// accepted by `initialize` and then never called — here that would mean a market that
    /// charges nobody anything, discovered after it held money.
    constructor(IPoolManager poolManager_, address factory_, address positionManager_) {
        uint160 bits = uint160(address(this)) & Hooks.ALL_HOOK_MASK;
        if (bits != REQUIRED_PERMISSIONS) {
            revert HookAddressMismatch(address(this), bits, REQUIRED_PERMISSIONS);
        }

        poolManager = poolManager_;
        factory = factory_;
        positionManager = positionManager_;
    }

    // --- configuration -------------------------------------------------------

    /// @notice Write a market's rules. Once per PoolId, by the factory, never again.
    ///
    /// @dev Separate from `beforeInitialize` because v4's initialise path carries no hook
    /// data at the pinned commit, which is the constraint `VerdantHook.configure` works
    /// around too. `beforeInitialize` then refuses any pool that has not been through here,
    /// so the two cannot come apart.
    ///
    /// The configuration's hash is **computed here**, from the struct being stored, and
    /// never accepted as an argument. A hash supplied alongside a configuration is a claim
    /// that the two describe each other, and a claim is exactly what an identity must not
    /// be: it is the one field a verifier would read instead of re-deriving, so a
    /// disagreement between them would be invisible precisely where it mattered. The
    /// invariant is `stored configuration -> canonical encoding -> configHash`, in that
    /// direction only.
    function configure(PoolKey calldata key, AgenRuleLib.Config calldata config, AgenEngineVault vault)
        external
        returns (bytes32 configHash)
    {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        _requireEngineKey(key);

        PoolId poolId = key.toId();
        Market storage market = _markets[poolId];
        if (market.rules.configured) revert AlreadyConfigured(poolId);

        // Which side of the sorted pair the quote asset landed on. Everything about sides
        // and legs is answered from this one bit, so it is established here — where the
        // configuration and the key are both in hand — rather than re-derived per swap.
        bool quoteIsZero;
        if (Currency.unwrap(key.currency0) == config.quoteAsset) {
            quoteIsZero = true;
        } else if (Currency.unwrap(key.currency1) == config.quoteAsset) {
            quoteIsZero = false;
        } else {
            revert QuoteNotInPool(config.quoteAsset, key.currency0, key.currency1);
        }

        Currency feeCurrency = _feeCurrencyOf(key, quoteIsZero, AgenRuleLib.FeeCurrency(config.feeCurrency));

        if (vault.hook() != address(this)) revert VaultMismatch(address(vault));
        if (Currency.unwrap(vault.currency()) != Currency.unwrap(feeCurrency)) {
            revert VaultMismatch(address(vault));
        }

        // Verify rather than trust. The vault owns the ledger and therefore the split; the
        // configuration is what the creator signed. If they disagreed, the market would pay
        // out shares nobody approved.
        if (vault.recipientCount() != config.distribution.length) {
            revert DistributionMismatch(config.distribution.length);
        }
        for (uint256 i = 0; i < config.distribution.length; i++) {
            if (vault.shareAt(i) != config.distribution[i].sharePpm) revert DistributionMismatch(i);
        }

        // `store` validates. An invalid configuration cannot reach storage.
        market.rules.store(config);
        market.vault = vault;
        market.quoteIsCurrency0 = quoteIsZero;

        // Derived from what was just stored, so the two cannot describe different markets.
        configHash = AgenRuleLib.hashConfig(config);
        market.configHash = configHash;

        emit MarketConfigured(
            poolId,
            config.engineVersion,
            configHash,
            address(vault),
            Currency.unwrap(quoteIsZero ? key.currency1 : key.currency0),
            config.quoteAsset,
            config.feeCurrency
        );
    }

    // --- v4 callbacks --------------------------------------------------------

    /// @inheritdoc IHooks
    function beforeInitialize(address sender, PoolKey calldata key, uint160) external view override returns (bytes4) {
        _requirePoolManager();
        if (sender != factory) revert NotFactory(sender);

        // Re-checked at runtime, not only at construction, because the constructor cannot
        // speak for code placed at an address by any means other than construction.
        uint160 bits = uint160(address(this)) & Hooks.ALL_HOOK_MASK;
        if (bits != REQUIRED_PERMISSIONS) {
            revert HookAddressMismatch(address(this), bits, REQUIRED_PERMISSIONS);
        }

        PoolId poolId = key.toId();
        if (!_markets[poolId].rules.configured) revert NotConfigured(poolId);

        return IHooks.beforeInitialize.selector;
    }

    /// @inheritdoc IHooks
    /// @dev Records the origin every time threshold is measured from, and zeroes the pool's
    /// stored LP fee. The `updateDynamicLPFee` call has to be here rather than in
    /// `beforeInitialize` because the pool it updates does not exist until v4 has finished
    /// initialising it.
    function afterInitialize(address, PoolKey calldata key, uint160, int24) external override returns (bytes4) {
        _requirePoolManager();

        PoolId poolId = key.toId();
        // forge-lint: disable-next-line(unsafe-typecast) -- uint40 holds timestamps to year 36812
        uint40 initTime = uint40(block.timestamp);
        _markets[poolId].rules.recordInitTime(initTime);

        poolManager.updateDynamicLPFee(key, 0);

        emit MarketInitialized(poolId, initTime);
        return IHooks.afterInitialize.selector;
    }

    /// @inheritdoc IHooks
    /// @notice Exactly one position ever exists in an engine pool: the locked one the
    /// factory mints at creation.
    ///
    /// @dev Two checks and neither is sufficient alone. `sender` must be the pinned
    /// PositionManager, because the next line asks it who *its* caller was — and if any
    /// contract could occupy this position, any contract could answer that question. The
    /// initiator must then be the factory, which is the check that actually restricts
    /// liquidity.
    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        _requirePoolManager();
        if (sender != positionManager) revert NotPositionManager(sender);

        address initiator = IMsgSender(sender).msgSender();
        if (initiator != factory) revert NotFactory(initiator);

        return IHooks.beforeAddLiquidity.selector;
    }

    /// @inheritdoc IHooks
    /// @dev Charges when the fee's currency is the swap's specified one, and enforces the
    /// ceiling when the launched token is. Returns a zero LP fee either way.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _requirePoolManager();

        PoolId poolId = key.toId();
        Market storage market = _markets[poolId];
        if (!market.rules.configured) revert NotConfigured(poolId);

        Shape memory shape = _shapeOf(market, params);

        // The ceiling reads the gross token amount, so it is enforced here whenever that
        // figure is available and in `afterSwap` otherwise. Earlier is better: a refused
        // trade then costs the trader as little gas as v4 allows.
        if (shape.tokenIsSpecified) {
            _requireBelowCeiling(market, poolId, shape.side, shape.isBuy, shape.specified);
        }

        // Zero LP fee, always. The flag is what makes v4 use this rather than the stored one.
        uint24 zeroLpFee = LPFeeLibrary.OVERRIDE_FEE_FLAG;

        if (!shape.feeIsSpecified) {
            // The fee's currency is the unspecified one, so `afterSwap` settles it.
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, zeroLpFee);
        }

        /*
         * The fee currency is specified, so its gross amount is `specified` and the fee is
         * settled here.
         *
         * When the fee is token-denominated, `tokenIsSpecified` holds — the two conditions
         * are the same statement — so the gross token amount the tier needs is exactly
         * `specified`. When it is quote-denominated the market has no tiers at all, by
         * ADR-018's derivation, so passing zero as the size cannot change the rate.
         */
        uint256 fee = _charge(
            market,
            poolId,
            key,
            Charge({
                side: shape.side,
                isBuy: shape.isBuy,
                grossToken: shape.tokenIsSpecified ? shape.specified : 0,
                grossQuote: shape.tokenIsSpecified ? 0 : shape.specified,
                feeBase: shape.specified
            })
        );
        if (fee == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, zeroLpFee);
        }

        /*
         * `amountToSwap` becomes `amountSpecified + deltaSpecified` inside
         * `Hooks.beforeSwap`, and `+fee` is the right sign in both shapes that reach here.
         *
         * On an exact-input swap `amountSpecified` is negative, so adding the fee makes the
         * magnitude smaller: the pool swaps less and the trader spends what they said. On an
         * exact-output swap it is positive, so adding the fee makes the pool produce the fee
         * on top and the trader still receives exactly what they asked for.
         */
        // forge-lint: disable-next-line(unsafe-typecast) -- a fraction of an amount v4 holds as int128
        BeforeSwapDelta delta = toBeforeSwapDelta(int128(int256(fee)), 0);
        return (IHooks.beforeSwap.selector, delta, zeroLpFee);
    }

    /// @inheritdoc IHooks
    /// @dev Charges when the fee's currency is the swap's *unspecified* one, enforces the
    /// ceiling when the token was unspecified, and accumulates quote volume in every case.
    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        override
        returns (bytes4, int128)
    {
        _requirePoolManager();

        PoolId poolId = key.toId();
        Market storage market = _markets[poolId];
        if (!market.rules.configured) revert NotConfigured(poolId);

        Shape memory shape = _shapeOf(market, params);
        Charge memory swap = _grossOf(market, shape, delta);

        // Where the token was unspecified, `beforeSwap` could not read its amount, so the
        // ceiling is enforced here instead. Reverting in `afterSwap` still reverts the whole
        // swap, which is all a ceiling has to do.
        if (!shape.tokenIsSpecified) {
            _requireBelowCeiling(market, poolId, shape.side, shape.isBuy, swap.grossToken);
        }

        int128 owed;
        if (!shape.feeIsSpecified) {
            uint256 fee = _charge(market, poolId, key, swap);
            // forge-lint: disable-next-line(unsafe-typecast) -- a fraction of an int128 leg
            owed = int128(int256(fee));
        }

        /*
         * Volume last, and always in the quote asset.
         *
         * Last because a trade must never advance its own stage: the rate above was read
         * from the total this trade is about to join. Quote-denominated even when the fee is
         * taken in the launched token, because "after 100 ETH of volume" is a statement
         * about ETH and the two denominations are independent concepts.
         */
        market.rules.accumulate(swap.grossQuote);

        return (IHooks.afterSwap.selector, owed);
    }

    // --- views ---------------------------------------------------------------

    /// @notice The rate a trade of this shape would pay right now, in ppm.
    /// @dev For an interface quoting a trade before it is signed. Reads the same function
    /// the swap path does, so a quote cannot describe a different market.
    function feePpmFor(PoolId poolId, bool isBuy, uint256 grossTokenAmount) external view returns (uint24) {
        AgenRuleLib.Stored storage rules = _markets[poolId].rules;
        return rules.feePpmFor(
            isBuy ? AgenRuleLib.Side.Buy : AgenRuleLib.Side.Sell,
            grossTokenAmount,
            rules.progressOf(block.timestamp)
        );
    }

    function vaultOf(PoolId poolId) external view returns (AgenEngineVault) {
        return _markets[poolId].vault;
    }

    function configHashOf(PoolId poolId) external view returns (bytes32) {
        return _markets[poolId].configHash;
    }

    /// @notice The commitment this market's creator approved, recomputed from the chain.
    ///
    /// @dev The point of exposing it is that nobody has to trust the registry's copy. This
    /// derives it from the configuration actually stored here, so a verifier can compare the
    /// two and a disagreement is visible rather than assumed away.
    function implementationHashOf(PoolId poolId) external view returns (bytes32) {
        Market storage market = _markets[poolId];
        if (!market.rules.configured) revert NotConfigured(poolId);

        return AgenRuleLib.implementationHash(
            market.configHash, block.chainid, address(this), market.rules.engineVersion
        );
    }

    /// @notice The engine version this market's rules were written for. Never reinterpreted.
    function engineVersionOf(PoolId poolId) external view returns (uint8) {
        return _markets[poolId].rules.engineVersion;
    }

    function isConfigured(PoolId poolId) external view returns (bool) {
        return _markets[poolId].rules.configured;
    }

    function quoteIsCurrency0(PoolId poolId) external view returns (bool) {
        return _markets[poolId].quoteIsCurrency0;
    }

    function cumulativeQuoteVolume(PoolId poolId) external view returns (uint128) {
        return _markets[poolId].rules.cumulativeQuoteVolume;
    }

    function initTimeOf(PoolId poolId) external view returns (uint40) {
        return _markets[poolId].rules.initTime;
    }

    function feeCurrencyOf(PoolId poolId) external view returns (uint8) {
        return uint8(_markets[poolId].rules.feeCurrency);
    }

    /// @notice The permissions this hook implements, in Uniswap's own struct.
    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: true,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // --- internals -----------------------------------------------------------

    /// @dev What kind of swap this is, in the four terms both callbacks branch on.
    ///
    /// Derived once per callback rather than inline, because computing it in place left both
    /// `beforeSwap` and `afterSwap` over the stack limit — and because there being exactly
    /// one definition of each of these four questions is the whole point of `orientation.ts`
    /// having a Solidity twin at all.
    struct Shape {
        /// The trader receives the launched token. Never `zeroForOne` alone.
        bool isBuy;
        AgenRuleLib.Side side;
        /// The launched token is the currency the swap named an amount for.
        bool tokenIsSpecified;
        /// The fee's currency is the one the swap named an amount for, so `beforeSwap` settles it.
        bool feeIsSpecified;
        /// `|amountSpecified|`.
        uint256 specified;
    }

    function _shapeOf(Market storage market, SwapParams calldata params) private view returns (Shape memory) {
        bool quoteIsZero = market.quoteIsCurrency0;
        bool isBuy = params.zeroForOne == quoteIsZero;

        // `Hooks.afterSwap`'s own test for which currency a returned delta lands on.
        bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;

        AgenRuleLib.FeeCurrency kind = market.rules.feeCurrency;
        bool feeIsCurrency0 = kind == AgenRuleLib.FeeCurrency.Quote ? quoteIsZero : !quoteIsZero;

        return Shape({
            isBuy: isBuy,
            side: isBuy ? AgenRuleLib.Side.Buy : AgenRuleLib.Side.Sell,
            tokenIsSpecified: specifiedIsCurrency0 == !quoteIsZero,
            feeIsSpecified: specifiedIsCurrency0 == feeIsCurrency0,
            specified: params.amountSpecified < 0
                ? uint256(-params.amountSpecified)
                : uint256(params.amountSpecified)
        });
    }

    /// @dev One swap's figures, gathered so `_charge` stays inside the stack limit.
    struct Charge {
        AgenRuleLib.Side side;
        bool isBuy;
        /// The launched-token leg before this hook's fee. What tiers read.
        uint256 grossToken;
        /// The quote leg before this hook's fee. What volume accumulates.
        uint256 grossQuote;
        /// The gross amount of whichever currency the fee is denominated in.
        uint256 feeBase;
    }

    /// @dev Both gross legs of a completed swap, and the fee base that follows from them.
    ///
    /// The rule is the same for each leg and it is worth stating once rather than per branch:
    /// **the specified leg's gross amount is `|amountSpecified|`, and the unspecified leg's
    /// is its `BalanceDelta` component.**
    ///
    /// Because when a leg is specified, `beforeSwap` may already have taken the fee out of it
    /// — that is exactly what its `BeforeSwapDelta` does — so the `BalanceDelta` reports what
    /// the pool swapped rather than what the trader named, and the difference is the fee.
    /// When a leg is unspecified, `beforeSwap` contributed nothing to it, so the delta is the
    /// untouched pool swap.
    ///
    /// Applying that to the token leg alone was a bug, and a native-quoted market found it: a
    /// 1 ETH exact-input buy paying 2% recorded 0.98 ETH of volume, because the quote leg was
    /// read from the delta after `beforeSwap` had taken 0.02 out of it. The fee itself was
    /// right — it had been computed from `amountSpecified` in `beforeSwap` — but the volume
    /// counter, which must count the actual quote-side amount the trader transacted, was
    /// short by exactly the fee on the most ordinary trade the market has.
    function _grossOf(Market storage market, Shape memory shape, BalanceDelta delta)
        private
        view
        returns (Charge memory)
    {
        bool quoteIsZero = market.quoteIsCurrency0;
        uint256 legZero = _magnitude(delta.amount0());
        uint256 legOne = _magnitude(delta.amount1());

        // Exactly one of the two legs is the specified currency, so exactly one of these
        // takes `shape.specified`.
        uint256 grossToken = shape.tokenIsSpecified ? shape.specified : (quoteIsZero ? legOne : legZero);
        uint256 grossQuote = shape.tokenIsSpecified ? (quoteIsZero ? legZero : legOne) : shape.specified;

        return Charge({
            side: shape.side,
            isBuy: shape.isBuy,
            grossToken: grossToken,
            grossQuote: grossQuote,
            feeBase: market.rules.feeCurrency == AgenRuleLib.FeeCurrency.Quote ? grossQuote : grossToken
        });
    }

    /// @dev Evaluate the rate, mint the fee to the market's vault, and record it.
    ///
    /// Returns the amount taken so the caller can balance it with a delta. Returns zero on
    /// a leg too small to owe a base unit, and must not revert on one: this runs inside
    /// every swap, and a revert here is a market that cannot be traded.
    function _charge(Market storage market, PoolId poolId, PoolKey calldata key, Charge memory swap)
        private
        returns (uint256 fee)
    {
        uint24 feePpm =
            market.rules.feePpmFor(swap.side, swap.grossToken, market.rules.progressOf(block.timestamp));
        fee = AgenRuleLib.feeOf(swap.feeBase, feePpm);
        if (fee == 0) return 0;

        Currency feeCurrency =
            _feeCurrencyOf(key, market.quoteIsCurrency0, market.rules.feeCurrency);

        /*
         * `mint`, not `take`. At this point in a swap the trader has not settled, so the
         * manager may hold nothing at all — which is exactly the state a freshly launched
         * pool is in until its first buy. Minting credits the vault with a claim and leaves
         * this hook owing the manager the same amount, which the returned delta makes the
         * trader cover.
         */
        AgenEngineVault vault = market.vault;
        poolManager.mint(address(vault), feeCurrency.toId(), fee);
        vault.credit(fee);

        emit FeeTaken(poolId, swap.isBuy, swap.grossToken, swap.grossQuote, feePpm, fee);
    }

    function _requireBelowCeiling(
        Market storage market,
        PoolId poolId,
        AgenRuleLib.Side side,
        bool isBuy,
        uint256 grossToken
    ) private view {
        uint128 ceiling = market.rules.ceilingFor(side);
        if (ceiling != 0 && grossToken > ceiling) {
            revert TradeAboveCeiling(poolId, isBuy, grossToken, ceiling);
        }
    }

    /// @dev Which of the pool's two currencies the fee is denominated in.
    function _feeCurrencyOf(PoolKey calldata key, bool quoteIsZero, AgenRuleLib.FeeCurrency kind)
        private
        pure
        returns (Currency)
    {
        bool feeIsCurrency0 = kind == AgenRuleLib.FeeCurrency.Quote ? quoteIsZero : !quoteIsZero;
        return feeIsCurrency0 ? key.currency0 : key.currency1;
    }

    function _magnitude(int128 amount) private pure returns (uint256) {
        return amount < 0 ? uint256(uint128(-amount)) : uint256(uint128(amount));
    }

    function _requirePoolManager() private view {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);
    }

    /// @dev Everything about a key this hook's arithmetic depends on. Checked where the key
    /// enters the system, because a `PoolId` is a hash of the whole key — so a key validated
    /// at `configure` is necessarily the key that gets a pool.
    function _requireEngineKey(PoolKey calldata key) private view {
        if (!key.fee.isDynamicFee()) revert FeeNotDynamic(key.fee);
        if (key.tickSpacing != VerdantConstants.TICK_SPACING) {
            revert TickSpacingMismatch(key.tickSpacing, VerdantConstants.TICK_SPACING);
        }
        if (address(key.hooks) != address(this)) revert HookNotThis(key.hooks, address(this));
    }

    // --- callbacks this hook cannot receive ----------------------------------
    // `IHooks` declares all ten. The address bits deny these five, so v4 will never call
    // them; they exist to satisfy the interface, and inheriting it is what guarantees the
    // ones above have exactly the signatures v4 will call. They revert rather than
    // returning a selector so a future hook cannot inherit this one and quietly gain a
    // permission.

    /// @inheritdoc IHooks
    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert CallbackNotEnabled();
    }

    /// @inheritdoc IHooks
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }

    /// @inheritdoc IHooks
    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert CallbackNotEnabled();
    }

    /// @inheritdoc IHooks
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }

    /// @inheritdoc IHooks
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }
}
