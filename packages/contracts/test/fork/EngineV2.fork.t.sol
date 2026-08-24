// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {DeployAgenEngineV2} from "../../script/DeployAgenEngineV2.s.sol";
import {AgenCurve} from "../../src/agen/AgenCurve.sol";
import {AgenMarketRegistry} from "../../src/agen/AgenMarketRegistry.sol";
import {AgenRouter} from "../../src/agen/AgenRouter.sol";
import {AgenBuybackPot} from "../../src/agen/engine/AgenBuybackPot.sol";
import {AgenEngineFactoryV2} from "../../src/agen/engine/AgenEngineFactoryV2.sol";
import {AgenEngineHookV2} from "../../src/agen/engine/AgenEngineHookV2.sol";
import {AgenLargestHolderPot} from "../../src/agen/engine/AgenLargestHolderPot.sol";
import {AgenRuleLib} from "../../src/agen/engine/AgenRuleLib.sol";
import {AgenRuleLibV2} from "../../src/agen/engine/AgenRuleLibV2.sol";
import {VerdantNotifyingToken} from "../../src/agen/engine/VerdantNotifyingToken.sol";
import {InjectedEngineV2DeployHarness} from "../utils/EngineV2DeployHarness.sol";

/// @title The featured market against the Uniswap that is actually deployed
///
/// @notice Every other engine-v2 test compiles Uniswap from vendored source. This one
/// runs against the bytecode on chain 4663.
///
/// @dev The distinction has a number behind it, the same one `Launch.fork.t.sol` cites:
/// this repository builds `PoolManager` to 26 988 bytes and the one deployed on 4663 is
/// 24 009. Same source, different optimizer settings, different bytecode. Two of engine
/// v2's load-bearing behaviours are, until this file runs, claims about a build nobody
/// uses:
///
///   1. `IMsgSender.msgSender()` exists on the deployed PositionManager and reports the
///      factory. `AgenEngineHookV2.beforeAddLiquidity` rests on it exactly as v1's does,
///      and it is the single thing most likely to differ between commits.
///   2. The three curve bands mint one-sided against the deployed manager, so a launch
///      needs no quote asset — which is what makes a native-quoted market launchable by
///      a creator holding nothing but the gas.
///
/// And two that are v2's alone, and that no local test can put against real bytecode:
///
///   3. A buyback re-enters the deployed `PoolManager` through `unlock` from outside a
///      swap, and settles both legs from the delta it is handed.
///   4. The notifying token's transfer callback survives being invoked from inside the
///      deployed manager's `take`, which is where most of a market's transfers originate.
///
/// Excluded from the default profile, so `forge test` needs no network. Run with
/// `FOUNDRY_PROFILE=fork`.
contract EngineV2ForkTest is Test {
    using PoolIdLibrary for PoolKey;

    /// @dev From packages/config/src/chains.ts, verified present on both Robinhood chains.
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;

    /// @dev The lengths `Launch.fork.t.sol` recorded. Asserted so a redeployment of
    /// Uniswap on 4663 fails here rather than being absorbed by a test that still passes.
    uint256 internal constant POOL_MANAGER_SIZE = 24_009;
    uint256 internal constant POSITION_MANAGER_SIZE = 23_877;

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint128 internal constant WALLET_CAP = uint128(SUPPLY / 50);
    uint128 internal constant LARGE_SELL = uint128(SUPPLY / 100);
    uint32 internal constant HOUR = 3600;
    uint32 internal constant WINDOW = 12 hours;

    /// @dev On the grid, with room for the curve's three bands below it, and the same
    /// opening tick `EngineV2.launch.t.sol` uses so the two suites price alike. A market
    /// opened at 204_200 — what `Launch.fork.t.sol` uses for a different token — puts a
    /// single ether through the 2%-of-supply cap on the first trade, which tests the cap
    /// but nothing else.
    int24 internal constant INITIAL_TICK = 92_200;

    IPoolManager internal manager = IPoolManager(POOL_MANAGER);
    IPositionManager internal posm = IPositionManager(POSITION_MANAGER);

    AgenRouter internal router;
    DeployAgenEngineV2.Deployment internal d;
    AgenEngineFactoryV2 internal factory;
    AgenEngineHookV2 internal hook;
    AgenMarketRegistry internal registry;

    address internal treasury = makeAddr("engine treasury");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    PoolKey internal poolKey;
    PoolId internal poolId;
    VerdantNotifyingToken internal token;
    AgenLargestHolderPot internal holderPot;
    AgenBuybackPot internal buybackPot;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));

        assertEq(POOL_MANAGER.code.length, POOL_MANAGER_SIZE, "the PoolManager on 4663 is not the one recorded");
        assertEq(
            POSITION_MANAGER.code.length, POSITION_MANAGER_SIZE, "the PositionManager on 4663 is not the one recorded"
        );

        // Ours, because a wallet-limited market is only reachable through it.
        router = new AgenRouter(manager);

        d = new InjectedEngineV2DeployHarness(POOL_MANAGER, POSITION_MANAGER, treasury, address(router)).run();
        factory = d.factory;
        hook = d.hook;
        registry = d.registry;

        vm.deal(creator, 10 ether);
        vm.deal(alice, 2_000_000 ether);
        vm.deal(bob, 2_000_000 ether);

        _launch();
    }

    // --- the launch -----------------------------------------------------------

    function _featuredConfig() private view returns (AgenRuleLibV2.Config memory config) {
        config.engineVersion = 2;
        config.referenceSupply = SUPPLY;
        config.quoteAsset = address(0);
        config.feeCurrency = uint8(AgenRuleLib.FeeCurrency.Quote);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.None);

        config.stages = new AgenRuleLib.Stage[](1);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 3_000, sellFeePpm: 3_000});

        config.buyTiers = new AgenRuleLib.Tier[](0);
        config.sellTiers = new AgenRuleLib.Tier[](0);

        config.distribution = new AgenRuleLibV2.Share[](2);
        config.distribution[0] =
            AgenRuleLibV2.Share({kind: AgenRuleLibV2.KIND_LARGEST_HOLDER, recipient: address(0), sharePpm: 500_000});
        config.distribution[1] =
            AgenRuleLibV2.Share({kind: AgenRuleLibV2.KIND_BUYBACK, recipient: address(0), sharePpm: 500_000});

        config.walletLimit = AgenRuleLibV2.WalletBuyLimit({maxBuyTokens: WALLET_CAP, windowSeconds: WINDOW});
        config.epochPeriodSeconds = HOUR;
        config.buybackTriggerTokens = LARGE_SELL;
    }

    function _launch() private {
        AgenEngineFactoryV2.Manifest memory manifest = AgenEngineFactoryV2.Manifest({
            name: "Cascade",
            symbol: "CSCD",
            supply: SUPPLY,
            metadataURI: "ipfs://cascade",
            metadataMutable: false,
            tokenSalt: bytes32(uint256(1)),
            quoteAsset: address(0),
            initialTick: INITIAL_TICK,
            config: _featuredConfig(),
            feeReceiver: creator,
            specificationHash: keccak256("the prompt"),
            implementationHash: bytes32(0)
        });
        manifest.implementationHash = AgenRuleLibV2.implementationHash(
            AgenRuleLibV2.hashConfig(manifest.config), block.chainid, address(hook), 2
        );

        vm.prank(creator);
        factory.deployMarket(manifest);

        AgenMarketRegistry.Market memory record = registry.marketAt(0);
        token = VerdantNotifyingToken(record.token);

        poolKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(record.token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: AgenCurve.TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolId = poolKey.toId();

        holderPot = AgenLargestHolderPot(payable(hook.holderPotOf(poolId)));
        buybackPot = AgenBuybackPot(payable(hook.buybackPotOf(poolId)));
    }

    function _buy(address who, uint128 amountIn) private returns (uint256) {
        vm.prank(who);
        return router.swap{value: amountIn}(poolKey, true, amountIn, 0, "");
    }

    function _sell(address who, uint128 amountIn) private returns (uint256) {
        vm.startPrank(who);
        token.approve(address(router), type(uint256).max);
        uint256 out = router.swap(poolKey, false, amountIn, 0, "");
        vm.stopPrank();
        return out;
    }

    // --- the claims this file exists to check ---------------------------------

    /// @dev 1 and 2: the liquidity guard reads the deployed PositionManager's own
    /// `msgSender()`, and the three bands mint with no quote asset supplied.
    function test_theFeaturedMarketLaunchesAgainstTheDeployedUniswap() public view {
        assertEq(registry.count(), 1, "one market recorded");
        assertEq(hook.engineVersionOf(poolId), 2, "an engine-v2 market");
        assertEq(token.totalSupply(), SUPPLY, "the whole supply exists");
        assertEq(token.listener(), address(hook), "and it notifies the hook");
        assertTrue(address(holderPot) != address(0), "the holder pot was deployed");
        assertTrue(address(buybackPot) != address(0), "and the buyback pot");
    }

    /// @dev 4: the transfer callback runs from inside the deployed manager's `take`.
    function test_aRoutedBuyWorksAndTheLedgerSeesIt() public {
        uint256 received = _buy(alice, 1 ether);

        assertGt(received, 0, "alice received tokens");
        assertEq(token.balanceOf(alice), received, "and holds them");
        assertEq(holderPot.balanceOf(alice), received, "the ledger saw the transfer");
        assertEq(hook.vaultOf(poolId).totalAccrued(), (1 ether * 3_000) / 1_000_000, "0.3% of the input");
    }

    function test_theWalletCapBindsAgainstTheDeployedUniswap() public {
        _buy(alice, 1 ether);
        assertGt(hook.boughtBy(poolId, alice), 0, "the rule counted the buy");

        bool refused;
        for (uint256 i = 0; i < 24; i++) {
            vm.prank(alice);
            try router.swap{value: 20_000 ether}(poolKey, true, 20_000 ether, 0, "") {
                assertLe(hook.boughtBy(poolId, alice), WALLET_CAP, "the accumulator never passes the cap");
            } catch {
                refused = true;
                break;
            }
        }

        assertTrue(refused, "the cap eventually refuses a buy outright");
        assertLe(hook.boughtBy(poolId, alice), WALLET_CAP, "and never let more through than it allows");
    }

    function test_theLockedLiquidityIsExcludedFromTheEpoch() public view {
        assertEq(holderPot.weightOf(0, address(posm)), 0, "the deployed position manager is excluded");
        assertEq(holderPot.weightOf(0, POOL_MANAGER), 0, "and the deployed pool");
    }

    function test_weightIsTimeWeightedAgainstTheDeployedUniswap() public {
        _buy(alice, 1 ether);
        vm.warp(block.timestamp + HOUR / 2);
        _buy(bob, 1 ether);
        vm.warp(block.timestamp + HOUR);

        assertGt(holderPot.weightOf(0, alice), 0, "the ledger accrued");
        assertGt(holderPot.weightOf(0, alice), holderPot.weightOf(0, bob), "holding longer is worth more");
    }

    /// @dev 3: the buyback unlocks the deployed manager from outside a swap, and does it
    /// while the wallet window is still open — the case that used to revert.
    function test_theBuybackArmsAndExecutesAgainstTheDeployedUniswap() public {
        // Buy up to the trigger. A large sell is 1% of supply and the cap is 2%, so a
        // wallet can reach it — which is the only reason the two rules coexist at all.
        for (uint256 i = 0; i < 24 && token.balanceOf(alice) < LARGE_SELL; i++) {
            _buy(alice, 20_000 ether);
        }

        uint256 held = token.balanceOf(alice);
        assertGe(held, LARGE_SELL, "alice reached the trigger size within her cap");

        _sell(alice, LARGE_SELL);
        assertTrue(buybackPot.armed(), "a large sell armed a buyback");
        assertTrue(hook.walletWindowOpen(poolId), "and the wallet window is still open");

        uint256 supplyBefore = token.totalSupply();
        buybackPot.execute(poolKey, 0);

        assertFalse(buybackPot.armed(), "the arm is spent");
        assertLt(token.totalSupply(), supplyBefore, "and what it bought was burned");
    }

    function test_theLargestHolderIsPaidAgainstTheDeployedUniswap() public {
        _buy(alice, 100 ether);
        _buy(bob, 10 ether);

        vm.warp(block.timestamp + HOUR + 1);
        holderPot.assignClosed();
        holderPot.claimEpoch(0, alice);

        vm.warp(block.timestamp + holderPot.CHALLENGE_SECONDS() + 1);

        uint256 before = alice.balance;
        holderPot.finalize(0);

        assertGt(alice.balance - before, 0, "the largest holder was paid in ether");
    }
}
