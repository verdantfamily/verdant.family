// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";

import {FactoryOrigin} from "../../../src/FactoryOrigin.sol";
import {AgenCurve} from "../../../src/agen/AgenCurve.sol";
import {AgenMarketRegistry} from "../../../src/agen/AgenMarketRegistry.sol";
import {AgenEngineDeployer} from "../../../src/agen/engine/AgenEngineDeployer.sol";
import {AgenEngineFactory} from "../../../src/agen/engine/AgenEngineFactory.sol";
import {AgenEngineHook} from "../../../src/agen/engine/AgenEngineHook.sol";
import {AgenEngineVault} from "../../../src/agen/engine/AgenEngineVault.sol";
import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";
import {HookMiner} from "../../utils/HookMiner.sol";

/// @title The deterministic launch, end to end
///
/// @notice Deploys the engine exactly as the real script will, then launches a market
/// through the real factory and trades it.
///
/// @dev The deployment half is the part that cannot be recovered from if it is wrong, so it
/// is a test rather than a runbook. `AgenEngineHook` names the factory in its constructor and
/// `AgenEngineFactory` names the hook in its own — a genuine cycle, and both are immutable
/// because a setter on either would mean a market's economics could be pointed somewhere
/// else after launch.
///
/// ## How the cycle is broken
///
/// By anchoring the factory's address to something whose address does not depend on the
/// factory's code. `FactoryOrigin` publishes `keccak(rlp(origin, 1))` — the address of its
/// own first creation — in its constructor. That address is knowable before the factory's
/// initcode exists, which is precisely what the cycle needs:
///
///   step 1  deploy `FactoryOrigin(operator)`. It publishes `factory()`.
///   step 2  deploy `AgenMarketRegistry(predictedFactory)`.
///   step 3  mine a CREATE2 salt for `AgenEngineHook(poolManager, predictedFactory,
///           positionManager)` whose address carries 0x38CC, and deploy it.
///   step 4  `origin.deployFactory(AgenEngineFactory initcode naming that hook)`. It lands
///           on the published address, with the hook fixed in an immutable.
///
/// Step 4's constructor then checks both wirings — `registry.factory() == address(this)` and
/// `hook.factory() == address(this)` — so a mis-ordered deployment is a failed transaction
/// rather than a live factory whose markets no hook will configure. No setter, no admin, no
/// proxy, and no address that anybody has to trust a script to have computed correctly.
contract EngineLaunchTest is Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 internal constant ENGINE_FLAGS = 0x38CC;

    /// @dev A million tokens, which is what the fixtures use and what keeps a band's
    /// liquidity non-zero at the opening tick below.
    uint256 internal constant SUPPLY = 1_000_000e18;
    uint128 internal constant ONE_PERCENT = uint128(SUPPLY / 100);

    /// @dev Priced so the launch's own liquidity is deep against the trades below.
    int24 internal constant INITIAL_TICK = 92_200;

    PositionManager internal posm;
    FactoryOrigin internal origin;
    AgenEngineDeployer internal engineDeployer;
    AgenMarketRegistry internal registry;
    AgenEngineHook internal hook;
    AgenEngineFactory internal factory;

    MockERC20 internal quote;

    address internal treasury = address(0x7EA5);
    address internal trader = address(0xDECAF);

    address internal predictedFactory;

    function setUp() public {
        deployFreshManagerAndRouters();

        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        quote = new MockERC20("Quote", "QUOTE", 18);

        _deployEngineInOrder();
    }

    /// @dev The four steps, in order, exactly as `DeployAgenEngine.s.sol` will run them.
    function _deployEngineInOrder() private {
        // 1. The anchor. Its own address is irrelevant; what matters is that it publishes
        //    where the factory will be, before the factory's code exists.
        origin = new FactoryOrigin(address(this));
        predictedFactory = origin.factory();
        assertTrue(predictedFactory != address(0), "the anchor published nothing");
        assertEq(predictedFactory.code.length, 0, "something is already at the factory's address");

        // 2. The deployer, which holds the per-market bytecode so the factory can stay under
        //    EIP-170, and which names the factory it will only ever act for.
        engineDeployer = new AgenEngineDeployer(predictedFactory);

        // 3. The registry, which names the factory it will only ever accept writes from.
        registry = new AgenMarketRegistry(predictedFactory);

        // 4. The hook, mined against the *predicted* factory. This is the step that would be
        //    impossible without the anchor: the hook's initcode contains the factory's
        //    address, so the factory's address cannot depend on the hook's initcode.
        bytes memory args = abi.encode(manager, predictedFactory, address(posm));
        (address predictedHook, bytes32 salt) =
            HookMiner.find(address(this), ENGINE_FLAGS, type(AgenEngineHook).creationCode, args);

        hook = new AgenEngineHook{salt: salt}(manager, predictedFactory, address(posm));
        assertEq(address(hook), predictedHook, "the hook did not land where it was mined");

        // 5. The factory, through the anchor, naming all three.
        bytes memory initcode = abi.encodePacked(
            type(AgenEngineFactory).creationCode,
            abi.encode(manager, posm, engineDeployer, registry, hook, treasury)
        );
        address deployed = origin.deployFactory(initcode);
        factory = AgenEngineFactory(deployed);

        assertEq(deployed, predictedFactory, "the factory did not land on the published address");
    }

    // --- the deployment itself ------------------------------------------------

    function test_the_predicted_addresses_are_the_deployed_addresses() public view {
        assertEq(address(factory), predictedFactory, "factory");
        assertEq(uint160(address(hook)) & 0x3FFF, ENGINE_FLAGS, "the hook's permission bits");
    }

    function test_the_hook_and_the_factory_pin_each_other() public view {
        // Both immutable, both checked. Neither can be repointed.
        assertEq(hook.factory(), address(factory), "the hook does not name the factory");
        assertEq(address(factory.hook()), address(hook), "the factory does not name the hook");
        assertEq(registry.factory(), address(factory), "the registry does not name the factory");
    }

    function test_the_factory_refuses_a_hook_that_names_someone_else() public {
        // The check that turns a mis-ordered deployment into a failed one. A second origin,
        // so a second factory address, and a hook still pointing at the first.
        FactoryOrigin second = new FactoryOrigin(address(this));
        AgenMarketRegistry otherRegistry = new AgenMarketRegistry(second.factory());

        bytes memory initcode = abi.encodePacked(
            type(AgenEngineFactory).creationCode,
            abi.encode(manager, posm, otherRegistry, hook, treasury)
        );

        vm.expectRevert();
        second.deployFactory(initcode);
    }

    function test_the_anchor_can_only_be_used_once() public {
        bytes memory initcode = abi.encodePacked(
            type(AgenEngineFactory).creationCode,
            abi.encode(manager, posm, registry, hook, treasury)
        );

        vm.expectRevert(abi.encodeWithSelector(FactoryOrigin.AlreadyUsed.selector, predictedFactory));
        origin.deployFactory(initcode);
    }

    // --- launching ------------------------------------------------------------

    function _flatConfig(uint24 feePpm) internal view returns (AgenRuleLib.Config memory config) {
        config.engineVersion = 1;
        config.referenceSupply = SUPPLY;
        config.quoteAsset = address(quote);
        config.feeCurrency = uint8(AgenRuleLib.FeeCurrency.Quote);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.None);

        config.stages = new AgenRuleLib.Stage[](1);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: feePpm, sellFeePpm: feePpm});

        config.buyTiers = new AgenRuleLib.Tier[](0);
        config.sellTiers = new AgenRuleLib.Tier[](0);

        config.distribution = new AgenRuleLib.Share[](2);
        config.distribution[0] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Creator, recipient: address(0), sharePpm: 800_000});
        config.distribution[1] =
            AgenRuleLib.Share({kind: AgenRuleLib.RecipientKind.Treasury, recipient: address(0), sharePpm: 200_000});
    }

    function _tieredConfig(uint24 baseFeePpm, uint128 threshold, uint24 tierFeePpm)
        internal
        view
        returns (AgenRuleLib.Config memory config)
    {
        config = _flatConfig(baseFeePpm);
        config.feeCurrency = uint8(AgenRuleLib.FeeCurrency.Token);
        config.sellTiers = new AgenRuleLib.Tier[](1);
        config.sellTiers[0] = AgenRuleLib.Tier({thresholdTokens: threshold, feePpm: tierFeePpm});
    }

    /// @dev A manifest whose token salt sorts the token above the quote asset, which the
    /// curve requires. Searched here exactly as the deployment preparation will search it.
    function _manifest(string memory symbol, AgenRuleLib.Config memory config)
        internal
        view
        returns (AgenEngineFactory.Manifest memory manifest)
    {
        manifest = AgenEngineFactory.Manifest({
            name: "Engine Market",
            symbol: symbol,
            supply: SUPPLY,
            metadataURI: "ipfs://engine",
            metadataMutable: false,
            tokenSalt: bytes32(0),
            quoteAsset: address(quote),
            initialTick: INITIAL_TICK,
            config: config,
            feeReceiver: address(this),
            specificationHash: keccak256(abi.encodePacked("spec:", symbol)),
            implementationHash: bytes32(0)
        });

        for (uint256 i = 1; i < 512; i++) {
            manifest.tokenSalt = keccak256(abi.encodePacked(symbol, i));
            if (factory.predictToken(manifest) > address(quote)) break;
        }
        require(factory.predictToken(manifest) > address(quote), "no salt sorted the token above the quote");

        manifest.implementationHash = AgenRuleLib.implementationHash(
            AgenRuleLib.hashConfig(config), block.chainid, address(hook), config.engineVersion
        );
    }

    function _launch(AgenEngineFactory.Manifest memory manifest) internal returns (uint256 index, PoolKey memory key) {
        index = factory.deployMarket(manifest);

        AgenMarketRegistry.Market memory market = registry.marketAt(index);
        key = PoolKey({
            currency0: Currency.wrap(address(quote)),
            currency1: Currency.wrap(market.token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: AgenCurve.TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        quote.mint(trader, SUPPLY);
        vm.startPrank(trader);
        quote.approve(address(swapRouter), type(uint256).max);
        MockERC20(market.token).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    function _settings() private pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    /// @dev A buy spends the quote, which is `currency0`, so `zeroForOne`.
    function _buy(PoolKey memory key, uint256 amountIn) private {
        vm.prank(trader);
        swapRouter.swap(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
            SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            ""
        );
    }

    function _sell(PoolKey memory key, uint256 amountIn) private {
        vm.prank(trader);
        swapRouter.swap(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
            SwapParams({zeroForOne: false, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            _settings(),
            ""
        );
    }

    // --- the end-to-end assertions -------------------------------------------

    function test_a_launch_produces_a_correct_engine_market() public {
        AgenRuleLib.Config memory config = _flatConfig(20_000);
        AgenEngineFactory.Manifest memory manifest = _manifest("ENG", config);
        address expectedToken = factory.predictToken(manifest);

        (uint256 index, PoolKey memory key) = _launch(manifest);
        PoolId poolId = key.toId();
        AgenMarketRegistry.Market memory market = registry.marketAt(index);

        // 2. the token
        assertEq(market.token, expectedToken, "the token is not where it was predicted");
        assertEq(IERC20(market.token).totalSupply(), SUPPLY, "the supply is wrong");
        assertEq(IERC20(market.token).balanceOf(address(factory)), 0, "the factory kept supply");

        // 3. the pool
        (uint160 sqrtPrice,,, uint24 lpFee) = manager.getSlot0(poolId);
        assertGt(sqrtPrice, 0, "the pool did not initialise");
        assertEq(lpFee, 0, "the pool would charge a second fee");

        // 4 and 5. the rules, and their identity derived from what was stored
        assertTrue(hook.isConfigured(poolId), "the hook has no rules for this pool");
        assertEq(hook.configHashOf(poolId), AgenRuleLib.hashConfig(config), "the identity is not the config's");
        assertEq(uint8(hook.feeCurrencyOf(poolId)), uint8(AgenRuleLib.FeeCurrency.Quote), "fee currency");
        assertEq(hook.engineVersionOf(poolId), 1, "engine version");

        // 6. the commitment, recomputed from the chain
        assertEq(hook.implementationHashOf(poolId), manifest.implementationHash, "the hook's commitment");
        assertEq(market.implementationHash, manifest.implementationHash, "the registry's commitment");

        // 7. the vault
        AgenEngineVault vault = hook.vaultOf(poolId);
        assertEq(Currency.unwrap(vault.currency()), address(quote), "the vault holds the wrong currency");
        assertEq(vault.recipientCount(), 2, "recipients");
        assertEq(vault.recipientAt(0), address(this), "the creator was not resolved");
        assertEq(vault.recipientAt(1), treasury, "the treasury was not resolved");
        assertEq(vault.shareAt(0), 800_000, "the creator's share");
        assertEq(vault.shareAt(1), 200_000, "the treasury's share");

        // 8. the registry
        assertEq(market.creator, address(this), "creator");
        assertEq(market.hook, address(hook), "hook");
        assertEq(market.quoteAsset, address(quote), "quote asset");
        assertEq(market.specificationHash, manifest.specificationHash, "specification hash");

        AgenMarketRegistry.Component[] memory components = registry.componentsAt(index);
        assertEq(components.length, 4, "components");
        assertEq(components[2].addr, address(vault), "the vault is not recorded");
        assertEq(components[2].role, registry.ROLE_VAULT(), "the vault's role");

        /*
         * 9. the liquidity, locked.
         *
         * Not asserted as `getLiquidity(poolId) > 0` at this point, which would be wrong:
         * that reports liquidity *at the current tick*, and every one of `AgenCurve`'s three
         * bands has its upper tick at or below the opening tick. A launch is deliberately
         * one-sided — the supply sits below the opening price and becomes active as the price
         * falls into it — so zero in-range liquidity at tick zero of trading is the design
         * rather than a fault. What is asserted is that the positions exist, that the locker
         * owns them, and that the pool trades.
         */
        assertEq(components[3].role, registry.ROLE_LOCKER(), "the locker's role");
        assertEq(components[3].addr.code.length > 0, true, "no locker was deployed");

        // 10, 11. tradeable, and a buy is charged
        uint256 spend = 1e18;
        _buy(key, spend);
        assertEq(vault.totalAccrued(), (spend * 20_000) / 1e6, "a buy was not charged correctly");
        assertGt(manager.getLiquidity(poolId), 0, "the buy did not move the price into the bands");

        // 12. and a sell
        uint256 held = IERC20(market.token).balanceOf(trader);
        assertGt(held, 0, "the buy delivered nothing");
        uint256 before = vault.totalAccrued();
        _sell(key, held / 2);
        assertGt(vault.totalAccrued(), before, "a sell was not charged");

        // 16. a recipient can claim
        uint256 owed = vault.claimable(0);
        assertGt(owed, 0, "nothing accrued to the creator");
        uint256 quoteBefore = quote.balanceOf(address(this));
        vault.claim(0);
        assertEq(quote.balanceOf(address(this)) - quoteBefore, owed, "the creator was not paid");
    }

    // 13. the tier boundary, through a real launch
    function test_a_tiered_market_applies_its_tier_at_the_boundary() public {
        AgenRuleLib.Config memory config = _tieredConfig(5_000, ONE_PERCENT, 40_000);
        (, PoolKey memory key) = _launch(_manifest("TIER", config));
        PoolId poolId = key.toId();

        AgenEngineVault vault = hook.vaultOf(poolId);
        address token = Currency.unwrap(key.currency1);

        // A tiered market collects in the launched token.
        assertEq(Currency.unwrap(vault.currency()), token, "a tiered market must collect in the token");

        // Buy enough token to sell across the threshold.
        _buy(key, 500e18);
        assertGe(IERC20(token).balanceOf(trader), uint256(ONE_PERCENT), "not enough token to test the boundary");

        uint256 before = vault.totalAccrued();
        _sell(key, uint256(ONE_PERCENT));
        assertEq(
            vault.totalAccrued() - before,
            (uint256(ONE_PERCENT) * 40_000) / 1e6,
            "a sell of exactly 1% of supply must pay the tier"
        );

        before = vault.totalAccrued();
        _sell(key, uint256(ONE_PERCENT) - 1);
        assertEq(
            vault.totalAccrued() - before,
            ((uint256(ONE_PERCENT) - 1) * 5_000) / 1e6,
            "one token below the threshold must pay the base rate"
        );
    }

    // 14. a configured ladder behaves
    function test_a_time_ladder_market_changes_rate_on_the_boundary() public {
        AgenRuleLib.Config memory config = _flatConfig(20_000);
        config.ladderAxis = uint8(AgenRuleLib.LadderAxis.Time);
        config.stages = new AgenRuleLib.Stage[](2);
        config.stages[0] = AgenRuleLib.Stage({threshold: 0, buyFeePpm: 20_000, sellFeePpm: 20_000});
        config.stages[1] = AgenRuleLib.Stage({threshold: 3600, buyFeePpm: 10_000, sellFeePpm: 10_000});

        (, PoolKey memory key) = _launch(_manifest("LADR", config));
        AgenEngineVault vault = hook.vaultOf(key.toId());

        uint256 spend = 1e18;
        _buy(key, spend);
        assertEq(vault.totalAccrued(), (spend * 20_000) / 1e6, "the opening rate");

        vm.warp(block.timestamp + 3600);
        uint256 before = vault.totalAccrued();
        _buy(key, spend);
        assertEq(vault.totalAccrued() - before, (spend * 10_000) / 1e6, "the stage did not advance");
    }

    // 17, 18. nobody can change a launched market
    function test_a_creator_cannot_reconfigure_their_market() public {
        AgenRuleLib.Config memory config = _flatConfig(20_000);
        (, PoolKey memory key) = _launch(_manifest("IMMU", config));

        AgenEngineVault vault = hook.vaultOf(key.toId());

        // Not through the hook: only the factory may configure, and only once.
        vm.expectRevert(abi.encodeWithSelector(AgenEngineHook.NotFactory.selector, address(this)));
        hook.configure(key, _flatConfig(90_000), vault);
    }

    function test_a_second_launch_cannot_reconfigure_an_existing_pool() public {
        AgenRuleLib.Config memory config = _flatConfig(20_000);
        AgenEngineFactory.Manifest memory manifest = _manifest("DUPE", config);
        _launch(manifest);

        // The same manifest again: the same token salt, so the same token address, so the
        // same pool. CREATE2 refuses the token before anything else is touched.
        vm.expectRevert();
        factory.deployMarket(manifest);
    }

    // --- two markets, one hook ------------------------------------------------

    function test_two_launched_markets_stay_isolated() public {
        AgenRuleLib.Config memory flatConfig = _flatConfig(20_000);
        (uint256 indexA, PoolKey memory keyA) = _launch(_manifest("ISOA", flatConfig));

        AgenRuleLib.Config memory tieredConfig = _tieredConfig(5_000, ONE_PERCENT, 40_000);
        (uint256 indexB, PoolKey memory keyB) = _launch(_manifest("ISOB", tieredConfig));

        assertTrue(PoolId.unwrap(keyA.toId()) != PoolId.unwrap(keyB.toId()), "two launches produced one pool");

        AgenEngineVault vaultA = hook.vaultOf(keyA.toId());
        AgenEngineVault vaultB = hook.vaultOf(keyB.toId());
        assertTrue(address(vaultA) != address(vaultB), "two markets share a vault");

        // Different rules, different identities, different fee currencies.
        assertTrue(hook.configHashOf(keyA.toId()) != hook.configHashOf(keyB.toId()), "one identity, two markets");
        assertEq(uint8(hook.feeCurrencyOf(keyA.toId())), uint8(AgenRuleLib.FeeCurrency.Quote));
        assertEq(uint8(hook.feeCurrencyOf(keyB.toId())), uint8(AgenRuleLib.FeeCurrency.Token));

        // A trade in A credits A alone.
        _buy(keyA, 1e18);
        assertGt(vaultA.totalAccrued(), 0, "A was not credited");
        assertEq(vaultB.totalAccrued(), 0, "A's trade credited B");

        uint256 aBefore = vaultA.totalAccrued();
        _buy(keyB, 1e18);
        assertGt(vaultB.totalAccrued(), 0, "B was not credited");
        assertEq(vaultA.totalAccrued(), aBefore, "B's trade credited A");

        // And both are registered, separately, under the same shared hook.
        assertEq(registry.marketAt(indexA).hook, address(hook));
        assertEq(registry.marketAt(indexB).hook, address(hook));
        assertTrue(registry.marketAt(indexA).token != registry.marketAt(indexB).token, "one token, two markets");
    }

    /// @dev A single-shot measurement, so it can be compared with the native figure in
    /// `EngineNative.t.sol`. A gas-report median is not comparable: it averages over the
    /// failure tests, several of which revert early and cost almost nothing.
    function test_gas_a_full_erc20_launch() public {
        AgenEngineFactory.Manifest memory manifest = _manifest("GLCH", _flatConfig(20_000));

        uint256 before = gasleft();
        factory.deployMarket(manifest);
        uint256 used = before - gasleft();

        emit log_named_uint("full ERC-20 engine launch", used);
        assertLt(used, 6_000_000, "an ERC-20 launch regressed");
    }

    // --- failure atomicity ----------------------------------------------------

    /*
     * Each of these fails at a different stage, and the assertion in every case is the same:
     * nothing survives. A reverted transaction leaves no code behind, so the token and vault
     * CREATE2s are undone with everything else — but the registry is append-only and has no
     * repair path, so "no half-registered market" is the property worth stating outright.
     */
    function _assertNothingRegistered(uint256 countBefore) private view {
        assertEq(registry.count(), countBefore, "a failed launch left a registry record");
    }

    function test_a_supply_that_disagrees_with_the_configuration_is_refused() public {
        uint256 before = registry.count();
        AgenEngineFactory.Manifest memory manifest = _manifest("BADS", _flatConfig(20_000));
        manifest.supply = SUPPLY + 1;

        vm.expectRevert(
            abi.encodeWithSelector(AgenEngineFactory.SupplyMismatch.selector, SUPPLY + 1, SUPPLY)
        );
        factory.deployMarket(manifest);
        _assertNothingRegistered(before);
    }

    function test_a_quote_asset_that_disagrees_with_the_configuration_is_refused() public {
        uint256 before = registry.count();
        AgenEngineFactory.Manifest memory manifest = _manifest("BADQ", _flatConfig(20_000));
        manifest.quoteAsset = address(0xBEEF);

        vm.expectRevert();
        factory.deployMarket(manifest);
        _assertNothingRegistered(before);
    }

    function test_an_invalid_fee_is_refused() public {
        uint256 before = registry.count();
        // Above the engine's ceiling. `AgenRuleLib.validate` refuses it inside `configure`,
        // after the token has been deployed — and the revert takes the token with it.
        AgenEngineFactory.Manifest memory manifest = _manifest("BADF", _flatConfig(200_000));

        vm.expectRevert();
        factory.deployMarket(manifest);
        _assertNothingRegistered(before);
    }

    function test_an_invalid_split_is_refused() public {
        uint256 before = registry.count();
        AgenRuleLib.Config memory config = _flatConfig(20_000);
        config.distribution[1].sharePpm = 100_000; // 80% + 10%

        AgenEngineFactory.Manifest memory manifest = _manifest("BADD", config);

        vm.expectRevert();
        factory.deployMarket(manifest);
        _assertNothingRegistered(before);
    }

    function test_a_wrong_commitment_is_refused() public {
        uint256 before = registry.count();
        AgenEngineFactory.Manifest memory manifest = _manifest("BADH", _flatConfig(20_000));

        bytes32 declared = keccak256("not the commitment");
        bytes32 computed = manifest.implementationHash;
        manifest.implementationHash = declared;

        // The check that makes an approval binding.
        vm.expectRevert(
            abi.encodeWithSelector(AgenEngineFactory.CommitmentMismatch.selector, declared, computed)
        );
        factory.deployMarket(manifest);
        _assertNothingRegistered(before);
    }

    function test_changing_the_economics_after_signing_invalidates_the_commitment() public {
        uint256 before = registry.count();

        // A creator approves a 2% market. The manifest's commitment is over that.
        AgenEngineFactory.Manifest memory manifest = _manifest("SWAP", _flatConfig(20_000));

        // Someone then raises the rate while keeping the approved hash.
        manifest.config.stages[0].buyFeePpm = 90_000;
        manifest.config.stages[0].sellFeePpm = 90_000;

        vm.expectRevert();
        factory.deployMarket(manifest);
        _assertNothingRegistered(before);
    }

    function test_a_token_that_does_not_sort_above_the_quote_is_refused() public {
        uint256 before = registry.count();
        AgenEngineFactory.Manifest memory manifest = _manifest("SORT", _flatConfig(20_000));

        // Search for a salt that sorts the token *below* the quote, which the curve cannot lay
        // bands against.
        for (uint256 i = 1; i < 512; i++) {
            manifest.tokenSalt = keccak256(abi.encodePacked("below", i));
            if (factory.predictToken(manifest) < address(quote)) break;
        }
        vm.assume(factory.predictToken(manifest) < address(quote));

        vm.expectRevert();
        factory.deployMarket(manifest);
        _assertNothingRegistered(before);
    }

    function test_a_zero_supply_is_refused() public {
        uint256 before = registry.count();
        AgenEngineFactory.Manifest memory manifest = _manifest("ZERO", _flatConfig(20_000));
        manifest.supply = 0;

        vm.expectRevert(AgenEngineFactory.ZeroSupply.selector);
        factory.deployMarket(manifest);
        _assertNothingRegistered(before);
    }

    function test_an_off_grid_opening_tick_is_refused() public {
        uint256 before = registry.count();
        AgenEngineFactory.Manifest memory manifest = _manifest("TICK", _flatConfig(20_000));
        manifest.initialTick = INITIAL_TICK + 1;

        vm.expectRevert();
        factory.deployMarket(manifest);
        _assertNothingRegistered(before);
    }

    /// @dev Native quote launches are covered in full by `EngineNative.t.sol`, which owns the
    /// fixture. This asserts only that the factory does not refuse one, since that refusal
    /// used to live here.
    function test_a_native_quote_is_accepted() public {
        AgenRuleLib.Config memory config = _flatConfig(20_000);
        config.quoteAsset = address(0);

        AgenEngineFactory.Manifest memory manifest = _manifest("NATV", config);
        manifest.quoteAsset = address(0);

        // Native sorts to currency0 unconditionally, so the token is currency1 without a
        // salt search — the curve's requirement is satisfied for free.
        uint256 index = factory.deployMarket(manifest);
        assertEq(registry.marketAt(index).quoteAsset, address(0), "the quote asset is not native");
    }

    // 19. the legacy path is untouched
    function test_the_engine_registry_is_separate_from_the_legacy_one() public view {
        // Engine markets go into their own registry instance, pinned to this factory, so no
        // engine-0 record is read, written or reinterpreted by any of this.
        assertEq(registry.factory(), address(factory), "the engine registry is not the engine's");
    }
}
