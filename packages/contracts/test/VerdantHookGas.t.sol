// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {VerdantHook} from "../src/VerdantHook.sol";
import {ScheduleLib} from "../src/libraries/ScheduleLib.sol";
import {VerdantConstants} from "../src/libraries/VerdantConstants.sol";

/// @title VerdantHook — the cost every trader pays
/// @notice `beforeSwap` runs on every trade in every Verdant market for the life
/// of the market, and its cost is fixed at deployment along with everything else.
/// These figures are measured at the boundary the PoolManager actually crosses —
/// metered around the external call into the hook, including the CALL itself and
/// the cold SLOAD — because that is the number a trader pays.
///
/// The `assertLt` budgets are deliberately loose; the committed snapshot is the
/// tight check. A budget catches a collapse, a snapshot diff catches a drift.
contract VerdantHookGasTest is Deployers {
    using PoolIdLibrary for PoolKey;

    address internal constant HOOK_ADDRESS = address(uint160(0xC0FFEE0000 | 0x3880));

    uint160 internal constant START_PRICE = 79228162514264337593543950336; // 1:1
    uint256 internal constant INIT_AT = 1_800_000_000;

    /// @dev Deep into the schedule, so the backwards scan in `stageAt` finds the
    /// active stage immediately — the common case for a mature market.
    uint256 internal constant LATE = INIT_AT + 400 days;

    VerdantHook internal hook;
    address internal factory = makeAddr("verdant factory");
    address internal positionManager = makeAddr("position manager");

    PoolKey internal warmup;
    PoolKey internal oneStage;
    PoolKey internal threeStages;
    PoolKey internal fourStages;
    PoolKey internal eightStages;

    SwapParams internal swapParams =
        SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: START_PRICE / 2});

    function setUp() public {
        deployFreshManager();
        deployCodeTo("VerdantHook.sol:VerdantHook", abi.encode(manager, factory, positionManager), HOOK_ADDRESS);
        hook = VerdantHook(HOOK_ADDRESS);

        vm.warp(INIT_AT);

        warmup = _market(0xA0, 1);
        oneStage = _market(0xA1, 1);
        threeStages = _market(0xA3, 3);
        fourStages = _market(0xA4, 4);
        eightStages = _market(0xA8, 8);
    }

    function _market(uint160 tokenId, uint256 stageCount) internal returns (PoolKey memory poolKey) {
        poolKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(tokenId)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(HOOK_ADDRESS)
        });

        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](stageCount);
        for (uint256 i = 0; i < stageCount; i++) {
            // forge-lint: disable-next-line(unsafe-typecast) -- i < 8, so i * 30 days fits uint32
            uint32 startOffset = uint32(i * 30 days);
            // forge-lint: disable-next-line(unsafe-typecast) -- stays above MIN_FEE_PPM for i < 8
            uint24 feePpm = uint24(ScheduleLib.MAX_FEE_PPM - i * 10_000);
            stages[i] = ScheduleLib.Stage({startOffset: startOffset, feePpm: feePpm});
        }

        vm.prank(factory);
        hook.configure(poolKey, stageCount == 1 ? 0 : 1, stages);

        vm.prank(factory);
        manager.initialize(poolKey, START_PRICE);
    }

    /// @dev Metered around the external call, so it includes the CALL, the
    /// dispatch and the cold read of the market's schedule — the storage access
    /// the two-word encoding exists to minimise.
    ///
    /// The identical call is made against a throwaway market first. That is not
    /// cosmetic: without it the figure lands 12 500 gas higher, and the excess is
    /// the harness rather than the protocol. Foundry meters per-test bookkeeping
    /// into the first external call of a test — a 137-byte contract with one cold
    /// SLOAD measures 7 313 gas cold against 807 warm, where the EVM's own rules
    /// account for about 4 700 of the difference. Warming first removes the
    /// artefact and leaves the reads, which is the quantity being compared.
    ///
    /// Two costs are therefore NOT in these figures, and both are constant across
    /// every market and so cannot affect the comparison: the ~2 500 gas for the
    /// cold account access when v4 first calls the hook in a swap transaction,
    /// and v4's own dispatch around the call.
    function _measure(PoolKey memory poolKey, uint256 timestamp) internal returns (uint256) {
        vm.warp(timestamp);

        vm.prank(address(manager));
        hook.beforeSwap(factory, warmup, swapParams, "");

        vm.prank(address(manager));
        uint256 before = gasleft();
        hook.beforeSwap(factory, poolKey, swapParams, "");
        return before - gasleft();
    }

    function test_gas_beforeSwap_1Stage() public {
        uint256 used = _measure(oneStage, LATE);
        emit log_named_uint("beforeSwap gas, 1 stage", used);
        assertLt(used, 15_000, "the swap-path read got more expensive than budgeted");
    }

    function test_gas_beforeSwap_3Stages() public {
        uint256 used = _measure(threeStages, LATE);
        emit log_named_uint("beforeSwap gas, 3 stages", used);
        assertLt(used, 15_000, "the swap-path read got more expensive than budgeted");
    }

    function test_gas_beforeSwap_4Stages() public {
        uint256 used = _measure(fourStages, LATE);
        emit log_named_uint("beforeSwap gas, 4 stages", used);
        assertLt(used, 15_000, "the swap-path read got more expensive than budgeted");
    }

    function test_gas_beforeSwap_8Stages() public {
        uint256 used = _measure(eightStages, LATE);
        emit log_named_uint("beforeSwap gas, 8 stages", used);
        assertLt(used, 18_000, "the swap-path read got more expensive than budgeted");
    }

    function test_gas_beforeSwap_8StagesEarlyInSchedule() public {
        uint256 used = _measure(eightStages, INIT_AT);
        emit log_named_uint("beforeSwap gas, 8 stages, first stage active", used);
        assertLt(used, 18_000, "the worst-case scan got more expensive than budgeted");
    }

    /// @notice The property the two-word encoding exists for, asserted rather
    /// than reported: a market of one, three or four stages costs the *same* on
    /// the swap path, because all three read one storage slot and find their
    /// active stage in one iteration.
    ///
    /// @dev This is the assertion that was missing when two phase reports quoted
    /// different numbers for it. The tolerance is eight gas rather than zero: the
    /// three paths execute the same opcodes over the same one storage slot, but
    /// they are not bit-identical traces, and a one-gas difference between them is
    /// not the regression this test is for. Anything that made stage count
    /// actually matter would cost a cold SLOAD, 2 100 gas, which this catches by
    /// two orders of magnitude.
    ///
    /// The exact form of the claim — one storage slot, not two — is asserted
    /// separately and without tolerance by
    /// `VerdantHookTest.test_aFourStageMarketReadsOneStorageSlotOnASwap`.
    function test_costIsFlatFromOneStageToFour() public {
        uint256 one = _measure(oneStage, LATE);
        uint256 three = _measure(threeStages, LATE);
        uint256 four = _measure(fourStages, LATE);

        emit log_named_uint("1 stage", one);
        emit log_named_uint("3 stages", three);
        emit log_named_uint("4 stages", four);

        assertApproxEqAbs(one, three, 8, "one and three stages must cost the same");
        assertApproxEqAbs(three, four, 8, "three and four stages must cost the same");
    }

    /// @notice And the other side: the fifth stage is what costs, not the second.
    function test_theSecondWordIsWhatCosts() public {
        uint256 four = _measure(fourStages, LATE);
        uint256 eight = _measure(eightStages, LATE);

        emit log_named_uint("4 stages", four);
        emit log_named_uint("8 stages", eight);
        emit log_named_uint("cost of the second word", eight - four);

        // A cold SLOAD is 2 100, and the eight-stage path also skips the branch
        // that the four-stage path takes, so the observed difference is a little
        // under that. The floor asserts that the difference is a storage access
        // rather than arithmetic.
        assertGt(eight - four, 1_500, "the second word must cost a cold SLOAD");
    }
}
