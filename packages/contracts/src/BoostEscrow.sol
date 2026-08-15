// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {MarketRegistry} from "./MarketRegistry.sol";
import {InstantFees} from "./libraries/InstantFees.sol";

/// @dev The part of `InstantFeeVault` this contract uses. Declared rather than imported for
/// the reason `FeeForwarder` gives about `IFeeSplitter`: an escrow should be pointable at any
/// vault that keeps this shape, including the ones already deployed.
interface IInstantFeeVault {
    function claimCreator() external returns (uint256 amount);
    function claimable(address recipient) external view returns (uint256);
    function creator() external view returns (address);
    function treasury() external view returns (address);
}

/// @dev The part of `InstantFactory` this contract uses. `poolKeyFor` is the reason it is
/// here: a buyback must never accept a caller's idea of which pool to trade in.
interface IInstantFactory {
    function poolKeyFor(address token) external view returns (PoolKey memory);
    function treasury() external view returns (address);
}

/// @dev The part of `BoostTreasury` this contract uses.
///
/// Declared rather than imported to keep the dependency one-directional: `BoostTreasury` names
/// this contract's `receivePlatformFee` and `owner`, and importing it back would make the pair
/// mutually dependent for no benefit.
interface IBoostTreasury {
    function register(address vault) external returns (bool boosting);
    function setBoost(address vault, bool boosting, uint256 settled) external returns (bool changed);
    function settle(address vault) external returns (uint256 amount);
    function pullForBoost(address vault) external returns (uint256 amount);
    function isBoosting(address vault) external view returns (bool);
    function platformStateOf(address vault)
        external
        view
        returns (
            bool registered,
            bool boosting,
            uint256 agenPending,
            uint256 boostPending,
            uint256 vaultClaimable,
            uint256 routedToBoost,
            uint256 paidToAgen
        );
}

/// @dev The part of `AgenRouter` this contract uses.
interface IAgenRouter {
    function swap(PoolKey calldata key, bool zeroForOne, uint128 amountIn, uint128 minAmountOut, bytes calldata extra)
        external
        payable
        returns (uint256 amountOut);
}

/// @title BoostEscrow
/// @notice One creator's Instant fee recipient, and the switch that turns their fees into
/// buybacks. Boost is off until they turn it on, and turning it off cannot reach what was
/// already committed.
///
/// @dev **Nothing that is already deployed changes.** Not the hook, not the factory, not the
/// registry, not a single existing market. This contract works because of one line of
/// `InstantFactory.create` that was always there:
///
/// ```
/// created.vault = address(deployer.deployVault(salt, address(hook), poolManager, params.feeRecipient, treasury));
/// ```
///
/// `params.feeRecipient` becomes the vault's immutable `creator`, and `claimCreator()` is
/// permissionless and takes no argument for whom to pay. So a market that names *this*
/// contract at launch has its future creator fees delivered here by anybody, forever, with
/// no privileged address anywhere in the path. That is the whole mechanism, and it is the
/// same argument `FeeForwarder` makes for the Programmable side.
///
/// The corollary is the limit, and it is worth stating plainly rather than in a release
/// note: a market that named a wallet at launch can **never** be Boosted. `vault.creator` is
/// an immutable with no setter, the hook's vault mapping is write-once, and the chain is
/// pre-Prague so EIP-7702 cannot retrofit code onto an address that is already an EOA. Boost
/// is available to markets launched with an escrow and to no others.
///
/// ## Why one escrow per creator rather than one per market
///
/// `FeeForwarderFactory`'s reasoning, unchanged: the address is a pure function of the
/// owner, so a creator's second launch reuses the first's without anything being stored, and
/// a keeper has one place to ask what an address's escrow is. Per-market state is keyed by
/// token inside, and the vault that pays it in is the market's own identity — which is what
/// makes `receive()` able to attribute a bare ether transfer with no calldata.
///
/// ## The cutoff, which is the only subtle part
///
/// A vault pays out everything accrued since the last claim as one undifferentiated lump.
/// This contract cannot look at an arriving 0.3 ether and know which part of it was earned
/// before a toggle. So it never has to: **every toggle settles first.**
///
/// `enableBoost` claims what is outstanding *while Boost is still off*, so that ether lands
/// in the owner's balance and belongs to the creator. `disableBoost` claims what is
/// outstanding *while Boost is still on*, so that ether lands in `boostPending` and stays
/// committed to a buyback. The cutoff is therefore the toggle transaction itself, atomically,
/// and there is no window in which a creator can watch a large trade accrue and then switch
/// off to pocket it. That attack is the reason this design is not a watermark comparison.
///
/// Committed funds are committed. `withdraw` pays `creatorPending` and nothing else, and no
/// path anywhere in this contract moves a wei from `boostPending` to `creatorPending`.
///
/// ## Recursion
///
/// A buyback is a real trade, so it pays the market's own 1.50% — 1.00% of which comes back
/// here as more Boost budget. It is worth being precise about this rather than reassuring,
/// because the reassuring version is wrong: that returned fee is *not* automatically below
/// `MIN_BOOST_WEI`, so a large cycle really is followed by a smaller one.
///
/// What makes it safe is the ratio rather than the threshold. Each cycle returns one hundredth
/// of what it spent, so the tail decays by two orders of magnitude a round and crosses the
/// threshold within a handful of rounds whatever the first spend was. Total lifetime spend
/// converges to about 1.0101 times what was contributed.
///
/// Nothing reenters at any point. The fee lands in the vault's ledger and needs a separate
/// transaction to move, and `BOOST_INTERVAL` puts half an hour between those transactions — so
/// a keeper written as "buy while there is anything to buy with" cannot spin even while the
/// tail is still non-zero. `BoostEscrow.t.sol` drives a tail to exhaustion and asserts the
/// round count, so a change to the fee, the split or the threshold that turned this into a
/// treadmill fails there rather than on chain.
contract BoostEscrow is ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;

    // --- what Boost is, frozen -------------------------------------------------

    /// @notice Where bought-back tokens go, permanently.
    ///
    /// @dev A constant, not a parameter and not storage. This is the line that makes
    /// "creators cannot redirect Boost" true by construction rather than by check.
    ///
    /// Instant tokens are `VerdantToken`, which has no `burn` and no `burnFrom` — asserted
    /// against the compiled ABI in `VerdantToken.t.sol`, and confirmed on chain. So this is
    /// a sink rather than a burn, and the difference is not cosmetic: `totalSupply()` does
    /// **not** decrease. Any consumer computing a circulating supply has to subtract this
    /// address's balance, which is why `sunk` is exposed per market and cumulatively.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The least ether worth spending a buyback's gas on.
    ///
    /// @dev Also what terminates the fee-on-buyback tail described in the header. It does not
    /// stop that tail after one round — the fee returned is 1.00% of the spend, which for a
    /// large cycle is still above this — it bounds how far the tail can run, and the residue
    /// below it stays committed rather than becoming the creator's again.
    uint256 public constant MIN_BOOST_WEI = 0.001 ether;

    /// @notice How often one market may be Boosted.
    ///
    /// @dev Enforced here rather than only in the keeper, so "one cycle per market per run"
    /// is a property of the contract and not of whoever is running the script. A keeper on a
    /// 30-minute timer that double-fires, or two keepers racing, cannot drain a market's
    /// budget in a burst of tiny swaps.
    uint40 public constant BOOST_INTERVAL = 30 minutes;

    /// @notice How far below the pool's spot price a buyback may settle.
    ///
    /// @dev The reason `boost` can be permissionless. The caller supplies `minTokensOut`
    /// because a good bound needs a quote and `AgenRouter.quote` reverts by design, but a
    /// caller supplying zero would be inviting a sandwich against somebody else's burn. So
    /// the floor is derived here from the pool's own `sqrtPriceX96` and the caller may only
    /// tighten it.
    ///
    /// A spot estimate is a valid *upper* bound on a real buy's output, because price impact
    /// on a buy is always adverse — so `spot × (1 − tolerance)` is a floor no honest trade
    /// fails. Five percent leaves room for impact on a market whose liquidity is one
    /// position, without leaving room for a meaningful extraction.
    uint256 public constant MAX_SLIPPAGE_BPS = 500;

    uint256 private constant BPS = 10_000;

    // --- wiring, all immutable -------------------------------------------------

    /// @notice The only address any ether can leave here for, other than the pool.
    address public immutable owner;

    /// @notice Instant's registry. The authority on which vault belongs to which token.
    MarketRegistry public immutable marketRegistry;

    /// @notice Instant's factory, consulted only for `poolKeyFor`.
    IInstantFactory public immutable instantFactory;

    /// @notice The route a buyback takes. Agen's own router, so a buyback is an ordinary
    /// Agen trade that emits `AgenSwap` and appears in the market's history like any other.
    IAgenRouter public immutable agenRouter;

    IPoolManager public immutable poolManager;

    // The platform fee's route is deliberately **not** an immutable here. It is read from each
    // market's own vault at enrolment — see `Market.boostTreasury`.

    // --- per-market state ------------------------------------------------------

    struct Market {
        /// @dev The market's `InstantFeeVault`. Zero until enrolled, and never changed.
        address vault;
        bool boostEnabled;
        /// @dev Set by `lockBoostForever`. One way.
        bool boostLocked;
        /// @dev Ether committed to buybacks and not yet spent. Unreachable by the owner.
        uint256 boostPending;
        /// @dev Ether that is the owner's, waiting to be withdrawn. Fees this market earned
        /// while Boost was off, and never Boost money.
        ///
        /// Per market rather than one pooled balance, which is a deliberate choice and not the
        /// obvious one: a single pot would be cheaper. But a creator's profile lists a row per
        /// market, and a pooled figure would either appear on every row — reading as several
        /// times more money than exists — or need a row of its own that does not correspond to
        /// any market. Per market, "what this market owes you" has an answer, and it is the
        /// same shape of answer `InstantFeeVault` already gives.
        uint256 creatorPending;
        /// @dev Where this market's platform 0.50% is paid, read from its own vault.
        ///
        /// **Discovered rather than configured, and that is what makes the deployment acyclic.**
        /// An escrow told its treasury in a constructor would have to exist before the treasury and
        /// the treasury before the escrow factory — a cycle CREATE2 cannot break, since each
        /// address would be inside the other's init code. The vault already knows the answer:
        /// `treasury` is an immutable it was built with, so asking it is both simpler and more
        /// accurate than being told.
        ///
        /// It also means one escrow can serve markets from different Instant deployments and get
        /// each one right, rather than assuming every market it holds came from the same stack.
        ///
        /// Zero for a market whose vault pays an ordinary address, which is every market from an
        /// Instant deployed before `BoostTreasury` existed.
        address boostTreasury;
        /// @dev Whether that address accepted this market, which is what "the platform share is
        /// captured too" means in practice.
        ///
        /// The difference between a market whose Boost is the full 1.50% of trading fees and one
        /// whose Boost is the creator's 1.00%. The interface must state which, because the second
        /// is not what "100% Boost" claims.
        bool platformBoosted;
        /// @dev Ether routed here from `boostTreasury`: the platform's 0.50%, captured by the fee
        /// architecture rather than sent by hand. Cumulative.
        uint256 platformRouted;
        /// @dev Ether that arrived through `contribute` rather than from either fee stream.
        /// Cumulative, and reported separately so a voluntary top-up is never presented as part of
        /// what the fee split itself produced.
        uint256 agenContributed;
        /// @dev Ether ever spent buying this token back.
        uint256 boostSpent;
        /// @dev Tokens ever received from those buybacks.
        uint256 tokensBought;
        /// @dev Tokens ever sent to `DEAD`.
        uint256 tokensSunk;
        uint40 lastBoostAt;
        uint32 boostCount;
    }

    mapping(address token => Market) private _markets;

    /// @dev The reverse of `Market.vault`, and the reason `receive()` can attribute a
    /// transfer that carries no calldata: the vault paying in *is* the market.
    mapping(address vault => address token) private _tokenOfVault;

    /// @dev Every token enrolled here, in enrolment order, so a keeper can enumerate a
    /// creator's markets without an archive node.
    address[] private _enrolled;

    /// @notice Ether that arrived from an address this contract cannot attribute.
    /// @dev Should be zero. Reported rather than silently folded into a balance, for the
    /// reason `InstantFeeVault.unaccounted()` gives.
    uint256 public unattributed;

    /// @dev Set for the duration of a buyback so that `AgenRouter`'s refund of an input the
    /// pool could not absorb is credited back to that market's commitment rather than
    /// misread as fee income. The refund arrives from the PoolManager, which is not a vault,
    /// so without this it would fall to `unattributed` and quietly leave Boost short.
    address private _refunding;

    // --- events ----------------------------------------------------------------

    /// @notice A market's fees now arrive here.
    event MarketEnrolled(address indexed token, address indexed vault, bytes32 poolId);

    /// @notice Boost was switched.
    /// @dev The two settled amounts are what the toggle's own claims moved on each stream, which
    /// is exactly what the cutoff assigned to the side being left. Carried separately because the
    /// two are different people's money: `creatorSettled` is the creator's 1.00% and
    /// `platformSettled` is Agen's 0.50%, and an audit of who gave up what needs both.
    event BoostSet(address indexed token, bool enabled, uint256 creatorSettled, uint256 platformSettled);

    /// @notice The platform's 0.50% was routed here by the fee architecture.
    /// @dev Distinct from `BoostFunded` with `fromAgen` set, which is a voluntary top-up. This one
    /// is the fee split itself, and it is the event that makes "all 1.50%" checkable.
    event PlatformFeeRouted(address indexed token, address indexed vault, uint256 amount);

    /// @notice Boost can never be switched off for this market again.
    event BoostLocked(address indexed token);

    /// @notice Ether was committed to a market's buybacks.
    /// @dev `fromAgen` distinguishes a platform contribution from the creator's own fees,
    /// which is the distinction the interface must not blur.
    event BoostFunded(address indexed token, uint256 amount, bool fromAgen);

    /// @notice Creator fees arrived while Boost was off, and are the owner's.
    event CreatorFunded(address indexed token, uint256 amount);

    event Withdrawn(address indexed to, uint256 amount);

    /// @notice One buyback cycle. The whole of Boost's accounting, verifiable from this
    /// event alone.
    event BoostExecuted(
        address indexed token,
        address indexed caller,
        uint256 etherSpent,
        uint256 tokensBought,
        uint256 tokensSunk,
        uint256 cumulativeSunk,
        uint256 remainingPending
    );

    // --- failures --------------------------------------------------------------

    error ZeroOwner();
    error ZeroAddress();
    error NotOwner(address caller);

    /// @notice The market has not been enrolled here.
    error NotEnrolled(address token);

    /// @notice The registry knows this token, but its vault does not pay this contract.
    /// @dev The check that makes enrolment permissionless. A market whose `feeRecipient` is
    /// somebody else cannot be attached to this escrow, so nothing here can ever be about a
    /// market it is not the recipient of.
    error VaultPaysSomeoneElse(address token, address vault, address paysTo);

    /// @notice `enroll` was called twice with different answers.
    error AlreadyEnrolled(address token, address vault);

    /// @notice The registry's record does not describe the token asked about.
    error RegistryMismatch(address asked, address recorded);

    error BoostAlreadyLocked(address token);
    error BoostNotEnabled(address token);
    error BoostAlreadyInThatState(address token, bool enabled);

    /// @notice Not enough committed to be worth a buyback.
    error BelowThreshold(uint256 pending, uint256 minimum);

    /// @notice A contribution of nothing.
    error NothingContributed();

    /// @notice Something other than the configured treasury tried to route a platform fee.
    error NotBoostTreasury(address caller);

    /// @notice A buyback with no floor at all.
    error ZeroMinimumOut();

    /// @notice This market was Boosted too recently.
    error TooSoon(uint40 lastBoostAt, uint40 earliest);

    /// @notice The caller's slippage bound is looser than this contract permits.
    error SlippageTooLoose(uint256 provided, uint256 floor);

    /// @notice The pool has no price, so no floor can be derived.
    error PoolNotInitialised(address token);

    error NothingToWithdraw();
    error TransferFailed(address to, uint256 amount);

    constructor(
        address owner_,
        MarketRegistry marketRegistry_,
        IInstantFactory instantFactory_,
        IAgenRouter agenRouter_,
        IPoolManager poolManager_
    ) {
        if (owner_ == address(0)) revert ZeroOwner();
        if (
            address(marketRegistry_) == address(0) || address(instantFactory_) == address(0)
                || address(agenRouter_) == address(0) || address(poolManager_) == address(0)
        ) {
            revert ZeroAddress();
        }

        owner = owner_;
        marketRegistry = marketRegistry_;
        instantFactory = instantFactory_;
        agenRouter = agenRouter_;
        poolManager = poolManager_;
    }

    // --- enrolment -------------------------------------------------------------

    /// @notice Attach a market whose fees this contract receives.
    ///
    /// @dev Permissionless, and safe to be: everything is derived rather than supplied. The
    /// caller names a token, the registry says which vault that token's market has, and the
    /// vault says who it pays. Only if that answer is this contract does anything get
    /// stored. So the worst a stranger can do is finish a step the creator would have had to
    /// take, which is the same reason `PositionLocker.collect` is open.
    ///
    /// Idempotent for the same vault so a launch flow need not branch on whether it already
    /// ran, and a hard failure for a different one, because a token whose vault changed would
    /// mean the registry was rewritten and it cannot be.
    function enroll(address token) public returns (address vault) {
        return _ensureEnrolled(token).vault;
    }

    /// @dev Enrolment, and the resolved market. Called by every entry point that needs one, so
    /// that a creator never signs a transaction whose only purpose is bookkeeping: turning
    /// Boost on enrols, and so does a claim.
    ///
    /// It matters for more than convenience. `receive()` attributes an arriving transfer by the
    /// vault that sent it, so a market that is not enrolled when its vault pays would have its
    /// fees booked as unattributed. Enrolling on the way in closes that gap for every path a
    /// creator or a keeper actually takes.
    function _ensureEnrolled(address token) private returns (Market storage market) {
        if (token == address(0)) revert ZeroAddress();

        market = _markets[token];
        address known = market.vault;

        MarketRegistry.Market memory record = marketRegistry.marketByToken(token);
        if (record.token != token) revert RegistryMismatch(token, record.token);

        address vault = record.splitter;
        address paysTo = IInstantFeeVault(vault).creator();
        if (paysTo != address(this)) revert VaultPaysSomeoneElse(token, vault, paysTo);

        // The registry is append-only with an immutable writer, so a token's vault cannot
        // change. A disagreement here would mean one of those two properties had failed, which
        // is worth refusing rather than overwriting.
        if (known != address(0)) {
            if (known != vault) revert AlreadyEnrolled(token, known);
            return market;
        }

        market.vault = vault;
        _tokenOfVault[vault] = token;
        _enrolled.push(token);

        /*
         * Ask the vault where its platform fee goes, then ask that address to accept the market.
         *
         * `try` rather than a code-size check, because the question is not "is there a contract
         * there" but "will it take instructions about this market". A genuine `BoostTreasury`
         * verifies for itself that the vault pays it and returns; an ordinary address has no code
         * and reverts; anything else is that market's own treasury and its own business.
         *
         * Registering here rather than at the first toggle means a platform fee arriving before
         * anybody touches the switch is attributed instead of falling to the treasury's
         * unattributed pile.
         */
        address payingTo = IInstantFeeVault(vault).treasury();
        if (payingTo != address(0)) {
            try IBoostTreasury(payingTo).register(vault) {
                market.boostTreasury = payingTo;
                market.platformBoosted = true;
            } catch {
                // A market whose platform share cannot be captured. Boost still works on the
                // creator's 1.00%; the interface says 1.00% rather than 1.50% for it.
            }
        }

        emit MarketEnrolled(token, vault, record.poolId);
    }

    // --- the switch ------------------------------------------------------------

    /// @notice Turn Boost on for a market. Everything earned up to this transaction stays
    /// the creator's; everything after it buys the token back.
    function enableBoost(address token) external nonReentrant returns (uint256 settled) {
        _requireOwner();
        // Enrols if it has to, so turning Boost on is one signature for a market that has
        // never been attached — which is every market the first time.
        Market storage market = _ensureEnrolled(token);
        if (market.boostEnabled) revert BoostAlreadyInThatState(token, true);

        // Both streams are claimed while Boost is still off, so the creator's share lands in
        // `creatorPending` and the platform's lands in Agen's ledger at the treasury. This is the
        // cutoff, and it is what stops enabling Boost from seizing either side's earlier fees.
        settled = _settle(market);
        uint256 platformSettled = _settlePlatform(market);

        market.boostEnabled = true;
        // After the settlement and after this contract's own flag, so the treasury's mirror can
        // never be on for a period this escrow considered off.
        _setPlatformBoost(market, true, platformSettled);

        emit BoostSet(token, true, settled, platformSettled);
    }

    /// @notice Turn Boost off. Fees earned from here on are the creator's again; everything
    /// already committed still gets spent on buybacks.
    function disableBoost(address token) external nonReentrant returns (uint256 settled) {
        _requireOwner();
        Market storage market = _requireEnrolled(token);
        if (market.boostLocked) revert BoostAlreadyLocked(token);
        if (!market.boostEnabled) revert BoostAlreadyInThatState(token, false);

        // Both streams are claimed while Boost is still on, so both stay committed. Without this
        // a creator could watch a large trade accrue, disable, and claim their share — and Agen's
        // share of those same trades would silently revert to Agen, which would make the 1.50%
        // claim false in retrospect for fees the market had already earned under it.
        settled = _settle(market);
        uint256 platformSettled = _settlePlatform(market);

        market.boostEnabled = false;
        _setPlatformBoost(market, false, platformSettled);

        emit BoostSet(token, false, settled, platformSettled);
    }

    /// @notice Give up the ability to ever turn Boost off for this market.
    ///
    /// @dev There is no counterpart and there will not be one. A market that can be unlocked is a
    /// market that was never locked, and the only value this function has is that the promise is
    /// not revocable.
    ///
    /// It locks **both** streams. `disableBoost` is the only function that turns either off and it
    /// refuses a locked market, so after this the creator's 1.00% and — where the deployment
    /// captures it — Agen's 0.50% are committed to this market's buybacks for as long as it
    /// trades. Neither the creator nor Agen can undo it.
    function lockBoostForever(address token) external {
        _requireOwner();
        Market storage market = _requireEnrolled(token);
        if (!market.boostEnabled) revert BoostNotEnabled(token);
        if (market.boostLocked) revert BoostAlreadyLocked(token);

        market.boostLocked = true;
        emit BoostLocked(token);
    }

    // --- funding ---------------------------------------------------------------

    /// @notice Claim this market's outstanding creator fees out of its vault.
    ///
    /// @dev Permissionless, because the vault's `claimCreator` is and because the two
    /// destinations here are fixed: Boost's commitment or the owner's balance, decided by a
    /// state the caller cannot influence.
    function settle(address token) public returns (uint256 amount) {
        return _settle(_ensureEnrolled(token));
    }

    /// @notice Add ether to a market's buybacks from outside its fee stream.
    ///
    /// @dev How Agen's 0.50% reaches Boost, and the honest shape of it. Every existing and
    /// every future vault has the platform treasury as an immutable, and that treasury is an
    /// EOA — so Agen's share cannot be routed here by code without redeploying the entire
    /// Instant stack. This function is therefore a contribution and not a redirection: it is
    /// Agen choosing to send ether, tracked in its own field, provable against the vault's
    /// `platformAccrued` by anyone who cares to check, and never counted as part of the
    /// creator's commitment.
    ///
    /// Open to anybody. A stranger who wants to fund somebody's burn may.
    function contribute(address token) external payable returns (uint256 pending) {
        Market storage market = _ensureEnrolled(token);
        if (msg.value == 0) revert NothingContributed();

        market.boostPending += msg.value;
        market.agenContributed += msg.value;

        emit BoostFunded(token, msg.value, true);
        return market.boostPending;
    }

    /// @notice Take the platform's 0.50% for this market's buybacks.
    ///
    /// @dev Called by `boostTreasury` and by nothing else, which is the whole of the
    /// authentication: that contract only ever sends a market's committed platform fees to the
    /// address the market's own vault names as its creator, and it verifies that address is an
    /// escrow this factory derived before it does. So there is no argument here a caller could
    /// abuse and no destination to aim.
    ///
    /// Booked to `boostPending` unconditionally rather than to whichever bucket the flag names.
    /// The treasury has already decided: it only holds ether for Boost when its mirror said Boost
    /// was on at the moment the fee arrived, and that mirror is set after this escrow's own flag.
    /// Re-deciding here would be a second implementation of the cutoff.
    function receivePlatformFee(address vault) external payable {
        address token = _tokenOfVault[vault];
        if (token == address(0)) revert NotEnrolled(vault);

        Market storage market = _markets[token];
        // Against this market's own treasury, not a contract-wide one. That is the whole of the
        // authentication and it is per market by construction: the address was read from the
        // vault's own immutable at enrolment, so only the contract that market's fees are actually
        // paid to can credit it.
        if (msg.sender != market.boostTreasury) revert NotBoostTreasury(msg.sender);
        market.boostPending += msg.value;
        market.platformRouted += msg.value;

        emit PlatformFeeRouted(token, vault, msg.value);
        emit BoostFunded(token, msg.value, true);
    }

    /// @notice Send the owner what this market owes them.
    ///
    /// @dev Permissionless and takes no destination, exactly as `InstantFeeVault.claimCreator`
    /// does and for the same reason: the only address this can pay is an immutable, so an
    /// open caller has nothing to redirect and Agen can pay a creator's gas without being
    /// able to touch their money.
    ///
    /// It cannot reach `boostPending`. That is not a check, it is a different storage field
    /// that no path in this contract adds to this one.
    function withdraw(address token) public nonReentrant returns (uint256 amount) {
        Market storage market = _requireEnrolled(token);

        amount = market.creatorPending;
        if (amount == 0) revert NothingToWithdraw();

        market.creatorPending = 0;
        emit Withdrawn(owner, amount);

        _pay(owner, amount);
    }

    /// @notice Claim a market's fees and pay out whatever of them is the owner's, in one
    /// transaction.
    ///
    /// @dev What the profile's claim button calls. With Boost off it is exactly today's
    /// behaviour from a creator's point of view — one signature, ether in their wallet — and
    /// with Boost on it commits the fees and pays out nothing, which is the point.
    function pull(address token) external returns (uint256 claimed, uint256 paid) {
        claimed = settle(token);
        if (_markets[token].creatorPending != 0) paid = withdraw(token);
    }

    /// @notice Move ether nobody could attribute to the owner.
    function sweepUnattributed() external nonReentrant returns (uint256 amount) {
        amount = unattributed;
        if (amount == 0) revert NothingToWithdraw();

        unattributed = 0;
        emit Withdrawn(owner, amount);

        _pay(owner, amount);
    }

    // --- the buyback -----------------------------------------------------------

    /// @notice Spend a market's committed ether buying its own token, and send every token
    /// bought to `DEAD`.
    ///
    /// @dev Permissionless. The three things a caller could otherwise abuse are all fixed
    /// here rather than trusted:
    ///
    ///  - **which pool** is `instantFactory.poolKeyFor(token)`, derived from the token and
    ///    the factory's own hook, so a caller cannot point the spend at a pool they made;
    ///  - **where the tokens go** is a constant;
    ///  - **how bad a price is acceptable** is floored against the pool's own spot price, so
    ///    `minTokensOut: 0` is refused.
    ///
    /// Runs even when Boost has since been switched off, because committed ether stays
    /// committed. What it will not do is run for a market with nothing committed, run twice
    /// inside `BOOST_INTERVAL`, or run on an amount too small to be worth its gas.
    ///
    /// @param minTokensOut The caller's own floor, which must be at least this contract's.
    /// @return spent Ether the pool actually took.
    /// @return bought Tokens the swap returned.
    /// @return sunk Tokens sent to `DEAD`, which is this contract's whole balance of them.
    function boost(address token, uint128 minTokensOut)
        external
        nonReentrant
        returns (uint256 spent, uint256 bought, uint256 sunk)
    {
        Market storage market = _ensureEnrolled(token);

        uint128 amountIn = _commit(token, market, minTokensOut);
        (spent, bought) = _swap(token, market, amountIn, minTokensOut);
        sunk = _sink(token);

        market.boostSpent += spent;
        market.tokensBought += bought;
        market.tokensSunk += sunk;

        emit BoostExecuted(token, msg.sender, spent, bought, sunk, market.tokensSunk, market.boostPending);
    }

    /// @dev Everything that must be true before a wei is spent, and the effects that make it
    /// safe to spend it. Split out from `boost` because the whole cycle in one frame is more
    /// locals than the optimiser can place.
    ///
    /// Returns the amount to spend, with the commitment already reduced by it: effects before
    /// the interaction, so a reentrant caller finds nothing left to spend.
    function _commit(address token, Market storage market, uint128 minTokensOut) private returns (uint128 amountIn) {
        if (minTokensOut == 0) revert ZeroMinimumOut();

        // The interval before anything else, so a call that was never going to run does not
        // pay for a settle it will roll back.
        uint40 earliest = market.lastBoostAt + BOOST_INTERVAL;
        // A sequencer nudging the clock by a few seconds against a half-hour interval changes
        // nothing worth defending: the bound exists to stop a budget being spent as a burst of
        // tiny swaps, and it does that at any plausible drift.
        // forge-lint: disable-next-line(block-timestamp)
        if (market.lastBoostAt != 0 && block.timestamp < earliest) {
            revert TooSoon(market.lastBoostAt, earliest);
        }

        // Then sweep in whatever either stream is holding, so a cycle spends everything available
        // rather than whatever happened to have been claimed already. Both, because a Boosted
        // market's budget is the creator's 1.00% and the platform's 0.50% together and spending
        // only one would leave the other idling for half an hour.
        _settle(market);
        _settlePlatform(market);
        _pullPlatform(market);

        uint256 pending = market.boostPending;
        if (pending < MIN_BOOST_WEI) revert BelowThreshold(pending, MIN_BOOST_WEI);

        // Unreachable — a market's fees are a fraction of trades in one pool — but a silent
        // truncation to `uint128` would spend the wrong amount rather than fail, so the
        // amount is clamped and the remainder simply stays committed for the next cycle.
        // forge-lint: disable-next-line(unsafe-typecast) -- the ternary is the bound check
        amountIn = pending > type(uint128).max ? type(uint128).max : uint128(pending);

        uint256 floor = _spotFloor(token, instantFactory.poolKeyFor(token), amountIn);
        if (minTokensOut < floor) revert SlippageTooLoose(minTokensOut, floor);

        market.boostPending = pending - amountIn;
        // forge-lint: disable-next-line(unsafe-typecast) -- uint40 holds timestamps to year 36812
        market.lastBoostAt = uint40(block.timestamp);
        market.boostCount += 1;
    }

    /// @dev The trade, through Agen's own router, in the pool derived from the token.
    function _swap(address token, Market storage market, uint128 amountIn, uint128 minTokensOut)
        private
        returns (uint256 spent, uint256 bought)
    {
        uint256 remainder = market.boostPending;

        // The refund of an input the pool could not take arrives from the PoolManager, which
        // is not a vault. This is what tells `receive()` to put it back on the commitment.
        _refunding = token;
        bought = agenRouter.swap{value: amountIn}(instantFactory.poolKeyFor(token), true, amountIn, minTokensOut, "");
        _refunding = address(0);

        // One-sided launch liquidity is finite, so a large input can be only partly consumed.
        // `receive()` has put whatever came back onto the commitment already, so the increase
        // over the remainder is the refund and the rest is what the pool took.
        spent = amountIn - (market.boostPending - remainder);
    }

    /// @dev Send every one of these tokens this contract holds to `DEAD`.
    ///
    /// The whole balance rather than the amount just bought, so a token that reached this
    /// contract by any other route is sunk with the rest instead of being stranded here
    /// forever — there is no other function that could move it. Reported separately from
    /// `bought` because they are different claims and the interface states both.
    function _sink(address token) private returns (uint256 sunk) {
        sunk = IERC20(token).balanceOf(address(this));
        if (sunk != 0) IERC20(token).safeTransfer(DEAD, sunk);
    }

    // --- views -----------------------------------------------------------------

    /// @notice Everything an interface needs about one market, in one call.
    struct BoostState {
        address vault;
        bool enrolled;
        bool enabled;
        bool locked;
        /// @dev Committed here and not yet spent. Does not include what is still in the
        /// vault; `vaultClaimable` is that.
        uint256 pending;
        /// @dev The owner's, waiting here to be withdrawn. What a creator's profile shows as
        /// claimable income, and it is never Boost money.
        uint256 creatorPending;
        /// @dev Whether this market's platform 0.50% is captured by Boost as well.
        ///
        /// False means Boost is the creator's 1.00% of trading fees; true means it is the full
        /// 1.50%. The interface must read this rather than assume, because "100% of trading fees"
        /// is only true of the second and stating it of the first would be the one overclaim this
        /// feature cannot afford.
        bool platformBoosted;
        /// @dev Agen's 0.50%, routed here by the fee architecture. Cumulative.
        uint256 platformRouted;
        /// @dev Where this market's platform fee is paid. Zero where it cannot be captured.
        address boostTreasury;
        /// @dev Agen's 0.50% sitting at the treasury, committed to this market and waiting for the
        /// next cycle to pull it. Part of what a buyback will spend, so an interface adds it to
        /// `pending` when it shows what is queued.
        uint256 platformPending;
        /// @dev Outstanding in the vault, which a settle would move. With Boost on it
        /// becomes Boost money; with Boost off it becomes the owner's.
        uint256 vaultClaimable;
        uint256 agenContributed;
        uint256 spent;
        uint256 bought;
        uint256 sunk;
        /// @dev The dead address's actual balance of this token, which is the number a
        /// circulating supply has to subtract. Read from the token rather than from
        /// `sunk`, because tokens reach `DEAD` by routes this contract knows nothing about.
        uint256 deadBalance;
        uint40 lastBoostAt;
        /// @dev The earliest a next cycle could run. Not a promise that one will.
        uint40 nextBoostAt;
        uint32 boostCount;
        /// @dev Whether a cycle would succeed right now, threshold and interval included.
        bool ready;
    }

    function boostStateOf(address token) external view returns (BoostState memory state) {
        Market storage market = _markets[token];

        state.vault = market.vault;
        state.enrolled = market.vault != address(0);
        state.enabled = market.boostEnabled;
        state.locked = market.boostLocked;
        state.pending = market.boostPending;
        state.creatorPending = market.creatorPending;
        state.platformBoosted = market.platformBoosted;
        state.platformRouted = market.platformRouted;
        state.boostTreasury = market.boostTreasury;
        state.agenContributed = market.agenContributed;
        state.spent = market.boostSpent;
        state.bought = market.tokensBought;
        state.sunk = market.tokensSunk;
        state.lastBoostAt = market.lastBoostAt;
        state.boostCount = market.boostCount;

        if (!state.enrolled) return state;

        state.vaultClaimable = IInstantFeeVault(market.vault).claimable(address(this));
        state.deadBalance = IERC20(token).balanceOf(DEAD);

        // The platform side of what a cycle would spend: what the treasury already holds for this
        // market, plus what its vault has not paid over yet. Both become Boost funds on the next
        // settle, so both belong in the figure an interface labels "pending".
        if (market.platformBoosted) {
            (,,, uint256 heldForBoost, uint256 platformInVault,,) =
                IBoostTreasury(market.boostTreasury).platformStateOf(market.vault);
            state.platformPending = heldForBoost + (market.boostEnabled ? platformInVault : 0);
        }
        state.nextBoostAt = market.lastBoostAt == 0 ? 0 : market.lastBoostAt + BOOST_INTERVAL;

        uint256 available =
            market.boostPending + state.platformPending + (market.boostEnabled ? state.vaultClaimable : 0);
        // A hint for a keeper and a label for an interface, not a guard. `boost` enforces both
        // bounds itself, so drift here can only make a caller try a second early.
        // forge-lint: disable-next-line(block-timestamp)
        state.ready = available >= MIN_BOOST_WEI && block.timestamp >= state.nextBoostAt;
    }

    /// @notice Every token enrolled here, in enrolment order.
    function enrolledTokens() external view returns (address[] memory) {
        return _enrolled;
    }

    function enrolledCount() external view returns (uint256) {
        return _enrolled.length;
    }

    /// @notice The token a vault's payments belong to, or zero.
    function tokenOfVault(address vault) external view returns (address) {
        return _tokenOfVault[vault];
    }

    /// @notice The least output this contract would accept for spending `amountIn` on
    /// `token` right now. What a keeper should quote against.
    function slippageFloor(address token, uint128 amountIn) external view returns (uint256) {
        if (_markets[token].vault == address(0)) revert NotEnrolled(token);
        return _spotFloor(token, instantFactory.poolKeyFor(token), amountIn);
    }

    // --- internals -------------------------------------------------------------

    /// @dev Pull whatever the vault owes this contract. The destination is decided by
    /// `receive()` from the market's state at this instant, which is what makes the toggles
    /// above a cutoff rather than a reallocation.
    ///
    /// Not an error when there is nothing there: this runs inside a toggle and inside every
    /// buyback, and a market nobody has traded since the last claim is a normal state.
    function _settle(Market storage market) private returns (uint256 amount) {
        IInstantFeeVault vault = IInstantFeeVault(market.vault);
        if (vault.claimable(address(this)) == 0) return 0;

        // The vault sends the ether with a bare call carrying no calldata, so the booking
        // happens in `receive()` below rather than here. This function deliberately does not
        // touch a balance itself: one place decides where an arriving wei belongs, and it is
        // the place that cannot be bypassed.
        amount = vault.claimCreator();
    }

    /// @dev Claim this market's outstanding platform fee, if this deployment captures one.
    ///
    /// Returns what moved. The destination is decided by the treasury's mirror at this instant,
    /// which is why both toggles call this *before* changing that mirror: everything up to the
    /// toggle transaction is assigned to the side being left, and nothing after it is.
    ///
    /// A no-op where `boostTreasury` is unset or where this market's vault pays a different
    /// address — the second happens for a market created by an Instant deployment whose treasury
    /// is an ordinary address, whose platform share is Agen's and cannot be routed here at all.
    function _settlePlatform(Market storage market) private returns (uint256 amount) {
        if (!market.platformBoosted) return 0;

        return IBoostTreasury(market.boostTreasury).settle(market.vault);
    }

    /// @dev Bring this market's committed platform fees over from the treasury.
    ///
    /// Separate from `_settlePlatform` because they are two different movements: that one claims
    /// the vault's outstanding platform fee *into* the treasury, and this one moves what the
    /// treasury has already booked for Boost *out* of it. A cycle needs both to have run.
    ///
    /// Tolerant of nothing to pull, which is the ordinary case for a market whose platform fee has
    /// just been settled to Agen instead.
    function _pullPlatform(Market storage market) private {
        if (!market.platformBoosted) return;

        IBoostTreasury treasury = IBoostTreasury(market.boostTreasury);
        (,,, uint256 boostPending,,,) = treasury.platformStateOf(market.vault);
        if (boostPending == 0) return;

        // Lands in `receivePlatformFee`, which books it to this market's commitment.
        treasury.pullForBoost(market.vault);
    }

    /// @dev Keep the treasury's mirror in step with this escrow's own flag.
    ///
    /// Only ever called immediately after `_settlePlatform` and after `boostEnabled` has been
    /// written, so there is no instant in which the two disagree about a period that has fees in
    /// it. `settled` is passed through only so the treasury's event carries the amount the cutoff
    /// assigned; it has no effect on accounting.
    function _setPlatformBoost(Market storage market, bool boosting, uint256 settled) private {
        if (!market.platformBoosted) return;

        IBoostTreasury(market.boostTreasury).setBoost(market.vault, boosting, settled);
    }

    /// @dev The floor described on `MAX_SLIPPAGE_BPS`.
    ///
    /// The fee is removed before the price is applied because the hook takes its 1.50% off
    /// the ether leg on the way in, so the pool only ever sees the net. Using the gross
    /// would put the floor 1.5% above anything achievable and stall every buyback.
    function _spotFloor(address token, PoolKey memory key, uint128 amountIn) private view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        if (sqrtPriceX96 == 0) revert PoolNotInitialised(token);

        (,, uint256 fee) = InstantFees.split(amountIn);
        uint256 netIn = amountIn - fee;

        // `(sqrtP / 2^96)^2 × netIn`, in two steps so neither intermediate has to hold the
        // square. `FullMath.mulDiv` carries the 512-bit product, so nothing overflows.
        uint256 spotOut =
            FullMath.mulDiv(FullMath.mulDiv(netIn, sqrtPriceX96, FixedPoint96.Q96), sqrtPriceX96, FixedPoint96.Q96);

        return (spotOut * (BPS - MAX_SLIPPAGE_BPS)) / BPS;
    }

    function _requireOwner() private view {
        if (msg.sender != owner) revert NotOwner(msg.sender);
    }

    function _requireEnrolled(address token) private view returns (Market storage market) {
        market = _markets[token];
        if (market.vault == address(0)) revert NotEnrolled(token);
    }

    function _pay(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);
    }

    /// @notice Books every wei that arrives, and never reverts.
    ///
    /// @dev Reverting here would be catastrophic and silent: `InstantFeeVault._pay` sends
    /// with a bare call and reverts the whole claim if it fails, so a receive that could
    /// throw would make a market's fees unreachable forever — the vault's recipient is an
    /// immutable and there would be no way to fix it. So this function has no requires, no
    /// external calls, and no path that can run out of anything.
    ///
    /// Three senders, in the order they are told apart:
    ///
    ///  1. the PoolManager refunding a buyback's unspent input, which `_refunding` names;
    ///  2. one of this contract's vaults paying out creator fees;
    ///  3. anybody else, which is booked as unattributed rather than assumed to be either.
    receive() external payable {
        if (msg.value == 0) return;

        address refunding = _refunding;
        if (refunding != address(0)) {
            _markets[refunding].boostPending += msg.value;
            return;
        }

        address token = _tokenOfVault[msg.sender];
        if (token == address(0)) {
            unattributed += msg.value;
            return;
        }

        Market storage market = _markets[token];
        if (market.boostEnabled) {
            market.boostPending += msg.value;
            emit BoostFunded(token, msg.value, false);
        } else {
            market.creatorPending += msg.value;
            emit CreatorFunded(token, msg.value);
        }
    }
}
