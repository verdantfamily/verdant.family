// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";
import {EngineFixture} from "./EngineFixture.sol";

/// @title What a programmable swap costs
///
/// @notice Measured rather than asserted, and logged so the numbers reach the deployment
/// review with the run that produced them. The bounds below are ceilings a regression would
/// breach, not targets — a market's fee path should never quietly double in cost.
///
/// @dev The interesting comparison is between the four configurations rather than against
/// some absolute figure: the flat market is the floor every market pays, the tiered market
/// adds the size comparisons, and the volume ladder adds the one storage write that is the
/// only thing on this path writing anything per trade.
contract EngineHookGasTest is EngineFixture {
    function setUp() public {
        _deployEngine();
    }

    function _settings() private pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    /// @dev One buy, warm. The first swap in a pool pays cold-slot costs that say more about
    /// v4's storage layout than about the engine, so the measurement is taken on the second.
    function _measureBuy(PoolKey memory key) private returns (uint256) {
        vm.startPrank(trader);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            ""
        );

        uint256 before = gasleft();
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            ""
        );
        uint256 used = before - gasleft();
        vm.stopPrank();

        return used;
    }

    /// @dev The floor: the same pair, the same depth, no hook at all. Everything above is
    /// this plus what the engine costs, which is the only way the figures mean anything.
    function test_gas_the_baseline_with_no_hook() public {
        PoolKey memory key = _plainKey();
        _openPlainPool(key);

        uint256 used = _measureBuy(key);
        emit log_named_uint("baseline swap, no hook", used);
        assertLt(used, 400_000, "the baseline regressed");
    }

    function test_gas_a_flat_market() public {
        PoolKey memory key = _keyFor();
        _openPool(key, _flatConfig(true, 20_000));

        uint256 used = _measureBuy(key);
        emit log_named_uint("flat programmable swap", used);
        assertLt(used, 400_000, "a flat programmable swap regressed");
    }

    function test_gas_a_size_tiered_market() public {
        PoolKey memory key = _keyFor();
        _openPool(key, _tieredConfig(true, 5_000, ONE_PERCENT, 40_000));

        uint256 used = _measureBuy(key);
        emit log_named_uint("size-tiered swap", used);
        assertLt(used, 400_000, "a size-tiered swap regressed");
    }

    function test_gas_a_market_with_four_tiers_a_side() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _flatConfig(true, 5_000);
        config.feeCurrency = uint8(AgenRuleLib.FeeCurrency.Token);
        config.buyTiers = new AgenRuleLib.Tier[](4);
        for (uint256 i = 0; i < 4; i++) {
            config.buyTiers[i] =
                AgenRuleLib.Tier({thresholdTokens: uint128((i + 1) * 1e24), feePpm: uint24(10_000 * (i + 1))});
        }
        _openPool(key, config);

        // The worst case for tier evaluation: a trade below every threshold, so all four are
        // examined before the stage rate wins.
        uint256 used = _measureBuy(key);
        emit log_named_uint("four-tier swap, no tier matched", used);
        assertLt(used, 400_000, "the tier scan regressed");
    }

    function test_gas_a_time_ladder() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _flatConfig(true, 20_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.Time);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 20_000, sellFeePpm: 20_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 3600, buyFeePpm: 10_000, sellFeePpm: 10_000});
        _openPool(key, config);

        uint256 used = _measureBuy(key);
        emit log_named_uint("time-ladder swap", used);
        assertLt(used, 400_000, "a time-ladder swap regressed");
    }

    /// @dev The expensive one, and the only configuration that writes storage per trade.
    function test_gas_a_volume_ladder() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _flatConfig(true, 20_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.QuoteVolume);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 20_000, sellFeePpm: 20_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 1e30, buyFeePpm: 10_000, sellFeePpm: 10_000});
        _openPool(key, config);

        uint256 used = _measureBuy(key);
        emit log_named_uint("volume-ladder swap", used);
        assertLt(used, 450_000, "a volume-ladder swap regressed");
    }

    /// @dev Four settlements on the claim path is the bound that decides what a payout costs.
    function test_gas_four_recipients() public {
        PoolKey memory key = _keyFor();
        AgenRuleLib.Config memory config = _flatConfig(true, 20_000);
        config.distribution = new AgenRuleLib.Share[](4);
        config.distribution[0] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Creator, recipient: address(0), sharePpm: 400_000});
        config.distribution[1] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Treasury, recipient: address(0), sharePpm: 300_000});
        config.distribution[2] = AgenRuleLib.Share({
            kind: AgenRuleLib.RecipientKind.Address,
            recipient: address(0xAAA1),
            sharePpm: 200_000
        });
        config.distribution[3] = AgenRuleLib.Share({
            kind: AgenRuleLib.RecipientKind.Address,
            recipient: address(0xAAA2),
            sharePpm: 100_000
        });

        _openPool(key, config);

        uint256 used = _measureBuy(key);
        emit log_named_uint("swap into a four-way split", used);
        assertLt(used, 400_000, "the fee path regressed with four recipients");
    }
}
