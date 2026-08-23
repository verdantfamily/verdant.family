// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {stdJson} from "forge-std/StdJson.sol";

import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {AgenCurve} from "../../../src/agen/AgenCurve.sol";
import {AgenMarketRegistry} from "../../../src/agen/AgenMarketRegistry.sol";
import {AgenEngineDeployer} from "../../../src/agen/engine/AgenEngineDeployer.sol";
import {AgenEngineFactory} from "../../../src/agen/engine/AgenEngineFactory.sol";
import {AgenEngineHook} from "../../../src/agen/engine/AgenEngineHook.sol";
import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";
import {FactoryOrigin} from "../../../src/FactoryOrigin.sol";
import {HookMiner} from "../../utils/HookMiner.sol";

/// @title The whole product path, joined
///
/// @notice One market carried from a prompt to a trade, with the TypeScript's answer and the
/// chain's answer required to be the same answer.
///
/// @dev Every stage of the engine is already tested. The pipeline has tests, the evaluator has
/// tests, the hook has tests, the factory has tests, the app has tests. What none of them can
/// establish is that the stages are joined — each side can be flawless about a *different*
/// market, and every suite stays green.
///
/// That join is where the architecture's entire claim lives. A creator is shown a review screen
/// and told the market they read is the market they will get. What makes that true is not any
/// one layer being correct; it is that the bytes the review was derived from are the bytes the
/// chain executes.
///
/// So this test is deliberately ignorant. `packages/market-compiler/scripts/emit-journey.ts`
/// walks a prompt through interpretation, resolution, compilation, simulation, review and
/// deployment preparation, and writes down two things: the ABI-encoded canonical configuration,
/// and what the TypeScript evaluator says each of several trades will pay. Nothing here is told
/// a rate, a threshold or a recipient. It is handed bytes and expected outcomes, decodes the
/// bytes with `abi.decode`, launches a real market through the real factory, trades against a
/// real `PoolManager`, and checks the fee.
///
/// A disagreement anywhere in the chain — the encoder, the decoder, the compiler's
/// normalisation, the hook's tier selection, the fee currency derivation — surfaces here as a
/// number that does not match, whichever side is wrong.
contract EngineJourneyTest is Deployers {
    using PoolIdLibrary for PoolKey;
    using stdJson for string;

    uint160 internal constant ENGINE_FLAGS = 0x38CC;
    int24 internal constant INITIAL_TICK = 92_200;

    /// @dev The ERC-20 quote address the journey fixture is built against. Low enough that a
    /// mined token address sorts above it, which `AgenCurve` requires.
    address internal constant FIXTURE_QUOTE = 0x1111111111111111111111111111111111111111;

    PositionManager internal posm;
    FactoryOrigin internal origin;
    AgenEngineDeployer internal engineDeployer;
    AgenMarketRegistry internal registry;
    AgenEngineHook internal hook;
    AgenEngineFactory internal factory;

    MockERC20 internal quote;

    address internal treasury = address(0x7EA5);
    address internal trader = address(0xDECAF);

    function setUp() public {
        deployFreshManagerAndRouters();

        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        /*
         * The quote asset is placed at the address the fixture names, rather than the fixture
         * being rewritten to name whatever this test happened to deploy.
         *
         * That direction matters. The quote asset is inside the canonical configuration and
         * therefore inside `configHash`, so changing it here would change the hash and destroy
         * the one comparison this file exists to make: that the commitment the TypeScript
         * produced is the commitment the chain arrives at. The factory's `QuoteAssetMismatch`
         * check is what makes that unavoidable, and it is right to be strict — a market whose
         * configuration names one asset and whose pool trades another is exactly the confusion
         * a commitment is meant to rule out.
         */
        deployCodeTo("MockERC20.sol:MockERC20", abi.encode("Quote", "QUOTE", uint8(18)), FIXTURE_QUOTE);
        quote = MockERC20(FIXTURE_QUOTE);

        _deployEngine();
    }

    /// @dev The same five steps as `EngineLaunch.t.sol` and `DeployAgenEngine.s.sol`. Repeated
    /// rather than shared because a journey test that inherited its deployment would be
    /// testing the inheritance as much as the path.
    function _deployEngine() private {
        origin = new FactoryOrigin(address(this));
        address predictedFactory = origin.factory();

        engineDeployer = new AgenEngineDeployer(predictedFactory);
        registry = new AgenMarketRegistry(predictedFactory);

        bytes memory args = abi.encode(manager, predictedFactory, address(posm));
        (, bytes32 salt) = HookMiner.find(address(this), ENGINE_FLAGS, type(AgenEngineHook).creationCode, args);
        hook = new AgenEngineHook{salt: salt}(manager, predictedFactory, address(posm));

        bytes memory initcode = abi.encodePacked(
            type(AgenEngineFactory).creationCode,
            abi.encode(manager, posm, engineDeployer, registry, hook, treasury)
        );
        factory = AgenEngineFactory(origin.deployFactory(initcode));
    }

    // --- the fixture ----------------------------------------------------------

    function _journey(string memory name) private view returns (string memory) {
        return vm.readFile(string.concat("../market-engine/journey/", name, ".json"));
    }

    /// @dev The configuration as the TypeScript encoded it, decoded as Solidity reads it.
    ///
    /// This single line is the encoder/decoder agreement the commitment depends on. If
    /// `encode.ts` and `AgenRuleLib.Config` had drifted by one field, the decode below would
    /// either revert or silently produce different economics — and every assertion after it
    /// would be measuring the wrong market. That is why the trades are checked against
    /// TypeScript's numbers rather than against anything recomputed here.
    function _configOf(string memory journey) private pure returns (AgenRuleLib.Config memory) {
        return abi.decode(journey.readBytes(".encodedConfig"), (AgenRuleLib.Config));
    }

    // --- the launch -----------------------------------------------------------

    function _manifest(string memory journey, AgenRuleLib.Config memory config)
        private
        view
        returns (AgenEngineFactory.Manifest memory manifest)
    {
        manifest = AgenEngineFactory.Manifest({
            name: "Journey",
            symbol: journey.readString(".binding.launchedTokenSymbol"),
            supply: uint256(vm.parseUint(journey.readString(".binding.referenceSupply"))),
            metadataURI: "ipfs://journey",
            metadataMutable: false,
            tokenSalt: bytes32(0),
            // From the fixture, so the manifest and the configuration name the same asset.
            // Zero for the native journey, which is how v4 spells native ETH.
            quoteAsset: journey.readAddress(".binding.quoteAsset.address"),
            initialTick: INITIAL_TICK,
            config: config,
            feeReceiver: address(this),
            specificationHash: journey.readBytes32(".configHash"),
            implementationHash: bytes32(0)
        });

        // `AgenCurve` requires the launched token to be currency1, so the salt is mined until
        // it sorts above the quote — the same search the factory's own callers do.
        address quoteAsset = manifest.quoteAsset;
        for (uint256 i = 1; i < 512; i++) {
            manifest.tokenSalt = keccak256(abi.encodePacked("journey", manifest.symbol, i));
            if (factory.predictToken(manifest) > quoteAsset) break;
        }
        require(factory.predictToken(manifest) > quoteAsset, "no salt sorted the token above the quote");

        manifest.implementationHash = AgenRuleLib.implementationHash(
            AgenRuleLib.hashConfig(config), block.chainid, address(hook), config.engineVersion
        );
    }

    function _launch(AgenEngineFactory.Manifest memory manifest)
        private
        returns (PoolKey memory key, address token)
    {
        uint256 index = factory.deployMarket(manifest);
        token = registry.marketAt(index).token;

        key = PoolKey({
            currency0: Currency.wrap(manifest.quoteAsset),
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: AgenCurve.TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        if (manifest.quoteAsset == address(0)) {
            vm.deal(trader, manifest.supply);
        } else {
            quote.mint(trader, manifest.supply);
            vm.prank(trader);
            quote.approve(address(swapRouter), type(uint256).max);
        }

        vm.prank(trader);
        MockERC20(token).approve(address(swapRouter), type(uint256).max);
    }

    function _settings() private pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    // --- the assertions -------------------------------------------------------

    /// @notice The economics the TypeScript committed to are the economics the chain stores.
    ///
    /// @dev `configHash` is engine- and chain-independent by construction, which is what makes
    /// it comparable across the boundary at all: the fixture was built against placeholder
    /// addresses on a different chain id, and the hash still has to match. The commitment
    /// hash deliberately does not — it binds this chain and this hook, and is checked
    /// separately below against a value recomputed here.
    function test_the_chain_stores_the_configuration_the_review_described() public {
        string memory journey = _journey("tiered");
        AgenRuleLib.Config memory config = _configOf(journey);

        assertEq(
            AgenRuleLib.hashConfig(config),
            journey.readBytes32(".configHash"),
            "the configuration the chain would store is not the one the review described"
        );

        (PoolKey memory key,) = _launch(_manifest(journey, config));

        assertEq(
            hook.configHashOf(key.toId()),
            journey.readBytes32(".configHash"),
            "the launched market's stored commitment is not the reviewed configuration"
        );
    }

    /// @notice Every trade the simulation predicted, executed, paying what it predicted.
    ///
    /// @dev The tiered journey includes the boundary triple — one unit below the tier, exactly
    /// at it, one unit above — because that is the only place a correct implementation and an
    /// incorrect one visibly differ, and it is the case the whole engine was rebuilt around.
    function test_every_predicted_trade_pays_what_was_predicted() public {
        string memory journey = _journey("tiered");
        AgenRuleLib.Config memory config = _configOf(journey);

        (PoolKey memory key,) = _launch(_manifest(journey, config));
        PoolId poolId = key.toId();

        // Counted from the fixture rather than hardcoded, so adding a boundary case to the
        // emitter is picked up here without a second edit — and so a fixture that lost its
        // trades fails loudly rather than asserting nothing.
        uint256 count = abi.decode(journey.parseRaw(".tradeCount"), (uint256));
        assertGt(count, 0, "the fixture predicts no trades");

        for (uint256 i = 0; i < count; i++) {
            string memory at = string.concat(".trades[", vm.toString(i), "]");

            uint256 gross = vm.parseUint(journey.readString(string.concat(at, ".grossTokenAmount")));
            uint256 expectedPpm = journey.readUint(string.concat(at, ".expectedFeePpm"));
            bool isBuy = journey.readBool(string.concat(at, ".isBuy"));

            // Asked of the hook rather than observed from a swap's deltas, because the
            // question is which *rate* the configuration selects for a trade of this size —
            // the thing the review screen states and the thing an implementation gets wrong.
            // The delta path is proven trade by trade in `EngineHook.swaps.t.sol`.
            uint24 charged = hook.feePpmFor(poolId, isBuy, gross);

            assertEq(
                uint256(charged),
                expectedPpm,
                string.concat(
                    "the chain disagrees with the simulation about ",
                    journey.readString(string.concat(at, ".what"))
                )
            );
        }
    }

    /// @notice A real swap, through a real PoolManager, on the market the journey built.
    ///
    /// @dev The rate assertions above are exact and static; this one is the liveness check that
    /// the market they describe can actually be traded. Both matter: a market that charges the
    /// right fee and cannot be swapped is not a market.
    function test_the_market_the_journey_built_can_be_traded() public {
        string memory journey = _journey("tiered");
        AgenRuleLib.Config memory config = _configOf(journey);

        (PoolKey memory key, address token) = _launch(_manifest(journey, config));

        uint256 before = MockERC20(token).balanceOf(trader);

        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            ""
        );

        assertGt(MockERC20(token).balanceOf(trader), before, "the trader received no tokens");
    }

    /// @notice The fee arrives in the asset the review named, and in the vault.
    ///
    /// @dev ADR-018 in one assertion. The tiered journey has size tiers, so its fees are
    /// collected in the launched token rather than the quote asset — and the review screen
    /// says so, in `feeCurrencySymbol`. This checks the chain agrees, which is the property a
    /// creator is relying on when they read which asset they will be paid in.
    function test_the_fee_arrives_in_the_asset_the_review_named() public {
        string memory journey = _journey("tiered");
        AgenRuleLib.Config memory config = _configOf(journey);

        assertEq(
            journey.readString(".review.feeCurrencySymbol"),
            journey.readString(".binding.launchedTokenSymbol"),
            "this fixture is meant to be a token-fee market"
        );

        (PoolKey memory key,) = _launch(_manifest(journey, config));

        // `FeeCurrency.Token` is 1. Compared as the enum rather than as an address because
        // that is what the hook stores and what `_feeCurrencyOf` reads on the swap path — the
        // address is derived from it and the pool's orientation, which `EngineHook.swaps.t.sol`
        // proves separately.
        assertEq(
            uint256(hook.feeCurrencyOf(key.toId())),
            1,
            "the chain collects the fee in a different asset than the review named"
        );
    }

    /// @notice The same journey, quoted in an ERC-20, has a quote-denominated fee.
    ///
    /// @dev The other half of the derivation. The native fixture has no size tiers, so its fee
    /// is collected in the quote asset. Launched here against the mock ERC-20 rather than
    /// against native ETH — the native settlement path itself is proven in `EngineNative.t.sol`,
    /// and what this adds is that the *derivation* travels across the boundary intact: a
    /// configuration the TypeScript marked as quote-denominated arrives quote-denominated.
    function test_a_market_without_tiers_collects_in_the_quote_asset() public {
        string memory journey = _journey("native");
        AgenRuleLib.Config memory config = _configOf(journey);

        (PoolKey memory key,) = _launch(_manifest(journey, config));

        // `FeeCurrency.Quote` is 0.
        assertEq(
            uint256(hook.feeCurrencyOf(key.toId())),
            0,
            "a market with no size tiers should collect in the quote asset"
        );
    }

    /// @notice That the fixture is a fixture of something.
    ///
    /// @dev The failure mode this whole file could quietly have: `vm.readFile` returning a
    /// stale or empty journey, every decode yielding zeros, and every assertion above passing
    /// against nothing. The emitter is a build step, so a fixture can go missing between a
    /// rename and a regeneration.
    function test_the_fixture_describes_a_real_market() public view {
        for (uint256 i = 0; i < 2; i++) {
            string memory journey = _journey(i == 0 ? "tiered" : "native");
            AgenRuleLib.Config memory config = _configOf(journey);

            assertGt(config.referenceSupply, 0, "a supply of nothing");
            assertGt(config.stages.length, 0, "no stages, so no rate at all");
            assertGt(config.distribution.length, 0, "nobody receives the fee");
            assertTrue(journey.readBytes32(".configHash") != bytes32(0), "an empty commitment");

            // And that the prompt it came from is still attached, so a failure names the
            // market a person would recognise rather than a file.
            assertGt(bytes(journey.readString(".prompt")).length, 0, "the journey lost its prompt");
        }
    }
}
