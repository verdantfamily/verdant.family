/**
 * Solidity written into every generated workspace before the model sees it.
 *
 * ## Why this exists
 *
 * The first live build that reached code generation failed three compilation repairs in
 * a row, all on the same thing: the model did not know where Uniswap v4's types live in
 * the commit this repository pins. It imported `ModifyPositionParams` from
 * `PoolOperation.sol`, then as a nested type on `IPoolManager`, then reached for
 * `v4-core/src/types/PoolManager.sol`, which is not a file. Each guess cost around two
 * minutes and none of them was about the market.
 *
 * That is not a failure of the model so much as a badly posed question. v4's API moved
 * repeatedly between release candidates, the training data contains every version of
 * it, and a list of import paths in a prompt is a weak way to say "this one". The strong
 * way is to hand over a base contract that already imports correctly and already
 * implements the interface, and ask for the market logic rather than the plumbing.
 *
 * ## What it buys beyond compiling
 *
 * The generated hook gets shorter, so it generates faster and there is less of it to
 * review. The permission bits, the pool-manager check and the callback signatures stop
 * being things a model can get subtly wrong — the unguarded-hook bug that a gate now
 * catches is structurally impossible against this base, because the only entry points
 * are already guarded.
 *
 * ## Why it is written rather than imported
 *
 * It lands in the job's own `contracts/` directory as a normal source file, compiled
 * alongside the generated market and visible on the review screen. A market's
 * deployable bytecode should be reproducible from the files in its workspace, and a
 * dependency resolved from somewhere else at build time is a file nobody reviewing the
 * market ever sees.
 */

import type { GeneratedSource } from "./workspace.js";

/**
 * The base every generated hook extends.
 *
 * Implements `IHooks` in full: the callbacks a market opts into are `virtual` and
 * default to doing nothing, and the ones it does not are left as reverts so that a
 * mismatch between the declared permissions and the address fails loudly rather than
 * silently. Everything imports from paths verified against the vendored tree by
 * `buildContext`.
 */
const BASE_HOOK = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";

/// @title AgenBaseHook
/// @notice The plumbing every Agen market hook shares. Extend this; do not reimplement it.
///
/// @dev Provided by Agen, not generated. It pins the import paths and the callback
/// signatures for the exact Uniswap v4 commit this project builds against, which is the
/// single largest source of generated code that compiles nowhere.
///
/// Override only the callbacks your market needs, and declare exactly those in
/// getHookPermissions. The address a hook is deployed to encodes its permissions, so a
/// callback you declare without implementing reverts every swap, and one you implement
/// without declaring is never called.
abstract contract AgenBaseHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using LPFeeLibrary for uint24;

    IPoolManager public immutable poolManager;

    error NotPoolManager(address caller);
    error CallbackNotEnabled();

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    /// @dev The only caller a hook may trust. Every entry point below carries it, which
    /// is why a market built on this base cannot ship the "anybody can call the hook"
    /// bug.
    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);
        _;
    }

    /// @notice Declare exactly the callbacks this market implements.
    function getHookPermissions() public pure virtual returns (Hooks.Permissions memory);

    // --- the callbacks, wired to overridable internals ------------------------

    function beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        external
        onlyPoolManager
        returns (bytes4)
    {
        _beforeInitialize(sender, key, sqrtPriceX96);
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96, int24 tick)
        external
        onlyPoolManager
        returns (bytes4)
    {
        _afterInitialize(sender, key, sqrtPriceX96, tick);
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4) {
        _beforeAddLiquidity(sender, key, params, hookData);
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        (BeforeSwapDelta delta, uint24 fee) = _beforeSwap(sender, key, params, hookData);
        return (IHooks.beforeSwap.selector, delta, fee);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, int128) {
        int128 adjustment = _afterSwap(sender, key, params, delta, hookData);
        return (IHooks.afterSwap.selector, adjustment);
    }

    // --- override these -------------------------------------------------------

    function _beforeInitialize(address, PoolKey calldata, uint160) internal virtual {}

    function _afterInitialize(address, PoolKey calldata, uint160, int24) internal virtual {}

    function _beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        virtual
    {}

    /// @return delta What this hook takes from the swap. BeforeSwapDeltaLibrary.ZERO_DELTA
    /// when it takes nothing.
    /// @return fee The LP fee for this swap. It MUST carry LPFeeLibrary.OVERRIDE_FEE_FLAG
    /// or the pool ignores it and keeps its stored fee.
    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        virtual
        returns (BeforeSwapDelta delta, uint24 fee)
    {
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        virtual
        returns (int128)
    {
        return 0;
    }

    // --- helpers a market usually wants ---------------------------------------

    /// @notice The currency a trade is spending, which is where a fee belongs.
    function inputCurrency(PoolKey calldata key, SwapParams calldata params)
        internal
        pure
        returns (Currency)
    {
        return params.zeroForOne ? key.currency0 : key.currency1;
    }

    /// @notice True when the trader is buying the launched token.
    /// @dev An Agen pool is always (quote, token), so zeroForOne means spending quote to
    /// receive the token.
    function isBuy(SwapParams calldata params) internal pure returns (bool) {
        return params.zeroForOne;
    }

    /// @notice The size of the swap, however it was specified.
    function swapAmount(SwapParams calldata params) internal pure returns (uint256) {
        return params.amountSpecified < 0 ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
    }

    /// @notice Move amount of currency out of the pool and into recipient.
    /// @dev Must be paired with a matching BeforeSwapDelta or the swap fails to settle.
    function takeInto(Currency currency, address recipient, uint256 amount) internal {
        poolManager.take(currency, recipient, amount);
    }

    // --- the callbacks this base does not enable ------------------------------
    //
    // Present because IHooks requires them, and reverting because a market that has not
    // implemented one should fail loudly if its address somehow grants it.

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external virtual returns (bytes4, BalanceDelta) {
        revert CallbackNotEnabled();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        virtual
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
    ) external virtual returns (bytes4, BalanceDelta) {
        revert CallbackNotEnabled();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        virtual
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        virtual
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }
}
`;


/**
 * A vault that holds value a hook diverts, and nothing else.
 *
 * The most-reached-for shape in every market that takes a fee: jackpots, buyback
 * reserves, reward pools and round prizes are all this contract with a different name
 * on the front. Generating it fresh each time costs a minute and produces a slightly
 * different bug surface every launch.
 */
const FEE_VAULT = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title FeeVault
/// @notice Holds value the hook diverts, and records how much arrived.
/// @dev Provided by Agen. A hook must never hold balances — it is called on every swap,
/// so a hook with a balance has a withdrawal path in every callback. This has one way
/// in and one way out.
///
/// credited exists so a test can prove the vault received what the hook claimed to
/// take. A ledger that disagrees with the balance is the difference between real custody
/// and a number in storage.
contract FeeVault {
    address public hook;
    address public immutable owner;

    /// @notice What the hook has recorded arriving, per currency. Zero address is ether.
    mapping(address => uint256) public credited;
    mapping(address => uint256) public withdrawn;

    error AlreadyWired(address hook);
    error NotHook(address caller);
    error NotOwner(address caller);
    error InsufficientBalance(uint256 requested, uint256 available);

    event Credited(address indexed currency, uint256 amount);
    event Withdrawn(address indexed currency, address indexed to, uint256 amount);

    constructor(address owner_) {
        owner = owner_;
    }

    /// @dev Set once, by the deployment, before the pool exists. See AgenFactory wiring.
    function setHook(address hook_) external {
        if (hook != address(0)) revert AlreadyWired(hook);
        hook = hook_;
    }

    function credit(address currency, uint256 amount) external {
        if (hook == address(0) || msg.sender != hook) revert NotHook(msg.sender);
        credited[currency] += amount;
        emit Credited(currency, amount);
    }

    /// @notice Move value out. Restricted to the owner named at deployment.
    function withdraw(address currency, address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);

        uint256 available = currency == address(0) ? address(this).balance : IERC20Minimal(currency).balanceOf(address(this));
        if (amount > available) revert InsufficientBalance(amount, available);

        withdrawn[currency] += amount;
        emit Withdrawn(currency, to, amount);

        if (currency == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            require(ok, "transfer failed");
        } else {
            require(IERC20Minimal(currency).transfer(to, amount), "transfer failed");
        }
    }

    receive() external payable {}
}

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}
`;

/**
 * Rewards owed to many wallets, in constant gas.
 *
 * The answer to "distribute proportionally to every holder", which is the single most
 * common request that cannot be implemented the way it is asked for: paying everyone in
 * a loop costs gas proportional to participation, so the round that finally attracts a
 * crowd is the round nobody can settle.
 *
 * The economics are identical and the implementation is not — shares accrue against an
 * index and are withdrawn rather than sent.
 */
const REWARD_ACCUMULATOR = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title RewardAccumulator
/// @notice Reward-per-share accounting with pull-based claims.
/// @dev Provided by Agen. Use this whenever value is owed to many wallets in proportion
/// to something they did. Paying them in a loop is the obvious implementation and it
/// stops working exactly when the market succeeds.
///
/// The index is scaled by 1e18 so integer division does not strand most of a small
/// reward. Dust below one wei per share stays in the contract rather than being minted
/// from nothing.
abstract contract RewardAccumulator {
    uint256 private constant PRECISION = 1e18;

    uint256 public totalShares;
    uint256 public rewardPerShare;

    mapping(address => uint256) public shares;
    mapping(address => uint256) public rewardDebt;
    mapping(address => uint256) public claimable;

    event SharesChanged(address indexed account, uint256 shares, uint256 totalShares);
    event RewardAdded(uint256 amount, uint256 rewardPerShare);
    event RewardClaimed(address indexed account, uint256 amount);

    /// @notice Give an account a share of future rewards.
    function _setShares(address account, uint256 newShares) internal {
        _settle(account);

        totalShares = totalShares - shares[account] + newShares;
        shares[account] = newShares;
        rewardDebt[account] = (newShares * rewardPerShare) / PRECISION;

        emit SharesChanged(account, newShares, totalShares);
    }

    /// @notice Distribute amount across every current share.
    /// @dev Does nothing when there are no shares: crediting an empty pool would make
    /// the value unreachable, and holding it until somebody has a share does not.
    function _addReward(uint256 amount) internal returns (bool distributed) {
        if (totalShares == 0 || amount == 0) return false;

        rewardPerShare += (amount * PRECISION) / totalShares;
        emit RewardAdded(amount, rewardPerShare);
        return true;
    }

    /// @notice What an account may withdraw right now.
    function pending(address account) public view returns (uint256) {
        uint256 accrued = (shares[account] * rewardPerShare) / PRECISION;
        return claimable[account] + (accrued > rewardDebt[account] ? accrued - rewardDebt[account] : 0);
    }

    function _settle(address account) internal {
        uint256 owed = pending(account);
        claimable[account] = owed;
        rewardDebt[account] = (shares[account] * rewardPerShare) / PRECISION;
    }

    /// @notice Zero an account's balance and return what it was, for the caller to pay.
    /// @dev The balance is cleared before this returns, so a reentrant caller finds
    /// nothing owed.
    function _takeClaim(address account) internal returns (uint256 amount) {
        _settle(account);
        amount = claimable[account];
        claimable[account] = 0;
        if (amount > 0) emit RewardClaimed(account, amount);
    }
}
`;

/**
 * Time in fixed windows, settled when somebody next interacts.
 *
 * Every "each hour", "each round", "every fifteen minutes" mechanic needs this, and
 * every one of them meets the same wall: nothing on chain can schedule a call, so a
 * period ends on the first transaction after its time is up rather than at the instant
 * it expires.
 */
const EPOCH_ACCOUNTING = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title EpochAccounting
/// @notice Fixed-length periods that close lazily.
/// @dev Provided by Agen. Nothing on chain can wake itself up, so an epoch ends on the
/// first interaction after its length has elapsed. That is the only implementation
/// available and markets should disclose it rather than imply a timer.
///
/// Handles the case a hand-written version usually forgets: a gap longer than one epoch.
/// After an hour of silence with ten-minute epochs, six have passed, and settling one
/// while claiming the clock is current quietly desynchronises every period after it.
abstract contract EpochAccounting {
    uint256 public immutable epochLength;

    uint256 public currentEpoch;
    uint256 public epochStartedAt;

    event EpochClosed(uint256 indexed epoch, uint256 at);
    event EpochOpened(uint256 indexed epoch, uint256 at);

    constructor(uint256 epochLength_) {
        require(epochLength_ > 0, "epoch length");
        epochLength = epochLength_;
        epochStartedAt = block.timestamp;
    }

    /// @notice Whether the open epoch has outlived its length.
    function epochIsDue() public view returns (bool) {
        return block.timestamp >= epochStartedAt + epochLength;
    }

    /// @notice How many whole epochs have elapsed without being closed.
    function epochsElapsed() public view returns (uint256) {
        if (!epochIsDue()) return 0;
        return (block.timestamp - epochStartedAt) / epochLength;
    }

    /// @notice Close every epoch whose time has passed, in order.
    /// @dev Bounded by maxToClose so a market that sat idle for a month cannot make
    /// the next trade unminable. The remainder close on subsequent interactions.
    function _rollEpochs(uint256 maxToClose) internal returns (uint256 closed) {
        uint256 due = epochsElapsed();
        if (due == 0) return 0;

        closed = due > maxToClose ? maxToClose : due;

        for (uint256 i = 0; i < closed; i++) {
            _onEpochClosed(currentEpoch);
            emit EpochClosed(currentEpoch, block.timestamp);

            currentEpoch += 1;
            epochStartedAt += epochLength;
            emit EpochOpened(currentEpoch, epochStartedAt);
        }
    }

    /// @notice Settle one epoch. Override with the market's own rules.
    function _onEpochClosed(uint256 epoch) internal virtual;
}
`;

/**
 * A price the chain cannot know by itself, with an explicit staleness policy.
 *
 * External data is the one dependency a market cannot hide, and the failure behaviour
 * is the part that gets skipped: an adapter that returns a stale price during an outage
 * turns a market's rules into whatever the last update said.
 */
const ORACLE_ADAPTER = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title OracleAdapter
/// @notice A price feed with a staleness bound and a stated failure behaviour.
/// @dev Provided by Agen. Markets that depend on outside information must disclose it,
/// and an adapter is where that dependency becomes explicit rather than buried.
///
/// readPrice never reverts. A rule that cannot get a price should decide what to do —
/// usually nothing — rather than blocking the trade, because a hook that reverts during
/// an oracle outage stops the market rather than pausing a mechanic.
contract OracleAdapter {
    address public immutable feed;
    uint256 public immutable maxAgeSeconds;
    address public immutable owner;

    error NotOwner(address caller);

    constructor(address feed_, uint256 maxAgeSeconds_, address owner_) {
        feed = feed_;
        maxAgeSeconds = maxAgeSeconds_;
        owner = owner_;
    }

    /// @return price The latest price, or zero when there is not a usable one.
    /// @return fresh False when the feed is unreachable or older than maxAgeSeconds.
    function readPrice() external view returns (uint256 price, bool fresh) {
        if (feed == address(0)) return (0, false);

        (bool ok, bytes memory data) =
            feed.staticcall(abi.encodeWithSignature("latestRoundData()"));
        if (!ok || data.length < 160) return (0, false);

        (, int256 answer,, uint256 updatedAt,) =
            abi.decode(data, (uint80, int256, uint256, uint256, uint80));

        if (answer <= 0) return (0, false);
        if (block.timestamp > updatedAt + maxAgeSeconds) return (uint256(answer), false);

        return (uint256(answer), true);
    }
}
`;

/**
 * Work that has to be triggered from outside, made explicit.
 *
 * The companion to lazy settlement. Some mechanics genuinely need somebody to press a
 * button — executing a buyback, closing an epoch nobody traded in — and the honest
 * design says so and lets anybody do it, rather than pretending the chain will.
 */
const KEEPER_ADAPTER = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title KeeperAdapter
/// @notice Permissionless upkeep with a minimum interval.
/// @dev Provided by Agen. Where a mechanic needs an outside trigger, anybody should be
/// able to supply it: restricting upkeep to one address makes that address able to
/// freeze the mechanic by doing nothing.
///
/// The interval exists so upkeep cannot be spammed into a griefing vector when the work
/// costs the market something.
abstract contract KeeperAdapter {
    uint256 public immutable minInterval;
    uint256 public lastUpkeepAt;

    error TooSoon(uint256 nextAllowedAt);

    event UpkeepPerformed(address indexed caller, uint256 at);

    constructor(uint256 minInterval_) {
        minInterval = minInterval_;
    }

    function upkeepDue() public view returns (bool) {
        return block.timestamp >= lastUpkeepAt + minInterval;
    }

    /// @notice Perform the market's upkeep. Anybody may call it.
    function performUpkeep() external {
        if (!upkeepDue()) revert TooSoon(lastUpkeepAt + minInterval);

        lastUpkeepAt = block.timestamp;
        _performUpkeep();

        emit UpkeepPerformed(msg.sender, block.timestamp);
    }

    function _performUpkeep() internal virtual;
}
`;

/**
 * The base every generated test extends, and the one thing it exists to do.
 *
 * Uniswap reads a hook's permissions from the low fourteen bits of its address, so a
 * test that deploys the hook with `new MyHook(...)` gets whatever address the nonce
 * produced and every callback the market relies on is either absent or unauthorised.
 * The pool manager then rejects it, and the failure — `NotHook`, or a callback that
 * silently never runs — says nothing about the address being the cause.
 *
 * There are two ways out and a generated test reaches for the wrong one. Uniswap's own
 * answer is `HookMiner`, which is not in the vendored tree; a live EMBRT build spent its
 * last repair round importing it and died on "File not found" having otherwise been
 * correct. The other is to compute the address from the permissions and put the code
 * there, which needs no mining, no CREATE2 and no salt search, and is what this does.
 *
 * The permissions are read off the hook rather than passed in, because a test that
 * restates them is a test that can restate them wrongly: the same build asserted a fee
 * of 3000 against a hook deployed at bits that never enabled `beforeSwap`, and the
 * repair diagnosed the market rather than the harness. Deploying twice — once anywhere
 * to ask, once at the address the answer implies — makes the question unaskable.
 */
const TEST_HARNESS = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// @title AgenTest
/// @notice The base for every generated test. Extend this instead of Test.
/// @dev Provided by Agen, not generated. It exists because a hook's address encodes its
/// permissions, which makes "deploy the contract under test" a step that cannot be done
/// the ordinary way and fails confusingly when it is.
abstract contract AgenTest is Test {
    /// @dev Any address whose low fourteen bits are clear works as a base; the permission
    /// flags are OR-ed into them. High enough not to collide with a precompile or with
    /// forge-std's own labelled addresses.
    address internal constant HOOK_BASE = 0xa6E0000000000000000000000000000000000000;

    /// @dev Where a hook is put briefly to be asked what permissions it wants. Nothing it
    /// writes during that construction survives — the real deployment runs the
    /// constructor again at the final address.
    address internal constant HOOK_PROBE = 0xa6e1000000000000000000000000000000000000;

    /// @notice The fee value a pool must be initialised with for a hook to override it.
    /// @dev A pool created with a fixed fee ignores whatever beforeSwap returns, so a
    /// market whose whole mechanic is a dynamic fee looks broken in a test that used
    /// 3000 here. Agen launches every market's pool with this.
    uint24 internal constant DYNAMIC_FEE = LPFeeLibrary.DYNAMIC_FEE_FLAG;

    /// @notice The manager the last deployPoolManager() call created, and its routers.
    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal liquidityRouter;

    /// @notice A real pool manager and the routers needed to drive it.
    /// @dev IPoolManager is large and still moving, so a hand-written fake is a
    /// half-implemented interface that the compiler rejects as abstract — and if it
    /// compiles it agrees with the hook about behaviour neither has checked against v4.
    /// Deploying the real one costs nothing here.
    ///
    /// The routers come with it because the manager is useless without them: every
    /// operation that moves value has to happen inside manager.unlock(), and a test that
    /// calls take() or settle() outside one reverts with ManagerLocked.
    function deployPoolManager() internal returns (IPoolManager) {
        manager = IPoolManager(address(new PoolManager(address(this))));
        swapRouter = new PoolSwapTest(manager);
        liquidityRouter = new PoolModifyLiquidityTest(manager);
        return manager;
    }

    /// @notice Put liquidity in a pool so it can be traded against.
    /// @dev A pool with no liquidity fills nothing, so a swap against one either reverts
    /// or moves zero and every assertion about a fee reads zero.
    function addLiquidity(PoolKey memory key, int256 amount) internal {
        liquidityRouter.modifyLiquidity{value: key.currency0.isAddressZero() ? 100 ether : 0}(
            key,
            ModifyLiquidityParams({
                tickLower: -887_220,
                tickUpper: 887_220,
                liquidityDelta: amount,
                salt: bytes32(0)
            }),
            ""
        );
    }

    /// @notice Perform a real swap: exact input, through the manager, fully settled.
    /// @param zeroForOne True to spend currency0 — a BUY in an Agen pool, where
    /// currency0 is the quote asset and currency1 is the launched token.
    /// @dev Use this rather than calling hook.beforeSwap(...) directly. A direct call
    /// tests the arithmetic and skips settlement, which is exactly where a hook that
    /// takes value goes wrong: take() without a matching delta reverts the swap inside
    /// the manager, and a test that never settles never finds out. It also cannot work —
    /// the manager is locked outside unlock() and reverts with ManagerLocked.
    function swapExactIn(PoolKey memory key, bool zeroForOne, uint256 amount)
        internal
        returns (BalanceDelta)
    {
        return swapRouter.swap{value: zeroForOne && key.currency0.isAddressZero() ? amount : 0}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Tests receive ether back from the routers when a swap returns some.
    receive() external payable {}

    /// @notice Deploy a hook at an address matching the permissions it declares.
    /// @param artifact "FileName.sol:ContractName", e.g. "MyHook.sol:MyHook".
    /// @param args abi.encode of the constructor arguments, or "" when there are none.
    /// @dev Use this for every hook. \`new MyHook(...)\` puts the code at an address whose
    /// bits are an accident, and the pool manager reads those bits as the hook's
    /// permissions.
    function deployHook(string memory artifact, bytes memory args) internal returns (address hook) {
        deployCodeTo(artifact, args, HOOK_PROBE);
        uint160 flags = permissionFlags(IHooks(HOOK_PROBE));
        vm.etch(HOOK_PROBE, "");

        hook = address(uint160(HOOK_BASE) | flags);
        deployCodeTo(artifact, args, hook);
    }

    /// @notice The address bits a hook's declared permissions correspond to.
    function permissionFlags(IHooks hook) internal view returns (uint160 flags) {
        Hooks.Permissions memory p = AgenPermissions(address(hook)).getHookPermissions();

        if (p.beforeInitialize) flags |= Hooks.BEFORE_INITIALIZE_FLAG;
        if (p.afterInitialize) flags |= Hooks.AFTER_INITIALIZE_FLAG;
        if (p.beforeAddLiquidity) flags |= Hooks.BEFORE_ADD_LIQUIDITY_FLAG;
        if (p.afterAddLiquidity) flags |= Hooks.AFTER_ADD_LIQUIDITY_FLAG;
        if (p.beforeRemoveLiquidity) flags |= Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;
        if (p.afterRemoveLiquidity) flags |= Hooks.AFTER_REMOVE_LIQUIDITY_FLAG;
        if (p.beforeSwap) flags |= Hooks.BEFORE_SWAP_FLAG;
        if (p.afterSwap) flags |= Hooks.AFTER_SWAP_FLAG;
        if (p.beforeDonate) flags |= Hooks.BEFORE_DONATE_FLAG;
        if (p.afterDonate) flags |= Hooks.AFTER_DONATE_FLAG;
        if (p.beforeSwapReturnDelta) flags |= Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG;
        if (p.afterSwapReturnDelta) flags |= Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        if (p.afterAddLiquidityReturnDelta) flags |= Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG;
        if (p.afterRemoveLiquidityReturnDelta) flags |= Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG;
    }

    /// @notice A pool key in the order Agen launches markets: quote below token.
    /// @dev The direction of every rule depends on this. zeroForOne means spending
    /// currency0, so a key built the other way round makes buys look like sells and a
    /// test written against it agrees with a hook that has the same bug.
    function agenPoolKey(Currency quote, Currency token, IHooks hook, int24 tickSpacing)
        internal
        pure
        returns (PoolKey memory)
    {
        return agenPoolKey(quote, token, hook, tickSpacing, DYNAMIC_FEE);
    }

    /// @notice The same key, opened at a stated fee.
    /// @dev For a hook that requires a fixed fee rather than a dynamic one. Such a hook
    /// is legitimate and Agen launches it: the build works out which fee the pool must
    /// carry and the manifest opens it that way. A harness that could only produce
    /// DYNAMIC_FEE could not test what it was about to deploy — the hook rejected the
    /// pool in afterInitialize, three repair attempts rewrote the test around a
    /// constraint they could not satisfy, and a market that would have launched
    /// correctly was reported undeployable.
    ///
    /// Pass the constant the hook itself checks. Passing DYNAMIC_FEE to a hook that
    /// wants a fixed fee fails at initialize; passing a fixed fee to a hook that
    /// returns one from beforeSwap is worse, because the pool ignores the returned fee
    /// and the test quietly concludes the mechanic charges nothing.
    function agenPoolKey(
        Currency quote,
        Currency token,
        IHooks hook,
        int24 tickSpacing,
        uint24 fee
    ) internal pure returns (PoolKey memory) {
        require(Currency.unwrap(quote) < Currency.unwrap(token), "quote must sort below token");
        return PoolKey({
            currency0: quote,
            currency1: token,
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: hook
        });
    }
}

/// @dev getHookPermissions is on AgenBaseHook rather than on IHooks, and the harness
/// must not import the market's own contracts to reach it.
interface AgenPermissions {
    function getHookPermissions() external pure returns (Hooks.Permissions memory);
}
`;

/**
 * The token, written by hand rather than by a model.
 *
 * A launched token is a fixed-supply ERC20 with a name, a symbol and a recipient. There
 * is no market mechanic in it and nothing for a model to decide, so asking one to write
 * it costs a slice of the slowest stage in the build to produce the same file every
 * time — with a chance of producing a subtly different one.
 *
 * This is the shape of the rule worth generalising: a model call earns its place when
 * there is a judgement to make. Where the answer is determined by three parameters, the
 * deterministic version is faster, cheaper and cannot vary.
 */
export function tokenSource({
  contractName,
  name,
  symbol,
  supplyTokens,
}: {
  readonly contractName: string;
  readonly name: string;
  readonly symbol: string;
  /** Whole tokens. Scaled by 1e18 in the constructor. */
  readonly supplyTokens: bigint;
}): GeneratedSource {
  // The market's own strings reach Solidity here, so they are escaped rather than
  // interpolated: a token named with a quote would otherwise produce a file that does
  // not parse, and a creator can name a token anything.
  const escape = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  return {
    path: `contracts/${contractName}.sol`,
    content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ${contractName}
/// @notice The token this market trades.
/// @dev Written by Agen rather than generated. A fixed-supply ERC20 has no market
/// mechanic in it and nothing to decide, so it is the same file every time.
///
/// The whole supply goes to the recipient named at deployment. Nothing can mint after
/// construction — there is no mint function, and its absence is the point.
contract ${contractName} {
    string public constant name = "${escape(name)}";
    string public constant symbol = "${escape(symbol)}";
    uint8 public constant decimals = 18;

    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    error InsufficientBalance(uint256 available, uint256 required);
    error InsufficientAllowance(uint256 available, uint256 required);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address recipient) {
        totalSupply = ${supplyTokens.toString()} * 1e18;
        balanceOf[recipient] = totalSupply;
        emit Transfer(address(0), recipient, totalSupply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(allowed, amount);
            allowance[from][msg.sender] = allowed - amount;
        }

        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(balance, amount);

        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }

        emit Transfer(from, to, amount);
    }
}
`,
  };
}

/**
 * The signatures a generated hook may override, read out of AgenBaseHook itself.
 *
 * Copied by hand into the generator's context, these would drift the first time the base
 * hook changed, and the generator would be confidently told a signature that no longer
 * compiles. Reading them from the source means the instruction is wrong only if the base
 * hook is wrong.
 *
 * Worth stating at all because getting one subtly wrong is expensive: a live build spent
 * a repair round on `_afterInitialize` declared as returning `bytes4`, which is what the
 * external callback returns but not what the override does.
 */
export function overridePoints(): readonly string[] {
  const points: string[] = [];
  const pattern = /function (_[A-Za-z]+)\(([^)]*)\)\s*(?:\n\s*)?internal\s+virtual\s*(?:\n\s*)?(returns \(([^)]*)\))?/g;

  for (const match of BASE_HOOK.matchAll(pattern)) {
    const [, name, args, , returns] = match;
    const parameters = (args ?? "").replace(/\s+/g, " ").trim();
    points.push(
      `function ${name!}(${parameters}) internal override${
        returns === undefined ? "" : ` returns (${returns.replace(/\s+/g, " ").trim()})`
      }`,
    );
  }

  return points;
}

/**
 * The safe way to finish wiring a market after its contracts exist.
 *
 * Two contracts that need each other's addresses cannot both learn them in their
 * constructors. CREATE2 makes addresses knowable in advance, but a constructor argument
 * is part of the init code and init code determines the address — so putting each
 * address in the other's constructor is circular, and no amount of prediction escapes
 * it. One side has to be told afterwards.
 *
 * Left to itself the generator writes that setter permissionless and calls it safe
 * because it can only be used once. A live PULSE build did exactly that, with a comment
 * reading "permissionless by design, but callable successfully only once", and the plan
 * that asked for it used the same words. Once is precisely the problem: between
 * deployment and wiring the slot is unclaimed, and whoever claims it keeps it. There it
 * was the fee vault, so anybody watching the mempool could have taken every fee that
 * market would ever charge, permanently, for the price of one transaction.
 *
 * The installer is an ordinary constructor argument and is not circular: it is the
 * factory, whose address is a fixed property of the deployment and known long before any
 * market is built.
 */
const WIRED = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AgenWired
/// @notice Base for a contract that must be told an address after it is deployed.
/// @dev A setter anybody may call is front-runnable even when it may only be called
///      once: the first caller wins and the wiring is permanent.
abstract contract AgenWired {
    /// @notice The only address permitted to wire this contract. The factory.
    address public immutable installer;

    error NotInstaller(address caller);
    error AlreadyWired();

    constructor(address installer_) {
        if (installer_ == address(0)) revert NotInstaller(address(0));
        installer = installer_;
    }

    /// @dev Put this on every setter that completes deployment.
    modifier onlyInstaller() {
        if (msg.sender != installer) revert NotInstaller(msg.sender);
        _;
    }

    /// @dev Guards the "exactly once" half. Pair it with onlyInstaller, never alone.
    function _wireOnce(address current) internal pure {
        if (current != address(0)) revert AlreadyWired();
    }
}
`;

/**
 * Test-side files written into a job's workspace before test generation.
 *
 * Kept apart from `preludeSources` deliberately. That list is the market's own
 * contracts — it feeds `preludeApi`, the reserved-name list and the review screen, and a
 * test harness appearing in any of those would be describing the build to itself. This
 * is scaffolding for the suite and is not part of what gets deployed.
 */
export function testPreludeSources(): readonly GeneratedSource[] {
  return [{ path: "test/AgenTest.sol", content: TEST_HARNESS }];
}

/** Files written into a job's workspace before generation begins. */
export function preludeSources(): readonly GeneratedSource[] {
  return [
    { path: "contracts/AgenBaseHook.sol", content: BASE_HOOK },
    { path: "contracts/FeeVault.sol", content: FEE_VAULT },
    { path: "contracts/RewardAccumulator.sol", content: REWARD_ACCUMULATOR },
    { path: "contracts/EpochAccounting.sol", content: EPOCH_ACCOUNTING },
    { path: "contracts/OracleAdapter.sol", content: ORACLE_ADAPTER },
    { path: "contracts/KeeperAdapter.sol", content: KEEPER_ADAPTER },
    { path: "contracts/AgenWired.sol", content: WIRED },
  ];
}

/**
 * Every function a generated contract can call on Agen's own contracts.
 *
 * This exists because of a market that compiled, passed thirty-two of its own tests, and
 * could not pay anybody. Its accounting contract declared a local interface with
 * `release(address,uint256)` on it and called the fee vault through that. Solidity is
 * perfectly happy with a cast to an interface the target does not implement, so nothing
 * objected — not the compiler, not the gates, and not the market's own tests, which
 * mocked the vault rather than deploying the real one. The real FeeVault has
 * `withdraw(address,address,uint256)`. The reward was uncollectable, and the only thing
 * that could have found it was deploying the bundle and trying.
 *
 * A model told what a contract is for will invent the method name it wishes existed. Told
 * the signatures, it has no reason to. Extracted from the sources rather than written out
 * beside them, so this cannot drift from what the prelude actually offers.
 */
export function preludeApi(): string {
  const sections: string[] = [];

  for (const { path, content: file } of preludeSources()) {
    const name = path.split("/").pop()?.replace(/\.sol$/, "") ?? "";
    const isAbstract = new RegExp(`abstract contract ${name}\\b`).test(file);

    // Only this contract's own body. `FeeVault.sol` also declares the ERC20 interface it
    // calls through, and reading the whole file listed `balanceOf` and `transfer` as
    // things a FeeVault offers — which is precisely the invented-method-name failure
    // this listing exists to prevent, produced by the listing itself.
    const content = bodyOf(file, name);

    /*
     * Internal members are included for the abstract bases, and they are the whole
     * point of one.
     *
     * The public surface of `EpochAccounting` is two view functions; everything a
     * subclass actually uses — `_rollEpochs`, `_onEpochClosed` — is internal, so a list
     * filtered to public told a generated market nothing about the contract it was
     * extending. It guessed `rollEpochs()`, spent three repair rounds on "Undeclared
     * identifier", and the build failed with the market itself perfectly sound.
     *
     * A concrete contract is the other case: it is used across a call, so its internals
     * are noise to a caller and are left out.
     */
    const wanted = isAbstract ? /\s(external|public|internal)\b/ : /\s(external|public)\b/;

    const functions = [...content.matchAll(/^\s{4}function\s+([^;{]+?)\s*[{;]/gm)]
      .map((match) => match[1]!.replace(/\s+/g, " ").trim())
      .filter((signature) => wanted.test(signature))
      // Modifier applications say nothing a caller or a subclass needs.
      .map((signature) =>
        signature.replace(/\s+(onlyOwner|onlyHook|onlyInstaller|onlyPoolManager)\b/g, ""),
      )
      // `virtual` is the one keyword worth keeping: it is the difference between a
      // member to call and a member to implement, and a subclass that overrides the
      // wrong one compiles and never runs.
      .map((signature) => (/ virtual\b/.test(signature) ? `${signature}   <- override this` : signature));

    // The constructor, because a base with one cannot be inherited without calling it.
    // A generated hook inherited AgenWired and passed it nothing, which does not compile
    // and reads as a mistake about the market rather than about the base.
    const constructor = /^\s{4}constructor\(([^)]*)\)/m.exec(content);

    if (functions.length === 0 && constructor === null) continue;

    const lines = [
      ...(constructor === null
        ? []
        : [`    constructor(${constructor[1]!.replace(/\s+/g, " ").trim()})`]),
      ...functions.map((signature) => `    function ${signature}`),
    ];

    sections.push(`  ${name}${isAbstract ? "  (abstract — inherit it)" : ""}\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * One contract's source, from its declaration to its closing brace.
 *
 * Brace counting rather than a regex to the next declaration, because a contract
 * containing a struct or a nested block would end early and silently drop half its
 * members from the listing. Falls back to the whole file if the contract is not found,
 * which keeps this from turning a rename into an empty section nobody notices.
 */
function bodyOf(file: string, name: string): string {
  const start = new RegExp(`^(?:abstract )?contract ${name}\\b`, "m").exec(file);
  if (start === null) return file;

  const from = file.indexOf("{", start.index);
  if (from === -1) return file;

  let depth = 0;
  for (let at = from; at < file.length; at++) {
    if (file[at] === "{") depth += 1;
    else if (file[at] === "}") {
      depth -= 1;
      if (depth === 0) return file.slice(start.index, at + 1);
    }
  }

  return file.slice(start.index);
}

/**
 * AgenWired's surface, for the generator that has to inherit it correctly.
 *
 * Quoted from the contract rather than described beside it, so the two cannot disagree.
 * Prose was not enough: told only what the base provides, a generated hook inherited it
 * without calling its constructor and then referred to a member named `wired` that has
 * never existed.
 */
export function wiredApi(): string {
  return WIRED.split("\n")
    .filter((line) => !line.trim().startsWith("///") && !line.trim().startsWith("//"))
    .join("\n")
    .replace(/^\s*\n/gm, "")
    .trim();
}

/** The names a generated market must not reuse, since the prelude already defines them. */
export const PRELUDE_CONTRACTS: readonly string[] = [
  "AgenBaseHook",
  "FeeVault",
  "RewardAccumulator",
  "EpochAccounting",
  "OracleAdapter",
  "KeeperAdapter",
  "AgenWired",
];

/**
 * Guard modifiers the prelude provides, for gates that ask whether a function checks its
 * caller.
 *
 * The prelude is deliberately excluded from static analysis — it is reviewed code and
 * judging it would report the same findings on every market — but that exclusion means
 * its modifier definitions are not in the AST the gates walk. Without this list, a
 * generated contract inheriting a correct guard reads as having no guard at all, and the
 * gate blocks exactly the code it was asking for.
 */
export const PRELUDE_GUARDS: readonly string[] = ["onlyPoolManager", "onlyInstaller"];
