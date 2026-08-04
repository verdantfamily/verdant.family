// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {MarketRegistry} from "./MarketRegistry.sol";
import {ModelRegistry} from "./ModelRegistry.sol";
import {VerdantDeployer} from "./VerdantDeployer.sol";
import {VerdantHook} from "./VerdantHook.sol";
import {LaunchBounds} from "./libraries/LaunchBounds.sol";
import {ScheduleLib} from "./libraries/ScheduleLib.sol";
import {VerdantConstants} from "./libraries/VerdantConstants.sol";

/// @title VerdantFactory
/// @notice Creates a Verdant market: a token, a pool, a permanently locked
/// position, a fee split and a public record — in one transaction, or none of it.
///
/// @dev The atomicity is the product. Every launchpad failure that matters happens
/// in a gap: a token that exists before its pool, a pool that exists before its
/// liquidity, liquidity that exists before it is locked. Each gap is a window in
/// which the creator can do something other than what they announced, and in which
/// somebody else can trade against a market that is not yet what it claims to be.
/// `create` closes all of them by construction — there is no state in which a
/// Verdant token exists and its market does not, because the same call that mints
/// the supply also puts it into a locked position or reverts.
///
/// ## What this contract can and cannot do
///
/// It has **no owner**. Not a paused owner, not a two-step owner — no privileged
/// address of any kind, and therefore no function that treats one caller
/// differently from another. Everything it can do, it does during creation.
///
/// It never holds anything once a call has returned. Supply arrives here and leaves
/// in the same call: to the PositionManager as liquidity, to a vesting contract, or
/// to the creator. What is left after the position is minted is transferred in whole
/// rather than by calculation, so there is no arithmetic that could leave a
/// remainder behind. The quote asset a creator sends for their first buy is subject
/// to the same rule — whatever the pool does not take is returned before the call
/// ends, because a factory that can finish a transaction holding somebody's money
/// is a factory that needs a function to get it back out.
///
/// It is the only address that can create a Verdant market, and that is enforced
/// by the hook rather than claimed here: `VerdantHook.configure`,
/// `beforeInitialize` and `beforeAddLiquidity` each check this address, so a pool
/// carrying the Verdant hook cannot exist unless it came through this function.
///
/// ## Why the hook is a constructor argument
///
/// The hook must know the factory (it authenticates against it) and the factory
/// must know the hook (it names it in every pool key), which reads like a cycle
/// and is not one. The hook's address is mined, so it is fixed by its constructor
/// arguments; the factory's is not, because it is deployed with plain `CREATE`,
/// whose address depends only on the deployer and a nonce. So the factory's
/// address is predicted, the hook is mined against it, and then the factory is
/// deployed naming the hook. The constructor below asserts the round trip closed —
/// `hook.factory() == address(this)` — which turns a wrong prediction into a failed
/// deployment instead of a live factory that cannot create anything.
///
/// The alternative, a one-time `setHook`, would leave a window in which the
/// factory's most important reference is mutable, and a contract with one setter
/// has to be argued about differently from one with none.
///
/// ## The shape of a launch
///
/// The position is one-sided. It holds only the token, spanning from the bottom of
/// the tick range up to the price the pool opens at, so nothing has to be paid in to
/// mint it and the first buyer is the first source of the quote asset in the pool.
/// Because the pool opens exactly at the top of the range, the amount of the quote
/// asset the position needs at mint is zero — not approximately zero — and
/// `amount0Max: 0` on the mint asserts that rather than assuming it.
///
/// ## The first buy happens inside the launch
///
/// `create` is payable, takes an `initialBuyAmount`, and spends it on the market it
/// has just opened before it returns. The reason is not that one signature is nicer
/// than two.
///
/// It is that a pool opened with one-sided liquidity and left alone for a block is a
/// standing invitation. The opening tick is the best price the market will ever
/// offer, the transaction that created it is public the moment it is mined, and
/// anybody reading the chain can take that price before the creator's own buy
/// arrives. A creator who launches and then buys is bidding against whoever was
/// faster, on a market they funded, at a price they set for themselves. Performing
/// the buy in the same call does not narrow that window; it removes it, because
/// there is no block in which the market exists at its opening price and the
/// creator has not yet bought.
///
/// The buy is an ordinary swap and is treated as one. The hook charges it the
/// schedule's stage-zero fee, that fee accrues to the locked position like every
/// other trade's, and the PoolManager emits the same `Swap` event — so the creator
/// pays the launch fee on their own first buy, and an indexer needs nothing new to
/// read it.
///
/// `initialBuyAmount` of zero is allowed, and means the shape above without the
/// buy: the pool opens one-sided and nothing is delivered. See
/// docs/decisions/009-the-first-buy-is-part-of-the-launch.md for why the factory
/// sets no floor on it.
///
/// ## What a market is quoted in
///
/// Either native ether, or an ERC-20 that `ModelRegistry` has admitted — in
/// practice one of Robinhood Chain's own tokenized equities. The choice is the
/// creator's, it is checked once here, and it is then part of the pool key and
/// therefore unchangeable.
///
/// The launch token is always `currency1`, whichever it is. v4 orders a pair by
/// address, so for an equity-quoted market that is a real constraint rather than a
/// convention: the token this factory is about to create must sort above the equity.
/// It does, because the creator chose a salt that makes it so — `saltFor` and
/// `VerdantDeployer.tokenInitCodeHash` are what let them find one before sending
/// the transaction, and `TokenNotAboveQuote` is what happens if they did not.
/// Everything downstream, from the locked position's one-sided range to the
/// indexer's reading of a swap, is written once against that invariant instead of
/// twice against both orderings. See
/// docs/decisions/008-the-launch-token-is-currency1.md.
contract VerdantFactory is IUnlockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    /// @notice Everything a creator chooses about a market.
    ///
    /// @dev One struct rather than fifteen arguments, because a launch is
    /// configuration and configuration read positionally is configuration entered
    /// wrongly. It also means the SDK, the tests and the interface all name the
    /// same fields.
    struct CreateParams {
        string name;
        string symbol;
        /// @dev Off-chain metadata location. May be empty.
        string metadataURI;
        /// @dev Whether the creator may edit `metadataURI` later. Immutable once
        /// chosen, and disclosed by the token itself.
        bool metadataMutable;
        /// @dev In whole tokens. The factory scales by 1e18.
        uint256 supplyTokens;
        /// @dev Index into `ModelRegistry`'s models.
        uint8 model;
        /// @dev What the market is quoted in: `address(0)` for native ether, or an
        /// ERC-20 the registry has admitted. Becomes the pool's `currency0`.
        address quoteAsset;
        /// @dev The fee schedule, offsets measured from the pool's initialisation.
        ScheduleLib.Stage[] stages;
        /// @dev The tick the pool opens at, and the top of the locked position's
        /// range. Sets the launch price: higher means more tokens per unit of the
        /// quote asset, so a cheaper token.
        int24 initialTick;
        /// @dev Share of supply withheld from the position for the creator.
        uint16 creatorAllocationBps;
        /// @dev Seconds before any of the creator's allocation is releasable.
        uint64 vestingCliff;
        /// @dev Seconds over which it releases. Zero means no vesting contract at
        /// all and the allocation is transferred outright.
        uint64 vestingDuration;
        /// @dev Where the creator's share of trading fees is paid. Often the
        /// creator, but a market may want a multisig or a splitter of its own, and
        /// it is fixed for the life of the market so it is asked for explicitly.
        address feeRecipient;
        /// @dev Chosen by the creator, namespaced by their address, so a vanity
        /// token address is available without one creator being able to occupy
        /// another's.
        bytes32 salt;
        /// @dev How much of the quote asset to spend on the market immediately, in
        /// the quote asset's own units — wei for an ether-quoted market, base units
        /// of the equity otherwise. Sent as `msg.value` when the quote is ether and
        /// pulled by `transferFrom` when it is not. Zero means the pool opens
        /// one-sided and nothing is bought.
        uint128 initialBuyAmount;
        /// @dev The floor on tokens received from that buy. The launch reverts in
        /// whole if the pool cannot meet it, so a creator can bound what they
        /// accept rather than discovering it afterwards.
        uint128 initialBuyMinTokens;
    }

    /// @notice What a launch produced.
    struct Created {
        address token;
        PoolId poolId;
        address splitter;
        address locker;
        /// @dev `address(0)` when the creator configured no vesting.
        address vesting;
        uint256 positionTokenId;
        uint128 liquidity;
        /// @dev Tokens the creator's first buy delivered to them. Zero when
        /// `initialBuyAmount` was zero.
        uint256 initialBuyTokens;
    }

    /// @dev Everything `unlockCallback` needs, carried through `poolManager.unlock`
    /// as calldata rather than written to storage between the two calls. Storage
    /// that exists only inside one transaction is still storage another call in that
    /// transaction could be made to read, and this struct names a recipient.
    struct InitialBuy {
        PoolKey key;
        address creator;
        uint128 amountIn;
        uint128 minTokens;
    }

    // --- immutables ----------------------------------------------------------

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    VerdantHook public immutable hook;

    /// @notice Holds the bytecode of a market's four contracts.
    /// @dev A separate address for a size reason, not an architectural one — see
    /// `VerdantDeployer`. It deploys only on this contract's instruction.
    VerdantDeployer public immutable deployer;
    ModelRegistry public immutable modelRegistry;
    MarketRegistry public immutable marketRegistry;

    /// @notice Where the protocol's share of every market's fees is paid.
    /// @dev Immutable, and per-market splitters snapshot it at creation, so this
    /// address is not a lever over markets that already exist.
    address public immutable treasury;

    /// @notice A market was created.
    /// @dev Carries the addresses an indexer needs to follow the market without
    /// reading the registry, because this event is emitted in the same transaction
    /// the token first appears in and is therefore the earliest complete record.
    event MarketCreated(
        PoolId indexed poolId,
        address indexed token,
        address indexed creator,
        uint8 model,
        address quoteAsset,
        address splitter,
        address locker,
        address vesting,
        uint256 positionTokenId,
        uint128 liquidity
    );

    // --- errors --------------------------------------------------------------

    error ZeroPoolManager();
    error ZeroPositionManager();
    error ZeroModelRegistry();
    error ZeroMarketRegistry();
    error ZeroTreasury();
    error ZeroFeeRecipient();

    /// @notice The hook named at construction does not authenticate this address.
    /// @dev The address prediction was wrong, or the hook was mined against a
    /// different factory. Either way the pair would be inert, so it never deploys.
    error HookNotBoundToThisFactory(address hook, address hookFactory);

    /// @notice The hook and the factory disagree about which PoolManager they use.
    error PoolManagerMismatch(address hookPoolManager, address poolManager);

    /// @notice The hook and the factory disagree about which PositionManager may
    /// add liquidity.
    error PositionManagerMismatch(address hookPositionManager, address positionManager);

    /// @notice The deployer named at construction takes instructions from a
    /// different address.
    error DeployerNotBoundToThisFactory(address deployer, address deployerFactory);

    /// @notice The market registry named at construction accepts writes from a
    /// different address.
    error RegistryNotWritableByThisFactory(address registry, address writer);

    /// @notice `ModelRegistry` refused this combination: creation is paused, the
    /// model is disabled, or the stage count is outside the model's bounds.
    /// @dev One error for all of them because the registry answers with one
    /// boolean; the interface reads the registry directly to say which.
    error CreationNotAllowed(uint8 model, uint256 stageCount);

    /// @notice `ModelRegistry` has not admitted this asset as a quote side.
    /// @dev Ether is admitted unconditionally, so this is only ever an ERC-20 — one
    /// that was never reviewed, or one that has since been withdrawn for new
    /// markets. Existing markets quoted in it are unaffected; nothing here can
    /// reach them.
    error QuoteAssetNotAdmitted(address quoteAsset);

    /// @notice The token's address does not sort above the quote asset's, so the
    /// token would be `currency0` and the market would be inverted.
    /// @dev Recoverable by the creator alone, and cheaply: choose another salt. The
    /// interface does that before it ever sends a transaction, so reaching this is
    /// either a hand-built call or a launch whose parameters changed after the salt
    /// was mined. Roughly half of all salts satisfy it.
    error TokenNotAboveQuote(address token, address quoteAsset);

    error NameLengthOutOfBounds(uint256 length, uint256 min, uint256 max);
    error SymbolLengthOutOfBounds(uint256 length, uint256 min, uint256 max);
    error MetadataURITooLong(uint256 length, uint256 max);
    error SupplyOutOfBounds(uint256 supplyTokens, uint256 min, uint256 max);
    error CreatorAllocationTooLarge(uint16 bps, uint16 max);

    /// @notice The opening tick is not on the pool's own tick grid, or is outside
    /// the range Verdant pools use.
    error InitialTickInvalid(int24 tick);

    error VestingDurationOutOfBounds(uint64 duration, uint64 min, uint64 max);

    /// @notice A vesting schedule was configured for an allocation of zero.
    /// @dev Refused rather than ignored: it deploys a contract that can never pay
    /// anybody, and it is a strong signal the creator meant to allocate something.
    error VestingWithoutAllocation();

    /// @notice The chosen supply and opening tick produce no liquidity at all.
    /// @dev Reachable only at the extremes — a minimum supply opened at the very
    /// bottom of the tick range — and it would mint a position that cannot be
    /// traded against.
    error NoLiquidity(uint256 amount, int24 initialTick);

    /// @notice The minted position is not owned by this market's locker.
    /// @dev Unreachable through the code below; asserted because the entire
    /// permanence claim rests on it, and an assertion that never fires is the
    /// cheapest kind.
    error PositionNotLocked(uint256 tokenId, address owner, address locker);

    /// @notice The ether sent is not the amount the launch says it will buy with.
    /// @dev Both directions are refused, and the equal case includes zero: a launch
    /// that buys nothing must send nothing. Accepting a mismatch would mean either
    /// buying with ether the creator did not offer or keeping ether they did.
    error InitialBuyValueMismatch(uint256 value, uint128 initialBuyAmount);

    /// @notice Ether was sent with a launch whose quote asset is an ERC-20.
    /// @dev There is nothing in such a launch that ether can pay for — the buy is
    /// settled in the equity — so ether here is a creator who has misread the form,
    /// and keeping it would strand it in a contract with no way to send it back.
    error NativeSentForTokenQuote(address quoteAsset, uint256 value);

    /// @notice The quote asset delivered less than it was asked to transfer.
    /// @dev The admitted set is supposed to exclude fee-on-transfer tokens, and this
    /// is where that assumption is checked instead of trusted. A short delivery here
    /// would otherwise surface as a swap that settles less than it spends, with the
    /// difference taken out of the creator's refund.
    error QuoteAmountNotReceived(address quoteAsset, uint256 received, uint128 expected);

    /// @notice The first buy would deliver fewer tokens than the creator accepted.
    /// @dev Reverts the launch in whole rather than the buy alone. A creator who
    /// named a floor was describing the market they wanted to exist, and a market
    /// that opened without it is one they cannot undo.
    error InitialBuyBelowMinimum(uint256 received, uint128 minTokens);

    /// @notice Something other than the PoolManager called `unlockCallback`.
    /// @dev The PoolManager only ever calls back the address that called `unlock`,
    /// so a caller other than it is a direct call from outside a lock, where the
    /// swap below would be settling against nothing.
    error NotPoolManager(address caller);

    /// @notice Returning the unspent part of the first buy to the creator failed.
    /// @dev Carries the creator because the only way this happens is an address that
    /// rejects ether, and knowing which one is the whole diagnosis.
    error NativeRefundFailed(address creator, uint256 amount);

    constructor(
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        VerdantHook hook_,
        VerdantDeployer deployer_,
        ModelRegistry modelRegistry_,
        MarketRegistry marketRegistry_,
        address treasury_
    ) {
        if (address(poolManager_) == address(0)) revert ZeroPoolManager();
        if (address(positionManager_) == address(0)) revert ZeroPositionManager();
        if (address(modelRegistry_) == address(0)) revert ZeroModelRegistry();
        if (address(marketRegistry_) == address(0)) revert ZeroMarketRegistry();
        if (treasury_ == address(0)) revert ZeroTreasury();

        // The three checks that make this factory and that hook one system rather
        // than two contracts that happen to reference each other. All three are
        // reads of the hook's immutables, so they cannot become false later.
        if (hook_.factory() != address(this)) {
            revert HookNotBoundToThisFactory(address(hook_), hook_.factory());
        }
        if (address(hook_.poolManager()) != address(poolManager_)) {
            revert PoolManagerMismatch(address(hook_.poolManager()), address(poolManager_));
        }
        if (hook_.positionManager() != address(positionManager_)) {
            revert PositionManagerMismatch(hook_.positionManager(), address(positionManager_));
        }

        // The same argument, for the two contracts that were also deployed against
        // this address before it existed. Between them these four checks mean a
        // deployed factory is either wired to every one of its counterparties or
        // does not exist.
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
        modelRegistry = modelRegistry_;
        marketRegistry = marketRegistry_;
        treasury = treasury_;
    }

    /// @notice Create a market. The caller is its creator.
    ///
    /// @dev The order of the steps below is the security argument, so it is worth
    /// stating why it is this order:
    ///
    ///  1. **Validate everything first.** Nothing is deployed until every
    ///     parameter has been accepted, so a rejected launch leaves no orphaned
    ///     contracts on chain for anyone to mistake for a market.
    ///  2. **Token, splitter, locker.** In that order, because each names the
    ///     previous. The locker needs the position's id, which is read from the
    ///     PositionManager *before* minting and asserted *after*.
    ///  3. **Configure, then initialise.** v4 carries no hook data through
    ///     `initialize`, so the schedule is written first and `beforeInitialize`
    ///     refuses a pool that has none. See V15 in docs/verification.md.
    ///  4. **Mint the locked position.** Directly to the locker — the position is
    ///     never owned by the factory, so there is no instant in which it could be
    ///     sent anywhere else.
    ///  5. **Distribute the remainder, and assert nothing is left.**
    ///  6. **Register.** Last, so the public record only ever describes a market
    ///     that fully exists.
    ///  7. **Buy.** After the record and after the event, so that an indexer sees
    ///     the market before it sees the first trade in it, and so that the swap is
    ///     the last thing that can revert rather than the first.
    ///
    /// `nonReentrant` because step 7 hands control to the quote asset — an equity's
    /// `transferFrom`, and its `transfer` inside the settlement — and a second
    /// `create` running inside the first would be minting a position against a
    /// PositionManager token id the outer call has already claimed.
    function create(CreateParams calldata params) external payable nonReentrant returns (Created memory created) {
        _validate(params);
        _collectQuote(params);

        // Snapshotted here, once. The registry may change afterwards; this market
        // is priced on what it said today.
        uint16 protocolBps = modelRegistry.protocolBps();

        uint256 supply = params.supplyTokens * LaunchBounds.TOKEN_SCALE;
        uint256 creatorAmount = (supply * params.creatorAllocationBps) / LaunchBounds.BPS_DENOMINATOR;
        if (params.vestingDuration != 0 && creatorAmount == 0) revert VestingWithoutAllocation();

        PoolKey memory key = _deployMarketContracts(params, created, supply, protocolBps);
        _openMarket(params, created, key, supply - creatorAmount);
        created.vesting = _distribute(created.token, msg.sender, creatorAmount, params);

        _register(params, created, protocolBps);

        emit MarketCreated(
            created.poolId,
            created.token,
            msg.sender,
            params.model,
            params.quoteAsset,
            created.splitter,
            created.locker,
            created.vesting,
            created.positionTokenId,
            created.liquidity
        );

        created.initialBuyTokens = _initialBuy(params, key);
    }

    /// @notice The PoolManager's callback for the creator's first buy.
    ///
    /// @dev Not part of this contract's interface in any useful sense — it exists
    /// because v4 will not let anybody touch a pool outside a lock, and the only
    /// thing that ever reaches it is `_initialBuy` below, by way of
    /// `poolManager.unlock`. `unlock` calls back whoever called it, so the check on
    /// `msg.sender` is what makes that the only route: a direct call from anywhere
    /// else would be swapping outside a lock, where the deltas this function settles
    /// do not exist.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);

        InitialBuy memory buy = abi.decode(data, (InitialBuy));

        BalanceDelta delta = poolManager.swap(
            buy.key,
            SwapParams({
                // The launch token is always `currency1`, so a buy is always
                // `zeroForOne`. See docs/decisions/008-the-quote-asset-is-a-parameter.md.
                zeroForOne: true,
                // Negative is exact input: spend at most this much of the quote
                // asset, whatever that turns out to buy.
                // forge-lint: disable-next-line(unsafe-typecast) -- a uint128 widened, not truncated
                amountSpecified: -int256(uint256(buy.amountIn)),
                // The extreme rather than a chosen limit. A price bound here would
                // be a second, silent slippage control on top of the creator's own
                // `initialBuyMinTokens`, and the one they can see is the one that
                // should decide.
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );

        // For an exact-input `zeroForOne` swap the pool owes us `currency1` and we
        // owe it `currency0`, so the signs are fixed: amount0 is what was spent and
        // amount1 is what was bought.
        // forge-lint: disable-next-line(unsafe-typecast) -- a negated int128 that v4 guarantees is non-positive
        uint256 spent = uint256(uint128(-delta.amount0()));
        // forge-lint: disable-next-line(unsafe-typecast) -- an int128 v4 guarantees is non-negative
        uint256 bought = uint256(uint128(delta.amount1()));

        if (bought < buy.minTokens) revert InitialBuyBelowMinimum(bought, buy.minTokens);

        _settle(buy.key.currency0, spent);

        // Straight to the creator. Taking to this contract and forwarding would be
        // two transfers and an instant in which the factory holds the market's
        // supply, for no gain.
        poolManager.take(buy.key.currency1, buy.creator, bought);

        // The position is finite, so an input larger than it can serve is consumed
        // only in part and the rest is still here. Returned in the same call: see
        // the note on this contract holding nothing.
        _refund(buy.key.currency0, buy.creator, buy.amountIn - spent);

        return abi.encode(bought);
    }

    /// @dev The three contracts a market owns, deployed in the only order that
    /// works: the splitter names the token, and the locker names both the splitter
    /// and the position id it is about to be given.
    ///
    /// Every one of them is created with the same salt, derived from the creator's
    /// address and their own chosen bytes. So a creator can predict all three
    /// addresses before they launch, and cannot predict anybody else's.
    function _deployMarketContracts(
        CreateParams calldata params,
        Created memory created,
        uint256 supply,
        uint16 protocolBps
    ) private returns (PoolKey memory key) {
        bytes32 salt = saltFor(msg.sender, params.salt);

        created.token = _deployToken(params, salt, supply);

        // v4 orders a pair by address and everything Verdant builds assumes the
        // launch token is `currency1`. Checked after deployment rather than
        // predicted before it, because predicting it here would mean carrying a
        // second copy of the token's creation code in this contract's bytecode to
        // answer a question the creator has already answered off chain.
        if (uint160(created.token) <= uint160(params.quoteAsset)) {
            revert TokenNotAboveQuote(created.token, params.quoteAsset);
        }

        key = poolKeyFor(params.quoteAsset, created.token);
        created.poolId = key.toId();

        created.splitter = address(
            deployer.deploySplitter(salt, params.feeRecipient, treasury, params.quoteAsset, created.token, protocolBps)
        );

        // Read before the mint and asserted after it. The PositionManager assigns
        // ids from a counter it increments during the mint, and nothing can mint in
        // between: this function is not reentrant and the mint happens in the same
        // transaction.
        created.positionTokenId = positionManager.nextTokenId();
        created.locker = address(
            deployer.deployLocker(
                salt, positionManager, created.positionTokenId, created.splitter, key.currency0, key.currency1
            )
        );
    }

    /// @dev Its own function only because seven arguments plus the caller's locals
    /// do not fit on the EVM's stack together.
    function _deployToken(CreateParams calldata params, bytes32 salt, uint256 supply) private returns (address) {
        return address(
            deployer.deployToken(
                salt, params.name, params.symbol, supply, msg.sender, params.metadataURI, params.metadataMutable
            )
        );
    }

    /// @dev Write the schedule, open the pool, and put the supply in a position the
    /// locker owns. The order of the first two is forced by v4 carrying no hook
    /// data through `initialize` (V15 in docs/verification.md); the third has to be
    /// last because there is no pool to add liquidity to before it.
    function _openMarket(
        CreateParams calldata params,
        Created memory created,
        PoolKey memory key,
        uint256 liquidityAmount
    ) private {
        hook.configure(key, params.model, params.stages);
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(params.initialTick));

        created.liquidity = _mintLockedPosition(created.token, key, params.initialTick, liquidityAmount, created.locker);

        address owner = IERC721(address(positionManager)).ownerOf(created.positionTokenId);
        if (owner != created.locker) revert PositionNotLocked(created.positionTokenId, owner, created.locker);
    }

    /// @dev The public record, written last, so that a registered market is always
    /// one that fully exists.
    ///
    /// Assembled field by field rather than as a struct literal because a
    /// twelve-field literal does not fit in the EVM's stack alongside this
    /// function's arguments. The order is the struct's own.
    function _register(CreateParams calldata params, Created memory created, uint16 protocolBps) private {
        MarketRegistry.Market memory market;

        market.poolId = PoolId.unwrap(created.poolId);
        market.token = created.token;
        market.quoteAsset = params.quoteAsset;
        market.creator = msg.sender;
        market.model = params.model;
        // forge-lint: disable-next-line(unsafe-typecast) -- uint40 holds timestamps to year 36812
        market.createdAt = uint40(block.timestamp);
        market.creatorBps = LaunchBounds.BPS_DENOMINATOR - protocolBps;
        market.protocolBps = protocolBps;
        // `reserveBps` is left at zero for every model in v1. The reserve share
        // arrives with Evergreen's reinforcement mechanism, which needs a consumer
        // for it; until then a non-zero value would be a number with nowhere to go.
        // See docs/decisions/005-splits-belong-to-the-splitter.md.
        market.positionTokenId = created.positionTokenId;
        market.locker = created.locker;
        market.splitter = created.splitter;
        market.vesting = created.vesting;

        marketRegistry.register(market);
    }

    // --- views ---------------------------------------------------------------

    /// @notice The pool key a market with this token and quote asset would have.
    /// @dev Every field but the two currencies is fixed for every Verdant market, so
    /// a market is resolvable from the pair alone — and, because a token belongs to
    /// exactly one market, from `MarketRegistry.marketByToken` and the quote asset
    /// it records.
    function poolKeyFor(address quoteAsset, address token) public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(quoteAsset),
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: hook
        });
    }

    /// @notice The salt every one of a market's contracts is created with.
    ///
    /// @dev Exposed so that an interface can predict a launch's addresses before
    /// the transaction is sent: with this salt and the artefacts' creation code, the
    /// CREATE2 formula gives the token, splitter and locker addresses exactly.
    ///
    /// The prediction is not done on chain because doing it would mean holding a
    /// second copy of each artefact's creation code in this contract's bytecode, to
    /// answer a question that has no on-chain consumer.
    function saltFor(address creator, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    // --- internals -----------------------------------------------------------

    /// @dev Split out so that `create` reads as a sequence of steps rather than a
    /// wall of comparisons. Every check here is on a value the creator supplied;
    /// nothing in it depends on state, which is why it can all happen first.
    function _validate(CreateParams calldata params) private view {
        if (params.feeRecipient == address(0)) revert ZeroFeeRecipient();

        // The registry's own question, asked with a reserve share of zero because
        // that is the only value v1 creates. It takes a model and a stage count
        // and nothing that identifies a market, which is the property that keeps
        // its owner unable to reach one.
        // forge-lint: disable-next-line(unsafe-typecast) -- a truncated count fails
        // the registry's own stage bounds, which have a floor of one
        if (!modelRegistry.creationAllowed(params.model, uint8(params.stages.length), 0)) {
            revert CreationNotAllowed(params.model, params.stages.length);
        }

        // Ether needs no admission and every other quote side does. Asked of the
        // registry rather than answered here so that the reviewed set can change
        // for future markets without redeploying this contract, and cannot change
        // for a market that exists because its pool key is already written.
        if (!modelRegistry.quoteAllowed(params.quoteAsset)) revert QuoteAssetNotAdmitted(params.quoteAsset);

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

        if (
            params.supplyTokens < LaunchBounds.MIN_SUPPLY_TOKENS || params.supplyTokens > LaunchBounds.MAX_SUPPLY_TOKENS
        ) {
            revert SupplyOutOfBounds(
                params.supplyTokens, LaunchBounds.MIN_SUPPLY_TOKENS, LaunchBounds.MAX_SUPPLY_TOKENS
            );
        }

        if (params.creatorAllocationBps > LaunchBounds.MAX_CREATOR_ALLOCATION_BPS) {
            revert CreatorAllocationTooLarge(params.creatorAllocationBps, LaunchBounds.MAX_CREATOR_ALLOCATION_BPS);
        }

        // The opening tick has to be usable as the top of the position's range,
        // which means on the grid and strictly above the bottom of it. A tick at
        // the very bottom would be a range of zero width.
        if (
            params.initialTick % VerdantConstants.TICK_SPACING != 0
                || params.initialTick <= VerdantConstants.MIN_USABLE_TICK
                || params.initialTick > VerdantConstants.MAX_USABLE_TICK
        ) {
            revert InitialTickInvalid(params.initialTick);
        }

        if (
            params.vestingDuration != 0
                && (params.vestingDuration < LaunchBounds.MIN_VESTING_DURATION
                    || params.vestingDuration > LaunchBounds.MAX_VESTING_DURATION)
        ) {
            revert VestingDurationOutOfBounds(
                params.vestingDuration, LaunchBounds.MIN_VESTING_DURATION, LaunchBounds.MAX_VESTING_DURATION
            );
        }
        // A cliff beyond the duration is rejected by TokenVesting itself, which is
        // the contract that would be broken by it. Not restated here.
    }

    /// @dev The mint, as three periphery actions.
    ///
    /// `MINT_POSITION` names the locker as owner directly. `SETTLE` pays the token
    /// side from the PositionManager's own balance — the tokens were transferred
    /// there a line earlier — which avoids Permit2 entirely: an allowance would be
    /// a standing approval on a contract that needs one for a single call.
    /// `SWEEP` returns whatever the mint did not consume, which is the dust left by
    /// converting an amount of token into a whole number of units of liquidity.
    ///
    /// `amount0Max: 0` is the assertion that no ETH is required. It holds because
    /// the pool opens at exactly `initialTick` and the position's range ends there:
    /// v4 puts a position whose upper tick is at or below the current tick entirely
    /// in `currency1`. If that ever stopped being true the mint would revert here
    /// rather than silently ask the factory for ETH it does not have.
    function _mintLockedPosition(address token, PoolKey memory key, int24 initialTick, uint256 amount, address locker)
        private
        returns (uint128 liquidity)
    {
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(VerdantConstants.MIN_USABLE_TICK);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(initialTick);

        uint256 liquidity256 = LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, amount);
        if (liquidity256 == 0) revert NoLiquidity(amount, initialTick);
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by v4's own uint128 liquidity
        liquidity = uint128(liquidity256);

        IERC20(token).safeTransfer(address(positionManager), amount);

        bytes memory actions =
            abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE), uint8(Actions.SWEEP));

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            key,
            VerdantConstants.MIN_USABLE_TICK,
            initialTick,
            liquidity256,
            uint128(0),
            // forge-lint: disable-next-line(unsafe-typecast) -- bounded by MAX_SUPPLY_TOKENS * 1e18
            uint128(amount),
            locker,
            bytes("")
        );
        params[1] = abi.encode(key.currency1, ActionConstants.OPEN_DELTA, false);
        params[2] = abi.encode(key.currency1, address(this));

        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    /// @dev Sends the creator's allocation where they said, and then empties the
    /// factory. The second transfer is the whole remaining balance, which is the
    /// allocation's dust when there is vesting and the allocation itself when there
    /// is not — so there is no state in which this returns with the factory holding
    /// any of the token. `VerdantLaunch.t.sol` asserts that from outside.
    ///
    /// The dust has to go somewhere and every candidate other than the creator is
    /// somebody who did not launch this market.
    function _distribute(address token, address creator, uint256 creatorAmount, CreateParams calldata params)
        private
        returns (address vesting)
    {
        if (params.vestingDuration != 0) {
            vesting = address(
                deployer.deployVesting(
                    saltFor(creator, params.salt),
                    token,
                    creator,
                    creatorAmount,
                    // forge-lint: disable-next-line(unsafe-typecast) -- uint64 holds timestamps to year 584942417355
                    uint64(block.timestamp),
                    params.vestingCliff,
                    params.vestingDuration
                )
            );
            IERC20(token).safeTransfer(vesting, creatorAmount);
        }

        uint256 remaining = IERC20(token).balanceOf(address(this));
        if (remaining != 0) IERC20(token).safeTransfer(creator, remaining);
    }

    /// @dev Takes the quote asset the creator is buying with, and refuses every way
    /// of getting the two payment routes confused.
    ///
    /// An ether-quoted launch is paid by value and the amounts must agree exactly.
    /// An equity-quoted one is paid by allowance and must carry no value at all,
    /// because this contract has no use for ether in that market and no function
    /// that could send stray ether back.
    ///
    /// The balance is measured across the transfer rather than assumed from it. Every
    /// admitted quote asset is supposed to move exactly what it is told to — that is
    /// most of what admission means (ADR-008) — and this is the one place where the
    /// claim meets an actual transfer, so it is checked here rather than relied upon
    /// everywhere else.
    function _collectQuote(CreateParams calldata params) private {
        if (params.quoteAsset == address(0)) {
            if (msg.value != params.initialBuyAmount) {
                revert InitialBuyValueMismatch(msg.value, params.initialBuyAmount);
            }
            return;
        }

        if (msg.value != 0) revert NativeSentForTokenQuote(params.quoteAsset, msg.value);
        if (params.initialBuyAmount == 0) return;

        IERC20 quote = IERC20(params.quoteAsset);
        uint256 before = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), params.initialBuyAmount);

        uint256 received = quote.balanceOf(address(this)) - before;
        if (received != params.initialBuyAmount) {
            revert QuoteAmountNotReceived(params.quoteAsset, received, params.initialBuyAmount);
        }
    }

    /// @dev The creator's first buy, or nothing.
    ///
    /// A zero amount returns without touching the pool, which is the whole of what
    /// "the buy is optional" means: no swap, no event, no delivery, and a market that
    /// opens exactly as it did before this function existed.
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

    /// @dev Pay what the swap owes the PoolManager.
    ///
    /// These are the lines `CurrencySettler` would provide, written out instead of
    /// imported: the only copy of that library in this repository is under v4-core's
    /// `test/utils/`, and production bytecode should not be built out of a test
    /// helper. For an ERC-20 the order matters — `sync` snapshots the PoolManager's
    /// balance so that `settle` can measure the transfer that follows it — and for
    /// ether there is nothing to snapshot, because the payment arrives with the call.
    function _settle(Currency currency, uint256 amount) private {
        if (Currency.unwrap(currency) == address(0)) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
            poolManager.settle();
        }
    }

    /// @dev Return the part of the first buy the pool did not take.
    function _refund(Currency currency, address creator, uint256 amount) private {
        if (amount == 0) return;

        if (Currency.unwrap(currency) == address(0)) {
            // A bare call rather than `transfer`: the creator may be a contract whose
            // receive costs more than 2 300 gas, and a stipend that was a safety
            // measure in 2018 is a liveness bug now. The same reasoning as
            // `FeeSplitter.claim`.
            //
            // Slither reads a `.call{value:}` to a non-constant address as sending
            // ether to an arbitrary destination. Here the destination is the caller:
            // `creator` reaches this function only from `market.creator`, which is
            // assigned `msg.sender` and never anything else, and the amount is the
            // part of that same caller's `msg.value` the pool did not take. The
            // factory has no `receive` and no `fallback`, so it holds no balance
            // between calls for a stranger to aim this at. See docs/security/slither.md.
            // slither-disable-next-line arbitrary-send-eth
            (bool ok,) = creator.call{value: amount}("");
            if (!ok) revert NativeRefundFailed(creator, amount);
        } else {
            IERC20(Currency.unwrap(currency)).safeTransfer(creator, amount);
        }
    }
}
