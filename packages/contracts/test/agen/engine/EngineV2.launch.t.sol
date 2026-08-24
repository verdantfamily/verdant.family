// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";

import {DeployAgenEngineV2} from "../../../script/DeployAgenEngineV2.s.sol";
import {AgenCurve} from "../../../src/agen/AgenCurve.sol";
import {AgenMarketRegistry} from "../../../src/agen/AgenMarketRegistry.sol";
import {AgenRouter} from "../../../src/agen/AgenRouter.sol";
import {AgenBuybackPot} from "../../../src/agen/engine/AgenBuybackPot.sol";
import {AgenEngineFactoryV2} from "../../../src/agen/engine/AgenEngineFactoryV2.sol";
import {AgenEngineHookV2} from "../../../src/agen/engine/AgenEngineHookV2.sol";
import {AgenLargestHolderPot} from "../../../src/agen/engine/AgenLargestHolderPot.sol";
import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";
import {AgenRuleLibV2} from "../../../src/agen/engine/AgenRuleLibV2.sol";
import {VerdantNotifyingToken} from "../../../src/agen/engine/VerdantNotifyingToken.sol";
import {InjectedEngineV2DeployHarness} from "../../utils/EngineV2DeployHarness.sol";

/// @title EngineV2Launch
/// @notice The featured market, launched through the factory the deploy script produces.
///
/// @dev `EngineV2.market.t.sol` wires the vault and the pots by hand, which proves the
/// mechanics and says nothing about the code a broadcast actually installs. Everything the
/// factory alone does lives here: the token salt sorting above the quote asset, the curve's
/// three locked bands, the commitment recomputed on chain, the registry record, and the
/// pots being deployed and bound rather than passed in.
///
/// Native ETH is the quote, because that is what a Robinhood Chain launch uses and because
/// it is the case that cannot be reached from the ERC-20 fixture: native currency is the
/// zero address, so it always sorts to `currency0` and the vault holds real ETH rather than
/// a token balance.
contract EngineV2LaunchTest is Deployers {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint128 internal constant WALLET_CAP = uint128(SUPPLY / 50);
    uint128 internal constant LARGE_SELL = uint128(SUPPLY / 100);
    uint32 internal constant HOUR = 3600;
    uint32 internal constant WINDOW = 12 hours;

    /// @dev On the grid, with room for the curve's three bands below it.
    int24 internal constant INITIAL_TICK = 92_200;

    PositionManager internal posm;
    AgenRouter internal router;
    InjectedEngineV2DeployHarness internal harness;
    DeployAgenEngineV2.Deployment internal d;

    AgenEngineFactoryV2 internal factory;
    AgenEngineHookV2 internal hook;
    AgenMarketRegistry internal registry;

    address internal treasury = makeAddr("engine treasury");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        deployFreshManagerAndRouters();
        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );
        router = new AgenRouter(manager);

        harness = new InjectedEngineV2DeployHarness(address(manager), address(posm), treasury, address(router));
        d = harness.run();

        factory = d.factory;
        hook = d.hook;
        registry = d.registry;

        // `vm.prank` rewrites who the callee sees, not who the EVM debits, so the balance
        // that funds a native swap is this contract's.
        vm.deal(address(this), 10_000_000 ether);
        vm.deal(alice, 1_000_000 ether);
        vm.deal(bob, 1_000_000 ether);
    }

    // --- the deployment -----------------------------------------------------

    function test_theScriptWiresEveryIdentityBothWays() public view {
        assertEq(address(factory.hook()), address(hook), "factory names the hook");
        assertEq(hook.factory(), address(factory), "hook names the factory");
        assertEq(address(factory.deployer()), address(d.deployer), "factory names the deployer");
        assertEq(d.deployer.factory(), address(factory), "deployer names the factory");
        assertEq(address(factory.registry()), address(registry), "factory names the registry");
        assertEq(registry.factory(), address(factory), "registry accepts only the factory");
        assertEq(factory.treasury(), treasury, "and pays the treasury it was told to");
    }

    function test_theHookIsPinnedToTheRouter() public view {
        // Without this the wallet rule has nothing to authenticate against.
        assertEq(hook.agenRouter(), address(router), "the hook knows its router");
    }

    function test_theRegistryStartsEmptyAndIsItsOwn() public view {
        assertEq(registry.count(), 0, "a fresh registry for a fresh engine version");
    }

    // --- the launch ---------------------------------------------------------

    function _featuredConfig(address token) private pure returns (AgenRuleLibV2.Config memory config) {
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
        token; // the quote is native, so nothing about the config depends on the token
    }

    function _manifest() private view returns (AgenEngineFactoryV2.Manifest memory manifest) {
        manifest = AgenEngineFactoryV2.Manifest({
            name: "Cascade",
            symbol: "CSCD",
            supply: SUPPLY,
            metadataURI: "ipfs://cascade",
            metadataMutable: false,
            tokenSalt: bytes32(uint256(1)),
            quoteAsset: address(0),
            initialTick: INITIAL_TICK,
            config: _featuredConfig(address(0)),
            feeReceiver: creator,
            specificationHash: keccak256("the prompt"),
            implementationHash: bytes32(0)
        });

        // The factory recomputes this and refuses the launch unless it matches, so the
        // manifest has to carry the commitment the configuration actually produces.
        manifest.implementationHash = AgenRuleLibV2.implementationHash(
            AgenRuleLibV2.hashConfig(manifest.config), block.chainid, address(hook), 2
        );
    }

    function _launch() private returns (address token, PoolKey memory key, PoolId poolId) {
        AgenEngineFactoryV2.Manifest memory manifest = _manifest();

        vm.prank(creator);
        factory.deployMarket(manifest);

        AgenMarketRegistry.Market memory record = registry.marketAt(registry.count() - 1);
        token = record.token;

        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: AgenCurve.TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();
    }

    function test_theFeaturedMarketLaunchesThroughTheFactory() public {
        (address token, PoolKey memory key, PoolId poolId) = _launch();
        key;

        assertEq(registry.count(), 1, "one market recorded");
        assertEq(hook.engineVersionOf(poolId), 2, "an engine-v2 market");
        assertTrue(token > address(0), "the token sorts above native");
        assertEq(VerdantNotifyingToken(token).totalSupply(), SUPPLY, "the whole supply exists");
        assertEq(VerdantNotifyingToken(token).listener(), address(hook), "and it notifies the hook");
    }

    function test_theFactoryDeploysAndBindsBothPots() public {
        (,, PoolId poolId) = _launch();

        address holderPot = hook.vaultOf(poolId).recipientAt(0);
        address buybackPot = hook.vaultOf(poolId).recipientAt(1);

        assertTrue(holderPot.code.length > 0, "a largest-holder pot exists");
        assertTrue(buybackPot.code.length > 0, "a buyback pot exists");
        assertTrue(AgenLargestHolderPot(payable(holderPot)).bound(), "the holder pot knows its vault");
        assertTrue(AgenBuybackPot(payable(buybackPot)).bound(), "and so does the buyback pot");
        assertTrue(holderPot != buybackPot, "the vault forbids one address in two slots");
    }

    function test_theCommitmentIsRecomputedOnChain() public {
        (,, PoolId poolId) = _launch();

        AgenMarketRegistry.Market memory record = registry.marketAt(0);
        assertEq(record.implementationHash, hook.implementationHashOf(poolId), "registry and hook agree");
    }

    function test_aManifestWhoseCommitmentDoesNotMatchIsRefused() public {
        AgenEngineFactoryV2.Manifest memory manifest = _manifest();
        manifest.implementationHash = keccak256("something the creator did not approve");

        vm.prank(creator);
        vm.expectRevert();
        factory.deployMarket(manifest);
    }

    function test_theLockedLiquidityIsExcludedFromTheHolderWeights() public {
        (,, PoolId poolId) = _launch();

        AgenLargestHolderPot pot = AgenLargestHolderPot(payable(hook.holderPotOf(poolId)));

        // The three bands are owned by the locker, which holds most of the supply. If it
        // could win the epoch, the market would pay its own fees back to itself.
        assertEq(pot.weightOf(0, address(posm)), 0, "the position manager is excluded");
        assertEq(pot.weightOf(0, address(manager)), 0, "the pool is excluded");
        assertEq(pot.weightOf(0, address(factory)), 0, "the factory is excluded");
        assertTrue(pot.excluded(address(posm)), "and the exclusion is recorded, not incidental");
    }

    // --- trading the launched market ----------------------------------------

    /// @dev The key is read before the prank, not inside the call. `_key()` reaches the
    /// registry, and `vm.prank` applies to the next call whichever one that turns out to
    /// be — so evaluating it in the argument list spent the prank on a staticcall and sent
    /// the swap as this contract. The router then credited the wrong trader, which is
    /// invisible until something reads who actually holds the tokens.
    function _buy(address who, uint128 amountIn) private returns (uint256) {
        PoolKey memory key = _key();

        vm.prank(who);
        return router.swap{value: amountIn}(key, true, amountIn, 0, "");
    }

    function _key() private view returns (PoolKey memory) {
        AgenMarketRegistry.Market memory record = registry.marketAt(0);
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(record.token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: AgenCurve.TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    function test_aRoutedBuyWorksAndPaysTheFeeInEther() public {
        (address token,, PoolId poolId) = _launch();

        uint256 received = _buy(alice, 1 ether);
        assertGt(received, 0, "alice received tokens");
        assertEq(VerdantNotifyingToken(token).balanceOf(alice), received, "and holds them");

        // Native quote, so the vault's accrual is ether rather than a token balance.
        assertEq(hook.vaultOf(poolId).totalAccrued(), (1 ether * 3_000) / 1_000_000, "0.3% of the input");
    }

    /// @dev Asserted as the invariant rather than against one magic trade size. The launch
    /// curve is one-sided, so a very large buy is partly filled rather than refused, and
    /// what a given amount of ether buys depends on the opening tick. What must hold at
    /// every step is that the accumulator never passes the cap and that a buy is eventually
    /// refused outright.
    function test_theWalletCapBindsOnTheLaunchedMarket() public {
        _launch();
        PoolKey memory key = _key();
        PoolId poolId = key.toId();

        _buy(alice, 1 ether);
        assertGt(hook.boughtBy(poolId, alice), 0, "the rule counted the first buy");

        bool refused;
        for (uint256 i = 0; i < 24; i++) {
            vm.prank(alice);
            try router.swap{value: 20_000 ether}(key, true, 20_000 ether, 0, "") {
                assertLe(hook.boughtBy(poolId, alice), WALLET_CAP, "the accumulator never passes the cap");
            } catch {
                refused = true;
                break;
            }
        }

        assertTrue(refused, "the cap eventually refuses a buy outright");
        assertLe(hook.boughtBy(poolId, alice), WALLET_CAP, "and never let more through than it allows");
    }

    function test_theHolderWeightsFollowTheLaunchedToken() public {
        (address token,, PoolId poolId) = _launch();

        _buy(alice, 1 ether);
        vm.warp(block.timestamp + HOUR / 2);
        _buy(bob, 1 ether);
        vm.warp(block.timestamp + HOUR);

        AgenLargestHolderPot pot = AgenLargestHolderPot(payable(hook.holderPotOf(poolId)));

        assertGt(pot.weightOf(0, alice), 0, "the token's transfers reached the ledger");
        assertGt(pot.weightOf(0, alice), pot.weightOf(0, bob), "and holding longer in the epoch is worth more");
        assertGt(VerdantNotifyingToken(token).balanceOf(bob), 0, "bob holds too");
    }
}
