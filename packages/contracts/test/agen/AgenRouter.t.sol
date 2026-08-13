// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgenHookData} from "../../src/agen/AgenHookData.sol";
import {AgenRouted} from "../../src/agen/AgenRouted.sol";
import {AgenRouter} from "../../src/agen/AgenRouter.sol";
import {VerdantConstants} from "../../src/libraries/VerdantConstants.sol";
import {HookMiner} from "../utils/HookMiner.sol";

import {BasicFeeHook, PulseStreakHook, RouterAuthHook, TraderIdentityHook} from "./fixtures/RoutedHooks.sol";
import {GeneratedToken} from "./fixtures/GeneratedToken.sol";

/// @title Trading an Agen market as the person who is actually trading
///
/// @notice Four markets, standing for the four kinds Agen produces, each driven through
/// real swaps against a real PoolManager.
///
/// The thing being proved is narrow and was the launch blocker: a generated hook can know
/// which wallet is trading, and cannot be lied to about it. Everything else here exists to
/// make that claim mean something — a hook that reads an identity nobody checked is a
/// faucet, and a router that reports the truth to a hook that never asks is decoration.
///
/// Every assertion is against state the hook wrote during a swap, or against balances.
/// None is against an event: an event proves what a contract said, and the failure this
/// suite is guarding against is a market that says the right thing while crediting the
/// router.
contract AgenRouterTest is Deployers {
    /// @dev What each fixture declares. A hook's address is its permission set, so these
    /// are mined rather than chosen, and a mismatch means v4 silently never calls it.
    uint160 internal constant FEE_FLAGS =
        uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
    uint160 internal constant PLAIN_FLAGS = uint160(Hooks.BEFORE_SWAP_FLAG);

    AgenRouter internal router;
    GeneratedToken internal token;

    BasicFeeHook internal basic;
    RouterAuthHook internal authed;
    TraderIdentityHook internal identity;
    PulseStreakHook internal pulse;

    PoolKey internal basicKey;
    PoolKey internal authedKey;
    PoolKey internal identityKey;
    PoolKey internal pulseKey;

    address internal walletA = makeAddr("walletA");
    address internal walletB = makeAddr("walletB");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    /// @dev One trade, small enough that several fit inside the band without exhausting
    /// it — so an assertion about what a trade spent measures the trade and not the pool.
    uint256 internal constant TRADE = 0.1 ether;
    /// @dev 1.5 ether across a billion tokens, which is Agen's standardised opening.
    int24 internal constant INITIAL_TICK = 203_200;

    function setUp() public {
        deployFreshManagerAndRouters();

        router = new AgenRouter(manager);
        token = new GeneratedToken("Pulse", "PULSE", SUPPLY, address(this));

        basic = BasicFeeHook(payable(_mineAndDeploy("basic", FEE_FLAGS)));
        authed = RouterAuthHook(_mineAndDeploy("authed", PLAIN_FLAGS));
        identity = TraderIdentityHook(_mineAndDeploy("identity", PLAIN_FLAGS));
        pulse = PulseStreakHook(payable(_mineAndDeploy("pulse", FEE_FLAGS)));

        // Before the pools: a position whose lower bound is the current tick needs a
        // little of currency0 as well as the token, and this contract mints it.
        vm.deal(walletA, 1_000 ether);
        vm.deal(walletB, 1_000 ether);
        vm.deal(attacker, 1_000 ether);
        vm.deal(address(this), 10_000 ether);

        basicKey = _openPool(address(basic));
        authedKey = _openPool(address(authed));
        identityKey = _openPool(address(identity));
        pulseKey = _openPool(address(pulse));
    }

    // --- setting up a market --------------------------------------------------

    function _mineAndDeploy(string memory which, uint160 flags) internal returns (address at) {
        bytes memory initcode = _initcodeFor(which);
        (address mined, bytes32 salt) = HookMiner.findFromInitcode(address(this), flags, initcode);

        // solhint-disable-next-line no-inline-assembly
        assembly {
            at := create2(0, add(initcode, 0x20), mload(initcode), salt)
        }

        require(at == mined, "hook landed elsewhere");
    }

    function _initcodeFor(string memory which) internal view returns (bytes memory) {
        bytes32 tag = keccak256(bytes(which));

        if (tag == keccak256("basic")) {
            return abi.encodePacked(type(BasicFeeHook).creationCode, abi.encode(manager));
        }
        if (tag == keccak256("authed")) {
            return abi.encodePacked(type(RouterAuthHook).creationCode, abi.encode(manager, address(router)));
        }
        if (tag == keccak256("identity")) {
            return abi.encodePacked(type(TraderIdentityHook).creationCode, abi.encode(manager, address(router)));
        }
        return abi.encodePacked(type(PulseStreakHook).creationCode, abi.encode(manager, address(router)));
    }

    /// @dev An Agen pool: ether as currency0, the token as currency1, dynamic fee, opened
    /// at the standardised tick with one-sided token liquidity above it.
    function _openPool(address hook) internal returns (PoolKey memory key) {
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(hook)
        });

        manager.initialize(key, TickMath.getSqrtPriceAtTick(INITIAL_TICK));

        token.approve(address(modifyLiquidityRouter), type(uint256).max);

        // The band sits below the opening tick and the pool opens at the top of it.
        //
        // A v4 price is currency1 per currency0 — token per ether — so it *falls* as the
        // token gets dearer, and a buy is `zeroForOne`. Liquidity for buyers therefore
        // lies below the opening tick, and a position entirely below the current price is
        // composed entirely of currency1. That is what makes an Agen launch need no
        // paired asset: the band is pure token, and the first ether into the market is a
        // buyer's.
        //
        // It is also the condition a hook that takes ether mid-swap is hardest on — the
        // manager holds none until the router settles — which is why every fee assertion
        // below is meaningful rather than incidental.
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: INITIAL_TICK - 18_000,
                tickUpper: INITIAL_TICK,
                // Deep enough that the trades below are absorbed whole — a band that runs
                // out mid-test refunds the remainder, which is correct behaviour and
                // would make every "spent exactly" assertion measure the band instead.
                // Bounded above by the supply: four pools share one token, so this is
                // about 1.5e26 each against a total of 1e27.
                liquidityDelta: 1e22,
                salt: bytes32(0)
            }),
            ""
        );
    }

    // --- driving trades -------------------------------------------------------

    /// @dev A buy through Agen, as `who`.
    function _buy(PoolKey memory key, address who, uint256 amount) internal returns (uint256 out) {
        vm.prank(who);
        out = router.swap{value: amount}(key, true, uint128(amount), 0, "");
    }

    /// @dev A sell through Agen, as `who`. The router pulls the token from them.
    function _sell(PoolKey memory key, address who, uint256 amount) internal returns (uint256 out) {
        vm.prank(who);
        token.approve(address(router), amount);

        vm.prank(who);
        out = router.swap(key, false, uint128(amount), 0, "");
    }

    /// @dev A swap the way anything that is not Agen would make it: a plain router, no
    /// hook data, the hook told only that a router called.
    function _plainBuy(PoolKey memory key, uint256 amount, bytes memory hookData) internal {
        swapRouter.swap{value: amount}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
    }

    // --- A: the market that does not care who is trading ----------------------

    function test_A_basicMarketTradesThroughAgen() public {
        uint256 before = walletB.balance;
        uint256 out = _buy(basicKey, walletB, TRADE);

        assertGt(out, 0, "bought nothing");
        assertEq(token.balanceOf(walletB), out, "tokens did not reach the trader");
        assertEq(walletB.balance, before - TRADE, "spent something other than the amount");
        assertEq(basic.collected(), TRADE / 100, "the 1% fee was not taken");
    }

    /// @dev The compatibility requirement, and the reason `_traderOr` exists.
    ///
    /// A market generated before this router existed must not have been broken by it, so
    /// this drives one through the plain route the Universal Router uses. The hook here
    /// is the identity one rather than the fee one, and the distinction is worth stating
    /// because it is not about identity at all: a hook that *takes* value during
    /// `beforeSwap` cannot work on a route that settles afterwards, since the manager is
    /// holding no ether at the moment the hook reaches for it. That is a property of the
    /// old route and of one-sided launch liquidity, it predates this work, and it is one
    /// of the reasons `AgenRouter` settles first.
    function test_A_marketWithoutCustodyStillTradesTheOldWay() public {
        _plainBuy(identityKey, TRADE, "");

        assertEq(identity.lastSender(), address(swapRouter), "the old route stopped working");
    }

    function test_A_sellingBackThroughAgen() public {
        uint256 bought = _buy(basicKey, walletB, TRADE);

        uint256 etherBefore = walletB.balance;
        uint256 returned = _sell(basicKey, walletB, bought / 2);

        assertGt(returned, 0, "sold for nothing");
        assertEq(walletB.balance, etherBefore + returned, "proceeds did not reach the seller");
        assertEq(token.balanceOf(walletB), bought - bought / 2, "the wrong amount left the seller");
    }

    // --- B: the market that authenticates the route ---------------------------

    function test_B_authenticatedMarketAcceptsAgen() public {
        _buy(authedKey, walletB, TRADE);

        assertEq(authed.lastTrader(), walletB, "the hook did not see the trader");
        assertEq(authed.tradesBy(walletB), 1, "the trade was attributed elsewhere");
        assertEq(authed.tradesBy(address(router)), 0, "the router was credited as a trader");
    }

    function test_B_authenticatedMarketRefusesEverythingElse() public {
        vm.expectRevert();
        _plainBuy(authedKey, TRADE, "");
    }

    /// @dev The hook must not be satisfied by data that merely looks right. This is the
    /// spoof: a well-formed identity claiming to be somebody else, sent through a route
    /// that is not Agen.
    function test_B_cannotBeSpoofedByForgedHookData() public {
        vm.expectRevert();
        _plainBuy(authedKey, TRADE, AgenHookData.encode(walletB, ""));

        assertEq(authed.tradesBy(walletB), 0, "a forged trade was attributed");
    }

    // --- C: the market that reads the trader ----------------------------------

    function test_C_readsTheTraderRatherThanTheCaller() public {
        _buy(identityKey, walletA, TRADE);
        _buy(identityKey, walletB, TRADE);
        _buy(identityKey, walletB, TRADE);

        assertEq(identity.buysBy(walletA), 1, "wallet A miscounted");
        assertEq(identity.buysBy(walletB), 2, "wallet B miscounted");
        assertEq(identity.buysBy(address(router)), 0, "the router accumulated a history");

        // The distinction the whole contract is for: the caller was the router and the
        // trader was not.
        assertEq(identity.lastSender(), address(router), "the sender was not the router");
        assertEq(identity.lastTrader(), walletB, "the trader was not read");
    }

    /// @dev A permissive market keeps trading off-route, and attributes those trades to
    /// the caller — which is the honest answer, since no identity was supplied.
    function test_C_stillTradesWithoutAnIdentity() public {
        _plainBuy(identityKey, TRADE, "");

        assertEq(identity.lastTrader(), address(swapRouter), "attributed to somebody who was not there");
        assertEq(identity.buysBy(walletB), 0, "credited a wallet that did not trade");
    }

    /// @dev Forged data on a non-Agen route must be ignored rather than believed. The
    /// hook is permissive, so this does not revert — it simply does not credit the
    /// address the attacker named.
    function test_C_ignoresForgedIdentityFromAnotherRoute() public {
        _plainBuy(identityKey, TRADE, AgenHookData.encode(walletA, ""));

        assertEq(identity.buysBy(walletA), 0, "a forged identity was believed");
        assertEq(identity.lastTrader(), address(swapRouter), "the caller was not used as the fallback");
    }

    // --- D: PULSE, which is only correct with per-wallet identity -------------

    function test_D_streaksAreCountedPerWallet() public {
        _buy(pulseKey, walletA, TRADE);
        _buy(pulseKey, walletA, TRADE);

        // Two wallets, two streaks. On a route that reported the router these would be
        // one streak and this buy would win.
        _buy(pulseKey, walletB, TRADE);

        assertEq(pulse.freeTradesOf(walletA), 0, "wallet A won early");
        assertEq(pulse.freeTradesOf(walletB), 0, "wallet B inherited a streak");
        assertEq(pulse.streakOf(walletA), 2, "wallet A's streak was lost");
        assertEq(pulse.streakOf(walletB), 1, "wallet B's streak did not start");
    }

    function test_D_thirdConsecutiveBuyIsFree() public {
        _buy(pulseKey, walletB, TRADE);
        _buy(pulseKey, walletB, TRADE);

        uint256 collectedBefore = pulse.collected();
        _buy(pulseKey, walletB, TRADE);

        assertEq(pulse.freeTradesOf(walletB), 1, "the third buy was not free");
        assertEq(pulse.collected(), collectedBefore, "a fee was charged on the free trade");
        assertEq(pulse.streakOf(walletB), 0, "the streak did not reset after winning");
    }

    function test_D_aSellResetsOnlyTheSellersStreak() public {
        _buy(pulseKey, walletA, TRADE);
        _buy(pulseKey, walletA, TRADE);
        uint256 bought = _buy(pulseKey, walletB, TRADE);

        _sell(pulseKey, walletB, bought / 2);

        assertEq(pulse.streakOf(walletB), 0, "the seller's streak survived");
        assertEq(pulse.streakOf(walletA), 2, "somebody else's sell reset wallet A");
    }

    function test_D_refusesAnUnroutedTrade() public {
        vm.expectRevert();
        _plainBuy(pulseKey, TRADE, AgenHookData.encode(walletB, ""));

        assertEq(pulse.streakOf(walletB), 0, "a forged trade advanced a streak");
    }

    // --- the router itself ----------------------------------------------------

    function test_routerHoldsNothingBetweenTrades() public {
        _buy(basicKey, walletB, TRADE);

        assertEq(address(router).balance, 0, "the router kept ether");
        assertEq(token.balanceOf(address(router)), 0, "the router kept tokens");
    }

    function test_routerRefusesMismatchedValue() public {
        vm.prank(walletB);
        vm.expectRevert(abi.encodeWithSelector(AgenRouter.WrongValue.selector, 0.5 ether, 1 ether));
        router.swap{value: 0.5 ether}(basicKey, true, 1 ether, 0, "");
    }

    function test_routerEnforcesTheTradersFloor() public {
        vm.prank(walletB);
        vm.expectRevert();
        router.swap{value: 1 ether}(basicKey, true, 1 ether, type(uint128).max, "");
    }

    function test_routerCannotBeCalledBackDirectly() public {
        vm.expectRevert(abi.encodeWithSelector(AgenRouter.NotPoolManager.selector, address(this)));
        router.unlockCallback("");
    }

    // --- the encoding ---------------------------------------------------------

    function test_hookDataRoundTrips() public view {
        bytes memory encoded = AgenHookData.encode(address(0xBEEF), hex"1234");
        (bool ok, address trader, bytes memory extra) = _decode(encoded);

        assertTrue(ok, "did not decode");
        assertEq(trader, address(0xBEEF), "wrong trader");
        assertEq(extra, hex"1234", "wrong extra");
    }

    function test_hookDataDeclinesAnythingElse() public view {
        // An ordinary swap's empty bytes, a truncated header, an unknown version, and an
        // identity of nobody. None of these may revert: they are all just trades that
        // carry no Agen identity.
        (bool empty,,) = _decode("");
        (bool short_,,) = _decode(hex"01aabb");
        (bool wrongVersion,,) = _decode(abi.encodePacked(uint8(9), address(0xBEEF)));
        (bool zero,,) = _decode(abi.encodePacked(uint8(1), address(0)));

        assertFalse(empty, "empty decoded");
        assertFalse(short_, "a truncated header decoded");
        assertFalse(wrongVersion, "a future version decoded");
        assertFalse(zero, "the zero address decoded");
    }

    /// @dev `decode` takes calldata, so it is reached through an external call.
    function decodeExternal(bytes calldata data)
        external
        pure
        returns (bool ok, address trader, bytes memory extra)
    {
        (bool decoded, address who, bytes calldata rest) = AgenHookData.decode(data);
        return (decoded, who, rest);
    }

    function _decode(bytes memory data) private view returns (bool, address, bytes memory) {
        return AgenRouterTest(payable(address(this))).decodeExternal(data);
    }
}
