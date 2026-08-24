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
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";

import {VerdantConstants} from "../../libraries/VerdantConstants.sol";
import {AgenRouted} from "../AgenRouted.sol";
import {AgenBuybackPot} from "./AgenBuybackPot.sol";
import {AgenEngineVault} from "./AgenEngineVault.sol";
import {AgenLargestHolderPot} from "./AgenLargestHolderPot.sol";
import {AgenRuleLib} from "./AgenRuleLib.sol";
import {AgenRuleLibV2, IAgenRuleValidatorV2} from "./AgenRuleLibV2.sol";
import {IAgenEngineHookV2} from "./IAgenEngineHookV2.sol";

import {IAgenTransferListener} from "./IAgenTransferListener.sol";

/// @title AgenEngineHookV2
/// @notice Engine v2's shared hook: v1's fee path, plus a per-wallet buy limit, a
/// time-weighted largest-holder pot, and a deferred buyback. New deployment; v1 is
/// untouched. ADR-019.
contract AgenEngineHookV2 is IHooks, AgenRouted, IAgenTransferListener, IAgenEngineHookV2 {
    using AgenRuleLib for AgenRuleLib.Stored;
    using AgenRuleLibV2 for AgenRuleLibV2.Stored;
    using CurrencyLibrary for Currency;
    using LPFeeLibrary for uint24;
    using PoolIdLibrary for PoolKey;

    uint160 internal constant REQUIRED_PERMISSIONS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    IPoolManager public immutable poolManager;
    address public immutable factory;
    address public immutable positionManager;

    /// @notice Where a configuration's checks live. Pure, stateless and immutable.
    /// @dev See `AgenRuleValidatorV2`. Held here so `store` can reach it, and pinned at
    /// construction so no configuration can ever be written against different rules.
    IAgenRuleValidatorV2 public immutable validator;

    // The holder weight ledger is deliberately not here. It lives on
    // `AgenLargestHolderPot`, which is the only thing that ever reads a weight — see that
    // contract's header. This hook forwards transfers to it and keeps none of the state.

    struct Market {
        AgenRuleLibV2.Stored rules;
        AgenEngineVault vault;
        bool quoteIsCurrency0;
        bytes32 configHash;
        address holderPot;
        address buybackPot;
        address token;
        bool swapping;
    }

    mapping(PoolId poolId => Market market) private _markets;
    mapping(address token => PoolId poolId) private _tokenMarket;

    event MarketConfigured(
        PoolId indexed poolId,
        uint8 engineVersion,
        bytes32 configHash,
        address vault,
        address launchedToken,
        address quoteAsset,
        uint8 feeCurrency
    );
    event MarketInitialized(PoolId indexed poolId, uint40 initTime);
    event FeeTaken(
        PoolId indexed poolId,
        bool isBuy,
        uint256 grossTokenAmount,
        uint256 grossQuoteAmount,
        uint24 feePpm,
        uint256 feeAmount
    );
    event BuybackArmed(PoolId indexed poolId, uint256 grossTokenAmount, uint256 trigger);

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
    error QuoteNotInPool(address quoteAsset, Currency currency0, Currency currency1);
    error VaultMismatch(address vault);
    error DistributionMismatch(uint256 slot);
    error TradeAboveCeiling(PoolId poolId, bool isBuy, uint256 attempted, uint128 ceiling);
    error NotMarketToken(address caller);
    error WrongPool(PoolId expected, PoolId provided);
    error ZeroValidator();

    constructor(
        IPoolManager poolManager_,
        address factory_,
        address positionManager_,
        address agenRouter_,
        IAgenRuleValidatorV2 validator_
    ) AgenRouted(agenRouter_) {
        uint160 bits = uint160(address(this)) & Hooks.ALL_HOOK_MASK;
        if (bits != REQUIRED_PERMISSIONS) {
            revert HookAddressMismatch(address(this), bits, REQUIRED_PERMISSIONS);
        }
        if (address(validator_) == address(0)) revert ZeroValidator();

        poolManager = poolManager_;
        factory = factory_;
        positionManager = positionManager_;
        validator = validator_;
    }

    function configure(PoolKey calldata key, AgenRuleLibV2.Config calldata config, AgenEngineVault vault)
        external
        returns (bytes32 configHash)
    {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        _requireEngineKey(key);

        PoolId poolId = key.toId();
        Market storage market = _markets[poolId];
        if (market.rules.base.configured) revert AlreadyConfigured(poolId);

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
        if (vault.recipientCount() != config.distribution.length) {
            revert DistributionMismatch(config.distribution.length);
        }

        address token = Currency.unwrap(quoteIsZero ? key.currency1 : key.currency0);
        address holderPot;
        address buybackPot;

        for (uint256 i = 0; i < config.distribution.length; i++) {
            if (vault.shareAt(i) != config.distribution[i].sharePpm) revert DistributionMismatch(i);
            uint8 kind = config.distribution[i].kind;
            if (kind == AgenRuleLibV2.KIND_LARGEST_HOLDER) {
                holderPot = vault.recipientAt(i);
            } else if (kind == AgenRuleLibV2.KIND_BUYBACK) {
                buybackPot = vault.recipientAt(i);
            }
        }

        market.rules.store(config, validator);
        market.vault = vault;
        market.quoteIsCurrency0 = quoteIsZero;
        market.token = token;
        market.holderPot = holderPot;
        market.buybackPot = buybackPot;
        _tokenMarket[token] = poolId;

        configHash = AgenRuleLibV2.hashConfig(config);
        market.configHash = configHash;

        if (holderPot != address(0)) {
            AgenLargestHolderPot pot = AgenLargestHolderPot(payable(holderPot));
            pot.bind(vault, poolId);
            // The pots hold the token only in transit. Neither may win the epoch.
            pot.exclude(holderPot);
            if (buybackPot != address(0)) pot.exclude(buybackPot);
        }
        if (buybackPot != address(0)) {
            AgenBuybackPot(payable(buybackPot)).bind(vault, poolId, token);
        }

        _emitConfigured(poolId, config, configHash, address(vault), token);
    }

    function _emitConfigured(
        PoolId poolId,
        AgenRuleLibV2.Config calldata config,
        bytes32 configHash,
        address vault,
        address token
    ) private {
        emit MarketConfigured(
            poolId, config.engineVersion, configHash, vault, token, config.quoteAsset, config.feeCurrency
        );
    }

    /// @notice Mark an address as a structural holder rather than a trader.
    /// @dev Forwarded to the pot, which owns the ledger. A market with no largest-holder
    /// recipient has no pot and nothing to exclude from, so this is a no-op there.
    function excludeHolder(PoolId poolId, address wallet) external {
        if (msg.sender != factory) revert NotFactory(msg.sender);

        address pot = _markets[poolId].holderPot;
        if (pot != address(0)) AgenLargestHolderPot(payable(pot)).exclude(wallet);
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160) external view override returns (bytes4) {
        _requirePoolManager();
        if (sender != factory) revert NotFactory(sender);

        uint160 bits = uint160(address(this)) & Hooks.ALL_HOOK_MASK;
        if (bits != REQUIRED_PERMISSIONS) {
            revert HookAddressMismatch(address(this), bits, REQUIRED_PERMISSIONS);
        }

        PoolId poolId = key.toId();
        if (!_markets[poolId].rules.base.configured) revert NotConfigured(poolId);
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata key, uint160, int24) external override returns (bytes4) {
        _requirePoolManager();
        PoolId poolId = key.toId();
        // forge-lint: disable-next-line(unsafe-typecast)
        uint40 initTime = uint40(block.timestamp);
        _markets[poolId].rules.base.recordInitTime(initTime);
        poolManager.updateDynamicLPFee(key, 0);
        emit MarketInitialized(poolId, initTime);
        return IHooks.afterInitialize.selector;
    }

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

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _requirePoolManager();

        PoolId poolId = key.toId();
        Market storage market = _markets[poolId];
        if (!market.rules.base.configured) revert NotConfigured(poolId);

        market.swapping = true;
        Shape memory shape = _shapeOf(market, params);

        if (shape.tokenIsSpecified) {
            _requireBelowCeiling(market, poolId, shape.side, shape.isBuy, shape.specified);
            _chargeWalletIfBuy(market, sender, hookData, shape.isBuy, shape.specified);
        }

        uint24 zeroLpFee = LPFeeLibrary.OVERRIDE_FEE_FLAG;
        if (!shape.feeIsSpecified) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, zeroLpFee);
        }

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

        // forge-lint: disable-next-line(unsafe-typecast)
        BeforeSwapDelta delta = toBeforeSwapDelta(int128(int256(fee)), 0);
        return (IHooks.beforeSwap.selector, delta, zeroLpFee);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external override returns (bytes4, int128) {
        _requirePoolManager();

        PoolId poolId = key.toId();
        Market storage market = _markets[poolId];
        if (!market.rules.base.configured) revert NotConfigured(poolId);

        Shape memory shape = _shapeOf(market, params);
        Charge memory swap = _grossOf(market, shape, delta);

        if (!shape.tokenIsSpecified) {
            _requireBelowCeiling(market, poolId, shape.side, shape.isBuy, swap.grossToken);
            _chargeWalletIfBuy(market, sender, hookData, shape.isBuy, swap.grossToken);
        }

        int128 owed;
        if (!shape.feeIsSpecified) {
            uint256 fee = _charge(market, poolId, key, swap);
            // forge-lint: disable-next-line(unsafe-typecast)
            owed = int128(int256(fee));
        }

        market.rules.base.accumulate(swap.grossQuote);
        if (!shape.isBuy) _armBuyback(market, poolId, swap.grossToken);

        market.swapping = false;
        return (IHooks.afterSwap.selector, owed);
    }

    /// @inheritdoc IAgenTransferListener
    /// @dev Forwarded to the market's holder pot, which owns the ledger. A market with no
    /// largest-holder recipient has no pot and does no bookkeeping at all, so its token
    /// transfers cost what an ordinary ERC-20's do.
    ///
    /// The caller is the token, established by looking the pool up by `msg.sender` rather
    /// than by believing an argument: an address that is not a launched token of this
    /// engine maps to the zero pool and is ignored.
    function onTokenTransfer(address from, address to, uint256 amount) external {
        PoolId poolId = _tokenMarket[msg.sender];
        if (PoolId.unwrap(poolId) == bytes32(0)) return;

        address pot = _markets[poolId].holderPot;
        if (pot == address(0)) return;

        AgenLargestHolderPot(payable(pot)).onTransfer(from, to, amount);
    }

    function feePpmFor(PoolId poolId, bool isBuy, uint256 grossTokenAmount) external view returns (uint24) {
        AgenRuleLib.Stored storage rules = _markets[poolId].rules.base;
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

    function implementationHashOf(PoolId poolId) external view returns (bytes32) {
        Market storage market = _markets[poolId];
        if (!market.rules.base.configured) revert NotConfigured(poolId);
        return AgenRuleLibV2.implementationHash(
            market.configHash, block.chainid, address(this), market.rules.base.engineVersion
        );
    }

    function engineVersionOf(PoolId poolId) external view returns (uint8) {
        return _markets[poolId].rules.base.engineVersion;
    }

    function epochOf(PoolId poolId, uint256 timestamp) public view returns (uint256) {
        return _markets[poolId].rules.epochOf(timestamp);
    }

    /// @notice Whether the per-wallet buy limit is in force right now.
    /// @dev What an interface needs to answer two questions a trader will ask: how much of
    /// their allowance is left, and whether this market can be reached by anything but
    /// Agen's router. Both stop being true at the same instant, because they are the same
    /// rule — see `_chargeWalletIfBuy`.
    function walletWindowOpen(PoolId poolId) external view returns (bool) {
        return _markets[poolId].rules.walletWindowOpen(block.timestamp);
    }

    /// @notice Tokens this wallet has bought while the window has been open.
    function boughtBy(PoolId poolId, address wallet) external view returns (uint128) {
        return _markets[poolId].rules.boughtBy(wallet);
    }

    /// @inheritdoc IAgenEngineHookV2
    function epochWindow(PoolId poolId) external view returns (uint256 initTime, uint32 period) {
        AgenRuleLibV2.Stored storage rules = _markets[poolId].rules;
        return (rules.base.initTime, rules.epochPeriodSeconds);
    }

    /// @notice The market's largest-holder pot, or the zero address where it has none.
    function holderPotOf(PoolId poolId) external view returns (address) {
        return _markets[poolId].holderPot;
    }

    /// @notice The market's buyback pot, or the zero address where it has none.
    function buybackPotOf(PoolId poolId) external view returns (address) {
        return _markets[poolId].buybackPot;
    }

    function inSwap(PoolId poolId) external view returns (bool) {
        return _markets[poolId].swapping;
    }

    function requireOwnPool(PoolId poolId, PoolKey calldata key) external view {
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId)) revert WrongPool(poolId, key.toId());
        if (address(key.hooks) != address(this)) revert HookNotThis(key.hooks, address(this));
    }

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

    struct Shape {
        bool isBuy;
        AgenRuleLib.Side side;
        bool tokenIsSpecified;
        bool feeIsSpecified;
        uint256 specified;
    }

    function _shapeOf(Market storage market, SwapParams calldata params) private view returns (Shape memory) {
        bool quoteIsZero = market.quoteIsCurrency0;
        bool isBuy = params.zeroForOne == quoteIsZero;
        bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;
        AgenRuleLib.FeeCurrency kind = market.rules.base.feeCurrency;
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

    struct Charge {
        AgenRuleLib.Side side;
        bool isBuy;
        uint256 grossToken;
        uint256 grossQuote;
        uint256 feeBase;
    }

    function _grossOf(Market storage market, Shape memory shape, BalanceDelta delta)
        private
        view
        returns (Charge memory)
    {
        bool quoteIsZero = market.quoteIsCurrency0;
        uint256 legZero = _magnitude(delta.amount0());
        uint256 legOne = _magnitude(delta.amount1());
        uint256 grossToken = shape.tokenIsSpecified ? shape.specified : (quoteIsZero ? legOne : legZero);
        uint256 grossQuote = shape.tokenIsSpecified ? (quoteIsZero ? legZero : legOne) : shape.specified;

        return Charge({
            side: shape.side,
            isBuy: shape.isBuy,
            grossToken: grossToken,
            grossQuote: grossQuote,
            feeBase: market.rules.base.feeCurrency == AgenRuleLib.FeeCurrency.Quote ? grossQuote : grossToken
        });
    }

    function _charge(Market storage market, PoolId poolId, PoolKey calldata key, Charge memory swap)
        private
        returns (uint256 fee)
    {
        uint24 feePpm = market.rules.base.feePpmFor(
            swap.side, swap.grossToken, market.rules.base.progressOf(block.timestamp)
        );
        fee = AgenRuleLib.feeOf(swap.feeBase, feePpm);
        if (fee == 0) return 0;

        Currency feeCurrency = _feeCurrencyOf(key, market.quoteIsCurrency0, market.rules.base.feeCurrency);
        AgenEngineVault vault = market.vault;
        poolManager.mint(address(vault), feeCurrency.toId(), fee);
        vault.credit(fee);
        emit FeeTaken(poolId, swap.isBuy, swap.grossToken, swap.grossQuote, feePpm, fee);
    }

    function _chargeWalletIfBuy(
        Market storage market,
        address sender,
        bytes calldata hookData,
        bool isBuy,
        uint256 tokens
    ) private {
        if (!isBuy || !market.rules.hasWalletLimit()) return;
        if (!market.rules.walletWindowOpen(block.timestamp)) return;

        /*
         * The market's own buyback is not a wallet, and holding it to the wallet rule makes
         * the two features mutually exclusive.
         *
         * The pot swaps by unlocking the PoolManager itself, so it arrives here as `sender`
         * with no hook data — which `_requireTrader` correctly refuses, because for a trader
         * that is exactly the unattributable swap the limit exists to stop. Applying it to
         * the pot meant a market with both a wallet cap and a buyback could arm a buyback
         * during the window and never execute it: every attempt reverted `TradeNotRouted`
         * until the window closed. That is the featured prompt, and its first twelve hours.
         *
         * Exempting the pot is safe in the way the router check is safe: `buybackPot` is
         * written once at `configure` from the vault's own recipient list and is immutable
         * after, so this is not "trust the caller", it is one known address that this hook
         * deployed the counterparty for. It also has nothing to gain — the pot buys with the
         * market's fees and burns what it receives.
         */
        if (sender == market.buybackPot) return;

        address trader = _requireTrader(sender, hookData);
        market.rules.chargeWalletBuy(trader, tokens);
    }

    function _armBuyback(Market storage market, PoolId poolId, uint256 grossToken) private {
        uint128 trigger = market.rules.buybackTriggerTokens;
        if (trigger == 0 || grossToken < trigger) return;
        address pot = market.buybackPot;
        if (pot == address(0)) return;
        AgenBuybackPot(payable(pot)).arm();
        emit BuybackArmed(poolId, grossToken, trigger);
    }

    function _requireBelowCeiling(
        Market storage market,
        PoolId poolId,
        AgenRuleLib.Side side,
        bool isBuy,
        uint256 grossToken
    ) private view {
        uint128 ceiling = market.rules.base.ceilingFor(side);
        if (ceiling != 0 && grossToken > ceiling) {
            revert TradeAboveCeiling(poolId, isBuy, grossToken, ceiling);
        }
    }

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

    function _requireEngineKey(PoolKey calldata key) private view {
        if (!key.fee.isDynamicFee()) revert FeeNotDynamic(key.fee);
        if (key.tickSpacing != VerdantConstants.TICK_SPACING) {
            revert TickSpacingMismatch(key.tickSpacing, VerdantConstants.TICK_SPACING);
        }
        if (address(key.hooks) != address(this)) revert HookNotThis(key.hooks, address(this));
    }

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

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }

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

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }
}
