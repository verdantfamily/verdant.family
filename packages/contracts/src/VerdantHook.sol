// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";

import {ScheduleLib} from "./libraries/ScheduleLib.sol";
import {VerdantConstants} from "./libraries/VerdantConstants.sol";

/// @title VerdantHook
/// @notice The fee schedule of every Verdant market, enforced by Uniswap v4.
///
/// @dev One hook serves every market, every model and both quote sides — a market
/// paired against ether and one paired against a tokenized equity are the same pool
/// shape with a different `currency0`, and nothing in this contract reads the
/// currencies at all. A market's schedule is
/// written once, when its market is created, and is then readable forever and
/// writable by nobody — including by Verdant. There is no owner, no setter, no
/// upgrade path, no `delegatecall` and no `selfdestruct` in this contract.
///
/// WHAT THIS HOOK DOES ON A SWAP
/// It reads one storage slot and returns a fee. No external calls, no writes,
/// no custody — the swap path touches nothing it does not own. The creation path
/// makes exactly two external calls in a market's whole lifetime:
/// `updateDynamicLPFee` when the pool is initialised, and one `msgSender()` when
/// the locked position is minted. Nothing after creation calls out at all.
/// It takes no custody of anything.
/// It declares none of v4's `*_RETURNS_DELTA` permissions, so v4 will not even
/// read a delta from it: the swap accounting is arithmetically unable to be
/// altered from here. The alternative design — a zero LP fee with the hook
/// skimming the ETH leg — was rejected for v1 because it puts custody and a
/// settle/take pair inside the swap, which is the most expensive surface to
/// review on a contract that cannot be fixed after deployment. It stays
/// available as an addition: a different hook, at a different address, for
/// future markets.
///
/// WHY THE ADDRESS MATTERS
/// v4 decides which callbacks exist by reading the low 14 bits of this
/// contract's own address, so the address is part of the security model rather
/// than an artefact of deployment. The required value is
/// `REQUIRED_PERMISSIONS` = 0x3880, and the constructor refuses to deploy
/// anywhere else. `script/MineHook.s.sol` finds the CREATE2 salt.
///
/// WHY CONFIGURATION IS TWO CALLS
/// v4's initialise path carries no hook data at the pinned commit —
/// `initialize(PoolKey, uint160)` and `beforeInitialize(address, PoolKey,
/// uint160)` have nowhere to put a schedule. The factory therefore calls
/// `configure` and then `PoolManager.initialize` in the same transaction.
/// `beforeInitialize` refuses to let a pool exist unless a configuration is
/// already present for its PoolId, so the two cannot come apart. See V15 in
/// docs/verification.md and docs/decisions/004-ihooks-not-basehook.md.
contract VerdantHook is IHooks {
    using LPFeeLibrary for uint24;
    using ScheduleLib for ScheduleLib.Packed;

    // --- permissions ---------------------------------------------------------

    /// @notice The low 14 bits this contract's address must have: 0x3880.
    ///
    /// @dev Composed from Uniswap's own flags rather than written as a literal,
    /// so that a change to their meaning upstream is a compile-time change here.
    /// `test/VerdantHook.permissions.t.sol` asserts it equals 0x3880 bit by bit
    /// and that every `*_RETURNS_DELTA` bit is clear.
    uint160 internal constant REQUIRED_PERMISSIONS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG
    );

    // --- immutables ----------------------------------------------------------

    /// @notice The only address permitted to call any callback on this contract.
    IPoolManager public immutable poolManager;

    /// @notice The only address permitted to configure a market or initialise a
    /// pool with this hook.
    ///
    /// @dev A plain immutable, not a lookup. The factory/hook construction cycle
    /// is broken by ordering — the factory is deployed first, this hook is mined
    /// against the factory's address, and the factory learns this address from
    /// the deployment record afterwards — which means this contract never has to
    /// ask anyone who the factory is.
    address public immutable factory;

    /// @notice Number of market models this hook will accept a discriminant for.
    ///
    /// @dev Deliberately the only model rule enforced here. Per-model policy —
    /// how many stages Progressive must have, what reserve share Evergreen
    /// requires — lives in ModelRegistry, whose owner may change it for future
    /// markets, and is enforced by the factory at creation. Duplicating a
    /// changeable bound into an immutable contract is how the two end up
    /// disagreeing. See docs/decisions/005-splits-belong-to-the-splitter.md.
    uint8 internal constant MODEL_COUNT = 3;

    /// @notice The only contract permitted to add liquidity to a Verdant pool.
    ///
    /// @dev v4 reports the *PoolManager's* caller as `sender` in
    /// `beforeAddLiquidity`, which for every mint routed through periphery is the
    /// PositionManager rather than the person who asked (V11 in
    /// docs/verification.md). Pinning it here is the first half of the
    /// authentication: it establishes that the contract reporting an initiator is
    /// the one deployed contract whose reporting can be trusted.
    address public immutable positionManager;

    // --- storage -------------------------------------------------------------

    /// @dev Two words per market: the model, the stage count, the initialisation
    /// time and up to four stages in the first, four more in the second. A
    /// market with four stages or fewer is one SLOAD on the swap path.
    mapping(PoolId poolId => ScheduleLib.Packed schedule) private _schedules;

    // --- events --------------------------------------------------------------

    /// @notice A market's schedule was written. Emitted exactly once per PoolId.
    event MarketConfigured(PoolId indexed poolId, uint8 model, uint256 stageCount, uint256 word0, uint256 word1);

    /// @notice The pool was initialised and the first stage's fee applied.
    event MarketInitialized(PoolId indexed poolId, uint40 initTime, uint24 feePpm);

    // --- errors --------------------------------------------------------------

    /// @notice A callback was invoked by something other than the PoolManager.
    error NotPoolManager(address caller);

    /// @notice `configure`, or an initialisation, was attempted by a caller
    /// other than the Verdant factory.
    error NotFactory(address caller);

    /// @notice This contract is deployed at an address whose low 14 bits do not
    /// grant exactly the permissions it implements.
    error HookAddressMismatch(address hook, uint160 actualBits, uint160 requiredBits);

    /// @notice A second configuration of a PoolId that already has one.
    error AlreadyConfigured(PoolId poolId);

    /// @notice A pool was initialised whose PoolId has no configuration.
    error NotConfigured(PoolId poolId);

    /// @notice Model discriminant is not one this hook recognises.
    error UnknownModel(uint8 model, uint8 modelCount);

    /// @notice The pool's fee is a static fee. The schedule can only be applied
    /// to a dynamic-fee pool.
    error FeeNotDynamic(uint24 fee);

    /// @notice The pool's tick spacing is not Verdant's.
    error TickSpacingMismatch(int24 provided, int24 required);

    /// @notice The key names a different hook, so its PoolId is not a pool this
    /// contract will ever be called for.
    error HookNotThis(IHooks provided, address expected);

    /// @notice Liquidity was added through something other than the pinned
    /// PositionManager.
    /// @dev Not a policy about routers. `sender` is the contract whose
    /// `msgSender()` this hook is about to believe, and an unpinned one can
    /// return whatever it likes.
    error NotPositionManager(address sender);

    /// @notice A callback this hook does not have permission to receive was
    /// called anyway. Present only because `IHooks` declares it.
    error CallbackNotEnabled();

    // --- construction --------------------------------------------------------

    /// @param poolManager_ The v4 PoolManager. The sole permitted caller.
    /// @param factory_ The Verdant factory. The sole permitted configurer.
    ///
    /// @dev The address check is the reason this constructor exists. v4 itself
    /// does *not* verify that a hook's address grants the permissions the hook
    /// implements — `Hooks.isValidHookAddress` only rejects structurally
    /// impossible combinations — so a hook deployed to an unmined address would
    /// be accepted by `PoolManager.initialize` and then silently never called.
    /// Checking here fails at deployment, before any pool can reference it,
    /// which is the earliest point at which it can be caught and the only one
    /// that catches an address with no permission bits at all.
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

    /// @notice Writes a market's fee schedule. Callable once per PoolId, by the
    /// factory, and never again by anyone.
    ///
    /// @dev Validation happens here rather than in `beforeInitialize` because
    /// this is where the schedule arrives, and because a rejected schedule
    /// should tell the creator which rule it broke. `PoolId` is a hash of the
    /// whole `PoolKey`, so validating the key here and requiring a configuration
    /// in `beforeInitialize` means the pool that gets initialised is necessarily
    /// the pool whose key was checked.
    ///
    /// `initTime` is left at zero deliberately: the pool does not exist yet, and
    /// `afterInitialize` records the real one.
    function configure(PoolKey calldata key, uint8 model, ScheduleLib.Stage[] calldata stages) external {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        if (model >= MODEL_COUNT) revert UnknownModel(model, MODEL_COUNT);
        _requireVerdantKey(key);

        PoolId poolId = _toId(key);
        if (_isConfigured(poolId)) revert AlreadyConfigured(poolId);

        // `pack` validates; an invalid schedule cannot reach storage, because
        // every field is written with a mask and would otherwise be truncated
        // into a different, plausible-looking schedule.
        ScheduleLib.Packed memory packed = ScheduleLib.pack(model, 0, stages);

        ScheduleLib.Packed storage stored = _schedules[poolId];
        stored.word0 = packed.word0;
        // Left untouched when the schedule fits one word, so a small market
        // never pays for a second slot it will never read.
        if (packed.word1 != 0) stored.word1 = packed.word1;

        emit MarketConfigured(poolId, model, stages.length, packed.word0, packed.word1);
    }

    // --- v4 callbacks --------------------------------------------------------

    /// @inheritdoc IHooks
    /// @dev Two questions only: is this the factory's pool, and has its schedule
    /// been written. The key's own fields were checked when it was configured,
    /// and the PoolId binds the two together.
    function beforeInitialize(address sender, PoolKey calldata key, uint160) external view override returns (bytes4) {
        _requirePoolManager();
        if (sender != factory) revert NotFactory(sender);

        // Re-checked at runtime, not only at construction, because the
        // constructor cannot speak for code placed at an address by any means
        // other than construction. It costs one comparison, once per market.
        uint160 bits = uint160(address(this)) & Hooks.ALL_HOOK_MASK;
        if (bits != REQUIRED_PERMISSIONS) {
            revert HookAddressMismatch(address(this), bits, REQUIRED_PERMISSIONS);
        }

        PoolId poolId = _toId(key);
        if (!_isConfigured(poolId)) revert NotConfigured(poolId);

        return IHooks.beforeInitialize.selector;
    }

    /// @inheritdoc IHooks
    /// @dev Records the initialisation time every stage offset is measured from,
    /// and applies stage 0's fee. The `updateDynamicLPFee` call is the only
    /// external call this contract makes in its entire lifetime; it has to be
    /// here rather than in `beforeInitialize` because the pool it updates does
    /// not exist until v4 has finished initialising it.
    function afterInitialize(address, PoolKey calldata key, uint160, int24) external override returns (bytes4) {
        _requirePoolManager();

        PoolId poolId = _toId(key);
        ScheduleLib.Packed storage schedule = _schedules[poolId];

        // forge-lint: disable-next-line(unsafe-typecast) -- uint40 holds timestamps to year 36812
        uint40 initTime = uint40(block.timestamp);
        schedule.recordInitTime(initTime);

        uint24 feePpm = ScheduleLib.feeAtStored(schedule, block.timestamp);
        poolManager.updateDynamicLPFee(key, feePpm);

        emit MarketInitialized(poolId, initTime, feePpm);
        return IHooks.afterInitialize.selector;
    }

    /// @inheritdoc IHooks
    /// @dev The swap path. One SLOAD for a market of four stages or fewer, no
    /// external calls, no storage writes, no custody, and a zero delta. The
    /// returned fee carries `OVERRIDE_FEE_FLAG`, which is what makes v4 use it
    /// for this swap instead of the pool's stored fee.
    ///
    /// This function must not revert for any reachable input. A schedule that
    /// could revert here would be a market that cannot be traded, which is worse
    /// than any fee it might return.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        view
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _requirePoolManager();

        uint24 feePpm = ScheduleLib.feeAtStored(_schedules[_toId(key)], block.timestamp);

        // ScheduleLib caps fees at 100_000 ppm (10%), two orders below v4's
        // MAX_LP_FEE, so the OR below cannot collide with the flag bits.
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, feePpm | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @inheritdoc IHooks
    /// @notice Exactly one position ever exists in a Verdant pool: the locked one
    /// the factory mints at creation. This is what makes that true.
    ///
    /// @dev Two checks, and neither is sufficient alone.
    ///
    /// `sender` must be the pinned PositionManager. `sender` is v4's name for the
    /// PoolManager's caller, and the next line asks it who *its* caller was — so
    /// if any contract could occupy this position, any contract could answer that
    /// question, and the answer would be worth nothing.
    ///
    /// The initiator must then be the factory. This is the check that actually
    /// restricts liquidity, and it holds for the same reason `configure` does:
    /// the factory is immutable, and it adds liquidity exactly once per market,
    /// during creation, before anybody else can reach the pool.
    ///
    /// The consequence is deliberately absolute. After creation, *nobody* can add
    /// liquidity to a Verdant pool — not the creator, not a passer-by, and not
    /// Verdant. A pool whose depth can be added to is a pool whose depth can be
    /// removed from, and the permanence of the locked position is the one promise
    /// a buyer cannot verify for themselves after the fact.
    ///
    /// This reads one external contract, which the swap path never does. It is
    /// the price of v4 discarding the initiator before the hook is called, and
    /// V11 records the alternatives considered: `hookData` is caller-supplied and
    /// therefore not a credential, and `sender` alone is the same address for
    /// every mint anyone makes.
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

    // --- views ---------------------------------------------------------------

    /// @notice The LP fee, in ppm and without any flag, at `timestamp`.
    function feeAt(PoolId poolId, uint256 timestamp) external view returns (uint24) {
        return ScheduleLib.feeAt(_schedules[poolId], timestamp);
    }

    /// @notice The index of the stage active at `timestamp`.
    function stageAt(PoolId poolId, uint256 timestamp) external view returns (uint256) {
        return ScheduleLib.stageAt(_schedules[poolId], timestamp);
    }

    /// @notice The market's configuration, as it was supplied.
    /// @dev The inverse of `configure`. `initTime` is zero until the pool is
    /// initialised.
    function configOf(PoolId poolId)
        external
        view
        returns (uint8 model, uint40 initTime, ScheduleLib.Stage[] memory stages)
    {
        return ScheduleLib.unpack(_schedules[poolId]);
    }

    /// @notice The timestamp of the next stage transition, or 0 if none remains.
    function nextTransition(PoolId poolId, uint256 timestamp) external view returns (uint256) {
        return ScheduleLib.nextTransition(_schedules[poolId], timestamp);
    }

    /// @notice Whether a schedule has been written for this PoolId.
    function isConfigured(PoolId poolId) external view returns (bool) {
        return _isConfigured(poolId);
    }

    /// @notice The permissions this hook implements, in Uniswap's own struct.
    /// @dev Not required by v4 — nothing on chain reads it — but it is the
    /// canonical machine-readable statement of what this contract can do, and
    /// the permissions test asserts it against both the address bits and the
    /// absence of every delta-returning flag.
    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: true,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // --- internals -----------------------------------------------------------

    function _requirePoolManager() private view {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);
    }

    /// @dev A configured schedule always has a non-zero stage count in `word0`,
    /// so a zero first word means "never configured" and cannot mean anything
    /// else. The stage count is written by `pack`, which rejects zero stages.
    function _isConfigured(PoolId poolId) private view returns (bool) {
        return _schedules[poolId].word0 != 0;
    }

    /// @dev The three properties of a Verdant pool key. Checked where the key
    /// enters the system rather than where the pool is created, because
    /// `key.hooks` cannot be wrong by the time v4 calls this contract — v4 calls
    /// whatever `key.hooks` names — and because the PoolId carries all three into
    /// `beforeInitialize` regardless.
    ///
    /// The currencies are not among them. This hook used to require `currency0` to
    /// be native ether, which was true of every market that could then exist and is
    /// no longer: a market may be quoted in a reviewed equity token instead. Which
    /// assets are admitted is policy, it can change for future markets, and
    /// `ModelRegistry` owns it — so the factory reads it there and this contract,
    /// which cannot be changed, does not hold a second copy of a rule that can. The
    /// guarantee that survives is the one that matters: only the factory can
    /// configure a schedule or initialise a pool here, so a Verdant pool's quote
    /// asset was admitted at the moment it was created. See
    /// docs/decisions/005-splits-belong-to-the-splitter.md for the same argument
    /// about fee splits, and 008 for this one.
    function _requireVerdantKey(PoolKey calldata key) private view {
        if (!key.fee.isDynamicFee()) revert FeeNotDynamic(key.fee);
        if (key.tickSpacing != VerdantConstants.TICK_SPACING) {
            revert TickSpacingMismatch(key.tickSpacing, VerdantConstants.TICK_SPACING);
        }
        if (address(key.hooks) != address(this)) revert HookNotThis(key.hooks, address(this));
    }

    /// @dev Uniswap's own definition. Computing the id here instead would be a
    /// second definition of what a PoolId is, and the two would have to agree
    /// forever for a market's configuration to remain findable.
    function _toId(PoolKey calldata key) private pure returns (PoolId) {
        return PoolIdLibrary.toId(key);
    }

    // --- callbacks this hook cannot receive ----------------------------------
    // `IHooks` declares all ten. The address bits deny these six, so v4 will
    // never call them; they exist to satisfy the interface, and inheriting the
    // interface is what guarantees the six above have exactly the signatures v4
    // will call. They revert rather than returning a selector so that a future
    // hook cannot inherit this one and quietly gain a permission.

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
    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        override
        returns (bytes4, int128)
    {
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
