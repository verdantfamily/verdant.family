// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
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

import {AgenCurve} from "./AgenCurve.sol";
import {AgenDeployer} from "./AgenDeployer.sol";
import {AgenMarketRegistry} from "./AgenMarketRegistry.sol";
import {AgenPositionLocker} from "./AgenPositionLocker.sol";

/// @title AgenFactory
/// @notice Deploys a generated market as one bundle, opens its pool, funds it, and
/// records what it deployed — in one transaction, or none of it.
///
/// @dev Entirely separate from `VerdantFactory`, which is untouched. That factory
/// launches markets whose shape is known — one token, one schedule, one hook fixed at
/// its own construction — and its hook address is an immutable, so a market with a
/// different hook cannot go through it at all without redeploying it and re-mining that
/// hook. Widening it would put every live market at risk for the benefit of markets
/// that do not exist yet. These two coexist and share nothing but the PoolManager.
///
/// ## The bundle is not a fixed graph
///
/// A generated market is however many contracts its mechanic needs. This factory does
/// not know what a vault is, or a claim contract, or an oracle adapter; it deploys a
/// list in the order it is given and asserts each landed where the manifest predicted.
/// The dependency ordering is resolved off-chain, and it has to be: a component's
/// constructor arguments are baked into its creation code, so by the time bytes reach
/// this contract every address they refer to is already decided. That is what makes the
/// whole bundle predictable before a single transaction is sent.
///
/// ## Hook addresses
///
/// Uniswap v4 reads a hook's permissions from the low fourteen bits of its address and
/// never asks the contract. A hook deployed to an address missing a bit it implements
/// is not a hook with a bug — it is a market whose rule silently never runs, trading
/// normally, indefinitely, with nothing reverting. So the salt is mined off-chain until
/// the address carries exactly the declared bits, and this contract checks the result
/// rather than trusting it.
///
/// ## The launch is funded here, not afterwards
///
/// An earlier version of this contract initialised the pool and stopped, on the
/// reasoning that funding a market is a separate act. It is not: a v4 pool with no
/// liquidity reverts every swap, so that version shipped markets nobody could trade,
/// and the only way to fix them from outside was to ask the creator to mint a
/// concentrated liquidity position by hand. That is the launchpad this product exists
/// not to be.
///
/// The supply therefore arrives here. Every generated token mints its whole supply to
/// this factory — the factory's address is a fixed constant long before any market is
/// built, so naming it in the token's constructor costs the manifest nothing — and this
/// call puts all of it into three permanently locked positions before it returns. The
/// factory holds nothing once it has: `AgenLaunch.t.sol` asserts that from outside.
///
/// The positions are one-sided, which is what makes the whole flow possible. Each sits
/// at or below the opening tick, so v4 values it entirely in `currency1` and it needs
/// no quote asset to mint. `amount0Max: 0` on each mint asserts that rather than
/// assuming it. Nobody has to bring the paired side, because the first buyer is the
/// first source of it. See `AgenCurve` for why there are three positions and not one.
///
/// ## The first buy happens inside the launch
///
/// `deployMarket` is payable, takes a `devBuyAmount`, and spends it on the market it has
/// just opened before it returns. The reason is not that one signature is nicer than
/// two.
///
/// It is that a pool opened with one-sided liquidity and left alone for a block is a
/// standing invitation. The opening tick is the best price the market will ever offer,
/// the transaction that created it is public the moment it is mined, and anybody
/// reading the chain can take that price before the creator's own buy arrives. A
/// creator who launches and then buys is bidding against whoever was faster, on a
/// market they funded, at a price they set for themselves. Performing the buy in the
/// same call does not narrow that window; it removes it.
///
/// The buy is an ordinary swap and is treated as one. The generated hook sees it,
/// charges it, and runs whatever rule it implements — so the market's mechanic is live
/// from the first trade rather than from the first trade *after* the creator's. A
/// `devBuyAmount` of zero is allowed and means the pool opens one-sided and nothing is
/// bought.
contract AgenFactory is IUnlockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    /// @notice The permission bits v4 reads out of a hook address.
    uint160 internal constant HOOK_FLAG_MASK = 0x3FFF;

    struct Component {
        /// @dev Mined for the hook; derived from the creator and market for the rest.
        bytes32 salt;
        /// @dev Where the manifest says this will land. Asserted, never assumed.
        address expected;
        uint8 role;
        /// @dev Creation code with constructor arguments already appended.
        bytes initCode;
    }

    /// @notice A call the factory makes once, after every component is deployed.
    ///
    /// @dev This exists because CREATE2 does not solve every dependency, and the first
    /// version of this contract assumed it did.
    ///
    /// Two contracts that each need the other's address at construction cannot both be
    /// placed by prediction: the hook's address is mined from its own creation code,
    /// that code contains the accounting contract's address, and the accounting
    /// contract's code would contain the hook's. The cycle is in the init code, and no
    /// amount of address arithmetic unties it. The way out is for one side to learn the
    /// other's address after both exist, which needs somebody to make that call inside
    /// the same transaction — otherwise a market sits half-wired between two
    /// transactions and anybody can wire it wrongly first.
    ///
    /// Restricted to components of this bundle by index rather than by address. The
    /// factory holds no funds between calls and no privileges, so its calls are worth
    /// nothing to an attacker, but a factory that would call any address on request is a
    /// factory that appears in someone's allowlist eventually.
    struct WiringCall {
        uint16 componentIndex;
        bytes data;
    }

    struct Manifest {
        bytes32 specificationHash;
        bytes32 implementationHash;
        string metadataURI;
        /// @dev `currency0`. The token must sort above it, as v4 requires.
        address quoteAsset;
        /// @dev `LPFeeLibrary.DYNAMIC_FEE_FLAG` for a market whose hook sets the fee.
        uint24 lpFee;
        /// @dev The tick the pool opens at, and the top of the first locked position.
        /// Sets the launch valuation. Must be on `AgenCurve.TICK_SPACING`'s grid.
        ///
        /// Replaces the `sqrtPriceX96` an earlier manifest carried. The two would have
        /// had to agree exactly — the positions are only one-sided because the pool
        /// opens at the top of the first one — and a pair of fields that must agree is
        /// a pair of fields that eventually will not.
        int24 initialTick;
        /// @dev Where this market's trading fees are paid. Often the creator, but a
        /// market may want a multisig or a splitter, and it is fixed for the life of
        /// the market so it is asked for explicitly.
        address feeReceiver;
        /// @dev How much of the quote asset to spend on the market immediately, in the
        /// quote asset's own units. Sent as `msg.value` when the quote is ether and
        /// pulled by `transferFrom` when it is not. Zero means nothing is bought.
        uint128 devBuyAmount;
        /// @dev The floor on tokens received from that buy. The launch reverts in whole
        /// if the pool cannot meet it.
        uint128 devBuyMinTokens;
        /// @dev Indices into `components`, so the roles do not have to be searched for.
        uint16 hookIndex;
        uint16 tokenIndex;
        Component[] components;
        /// @dev Made in order, after every component exists and before the pool opens.
        WiringCall[] wiring;
    }

    /// @dev What `_openLiquidity` produced, carried between the steps of a launch
    /// rather than recomputed. Three fields because the EVM's stack has opinions.
    struct Launch {
        address locker;
        uint256 firstTokenId;
        uint256 supply;
    }

    /// @dev Everything `unlockCallback` needs, carried through `poolManager.unlock` as
    /// calldata rather than written to storage between the two calls. Storage that
    /// exists only inside one transaction is still storage another call in that
    /// transaction could be made to read, and this struct names a recipient.
    struct DevBuy {
        PoolKey key;
        address creator;
        uint128 amountIn;
        uint128 minTokens;
    }

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    AgenDeployer public immutable deployer;
    AgenMarketRegistry public immutable registry;

    error NoComponents();
    error IndexOutOfRange(uint16 index, uint256 length);
    error AddressMismatch(uint256 componentIndex, address expected, address actual);
    error HookPermissionMismatch(address hook, uint160 declared, uint160 encoded);
    error TokenNotAboveQuote(address token, address quoteAsset);
    error WrongDeployer(address expected, address actual);
    error WiringFailed(uint16 componentIndex, bytes reason);
    error ZeroPositionManager();
    error ZeroFeeReceiver();

    /// @notice The generated token did not mint its supply to this factory.
    /// @dev The one thing the manifest has to get right that this contract cannot check
    /// before deploying: the token's recipient is a constructor argument baked into its
    /// creation code. Caught here rather than at the mint, where it would surface as an
    /// opaque periphery revert.
    error NoSupplyToLock(address token);

    /// @notice A band's allocation produces no liquidity at all.
    /// @dev Reachable only at the extremes — a minimum supply opened at the very bottom
    /// of the tick range — and it would mint a position that cannot be traded against.
    error NoLiquidity(uint256 band, uint256 amount);

    /// @notice A minted position is not owned by this market's locker.
    /// @dev Unreachable through the code below; asserted because the entire permanence
    /// claim rests on it, and an assertion that never fires is the cheapest kind.
    error PositionNotLocked(uint256 tokenId, address owner, address locker);

    /// @notice The ether sent is not the amount the launch says it will buy with.
    /// @dev Both directions are refused, and the equal case includes zero: a launch
    /// that buys nothing must send nothing.
    error DevBuyValueMismatch(uint256 value, uint128 devBuyAmount);

    /// @notice Ether was sent with a launch whose quote asset is an ERC-20.
    error NativeSentForTokenQuote(address quoteAsset, uint256 value);

    /// @notice The quote asset delivered less than it was asked to transfer.
    error QuoteAmountNotReceived(address quoteAsset, uint256 received, uint128 expected);

    /// @notice The first buy would deliver fewer tokens than the creator accepted.
    /// @dev Reverts the launch in whole rather than the buy alone. A creator who named a
    /// floor was describing the market they wanted to exist, and a market that opened
    /// without it is one they cannot undo.
    error DevBuyBelowMinimum(uint256 received, uint128 minTokens);

    /// @notice Something other than the PoolManager called `unlockCallback`.
    error NotPoolManager(address caller);

    /// @dev Carries the locker and the first position id as well as the addresses, so
    /// this event is a complete record of the launch on its own — it is emitted in the
    /// same transaction the market first appears in, which makes it the earliest one an
    /// indexer can read.
    event MarketDeployed(
        uint256 indexed index,
        address indexed token,
        address indexed hook,
        bytes32 poolId,
        address locker,
        uint256 firstTokenId,
        uint256 supplyLocked
    );

    constructor(
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        AgenDeployer deployer_,
        AgenMarketRegistry registry_
    ) {
        if (address(positionManager_) == address(0)) revert ZeroPositionManager();

        // Both name this contract's address, predicted before it existed. Asserting the
        // prediction here turns a mis-ordered deployment into a failed one rather than
        // a live set of contracts that cannot talk to each other.
        if (deployer_.factory() != address(this)) {
            revert WrongDeployer(address(this), deployer_.factory());
        }
        if (registry_.factory() != address(this)) {
            revert WrongDeployer(address(this), registry_.factory());
        }

        poolManager = poolManager_;
        positionManager = positionManager_;
        deployer = deployer_;
        registry = registry_;
    }

    /// @notice Deploy every component, open the pool, lock the liquidity, record the
    /// market, and spend the creator's first buy on it.
    /// @param manifest The bundle, with every address already predicted.
    /// @return index The market's index in the registry.
    ///
    /// @dev The order of the steps is the security argument, so it is worth stating why
    /// it is this order:
    ///
    ///  1. **Validate, then take payment.** Nothing is deployed until every parameter
    ///     has been accepted, so a rejected launch leaves no orphaned contracts.
    ///  2. **Deploy, then wire.** Wiring happens before the pool exists, so a market
    ///     cannot be traded half-connected even within this transaction.
    ///  3. **Initialise, then mint.** There is no pool to add liquidity to before it,
    ///     and the mint's one-sidedness depends on the price the pool opened at.
    ///  4. **Register.** After the liquidity exists, so the public record only ever
    ///     describes a market that can actually be traded.
    ///  5. **Buy.** Last, after the record and the event, so an indexer sees the market
    ///     before it sees the first trade in it, and so the swap is the last thing that
    ///     can revert rather than the first.
    ///
    /// `nonReentrant` because steps 1 and 5 hand control to the quote asset — an ERC-20
    /// quote's `transferFrom`, and its `transfer` inside the settlement — and a second
    /// launch running inside the first would be minting against PositionManager token
    /// ids the outer call has already claimed.
    function deployMarket(Manifest calldata manifest) external payable nonReentrant returns (uint256 index) {
        uint256 total = manifest.components.length;
        if (total == 0) revert NoComponents();
        if (manifest.hookIndex >= total) revert IndexOutOfRange(manifest.hookIndex, total);
        if (manifest.tokenIndex >= total) revert IndexOutOfRange(manifest.tokenIndex, total);
        if (manifest.feeReceiver == address(0)) revert ZeroFeeReceiver();
        AgenCurve.validate(manifest.initialTick);

        _collectQuote(manifest);

        // One longer than the bundle: the locker is deployed below, is part of the
        // market, and belongs in its record — but it is not a predicted component,
        // because its constructor names a token id that does not exist until the mint.
        AgenMarketRegistry.Component[] memory deployed = new AgenMarketRegistry.Component[](total + 1);

        _deployComponents(manifest, deployed);
        _wire(manifest, deployed);

        address hook = deployed[manifest.hookIndex].addr;
        address token = deployed[manifest.tokenIndex].addr;

        _requireHookPermissions(hook, manifest.components[manifest.hookIndex]);

        // v4 orders a pool's currencies, and the launched token must be currency1 so
        // that "zero for one" means a buy for every Agen market. A generated hook
        // reasons about direction constantly; letting it flip per market would make
        // every rule's meaning depend on an address comparison nobody sees.
        if (uint160(token) <= uint160(manifest.quoteAsset)) {
            revert TokenNotAboveQuote(token, manifest.quoteAsset);
        }

        PoolKey memory key = poolKeyFor(manifest.quoteAsset, token, manifest.lpFee, hook);
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(manifest.initialTick));

        Launch memory launch = _openLiquidity(manifest, key, token);
        deployed[total] = AgenMarketRegistry.Component({
            addr: launch.locker, role: registry.ROLE_LOCKER(), codeHash: launch.locker.codehash
        });

        index = _register(manifest, deployed, token, hook, key);

        emit MarketDeployed(
            index, token, hook, PoolId.unwrap(key.toId()), launch.locker, launch.firstTokenId, launch.supply
        );

        _devBuy(manifest, key);
    }

    /// @notice The PoolManager's callback for the creator's first buy.
    ///
    /// @dev Not part of this contract's interface in any useful sense — it exists
    /// because v4 will not let anybody touch a pool outside a lock, and the only thing
    /// that ever reaches it is `_devBuy` below, by way of `poolManager.unlock`.
    /// `unlock` calls back whoever called it, so the check on `msg.sender` is what makes
    /// that the only route: a direct call from anywhere else would be swapping outside a
    /// lock, where the deltas this function settles do not exist.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);

        DevBuy memory buy = abi.decode(data, (DevBuy));

        // Paid in before the swap rather than after it, and this ordering is the whole
        // difference between a factory that works for generated markets and one that
        // works only for markets whose hooks are as polite as Verdant's.
        //
        // `VerdantFactory` swaps first and settles afterwards, which is fine there
        // because its hook never touches the PoolManager's balances. A generated hook
        // does: taking a cut of the trade into a vault, mid-swap, is the mechanic behind
        // every jackpot, buyback and reward pool Agen advertises. Such a hook calls
        // `poolManager.take` inside `beforeSwap`, and at that instant the manager has to
        // already be holding the ether — which, at the launch of a market whose only
        // liquidity is one-sided token, it is not. It reverts with `NativeTransferFailed`
        // from inside the hook, and the launch fails for a reason that has nothing to do
        // with the hook being wrong.
        //
        // Settling first funds the manager before any callback can run. The swap then
        // draws against that credit, and whatever it does not use is taken back below.
        _settle(buy.key.currency0, buy.amountIn);

        BalanceDelta delta = poolManager.swap(
            buy.key,
            SwapParams({
                // The launch token is always `currency1`, so a buy is always zeroForOne.
                zeroForOne: true,
                // Negative is exact input: spend at most this much of the quote asset,
                // whatever that turns out to buy.
                // forge-lint: disable-next-line(unsafe-typecast) -- a uint128 widened, not truncated
                amountSpecified: -int256(uint256(buy.amountIn)),
                // The extreme rather than a chosen limit. A price bound here would be a
                // second, silent slippage control on top of the creator's own
                // `devBuyMinTokens`, and the one they can see is the one that should
                // decide.
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );

        // For an exact-input zeroForOne swap the pool owes us currency1 and we owe it
        // currency0, so the signs are fixed: amount0 is spent and amount1 is bought.
        // forge-lint: disable-next-line(unsafe-typecast) -- a negated int128 v4 guarantees is non-positive
        uint256 spent = uint256(uint128(-delta.amount0()));
        // forge-lint: disable-next-line(unsafe-typecast) -- an int128 v4 guarantees is non-negative
        uint256 bought = uint256(uint128(delta.amount1()));

        if (bought < buy.minTokens) revert DevBuyBelowMinimum(bought, buy.minTokens);

        // Straight to the creator. Taking to this contract and forwarding would be two
        // transfers and an instant in which the factory holds the market's supply, for
        // no gain.
        poolManager.take(buy.key.currency1, buy.creator, bought);

        // The positions are finite, so an input larger than they can serve is consumed
        // only in part. The rest is still sitting in the manager as this contract's
        // credit, so it is taken straight out to the creator — no balance to hold, no
        // refund path, and nothing left for the lock to complain about.
        uint256 unspent = buy.amountIn - spent;
        if (unspent != 0) poolManager.take(buy.key.currency0, buy.creator, unspent);

        return abi.encode(bought);
    }

    // --- views ---------------------------------------------------------------

    /// @notice The pool key a market with these parts would have.
    function poolKeyFor(address quoteAsset, address token, uint24 lpFee, address hook)
        public
        pure
        returns (PoolKey memory)
    {
        return PoolKey({
            currency0: Currency.wrap(quoteAsset),
            currency1: Currency.wrap(token),
            fee: lpFee,
            tickSpacing: AgenCurve.TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    /// @notice Where a component will land, for an interface showing addresses first.
    function predict(bytes32 salt, bytes calldata initCode) external view returns (address) {
        return deployer.computeAddress(salt, keccak256(initCode));
    }

    // --- internals -----------------------------------------------------------

    /// @dev In the order given, which is the topological order the plan resolved. A
    /// component whose constructor reads another's address works only because that
    /// address was fixed by CREATE2 before either was sent.
    function _deployComponents(Manifest calldata manifest, AgenMarketRegistry.Component[] memory deployed) private {
        for (uint256 i = 0; i < manifest.components.length; i++) {
            Component calldata component = manifest.components[i];
            address at = deployer.deploy(component.salt, component.initCode);

            if (at != component.expected) revert AddressMismatch(i, component.expected, at);

            deployed[i] = AgenMarketRegistry.Component({addr: at, role: component.role, codeHash: at.codehash});
        }
    }

    function _wire(Manifest calldata manifest, AgenMarketRegistry.Component[] memory deployed) private {
        uint256 total = manifest.components.length;

        for (uint256 i = 0; i < manifest.wiring.length; i++) {
            WiringCall calldata call = manifest.wiring[i];
            if (call.componentIndex >= total) revert IndexOutOfRange(call.componentIndex, total);

            (bool ok, bytes memory returned) = deployed[call.componentIndex].addr.call(call.data);
            if (!ok) revert WiringFailed(call.componentIndex, returned);
        }
    }

    /// @dev Deploy the locker, put the whole supply into three positions it owns, and
    /// prove it owns them.
    ///
    /// The locker is created with plain `CREATE` rather than through `AgenDeployer`,
    /// and that is the one address in a launch nobody predicts. It cannot be predicted:
    /// its constructor names the first position's token id, which the PositionManager
    /// does not assign until the mint that happens after it is deployed. Nothing else
    /// in the bundle refers to it — its address is an output of the launch, recorded in
    /// the registry — so nothing needs it in advance.
    function _openLiquidity(Manifest calldata manifest, PoolKey memory key, address token)
        private
        returns (Launch memory launch)
    {
        launch.supply = IERC20(token).balanceOf(address(this));
        if (launch.supply == 0) revert NoSupplyToLock(token);

        // Read before the mint and asserted after it. The PositionManager assigns ids
        // from a counter it increments during the mint, and nothing can mint in
        // between: this function is not reentrant and all three positions are created
        // by a single call.
        launch.firstTokenId = positionManager.nextTokenId();
        launch.locker = address(
            new AgenPositionLocker(
                positionManager, launch.firstTokenId, manifest.feeReceiver, key.currency0, key.currency1
            )
        );

        _mintBands(key, manifest.initialTick, token, launch.locker, launch.supply);

        for (uint256 i = 0; i < AgenCurve.BANDS; i++) {
            uint256 tokenId = launch.firstTokenId + i;
            address owner = IERC721(address(positionManager)).ownerOf(tokenId);
            if (owner != launch.locker) revert PositionNotLocked(tokenId, owner, launch.locker);
        }

        // Converting an amount of token into a whole number of units of liquidity
        // leaves dust, which `SWEEP` returned here. It goes to the creator: it has to
        // go somewhere, every other candidate is a party who did not launch this
        // market, and the factory must not end the call holding any of it.
        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust != 0) IERC20(token).safeTransfer(msg.sender, dust);
    }

    /// @dev The three mints, as one batch of periphery actions.
    ///
    /// `MINT_POSITION` names the locker as owner directly, so no position is ever owned
    /// by this factory and there is no instant in which one could be sent elsewhere.
    /// `SETTLE` pays the token side from the PositionManager's own balance — the supply
    /// was transferred there a line earlier — which avoids Permit2 entirely: an
    /// allowance would be a standing approval on a contract that needs one for a single
    /// call. `SWEEP` returns whatever the mints did not consume.
    ///
    /// `amount0Max: 0` on every band is the assertion that no quote asset is required.
    /// It holds because the pool opens at `initialTick` and every band's upper tick is
    /// at or below it: v4 values a position whose range ends at or below the current
    /// tick entirely in `currency1`. If that stopped being true the mint would revert
    /// here rather than silently ask the factory for ether it does not have.
    function _mintBands(PoolKey memory key, int24 initialTick, address token, address locker, uint256 supply) private {
        AgenCurve.Band[3] memory band = AgenCurve.bands(initialTick);

        IERC20(token).safeTransfer(address(positionManager), supply);

        bytes memory actions = abi.encodePacked(
            uint8(Actions.MINT_POSITION),
            uint8(Actions.MINT_POSITION),
            uint8(Actions.MINT_POSITION),
            uint8(Actions.SETTLE),
            uint8(Actions.SWEEP)
        );

        bytes[] memory params = new bytes[](AgenCurve.BANDS + 2);
        uint256 allocated;

        for (uint256 i = 0; i < AgenCurve.BANDS; i++) {
            // The last band takes the remainder rather than its own percentage, so the
            // three amounts sum to the supply exactly and no rounding crumb is left
            // outside a position.
            uint256 amount = i + 1 == AgenCurve.BANDS
                ? supply - allocated
                : (supply * band[i].allocationBps) / AgenCurve.BPS_DENOMINATOR;
            allocated += amount;

            uint256 liquidity = LiquidityAmounts.getLiquidityForAmount1(
                TickMath.getSqrtPriceAtTick(band[i].tickLower), TickMath.getSqrtPriceAtTick(band[i].tickUpper), amount
            );
            if (liquidity == 0) revert NoLiquidity(i, amount);

            params[i] = abi.encode(
                key,
                band[i].tickLower,
                band[i].tickUpper,
                liquidity,
                uint128(0),
                // forge-lint: disable-next-line(unsafe-typecast) -- a share of a supply that is itself uint128-bounded
                uint128(amount),
                locker,
                bytes("")
            );
        }

        params[AgenCurve.BANDS] = abi.encode(key.currency1, ActionConstants.OPEN_DELTA, false);
        params[AgenCurve.BANDS + 1] = abi.encode(key.currency1, address(this));

        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    /// @dev The public record, written after the liquidity exists so that a registered
    /// market is always one that can be traded.
    function _register(
        Manifest calldata manifest,
        AgenMarketRegistry.Component[] memory deployed,
        address token,
        address hook,
        PoolKey memory key
    ) private returns (uint256) {
        return registry.register(
            AgenMarketRegistry.Market({
                creator: msg.sender,
                token: token,
                hook: hook,
                poolId: PoolId.unwrap(key.toId()),
                quoteAsset: manifest.quoteAsset,
                specificationHash: manifest.specificationHash,
                implementationHash: manifest.implementationHash,
                metadataURI: manifest.metadataURI,
                createdAt: uint64(block.timestamp),
                createdAtBlock: uint64(block.number)
            }),
            deployed
        );
    }

    /// @dev Takes the quote asset the creator is buying with, and refuses every way of
    /// getting the two payment routes confused.
    ///
    /// An ether-quoted launch is paid by value and the amounts must agree exactly. An
    /// ERC-20-quoted one is paid by allowance and must carry no value at all, because
    /// this contract has no use for ether in that market and no function that could
    /// send stray ether back.
    ///
    /// The balance is measured across the transfer rather than assumed from it: a
    /// fee-on-transfer quote asset would otherwise surface as a swap that settles less
    /// than it spends, with the difference taken out of the creator's refund.
    function _collectQuote(Manifest calldata manifest) private {
        if (manifest.quoteAsset == address(0)) {
            if (msg.value != manifest.devBuyAmount) {
                revert DevBuyValueMismatch(msg.value, manifest.devBuyAmount);
            }
            return;
        }

        if (msg.value != 0) revert NativeSentForTokenQuote(manifest.quoteAsset, msg.value);
        if (manifest.devBuyAmount == 0) return;

        IERC20 quote = IERC20(manifest.quoteAsset);
        uint256 before = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), manifest.devBuyAmount);

        uint256 received = quote.balanceOf(address(this)) - before;
        if (received != manifest.devBuyAmount) {
            revert QuoteAmountNotReceived(manifest.quoteAsset, received, manifest.devBuyAmount);
        }
    }

    /// @dev The creator's first buy, or nothing.
    ///
    /// A zero amount returns without touching the pool, which is the whole of what "the
    /// buy is optional" means: no swap, no event, no delivery, and a market that opens
    /// exactly as it did before this function existed.
    function _devBuy(Manifest calldata manifest, PoolKey memory key) private {
        if (manifest.devBuyAmount == 0) return;

        poolManager.unlock(
            abi.encode(
                DevBuy({
                    key: key, creator: msg.sender, amountIn: manifest.devBuyAmount, minTokens: manifest.devBuyMinTokens
                })
            )
        );
    }

    /// @dev Pay what the swap owes the PoolManager.
    ///
    /// These are the lines `CurrencySettler` would provide, written out instead of
    /// imported: the only copy of that library in this repository is under v4-core's
    /// `test/utils/`, and production bytecode should not be built out of a test helper.
    /// For an ERC-20 the order matters — `sync` snapshots the PoolManager's balance so
    /// that `settle` can measure the transfer that follows it — and for ether there is
    /// nothing to snapshot, because the payment arrives with the call.
    function _settle(Currency currency, uint256 amount) private {
        if (Currency.unwrap(currency) == address(0)) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
            poolManager.settle();
        }
    }

    /// @dev The hook's declared permissions are read from the address the plan
    /// committed to rather than from the contract, because a contract that lies about
    /// its own permissions is exactly the case this is guarding against.
    function _requireHookPermissions(address hook, Component calldata component) private pure {
        uint160 encoded = uint160(hook) & HOOK_FLAG_MASK;
        uint160 declared = uint160(uint160(component.expected) & HOOK_FLAG_MASK);

        if (encoded != declared) revert HookPermissionMismatch(hook, declared, encoded);
        // A hook with no permissions is never called, which makes every rule in the
        // market dead code. v4 permits it; Agen does not, because such a market would
        // trade normally and do nothing it advertised.
        if (encoded == 0) revert HookPermissionMismatch(hook, declared, 0);
    }
}
