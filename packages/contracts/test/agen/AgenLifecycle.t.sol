// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";

import {AgenCurve} from "../../src/agen/AgenCurve.sol";
import {AgenDeployer} from "../../src/agen/AgenDeployer.sol";
import {AgenFactory} from "../../src/agen/AgenFactory.sol";
import {AgenMarketRegistry} from "../../src/agen/AgenMarketRegistry.sol";
import {AgenPositionLocker} from "../../src/agen/AgenPositionLocker.sol";
import {AgenRouter} from "../../src/agen/AgenRouter.sol";
import {HookMiner} from "../utils/HookMiner.sol";

import {GeneratedToken} from "./fixtures/GeneratedToken.sol";
import {PulseStreakHook, SellFeeHook} from "./fixtures/RoutedHooks.sol";

/// @title The whole life of an Agen market, one transaction at a time
///
/// @notice Launch, the creator's optional opening buy, a stranger's buy, that stranger's
/// sell — driven through the contracts that actually do it in production, in the order
/// they actually happen.
///
/// @dev The other Agen suites each prove one joint. `AgenLaunch` proves the curve is the
/// shape it was designed to be; `AgenRouter` proves a hook can be told who is trading and
/// cannot be lied to. Neither proves that a market comes out of the factory in a state
/// the router can then trade, which is the seam the product now depends on and the one
/// nothing was watching.
///
/// It matters because the two halves were built weeks apart against different fixtures.
/// The factory mints three one-sided positions and hands back a pool whose price sits at
/// the top of the opening band; the router assumes it can buy from that pool as an
/// ordinary trader. Every assertion here is against state written by one of those two
/// contracts and read back from the other.
///
/// ## The launch buys nothing
///
/// `devBuyAmount` is zero in every manifest below, and that is the point rather than a
/// simplification. The creator's opening buy used to happen inside `deployMarket`, as a
/// swap the factory made on their behalf, which is why it was refused on every market
/// whose hook cared who was trading — the factory was the caller. It is now a second
/// transaction through the router, so `test_step1` asserts the creator holds nothing when
/// the launch returns, and `test_step2` is the buy.
contract AgenLifecycleTest is Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 internal constant FEE_FLAGS =
        uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);

    PositionManager internal posm;
    AgenDeployer internal agenDeployer;
    AgenMarketRegistry internal registry;
    AgenFactory internal factory;
    AgenRouter internal router;

    address internal creator = makeAddr("creator");
    address internal walletB = makeAddr("wallet B");
    address internal feeReceiver = makeAddr("fee receiver");

    uint256 internal constant SUPPLY = 1_000_000_000e18;

    /// @dev Agen's standardised opening: a billion tokens at 1.5 ether.
    int24 internal constant INITIAL_TICK = 203_200;

    /// @dev A tenth of the opening valuation, which every band can serve comfortably.
    uint128 internal constant TRADE = 0.15 ether;

    /// @dev What one launch produced, read back from the registry rather than predicted.
    struct Market {
        address token;
        address hook;
        address locker;
        uint256 firstTokenId;
        PoolKey key;
    }

    function setUp() public {
        deployFreshManagerAndRouters();

        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        agenDeployer = new AgenDeployer(predicted);
        registry = new AgenMarketRegistry(predicted);
        factory = new AgenFactory(manager, posm, agenDeployer, registry);
        assertEq(address(factory), predicted, "factory address prediction");

        // Deployed here rather than by the factory, because that is where it lives: one
        // per chain, named by generated hooks, and unknown to the factory entirely.
        router = new AgenRouter(manager);

        vm.deal(creator, 100 ether);
        vm.deal(walletB, 100 ether);
    }

    // --- launching, the way production launches --------------------------------

    /// @dev One market, through `AgenFactory.deployMarket`, from a manifest of the shape
    /// the compiler assembles. `hookArgs` is what makes this reusable across the two kinds
    /// of market: a hook that needs the router takes it here, exactly as the deployment
    /// environment would supply it.
    function _launch(bytes memory hookInitCode, string memory label)
        internal
        returns (Market memory market)
    {
        bytes memory tokenInitCode = abi.encodePacked(
            type(GeneratedToken).creationCode, abi.encode(label, label, SUPPLY, address(factory))
        );

        bytes32 tokenSalt = keccak256(bytes(label));
        (address hookAt, bytes32 hookSalt) =
            HookMiner.findFromInitcode(address(agenDeployer), FEE_FLAGS, hookInitCode);

        AgenFactory.Component[] memory components = new AgenFactory.Component[](2);
        components[0] = AgenFactory.Component({
            salt: tokenSalt,
            expected: agenDeployer.computeAddress(tokenSalt, keccak256(tokenInitCode)),
            role: registry.ROLE_TOKEN(),
            initCode: tokenInitCode
        });
        components[1] = AgenFactory.Component({
            salt: hookSalt, expected: hookAt, role: registry.ROLE_HOOK(), initCode: hookInitCode
        });

        AgenFactory.Manifest memory manifest = AgenFactory.Manifest({
            specificationHash: keccak256(abi.encodePacked(label, " specification")),
            implementationHash: keccak256(abi.encodePacked(label, " implementation")),
            metadataURI: "ipfs://lifecycle",
            quoteAsset: address(0),
            lpFee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            initialTick: INITIAL_TICK,
            feeReceiver: feeReceiver,
            // Zero, always. The opening buy is `_buy` below, through the router.
            devBuyAmount: 0,
            devBuyMinTokens: 0,
            hookIndex: 1,
            tokenIndex: 0,
            components: components,
            wiring: new AgenFactory.WiringCall[](0)
        });

        // No value: a launch that buys nothing sends nothing.
        vm.prank(creator);
        uint256 index = factory.deployMarket(manifest);

        AgenMarketRegistry.Market memory recorded = registry.marketAt(index);
        AgenMarketRegistry.Component[] memory placed = registry.componentsAt(index);

        market.token = recorded.token;
        market.hook = recorded.hook;
        market.locker = placed[placed.length - 1].addr;
        market.firstTokenId = AgenPositionLocker(market.locker).firstTokenId();
        market.key = factory.poolKeyFor(address(0), recorded.token, LPFeeLibrary.DYNAMIC_FEE_FLAG, recorded.hook);
    }

    function _simple() internal returns (Market memory) {
        return _launch(
            abi.encodePacked(type(SellFeeHook).creationCode, abi.encode(address(manager), feeReceiver)),
            "SIMPLE"
        );
    }

    function _pulse() internal returns (Market memory) {
        return _launch(
            abi.encodePacked(type(PulseStreakHook).creationCode, abi.encode(address(manager), address(router))),
            "PULSE"
        );
    }

    // --- trading, the way production trades ------------------------------------

    function _buy(Market memory market, address who, uint128 amount) internal returns (uint256 out) {
        vm.prank(who);
        out = router.swap{value: amount}(market.key, true, amount, 0, "");
    }

    /// @dev A sell needs one allowance, to the router, and nothing else. Permit2 is not
    /// in this path: the router pulls the token straight from the seller to the pool
    /// manager and never holds it.
    function _sell(Market memory market, address who, uint256 amount) internal returns (uint256 out) {
        vm.prank(who);
        IERC20(market.token).approve(address(router), amount);

        vm.prank(who);
        out = router.swap(market.key, false, uint128(amount), 0, "");
    }

    function _tick(Market memory market) internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(market.key.toId());
    }

    // --- step 1: the launch -----------------------------------------------------

    function test_step1_launchProducesATradableMarketAndNoTrade() public {
        Market memory market = _pulse();

        assertGt(market.token.code.length, 0, "no token was deployed");
        assertGt(market.hook.code.length, 0, "no hook was deployed");
        assertEq(IERC20(market.token).totalSupply(), SUPPLY, "the token does not hold the supply");

        // Initialised, and at the tick the manifest asked for rather than near it.
        assertEq(_tick(market), INITIAL_TICK, "the pool did not open at the standard tick");

        // Three bands, each with liquidity, each held by the locker and not by a wallet.
        for (uint256 i = 0; i < AgenCurve.BANDS; i++) {
            assertGt(posm.getPositionLiquidity(market.firstTokenId + i), 0, "a band has no liquidity");
            assertEq(
                IERC721(address(posm)).ownerOf(market.firstTokenId + i),
                market.locker,
                "the locker does not own the position"
            );
        }

        assertEq(registry.count(), 1, "the market was not registered");
        assertEq(registry.marketAt(0).creator, creator, "the registry recorded a different creator");

        // Nothing was bought, which is the whole reason the opening buy is a second
        // transaction. The hook is the witness rather than a balance: it is told about
        // every swap, so a market that recorded no trade had no trade.
        assertEq(PulseStreakHook(payable(market.hook)).streakOf(creator), 0, "the creator was recorded as trading");
        assertEq(
            PulseStreakHook(payable(market.hook)).streakOf(address(factory)),
            0,
            "the factory was recorded as trading"
        );
        assertEq(address(manager).balance, 0, "the pool opened holding ether");

        // The creator does hold something, and it is not a trade: converting an amount
        // of token into a whole number of units of liquidity leaves a remainder, and
        // `AgenFactory._lockLiquidity` sends it to them because it has to go somewhere
        // and every other candidate did not launch this market. It is dust in the literal
        // sense — a ten-thousandth of one token against a supply of a billion — so this
        // bounds it rather than naming it, and the bound is what would fail if a real
        // allocation ever ended up here.
        uint256 held = IERC20(market.token).balanceOf(creator);
        assertLt(held, 1e18, "the creator was given more than rounding dust");
        assertEq(
            IERC20(market.token).balanceOf(address(manager)), SUPPLY - held, "the rest of the supply is not in the pool"
        );
    }

    // --- step 2: the creator's opening buy --------------------------------------

    function test_step2_openingBuyIsAnOrdinaryTradeByTheCreator() public {
        Market memory market = _pulse();
        PulseStreakHook hook = PulseStreakHook(payable(market.hook));

        // The launch's rounding dust, which is theirs before they trade. See `test_step1`.
        uint256 dust = IERC20(market.token).balanceOf(creator);
        uint256 spent = creator.balance;

        uint256 received = _buy(market, creator, TRADE);

        assertGt(received, 0, "the opening buy bought nothing");
        assertEq(
            IERC20(market.token).balanceOf(creator), dust + received, "the tokens did not reach the creator"
        );
        assertEq(creator.balance, spent - TRADE, "the creator spent something other than the amount");

        // The ether is in the v4 pool, not in the router and not in the factory.
        assertEq(address(manager).balance, TRADE - hook.collected(), "the ether did not reach the pool");
        assertEq(address(router).balance, 0, "the router kept ether");
        assertEq(address(factory).balance, 0, "the factory was involved");

        // The price moved off the opening tick, in the direction a buy moves it: an Agen
        // pool is priced token-per-ether, so it falls as the token gets dearer.
        assertLt(_tick(market), INITIAL_TICK, "a buy did not move the price");

        // The state that only exists because the hook was told who was trading.
        assertEq(hook.streakOf(creator), 1, "the creator's streak did not start");
        assertEq(hook.streakOf(address(router)), 0, "the router was credited as the trader");
        assertEq(hook.streakOf(address(factory)), 0, "the factory was credited as the trader");
    }

    // --- a stranger buys, and sells ---------------------------------------------

    function test_walletB_buysWithoutDisturbingTheCreator() public {
        Market memory market = _pulse();
        PulseStreakHook hook = PulseStreakHook(payable(market.hook));

        _buy(market, creator, TRADE);
        int24 afterCreator = _tick(market);

        uint256 received = _buy(market, walletB, TRADE);

        assertGt(received, 0, "wallet B bought nothing");
        assertEq(IERC20(market.token).balanceOf(walletB), received, "wallet B did not receive tokens");
        assertLt(_tick(market), afterCreator, "the second buy did not move the price");

        // Two wallets, two streaks. On a route that reported the router these would be
        // one streak of two, and the market would be a different market.
        assertEq(hook.streakOf(creator), 1, "the creator's streak changed");
        assertEq(hook.streakOf(walletB), 1, "wallet B's streak did not start");
    }

    function test_walletB_sellsThroughOneApproval() public {
        Market memory market = _pulse();
        PulseStreakHook hook = PulseStreakHook(payable(market.hook));

        _buy(market, creator, TRADE);
        uint256 bought = _buy(market, walletB, TRADE);

        uint256 before = walletB.balance;
        uint256 proceeds = _sell(market, walletB, bought / 2);

        assertGt(proceeds, 0, "the sell returned nothing");
        assertEq(walletB.balance, before + proceeds, "the proceeds did not reach the seller");
        assertEq(IERC20(market.token).balanceOf(walletB), bought - bought / 2, "the wrong amount left the seller");

        // The seller's own streak reset and nobody else's did.
        assertEq(hook.streakOf(walletB), 0, "the seller's streak survived their sell");
        assertEq(hook.streakOf(creator), 1, "somebody else's sell reset the creator");

        // Nothing is left behind. A router holding a balance between transactions is a
        // router with a withdrawal problem.
        assertEq(address(router).balance, 0, "the router kept ether");
        assertEq(IERC20(market.token).balanceOf(address(router)), 0, "the router kept tokens");
        assertEq(
            IERC20(market.token).allowance(walletB, address(router)),
            0,
            "the allowance was not spent exactly"
        );
    }

    // --- the simple market, which never mentions the router ----------------------

    function test_simple_tradesImmediatelyWithNoOpeningBuy() public {
        Market memory market = _simple();
        SellFeeHook hook = SellFeeHook(market.hook);

        // No second transaction. The market is tradable the moment the launch returns.
        assertEq(registry.count(), 1, "the market was not registered");
        assertEq(_tick(market), INITIAL_TICK, "the pool did not open at the standard tick");

        uint256 bought = _buy(market, walletB, TRADE);
        assertGt(bought, 0, "a public buy failed on a freshly launched market");
        assertEq(hook.collected(), 0, "a buy paid a sell fee");
    }

    function test_simple_chargesOnePercentOfASellToTheReceiver() public {
        Market memory market = _simple();
        SellFeeHook hook = SellFeeHook(market.hook);

        uint256 bought = _buy(market, walletB, TRADE);
        uint256 selling = bought / 2;

        uint256 receiverBefore = IERC20(market.token).balanceOf(feeReceiver);
        _sell(market, walletB, selling);

        // A sell spends the token, so the fee is taken in the token.
        uint256 fee = IERC20(market.token).balanceOf(feeReceiver) - receiverBefore;

        assertEq(fee, (selling * hook.SELL_FEE_PPM()) / 1_000_000, "the fee was not one percent of the sell");
        assertEq(hook.collected(), fee, "the hook's ledger disagrees with what arrived");
        assertEq(IERC20(market.token).balanceOf(address(hook)), 0, "the hook held the fee");
    }

    // --- the optional buy fails, and the market does not ------------------------

    /// @dev The failure this whole two-transaction shape has to survive.
    ///
    /// A creator signs the launch, it lands, and the opening buy then fails — they
    /// decline it, or it slips, or their wallet drops it. The market is already created
    /// and permanent at that point, so the only wrong outcome is an interface treating
    /// the pair as one thing that failed. This asserts the market is untouched by it and
    /// still trades for everybody, including for the creator on a second attempt.
    function test_aFailedOpeningBuyLeavesTheMarketLaunched() public {
        Market memory market = _pulse();
        PulseStreakHook hook = PulseStreakHook(payable(market.hook));

        uint256 dust = IERC20(market.token).balanceOf(creator);

        // Fails on the trader's own floor, which is the realistic shape: the router
        // reverts before anything is paid out.
        vm.prank(creator);
        vm.expectRevert();
        router.swap{value: TRADE}(market.key, true, TRADE, type(uint128).max, "");

        // Every one of these was true before the failed buy and is still true after it.
        assertEq(registry.count(), 1, "the market fell out of the registry");
        assertEq(registry.marketAt(0).creator, creator, "the registry lost the creator");
        assertEq(_tick(market), INITIAL_TICK, "the failed buy moved the price");
        assertEq(IERC20(market.token).balanceOf(creator), dust, "a reverted buy delivered tokens");
        assertEq(creator.balance, 100 ether, "a reverted buy spent ether");

        for (uint256 i = 0; i < AgenCurve.BANDS; i++) {
            assertGt(posm.getPositionLiquidity(market.firstTokenId + i), 0, "a band lost its liquidity");
        }

        // And it still trades — for a stranger, and for the creator on a second attempt.
        assertGt(_buy(market, walletB, TRADE), 0, "the market stopped trading for the public");
        assertGt(_buy(market, creator, TRADE), 0, "the market stopped trading for the creator");
        assertEq(hook.streakOf(creator), 1, "the creator's retry was not attributed to them");
    }
}
