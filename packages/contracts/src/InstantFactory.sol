// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {InstantDeployer} from "./InstantDeployer.sol";
import {InstantFeeVault} from "./InstantFeeVault.sol";
import {InstantHook} from "./InstantHook.sol";
import {MarketRegistry} from "./MarketRegistry.sol";
import {LaunchBounds} from "./libraries/LaunchBounds.sol";
import {VerdantConstants} from "./libraries/VerdantConstants.sol";

/// @title InstantFactory
/// @notice Creates an Instant market: a fixed-supply token, an ether-quoted v4 pool, the
/// whole supply in one permanently locked position, and a fee vault the creator and the
/// platform draw from in ether. One transaction, and afterwards nobody — not the creator,
/// not Agen — holds a privilege over any of it.
///
/// @dev **This is `VerdantFactory` with the choices taken out.** The launch sequence, the
/// locked position, the read-before/assert-after on the position id and the atomic first
/// buy are that contract's, deliberately unchanged, because they are the parts that have
/// been deployed and audited and there is nothing about Instant that wants them different.
/// What is gone is everything a creator would have had to decide: no model, no fee
/// schedule, no quote asset, no supply, no opening valuation, no allocation, no vesting.
/// ADR-014 argues that Instant is a preset rather than a model, and this is the shape of
/// that argument in Solidity — a `CreateParams` with seven fields, five of which are the
/// token's name and links.
///
/// It is a separate contract rather than a second instance of `VerdantFactory` because
/// that contract binds one hook, deploys a `FeeSplitter` per market and reads
/// `ModelRegistry.protocolBps()`, and Instant needs a different hook, an
/// `InstantFeeVault`, and a split that no registry setting can express. See ADR-014.
///
/// ## The liquidity is ordinary, on purpose
///
/// One one-sided position from `MIN_USABLE_TICK` to the opening tick, holding the entire
/// supply. Because the pool opens at the top of that range and buys can only push price
/// down into it, one constant-`L` position across the whole reachable range is `x*y=k`: an
/// Instant token trades like any other Uniswap token from its first block. A bespoke
/// aggression curve was built for this and rejected; ADR-014 records why.
///
/// ## No owner
///
/// It has no owner. Not a paused owner, not a two-step owner — no privileged address of
/// any kind, and so nothing to compromise and no key to lose. Every parameter that governs
/// a market is either a constant here or an immutable on the market's own contracts, fixed
/// at the block it was created in.
contract InstantFactory is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice What a creator chooses. Everything else about an Instant market is fixed.
    struct CreateParams {
        string name;
        string symbol;
        /// @dev Off-chain metadata location. May be empty. Never mutable — an Instant
        /// token has no privileged function at all, not even a URI setter.
        string metadataURI;
        /// @dev Where the creator's ether fees accrue. Often the creator, but a market may
        /// want a multisig, and it is fixed for the life of the market so it is asked for
        /// explicitly rather than defaulted to `msg.sender`.
        address feeRecipient;
        /// @dev Chosen by the creator, namespaced by their address, so a vanity token
        /// address is available without one creator being able to occupy another's.
        bytes32 salt;
        /// @dev Wei to spend on the market immediately, sent as `msg.value`. Zero means
        /// the pool opens one-sided and nothing is bought.
        uint128 initialBuyAmount;
        /// @dev The floor on tokens received from that buy. The launch reverts in whole if
        /// the pool cannot meet it.
        uint128 initialBuyMinTokens;
    }

    /// @notice What a launch produced.
    struct Created {
        address token;
        PoolId poolId;
        address vault;
        address locker;
        uint256 positionTokenId;
        uint128 liquidity;
        /// @dev Tokens the creator's first buy delivered to them. Zero when
        /// `initialBuyAmount` was zero.
        uint256 initialBuyTokens;
    }

    struct InitialBuy {
        PoolKey key;
        address creator;
        uint128 amountIn;
        uint128 minTokens;
    }

    // --- what every Instant market is ------------------------------------------

    /// @notice A billion tokens, always.
    ///
    /// @dev Not a parameter, and the reason is the one `apps/agen`'s launch screen gives
    /// for not having the field: a token that has never traded has no price to discover,
    /// so a supply typed into a form is either the default or a guess, and two markets
    /// whose creators guessed differently cannot be compared on a page that lists both.
    /// Holding it here rather than in the caller makes it true of every Instant market
    /// rather than of every market the interface happened to create.
    uint256 public constant SUPPLY_TOKENS = 1_000_000_000;

    /// @notice The supply in base units.
    uint256 public constant SUPPLY = SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE;

    /// @notice The tick every Instant pool opens at, and the top of the locked range.
    ///
    /// @dev A billion tokens at one and a half ether. Fixed for the same reason as the
    /// supply, and it is a grid point: `203_200` is divisible by the tick spacing of 200.
    /// `packages/config` holds the same number for everything off chain to read, and the
    /// SDK parity test checks the valuation formula still derives exactly this.
    int24 public constant INITIAL_TICK = 203_200;

    /// @dev `ModelRegistry`'s index for the single-stage model. Recorded so the registry
    /// row reads the same as a Verdant one; nothing here consults a model.
    uint8 internal constant FIXED_MODEL = 0;

    // --- wiring ----------------------------------------------------------------

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    InstantHook public immutable hook;

    /// @notice Holds the bytecode of a market's three contracts.
    /// @dev A separate address for a size reason, not an architectural one.
    InstantDeployer public immutable deployer;

    /// @notice Instant's own registry.
    ///
    /// @dev A second `MarketRegistry`, not the one Verdant writes to: that contract's
    /// `writer` is an immutable pointing at `VerdantFactory`, so this one could not write
    /// to it even if the two should share a table. They should not — an Instant market's
    /// fees are not divisible into the `creatorBps`/`protocolBps` the row carries.
    MarketRegistry public immutable marketRegistry;

    /// @notice Where the platform's half-percent accrues.
    /// @dev Immutable, and each market's vault snapshots it at creation, so this address
    /// is not a lever over markets that already exist.
    address public immutable treasury;

    // --- events and failures ----------------------------------------------------

    event MarketCreated(
        PoolId indexed poolId,
        address indexed token,
        address indexed creator,
        address vault,
        address locker,
        uint256 positionTokenId,
        uint128 liquidity
    );

    error ZeroPoolManager();
    error ZeroPositionManager();
    error ZeroMarketRegistry();
    error ZeroTreasury();
    error ZeroFeeRecipient();
    error HookNotBoundToThisFactory(address hook, address boundTo);
    error PoolManagerMismatch(address hookPoolManager, address poolManager);
    error PositionManagerMismatch(address hookPositionManager, address positionManager);
    error DeployerNotBoundToThisFactory(address deployer, address boundTo);
    error RegistryNotWritableByThisFactory(address registry, address writer);
    error NameLengthOutOfBounds(uint256 length, uint256 min, uint256 max);
    error SymbolLengthOutOfBounds(uint256 length, uint256 min, uint256 max);
    error MetadataURITooLong(uint256 length, uint256 max);
    error PositionNotLocked(uint256 tokenId, address owner, address locker);
    error InitialBuyValueMismatch(uint256 value, uint128 initialBuyAmount);
    error InitialBuyBelowMinimum(uint256 received, uint128 minTokens);
    error NotPoolManager(address caller);
    error NativeRefundFailed(address creator, uint256 amount);

    constructor(
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        InstantHook hook_,
        InstantDeployer deployer_,
        MarketRegistry marketRegistry_,
        address treasury_
    ) {
        if (address(poolManager_) == address(0)) revert ZeroPoolManager();
        if (address(positionManager_) == address(0)) revert ZeroPositionManager();
        if (address(marketRegistry_) == address(0)) revert ZeroMarketRegistry();
        if (treasury_ == address(0)) revert ZeroTreasury();

        if (hook_.factory() != address(this)) {
            revert HookNotBoundToThisFactory(address(hook_), hook_.factory());
        }
        if (address(hook_.poolManager()) != address(poolManager_)) {
            revert PoolManagerMismatch(address(hook_.poolManager()), address(poolManager_));
        }
        if (hook_.positionManager() != address(positionManager_)) {
            revert PositionManagerMismatch(hook_.positionManager(), address(positionManager_));
        }

        if (deployer_.factory() != address(this)) {
            revert DeployerNotBoundToThisFactory(address(deployer_), deployer_.factory());
        }
        if (marketRegistry_.writer() != address(this)) {
            revert RegistryNotWritableByThisFactory(address(marketRegistry_), marketRegistry_.writer());
        }

        poolManager = poolManager_;
        positionManager = positionManager_;
        hook = hook_;
        deployer = deployer_;
        marketRegistry = marketRegistry_;
        treasury = treasury_;
    }

    /// @notice Create an Instant market. The caller is its creator.
    ///
    /// @dev The order is `VerdantFactory`'s and the security argument is the same one:
    ///
    ///  1. **Validate first.** Nothing is deployed until every parameter is accepted, so a
    ///     rejected launch leaves no orphaned contracts for anyone to mistake for a market.
    ///  2. **Token, vault, locker.** In that order, because each names the previous. The
    ///     locker needs the position's id, read from the PositionManager *before* minting
    ///     and asserted *after*.
    ///  3. **Register the vault with the hook, then initialise.** v4 carries no hook data
    ///     through `initialize`, so the hook is told about the vault first and its
    ///     `beforeInitialize` refuses a pool that has none.
    ///  4. **Mint the locked position.** Directly to the locker — it is never owned by the
    ///     factory, so there is no instant in which it could be sent anywhere else.
    ///  5. **Return the dust, and hold nothing.**
    ///  6. **Register.** So the public record only ever describes a market that exists.
    ///  7. **Buy.** After the record and after the event, so an indexer sees the market
    ///     before it sees the first trade in it, and so the swap is the last thing that can
    ///     revert rather than the first.
    ///
    /// `nonReentrant` because step 7 hands control back to the creator — the refund of an
    /// unspent first buy, and the tokens taken to them — and a second `create` running
    /// inside the first would be minting against a position id the outer call has claimed.
    function create(CreateParams calldata params) external payable nonReentrant returns (Created memory created) {
        _validate(params);

        if (msg.value != params.initialBuyAmount) {
            revert InitialBuyValueMismatch(msg.value, params.initialBuyAmount);
        }

        PoolKey memory key = _deployMarketContracts(params, created);
        _openMarket(created, key);
        _returnDust(created.token);
        _register(created);

        emit MarketCreated(
            created.poolId,
            created.token,
            msg.sender,
            created.vault,
            created.locker,
            created.positionTokenId,
            created.liquidity
        );

        created.initialBuyTokens = _initialBuy(params, key);
    }

    /// @notice The PoolManager's callback for the creator's first buy.
    ///
    /// @dev Not part of this contract's interface in any useful sense — it exists because
    /// v4 will not let anybody touch a pool outside a lock, and the only thing that ever
    /// reaches it is `_initialBuy`, by way of `poolManager.unlock`. `unlock` calls back
    /// whoever called it, so the check on `msg.sender` is what makes that the only route.
    ///
    /// The buy pays the 1.50% like any other trade: the hook takes it from the ether leg
    /// on the way in, so `spent` here is already net of the fee and the creator's own
    /// launch buy funds the first entry in their own vault.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);

        InitialBuy memory buy = abi.decode(data, (InitialBuy));

        BalanceDelta delta = poolManager.swap(
            buy.key,
            SwapParams({
                zeroForOne: true,
                // forge-lint: disable-next-line(unsafe-typecast) -- a uint128 widened, not truncated
                amountSpecified: -int256(uint256(buy.amountIn)),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );

        // forge-lint: disable-next-line(unsafe-typecast) -- a negated int128 that v4 guarantees is non-positive
        uint256 spent = uint256(uint128(-delta.amount0()));
        // forge-lint: disable-next-line(unsafe-typecast) -- an int128 v4 guarantees is non-negative
        uint256 bought = uint256(uint128(delta.amount1()));

        if (bought < buy.minTokens) revert InitialBuyBelowMinimum(bought, buy.minTokens);

        _settle(spent);
        poolManager.take(buy.key.currency1, buy.creator, bought);
        _refund(buy.creator, buy.amountIn - spent);

        return abi.encode(bought);
    }

    // --- views ------------------------------------------------------------------

    /// @notice The salt a creator's chosen one becomes, namespaced by their address.
    /// @dev So a vanity address is available to everyone without one creator being able to
    /// occupy another's.
    function saltFor(address creator, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    /// @notice The pool an Instant token trades in.
    /// @dev Ether is always `currency0` — it is the zero address, so every token sorts
    /// above it and no launch has to search salts for the ordering v4 requires. The fee
    /// field is the dynamic flag because the hook sets the LP fee, to zero, on every swap.
    function poolKeyFor(address token) public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    // --- the launch, in order ---------------------------------------------------

    function _deployMarketContracts(CreateParams calldata params, Created memory created)
        private
        returns (PoolKey memory key)
    {
        bytes32 salt = saltFor(msg.sender, params.salt);

        created.token = address(
            deployer.deployToken(salt, params.name, params.symbol, SUPPLY, msg.sender, params.metadataURI, false)
        );

        key = poolKeyFor(created.token);
        created.poolId = key.toId();

        created.vault = address(deployer.deployVault(salt, address(hook), poolManager, params.feeRecipient, treasury));

        created.positionTokenId = positionManager.nextTokenId();
        created.locker = address(
            deployer.deployLocker(
                salt, positionManager, created.positionTokenId, created.vault, key.currency0, key.currency1
            )
        );
    }

    function _openMarket(Created memory created, PoolKey memory key) private {
        hook.register(key, InstantFeeVault(payable(created.vault)));
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(INITIAL_TICK));

        created.liquidity = _mintLockedPosition(created.token, key, created.locker);

        address owner = IERC721(address(positionManager)).ownerOf(created.positionTokenId);
        if (owner != created.locker) revert PositionNotLocked(created.positionTokenId, owner, created.locker);
    }

    /// @dev The mint, as three periphery actions, identical to `VerdantFactory`'s.
    ///
    /// `MINT_POSITION` names the locker as owner directly. `SETTLE` pays the token side
    /// from the PositionManager's own balance — the tokens were transferred there a line
    /// earlier — which avoids Permit2 entirely: an allowance would be a standing approval
    /// on a contract that needs one for a single call. `SWEEP` returns what converting the
    /// supply into a whole number of liquidity units left over.
    ///
    /// `amount0Max: 0` is the assertion that no ether is required. It holds because the
    /// pool opens at exactly `INITIAL_TICK` and the position's range ends there: v4 puts a
    /// position whose upper tick is at or below the current tick entirely in `currency1`.
    /// If that ever stopped being true the mint would revert here rather than silently ask
    /// the factory for ether it does not have.
    function _mintLockedPosition(address token, PoolKey memory key, address locker)
        private
        returns (uint128 liquidity)
    {
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(VerdantConstants.MIN_USABLE_TICK);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(INITIAL_TICK);

        uint256 liquidity256 = LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, SUPPLY);
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by v4's own uint128 liquidity
        liquidity = uint128(liquidity256);

        IERC20(token).safeTransfer(address(positionManager), SUPPLY);

        bytes memory actions =
            abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE), uint8(Actions.SWEEP));

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            key,
            VerdantConstants.MIN_USABLE_TICK,
            INITIAL_TICK,
            liquidity256,
            uint128(0),
            // forge-lint: disable-next-line(unsafe-typecast) -- SUPPLY is 1e27, far inside uint128
            uint128(SUPPLY),
            locker,
            bytes("")
        );
        params[1] = abi.encode(key.currency1, ActionConstants.OPEN_DELTA, false);
        params[2] = abi.encode(key.currency1, address(this));

        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    /// @dev Hand back what could not be expressed as liquidity.
    ///
    /// Converting the supply into a whole number of liquidity units leaves a remainder —
    /// about nineteen thousand wei, or 2e-23 of a billion tokens — which `SWEEP` returned
    /// to this contract. It goes to the creator because it is theirs and because the
    /// alternative is a factory that accumulates dust from every launch. This is the only
    /// token an Instant creator receives at launch, and calling it an allocation would be
    /// a stretch of about twenty-three orders of magnitude.
    function _returnDust(address token) private {
        uint256 remaining = IERC20(token).balanceOf(address(this));
        if (remaining != 0) IERC20(token).safeTransfer(msg.sender, remaining);
    }

    /// @dev The public record of the market.
    ///
    /// `splitter` holds the vault, which is the same thing in the position the field
    /// describes: the address a creator claims their fees from.
    ///
    /// `creatorBps` and `protocolBps` are left at **zero**, and that is a deliberate
    /// refusal rather than an omission. They describe a division of one collected pot, and
    /// Instant's shares of the fee are two thirds and one third, which is not a whole
    /// number of basis points — the nearest, 6 667 and 3 333, pays 1.00005% and 0.49995%.
    /// ADR-014 rejects that encoding for governing the split and it is no better for
    /// reporting it. A reader that divides by zero fees gets an obviously wrong answer
    /// instead of a plausibly wrong one, and the authority is `InstantFees`.
    function _register(Created memory created) private {
        MarketRegistry.Market memory market;

        market.poolId = PoolId.unwrap(created.poolId);
        market.token = created.token;
        market.quoteAsset = address(0);
        market.creator = msg.sender;
        market.model = FIXED_MODEL;
        // forge-lint: disable-next-line(unsafe-typecast) -- uint40 holds timestamps to year 36812
        market.createdAt = uint40(block.timestamp);
        market.positionTokenId = created.positionTokenId;
        market.locker = created.locker;
        market.splitter = created.vault;

        marketRegistry.register(market);
    }

    function _initialBuy(CreateParams calldata params, PoolKey memory key) private returns (uint256) {
        if (params.initialBuyAmount == 0) return 0;

        bytes memory bought = poolManager.unlock(
            abi.encode(
                InitialBuy({
                    key: key,
                    creator: msg.sender,
                    amountIn: params.initialBuyAmount,
                    minTokens: params.initialBuyMinTokens
                })
            )
        );

        return abi.decode(bought, (uint256));
    }

    // --- validation and settlement ----------------------------------------------

    /// @dev Three lengths and an address. Everything else an Instant market could get
    /// wrong is a constant of this contract and cannot be passed in to be checked.
    function _validate(CreateParams calldata params) private pure {
        if (params.feeRecipient == address(0)) revert ZeroFeeRecipient();

        uint256 nameLength = bytes(params.name).length;
        if (nameLength < LaunchBounds.MIN_NAME_LENGTH || nameLength > LaunchBounds.MAX_NAME_LENGTH) {
            revert NameLengthOutOfBounds(nameLength, LaunchBounds.MIN_NAME_LENGTH, LaunchBounds.MAX_NAME_LENGTH);
        }

        uint256 symbolLength = bytes(params.symbol).length;
        if (symbolLength < LaunchBounds.MIN_SYMBOL_LENGTH || symbolLength > LaunchBounds.MAX_SYMBOL_LENGTH) {
            revert SymbolLengthOutOfBounds(symbolLength, LaunchBounds.MIN_SYMBOL_LENGTH, LaunchBounds.MAX_SYMBOL_LENGTH);
        }

        uint256 uriLength = bytes(params.metadataURI).length;
        if (uriLength > LaunchBounds.MAX_METADATA_URI_LENGTH) {
            revert MetadataURITooLong(uriLength, LaunchBounds.MAX_METADATA_URI_LENGTH);
        }
    }

    /// @dev Pay what the swap owes the PoolManager. Ether only, so there is nothing to
    /// snapshot with `sync` — the payment arrives with the call.
    function _settle(uint256 amount) private {
        poolManager.settle{value: amount}();
    }

    /// @dev Return the part of the first buy the pool did not take.
    function _refund(address creator, uint256 amount) private {
        if (amount == 0) return;

        // A bare call rather than `transfer`: the creator may be a contract whose receive
        // costs more than 2 300 gas, and a stipend that was a safety measure in 2018 is a
        // liveness bug now.
        //
        // Slither reads a `.call{value:}` to a non-constant address as sending ether to an
        // arbitrary destination. Here the destination is the caller: `creator` reaches this
        // function only from `msg.sender`, and the amount is the part of that same caller's
        // `msg.value` the pool did not take. The factory has no `receive` and no
        // `fallback`, so it holds no balance between calls for a stranger to aim this at.
        // slither-disable-next-line arbitrary-send-eth
        (bool ok,) = creator.call{value: amount}("");
        if (!ok) revert NativeRefundFailed(creator, amount);
    }
}
