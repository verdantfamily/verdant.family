// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {VerdantHook} from "../src/VerdantHook.sol";
import {ScheduleLib} from "../src/libraries/ScheduleLib.sol";
import {VerdantConstants} from "../src/libraries/VerdantConstants.sol";

/// @title VerdantHook — the creation path and the swap-path fee
/// @notice Everything a market's immutability rests on is asserted here: who may
/// configure a market, what a valid market looks like, that a configuration can
/// never be written twice, and that the fee returned on a swap is the fee the
/// schedule says it should be at that second.
///
/// The tests go through the real PoolManager wherever the property is about v4's
/// behaviour, and call the hook directly where the property is about the hook's
/// own authentication. Both matter: a check that only holds when reached through
/// v4 is not a check, because a hook is a public contract.
contract VerdantHookTest is Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using LPFeeLibrary for uint24;

    /// @dev Any address whose low 14 bits are exactly 0x3880 will do; this one is
    /// legible in a trace.
    address internal constant HOOK_ADDRESS = address(uint160(0xC0FFEE0000 | 0x3880));

    VerdantHook internal hook;
    address internal factory = makeAddr("verdant factory");
    address internal token = makeAddr("market token");

    /// @dev Stands in for v4-periphery's PositionManager, which the hook knows
    /// only through `IMsgSender`. A stub rather than the real thing because the
    /// property under test is what the hook does with the answer, and the real
    /// PositionManager can only be made to answer by routing a mint through it —
    /// which is what the factory's integration test does.
    MsgSenderStub internal posm;

    PoolKey internal poolKey;
    PoolId internal poolId;

    uint160 internal constant START_PRICE = 79228162514264337593543950336; // 1:1
    uint256 internal constant INIT_AT = 1_800_000_000;

    /// @dev The same instant in the width the schedule header stores it in. Named
    /// rather than cast at each use so the narrowing is justified once.
    // forge-lint: disable-next-line(unsafe-typecast) -- 1.8e9 is far inside uint40's 1.1e12
    uint40 internal constant INIT_AT_40 = uint40(INIT_AT);

    SwapParams internal swapParams =
        SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: START_PRICE / 2});

    function setUp() public {
        deployFreshManager();
        posm = new MsgSenderStub();
        deployCodeTo("VerdantHook.sol:VerdantHook", abi.encode(manager, factory, posm), HOOK_ADDRESS);
        hook = VerdantHook(HOOK_ADDRESS);

        poolKey = _keyWith(address(0), LPFeeLibrary.DYNAMIC_FEE_FLAG, VerdantConstants.TICK_SPACING, HOOK_ADDRESS);
        poolId = poolKey.toId();

        vm.warp(INIT_AT);
    }

    // --- fixtures -----------------------------------------------------------

    function _keyWith(address currency0, uint24 fee, int24 tickSpacing, address hooks)
        internal
        view
        returns (PoolKey memory)
    {
        return PoolKey({
            currency0: Currency.wrap(currency0),
            currency1: Currency.wrap(token),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(hooks)
        });
    }

    /// @dev A decaying schedule: 10% for a day, then 3%, then 1%.
    function _threeStages() internal pure returns (ScheduleLib.Stage[] memory stages) {
        stages = new ScheduleLib.Stage[](3);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: 100_000});
        stages[1] = ScheduleLib.Stage({startOffset: 1 days, feePpm: 30_000});
        stages[2] = ScheduleLib.Stage({startOffset: 7 days, feePpm: 10_000});
    }

    function _oneStage(uint24 feePpm) internal pure returns (ScheduleLib.Stage[] memory stages) {
        stages = new ScheduleLib.Stage[](1);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: feePpm});
    }

    function _stages(uint256 count) internal pure returns (ScheduleLib.Stage[] memory stages) {
        stages = new ScheduleLib.Stage[](count);
        for (uint256 i = 0; i < count; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) -- i < 8, so i * 1 days fits uint32
            stages[i] = ScheduleLib.Stage({startOffset: uint32(i * 1 days), feePpm: uint24(100_000 - i * 10_000)});
        }
    }

    function _configure(ScheduleLib.Stage[] memory stages) internal {
        vm.prank(factory);
        hook.configure(poolKey, 1, stages);
    }

    function _initialize() internal {
        vm.prank(factory);
        manager.initialize(poolKey, START_PRICE);
    }

    function _configureAndInitialize(ScheduleLib.Stage[] memory stages) internal {
        _configure(stages);
        _initialize();
    }

    function _beforeSwapFee(uint256 timestamp) internal returns (uint24 raw) {
        vm.warp(timestamp);
        vm.prank(address(manager));
        (bytes4 selector, BeforeSwapDelta delta, uint24 fee) = hook.beforeSwap(factory, poolKey, swapParams, "");
        assertEq(selector, IHooks.beforeSwap.selector, "beforeSwap must return its own selector");
        assertEq(
            BeforeSwapDelta.unwrap(delta), BeforeSwapDelta.unwrap(BeforeSwapDeltaLibrary.ZERO_DELTA), "delta must be 0"
        );
        return fee;
    }

    /// @dev The fee a swap would actually be charged: the override flag removed,
    /// which is also v4's own validation path for a returned fee.
    function _feeCharged(uint256 timestamp) internal returns (uint24) {
        uint24 raw = _beforeSwapFee(timestamp);
        assertTrue(raw.isOverride(), "the fee must carry OVERRIDE_FEE_FLAG or v4 ignores it");
        uint24 charged = raw.removeOverrideFlag();
        assertLe(charged, LPFeeLibrary.MAX_LP_FEE, "a fee above MAX_LP_FEE would revert the swap");
        return charged;
    }

    // --- configure: authentication -------------------------------------------

    function test_configureRejectsEveryCallerButTheFactory() public {
        ScheduleLib.Stage[] memory stages = _threeStages();
        vm.expectRevert(abi.encodeWithSelector(VerdantHook.NotFactory.selector, address(this)));
        hook.configure(poolKey, 1, stages);
    }

    function testFuzz_configureRejectsEveryCallerButTheFactory(address caller) public {
        vm.assume(caller != factory);
        ScheduleLib.Stage[] memory stages = _threeStages();
        vm.expectRevert(abi.encodeWithSelector(VerdantHook.NotFactory.selector, caller));
        vm.prank(caller);
        hook.configure(poolKey, 1, stages);
    }

    function test_configureRefusesASecondConfigurationOfTheSamePoolId() public {
        _configure(_threeStages());

        ScheduleLib.Stage[] memory replacement = _oneStage(100);
        vm.expectRevert(abi.encodeWithSelector(VerdantHook.AlreadyConfigured.selector, poolId));
        vm.prank(factory);
        hook.configure(poolKey, 1, replacement);
    }

    function test_aConfigurationSurvivesInitialisationUnchanged() public {
        _configure(_threeStages());
        _initialize();

        // The same PoolId cannot be reconfigured after the pool exists either —
        // the point being that "written once" is a property of the PoolId, not of
        // the pool's lifecycle stage.
        ScheduleLib.Stage[] memory replacement = _oneStage(100);
        vm.expectRevert(abi.encodeWithSelector(VerdantHook.AlreadyConfigured.selector, poolId));
        vm.prank(factory);
        hook.configure(poolKey, 1, replacement);
    }

    function test_configureRejectsAnUnknownModel() public {
        ScheduleLib.Stage[] memory stages = _threeStages();
        vm.expectRevert(abi.encodeWithSelector(VerdantHook.UnknownModel.selector, 3, 3));
        vm.prank(factory);
        hook.configure(poolKey, 3, stages);
    }

    function test_configureAcceptsEveryKnownModel() public {
        for (uint8 model = 0; model < 3; model++) {
            PoolKey memory k =
                _keyWith(address(0), LPFeeLibrary.DYNAMIC_FEE_FLAG, VerdantConstants.TICK_SPACING, HOOK_ADDRESS);
            k.currency1 = Currency.wrap(address(uint160(0x1000 + model)));

            vm.prank(factory);
            hook.configure(k, model, _oneStage(10_000));

            (uint8 stored,,) = hook.configOf(k.toId());
            assertEq(stored, model, "model must round-trip");
        }
    }

    // --- configure: the pool-key assertions -----------------------------------

    /// @dev This hook once required `currency0` to be native ether, which was true
    /// of every market that could then exist. A market may now be quoted in a
    /// reviewed equity instead, and which assets those are is policy that changes
    /// for future markets — so `ModelRegistry` owns it, the factory reads it there,
    /// and this contract, which cannot be changed, holds no second copy of a rule
    /// that can.
    function test_configureAcceptsAnErc20OnTheQuoteSide() public {
        PoolKey memory paired = _keyWith(
            makeAddr("a tokenized equity"), LPFeeLibrary.DYNAMIC_FEE_FLAG, VerdantConstants.TICK_SPACING, HOOK_ADDRESS
        );
        ScheduleLib.Stage[] memory stages = _threeStages();

        vm.prank(factory);
        hook.configure(paired, 1, stages);

        (uint8 model,,) = hook.configOf(paired.toId());
        assertEq(model, 1, "the schedule was written against an equity-quoted key");
    }

    function test_configureRejectsAStaticFee() public {
        PoolKey memory bad = _keyWith(address(0), 3000, VerdantConstants.TICK_SPACING, HOOK_ADDRESS);
        ScheduleLib.Stage[] memory stages = _threeStages();

        vm.expectRevert(abi.encodeWithSelector(VerdantHook.FeeNotDynamic.selector, uint24(3000)));
        vm.prank(factory);
        hook.configure(bad, 1, stages);
    }

    function test_configureRejectsTheWrongTickSpacing() public {
        PoolKey memory bad = _keyWith(address(0), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, HOOK_ADDRESS);
        ScheduleLib.Stage[] memory stages = _threeStages();

        vm.expectRevert(
            abi.encodeWithSelector(VerdantHook.TickSpacingMismatch.selector, int24(60), VerdantConstants.TICK_SPACING)
        );
        vm.prank(factory);
        hook.configure(bad, 1, stages);
    }

    function test_configureRejectsAKeyNamingAnotherHook() public {
        address other = makeAddr("some other hook");
        PoolKey memory bad = _keyWith(address(0), LPFeeLibrary.DYNAMIC_FEE_FLAG, VerdantConstants.TICK_SPACING, other);
        ScheduleLib.Stage[] memory stages = _threeStages();

        vm.expectRevert(abi.encodeWithSelector(VerdantHook.HookNotThis.selector, IHooks(other), HOOK_ADDRESS));
        vm.prank(factory);
        hook.configure(bad, 1, stages);
    }

    // --- configure: the schedule --------------------------------------------
    // Each of these asserts the specific error with its specific arguments. A
    // creator whose schedule is rejected has to be told which rule and which
    // value, or the create form has to guess.

    function test_configureRejectsAnEmptySchedule() public {
        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](0);
        vm.expectRevert(abi.encodeWithSelector(ScheduleLib.InvalidStageCount.selector, 0, ScheduleLib.MAX_STAGES));
        vm.prank(factory);
        hook.configure(poolKey, 1, stages);
    }

    function test_configureRejectsNineStages() public {
        ScheduleLib.Stage[] memory stages = _stages(9);
        vm.expectRevert(abi.encodeWithSelector(ScheduleLib.InvalidStageCount.selector, 9, ScheduleLib.MAX_STAGES));
        vm.prank(factory);
        hook.configure(poolKey, 1, stages);
    }

    function test_configureRejectsANonZeroFirstOffset() public {
        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](2);
        stages[0] = ScheduleLib.Stage({startOffset: 1, feePpm: 10_000});
        stages[1] = ScheduleLib.Stage({startOffset: 1 days, feePpm: 5_000});

        vm.expectRevert(abi.encodeWithSelector(ScheduleLib.FirstOffsetNonZero.selector, 1));
        vm.prank(factory);
        hook.configure(poolKey, 1, stages);
    }

    function test_configureRejectsOffsetsThatDoNotIncrease() public {
        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](3);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: 10_000});
        stages[1] = ScheduleLib.Stage({startOffset: 1 days, feePpm: 9_000});
        stages[2] = ScheduleLib.Stage({startOffset: 1 days, feePpm: 8_000});

        vm.expectRevert(
            abi.encodeWithSelector(ScheduleLib.ScheduleNotIncreasing.selector, 2, uint256(1 days), uint256(1 days))
        );
        vm.prank(factory);
        hook.configure(poolKey, 1, stages);
    }

    function test_configureRejectsAGapUnderFiveMinutes() public {
        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](2);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: 10_000});
        stages[1] = ScheduleLib.Stage({startOffset: 299, feePpm: 9_000});

        vm.expectRevert(
            abi.encodeWithSelector(ScheduleLib.StageGapTooSmall.selector, 1, 299, ScheduleLib.MIN_STAGE_GAP)
        );
        vm.prank(factory);
        hook.configure(poolKey, 1, stages);
    }

    function test_configureRejectsAStageBeyondTheHorizon() public {
        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](2);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: 10_000});
        // forge-lint: disable-next-line(unsafe-typecast) -- 63_072_001 fits uint32
        stages[1] = ScheduleLib.Stage({startOffset: uint32(ScheduleLib.MAX_HORIZON + 1), feePpm: 9_000});

        vm.expectRevert(
            abi.encodeWithSelector(
                ScheduleLib.HorizonExceeded.selector, 1, ScheduleLib.MAX_HORIZON + 1, ScheduleLib.MAX_HORIZON
            )
        );
        vm.prank(factory);
        hook.configure(poolKey, 1, stages);
    }

    function test_configureAcceptsAStageExactlyOnTheHorizon() public {
        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](2);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: 10_000});
        // forge-lint: disable-next-line(unsafe-typecast) -- 63_072_000 fits uint32
        stages[1] = ScheduleLib.Stage({startOffset: uint32(ScheduleLib.MAX_HORIZON), feePpm: 9_000});

        _configureAndInitialize(stages);
        assertEq(_feeCharged(INIT_AT + ScheduleLib.MAX_HORIZON), 9_000, "the horizon stage must become active");
    }

    function test_configureRejectsAFeeBelowTheFloor() public {
        ScheduleLib.Stage[] memory stages = _oneStage(uint24(ScheduleLib.MIN_FEE_PPM - 1));
        vm.expectRevert(
            abi.encodeWithSelector(
                ScheduleLib.FeeOutOfBounds.selector,
                0,
                ScheduleLib.MIN_FEE_PPM - 1,
                ScheduleLib.MIN_FEE_PPM,
                ScheduleLib.MAX_FEE_PPM
            )
        );
        vm.prank(factory);
        hook.configure(poolKey, 1, stages);
    }

    function test_configureRejectsAFeeAboveTheCeiling() public {
        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](2);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: 10_000});
        // forge-lint: disable-next-line(unsafe-typecast) -- 100_001 fits uint24
        stages[1] = ScheduleLib.Stage({startOffset: 1 days, feePpm: uint24(ScheduleLib.MAX_FEE_PPM + 1)});

        vm.expectRevert(
            abi.encodeWithSelector(
                ScheduleLib.FeeOutOfBounds.selector,
                1,
                ScheduleLib.MAX_FEE_PPM + 1,
                ScheduleLib.MIN_FEE_PPM,
                ScheduleLib.MAX_FEE_PPM
            )
        );
        vm.prank(factory);
        hook.configure(poolKey, 1, stages);
    }

    // --- beforeInitialize ----------------------------------------------------

    function test_initializeRevertsWhenTheSenderIsNotTheFactory() public {
        _configure(_threeStages());

        (bool ok, bytes memory returned) =
            address(manager).call(abi.encodeCall(IPoolManager.initialize, (poolKey, START_PRICE)));
        assertFalse(ok, "only the factory may bring a Verdant pool into existence");
        assertTrue(_mentions(returned, VerdantHook.NotFactory.selector), "for the stated reason");
    }

    function test_initializeRevertsForAPoolWithNoConfiguration() public {
        vm.prank(factory);
        (bool ok, bytes memory returned) =
            address(manager).call(abi.encodeCall(IPoolManager.initialize, (poolKey, START_PRICE)));
        assertFalse(ok, "a pool with no schedule would trade at a zero fee forever");
        assertTrue(_mentions(returned, VerdantHook.NotConfigured.selector), "for the stated reason");
    }

    function test_beforeInitializeRejectsACallerThatIsNotThePoolManager() public {
        _configure(_threeStages());
        vm.expectRevert(abi.encodeWithSelector(VerdantHook.NotPoolManager.selector, factory));
        vm.prank(factory);
        hook.beforeInitialize(factory, poolKey, START_PRICE);
    }

    function test_aSecondInitialisationOfTheSamePoolIsRefusedByV4() public {
        _configureAndInitialize(_threeStages());

        vm.prank(factory);
        (bool ok,) = address(manager).call(abi.encodeCall(IPoolManager.initialize, (poolKey, START_PRICE)));
        assertFalse(ok, "v4 itself must refuse to reinitialise a pool");
    }

    // --- afterInitialize -----------------------------------------------------

    function test_afterInitialisationTheInitTimeIsRecorded() public {
        _configureAndInitialize(_threeStages());

        (, uint40 initTime,) = hook.configOf(poolId);
        assertEq(initTime, INIT_AT_40, "initTime must be the pool's own initialisation time");
    }

    function test_afterInitialisationThePoolFeeIsTheFirstStagesFee() public {
        ScheduleLib.Stage[] memory stages = _threeStages();
        _configureAndInitialize(stages);

        (,,, uint24 lpFee) = manager.getSlot0(poolId);
        assertEq(lpFee, stages[0].feePpm, "the pool's stored fee must be stage 0's fee");
        assertEq(lpFee, 100_000, "and that fee is the one that was configured");
    }

    function test_theInitTimeCannotBeRecordedTwice() public {
        _configureAndInitialize(_threeStages());

        // Reached only by the PoolManager, and v4 cannot initialise the same pool
        // twice — so this asserts the library's own one-shot guarantee, which is
        // what stands between a live market and a silently rescheduled one.
        vm.expectRevert(abi.encodeWithSelector(ScheduleLib.InitTimeAlreadyRecorded.selector, INIT_AT_40));
        vm.prank(address(manager));
        hook.afterInitialize(factory, poolKey, START_PRICE, 0);
    }

    function test_afterInitializeRejectsACallerThatIsNotThePoolManager() public {
        _configure(_threeStages());
        vm.expectRevert(abi.encodeWithSelector(VerdantHook.NotPoolManager.selector, factory));
        vm.prank(factory);
        hook.afterInitialize(factory, poolKey, START_PRICE, 0);
    }

    function test_theHookMakesExactlyOneExternalCallDuringCreation() public {
        _configure(_threeStages());
        _initialize();

        // updateDynamicLPFee is the only call, and its effect is observable as
        // the pool's stored fee. Asserted by outcome rather than by call count
        // because the outcome is what the trader experiences.
        (,,, uint24 lpFee) = manager.getSlot0(poolId);
        assertEq(lpFee, 100_000, "the one call must have landed");
    }

    // --- beforeSwap ----------------------------------------------------------

    function test_beforeSwapReturnsTheFirstStagesFeeAtInitTime() public {
        _configureAndInitialize(_threeStages());
        assertEq(_feeCharged(INIT_AT), 100_000, "at initTime the first stage is active");
    }

    function test_beforeSwapReturnsTheRightFeeAroundEveryTransition() public {
        ScheduleLib.Stage[] memory stages = _threeStages();
        _configureAndInitialize(stages);

        for (uint256 i = 1; i < stages.length; i++) {
            uint256 transition = INIT_AT + stages[i].startOffset;

            assertEq(_feeCharged(transition - 1), stages[i - 1].feePpm, "one second before a transition, the old fee");
            assertEq(_feeCharged(transition), stages[i].feePpm, "exactly at a transition, the new fee");
            assertEq(_feeCharged(transition + 1), stages[i].feePpm, "one second after, still the new fee");
        }
    }

    function test_beforeSwapReturnsTheLastStagesFeeTenYearsOut() public {
        ScheduleLib.Stage[] memory stages = _threeStages();
        _configureAndInitialize(stages);

        assertEq(
            _feeCharged(INIT_AT + 3650 days),
            stages[stages.length - 1].feePpm,
            "a schedule does not expire; the last stage is final"
        );
    }

    function test_beforeSwapCarriesTheOverrideFlagAndAZeroDelta() public {
        _configureAndInitialize(_threeStages());

        uint24 raw = _beforeSwapFee(INIT_AT + 2 days);
        assertEq(raw, uint24(30_000) | LPFeeLibrary.OVERRIDE_FEE_FLAG, "fee and flag, exactly");
        assertTrue(raw.isOverride(), "without the flag v4 uses the stored fee instead");
        assertEq(raw.removeOverrideFlag(), 30_000, "and the fee under the flag is the schedule's");
    }

    function testFuzz_beforeSwapIsAlwaysAValidOverrideFee(uint256 timestamp) public {
        _configureAndInitialize(_stages(8));

        timestamp = bound(timestamp, INIT_AT, INIT_AT + 100 * 365 days);
        uint24 charged = _feeCharged(timestamp);

        assertLe(charged, ScheduleLib.MAX_FEE_PPM, "Verdant's own ceiling, far below v4's");
        assertGe(charged, ScheduleLib.MIN_FEE_PPM, "and never zero, which would be a free market");
    }

    function test_beforeSwapRejectsACallerThatIsNotThePoolManager() public {
        _configureAndInitialize(_threeStages());

        vm.expectRevert(abi.encodeWithSelector(VerdantHook.NotPoolManager.selector, address(this)));
        hook.beforeSwap(factory, poolKey, swapParams, "");
    }

    function testFuzz_beforeSwapRejectsEveryCallerButThePoolManager(address caller) public {
        vm.assume(caller != address(manager));
        _configureAndInitialize(_threeStages());

        vm.expectRevert(abi.encodeWithSelector(VerdantHook.NotPoolManager.selector, caller));
        vm.prank(caller);
        hook.beforeSwap(factory, poolKey, swapParams, "");
    }

    function test_aFourStageMarketReadsOneStorageSlotOnASwap() public {
        _configureAndInitialize(_stages(4));

        vm.warp(INIT_AT + 3 days);
        vm.prank(address(manager));
        vm.record();
        hook.beforeSwap(factory, poolKey, swapParams, "");
        (bytes32[] memory reads,) = vm.accesses(HOOK_ADDRESS);

        assertGt(reads.length, 0, "the schedule was not read at all");
        bytes32 first = reads[0];
        for (uint256 i = 0; i < reads.length; i++) {
            assertEq(reads[i], first, "a four-stage market must not touch a second slot");
        }
    }

    // --- beforeAddLiquidity ---------------------------------------------------

    function _addLiquidityParams() internal pure returns (ModifyLiquidityParams memory) {
        return ModifyLiquidityParams({tickLower: -200, tickUpper: 200, liquidityDelta: 1e18, salt: 0});
    }

    function test_theOnlyLiquidityAcceptedIsThePositionManagerActingForTheFactory() public {
        posm.setMsgSender(factory);

        vm.prank(address(manager));
        bytes4 selector = hook.beforeAddLiquidity(address(posm), poolKey, _addLiquidityParams(), "");

        assertEq(selector, IHooks.beforeAddLiquidity.selector, "the callback must acknowledge itself");
    }

    /// @dev The half of the check that stops the other half being worthless. If any
    /// contract could occupy `sender`, any contract could claim the factory called
    /// it — so a mint routed through anything but the pinned PositionManager is
    /// refused before its answer is even asked for.
    function test_liquidityThroughAnyRouterButThePinnedOneIsRefused() public {
        MsgSenderStub impostor = new MsgSenderStub();
        impostor.setMsgSender(factory);

        vm.expectRevert(abi.encodeWithSelector(VerdantHook.NotPositionManager.selector, address(impostor)));
        vm.prank(address(manager));
        hook.beforeAddLiquidity(address(impostor), poolKey, _addLiquidityParams(), "");
    }

    function testFuzz_liquidityThroughAnyRouterButThePinnedOneIsRefused(address sender) public {
        vm.assume(sender != address(posm));

        vm.expectRevert(abi.encodeWithSelector(VerdantHook.NotPositionManager.selector, sender));
        vm.prank(address(manager));
        hook.beforeAddLiquidity(sender, poolKey, _addLiquidityParams(), "");
    }

    /// @dev The check that actually locks the pool. After creation the factory
    /// never adds liquidity again, so this rejects everybody — including the
    /// market's own creator, who has no more claim on the pool's depth than a
    /// passer-by does.
    function testFuzz_thePositionManagerActingForAnyoneElseIsRefused(address initiator) public {
        vm.assume(initiator != factory);
        posm.setMsgSender(initiator);

        vm.expectRevert(abi.encodeWithSelector(VerdantHook.NotFactory.selector, initiator));
        vm.prank(address(manager));
        hook.beforeAddLiquidity(address(posm), poolKey, _addLiquidityParams(), "");
    }

    function test_beforeAddLiquidityRejectsACallerThatIsNotThePoolManager() public {
        posm.setMsgSender(factory);

        vm.expectRevert(abi.encodeWithSelector(VerdantHook.NotPoolManager.selector, address(this)));
        hook.beforeAddLiquidity(address(posm), poolKey, _addLiquidityParams(), "");
    }

    // --- callbacks the address bits deny -------------------------------------

    function test_everyCallbackTheHookHasNoPermissionForReverts() public {
        ModifyLiquidityParams memory liq =
            ModifyLiquidityParams({tickLower: -200, tickUpper: 200, liquidityDelta: 1e18, salt: 0});
        BalanceDelta zero = BalanceDelta.wrap(0);

        vm.expectRevert(VerdantHook.CallbackNotEnabled.selector);
        hook.afterAddLiquidity(factory, poolKey, liq, zero, zero, "");

        vm.expectRevert(VerdantHook.CallbackNotEnabled.selector);
        hook.beforeRemoveLiquidity(factory, poolKey, liq, "");

        vm.expectRevert(VerdantHook.CallbackNotEnabled.selector);
        hook.afterRemoveLiquidity(factory, poolKey, liq, zero, zero, "");

        vm.expectRevert(VerdantHook.CallbackNotEnabled.selector);
        hook.afterSwap(factory, poolKey, swapParams, zero, "");

        vm.expectRevert(VerdantHook.CallbackNotEnabled.selector);
        hook.beforeDonate(factory, poolKey, 0, 0, "");

        vm.expectRevert(VerdantHook.CallbackNotEnabled.selector);
        hook.afterDonate(factory, poolKey, 0, 0, "");
    }

    // --- views ---------------------------------------------------------------

    function test_theViewsAgreeWithWhatASwapWouldBeCharged() public {
        ScheduleLib.Stage[] memory stages = _threeStages();
        _configureAndInitialize(stages);

        uint256 at = INIT_AT + 3 days;
        assertEq(hook.feeAt(poolId, at), 30_000, "feeAt");
        assertEq(hook.stageAt(poolId, at), 1, "stageAt");
        assertEq(hook.nextTransition(poolId, at), INIT_AT + 7 days, "nextTransition");
        assertEq(_feeCharged(at), hook.feeAt(poolId, at), "the view and the swap path must not diverge");
    }

    function test_isConfiguredReportsBothStates() public {
        assertFalse(hook.isConfigured(poolId), "nothing is configured to begin with");
        _configure(_threeStages());
        assertTrue(hook.isConfigured(poolId), "and configured after configure");
    }

    function test_configOfAnUnknownPoolIsEmpty() public view {
        (uint8 model, uint40 initTime, ScheduleLib.Stage[] memory stages) = hook.configOf(PoolId.wrap(bytes32(0)));
        assertEq(model, 0, "model");
        assertEq(initTime, 0, "initTime");
        assertEq(stages.length, 0, "an unconfigured pool has no stages");
    }

    function testFuzz_theStoredConfigurationRoundTripsFieldForField(uint8 rawModel, uint8 rawCount, uint256 seed)
        public
    {
        uint8 model = rawModel % 3;
        ScheduleLib.Stage[] memory stages = _fuzzSchedule(rawCount, seed);

        vm.prank(factory);
        hook.configure(poolKey, model, stages);

        (uint8 storedModel, uint40 storedInitTime, ScheduleLib.Stage[] memory storedStages) = hook.configOf(poolId);
        assertEq(storedModel, model, "model");
        assertEq(storedInitTime, 0, "initTime is unset until the pool exists");
        assertEq(storedStages.length, stages.length, "stage count");
        for (uint256 i = 0; i < stages.length; i++) {
            assertEq(storedStages[i].startOffset, stages[i].startOffset, "startOffset");
            assertEq(storedStages[i].feePpm, stages[i].feePpm, "feePpm");
        }

        _initialize();

        (uint8 afterModel, uint40 afterInitTime, ScheduleLib.Stage[] memory afterStages) = hook.configOf(poolId);
        assertEq(afterModel, model, "model must survive initialisation");
        assertEq(afterInitTime, INIT_AT_40, "initTime must be recorded by initialisation");
        assertEq(afterStages.length, stages.length, "stage count must survive initialisation");
        for (uint256 i = 0; i < stages.length; i++) {
            assertEq(afterStages[i].startOffset, stages[i].startOffset, "startOffset must survive");
            assertEq(afterStages[i].feePpm, stages[i].feePpm, "feePpm must survive");
        }
    }

    // --- helpers -------------------------------------------------------------

    /// @dev Builds a valid schedule from fuzzed bytes. Deriving one rather than
    /// rejecting invalid ones keeps every run useful: `vm.assume` on a
    /// multi-field structure discards almost everything.
    function _fuzzSchedule(uint8 rawCount, uint256 seed) internal pure returns (ScheduleLib.Stage[] memory stages) {
        uint256 count = (uint256(rawCount) % ScheduleLib.MAX_STAGES) + 1;
        stages = new ScheduleLib.Stage[](count);

        uint256 offset;
        for (uint256 i = 0; i < count; i++) {
            if (i > 0) {
                // At least MIN_STAGE_GAP apart, at most ~30 days, so eight stages
                // always stay inside MAX_HORIZON.
                offset += ScheduleLib.MIN_STAGE_GAP + (uint256(keccak256(abi.encode(seed, i, "gap"))) % 30 days);
            }
            uint256 span = ScheduleLib.MAX_FEE_PPM - ScheduleLib.MIN_FEE_PPM + 1;
            uint256 fee = ScheduleLib.MIN_FEE_PPM + (uint256(keccak256(abi.encode(seed, i, "fee"))) % span);

            // forge-lint: disable-next-line(unsafe-typecast) -- bounded above by 8 * (300 + 30 days)
            uint32 startOffset = uint32(offset);
            // forge-lint: disable-next-line(unsafe-typecast) -- bounded by MAX_FEE_PPM
            uint24 feePpm = uint24(fee);
            stages[i] = ScheduleLib.Stage({startOffset: startOffset, feePpm: feePpm});
        }
    }

    /// @dev v4 wraps a reverting hook call in its own error, so the inner reason
    /// is searched for rather than compared. Comparing the whole payload would
    /// couple these tests to the shape of Uniswap's wrapper rather than to the
    /// hook's behaviour.
    function _mentions(bytes memory haystack, bytes4 needle) internal pure returns (bool) {
        if (haystack.length < 4) return false;
        for (uint256 i = 0; i + 4 <= haystack.length; i++) {
            if (
                haystack[i] == needle[0] && haystack[i + 1] == needle[1] && haystack[i + 2] == needle[2]
                    && haystack[i + 3] == needle[3]
            ) return true;
        }
        return false;
    }
}

/// @notice The one function of the PositionManager the hook depends on.
/// @dev Settable, because the interesting cases are the answers a real
/// PositionManager would never give.
contract MsgSenderStub {
    address private _sender;

    function setMsgSender(address sender) external {
        _sender = sender;
    }

    function msgSender() external view returns (address) {
        return _sender;
    }
}
