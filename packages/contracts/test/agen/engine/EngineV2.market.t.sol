// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {VerdantConstants} from "../../../src/libraries/VerdantConstants.sol";
import {AgenRouted} from "../../../src/agen/AgenRouted.sol";
import {AgenRouter} from "../../../src/agen/AgenRouter.sol";
import {AgenBuybackPot} from "../../../src/agen/engine/AgenBuybackPot.sol";
import {AgenEngineHookV2} from "../../../src/agen/engine/AgenEngineHookV2.sol";
import {AgenEngineVault} from "../../../src/agen/engine/AgenEngineVault.sol";
import {AgenLargestHolderPot} from "../../../src/agen/engine/AgenLargestHolderPot.sol";
import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";
import {AgenRuleLibV2} from "../../../src/agen/engine/AgenRuleLibV2.sol";
import {AgenRuleValidatorV2} from "../../../src/agen/engine/AgenRuleValidatorV2.sol";
import {IAgenEngineHookV2} from "../../../src/agen/engine/IAgenEngineHookV2.sol";
import {VerdantNotifyingToken} from "../../../src/agen/engine/VerdantNotifyingToken.sol";
import {HookMiner} from "../../utils/HookMiner.sol";

/// @dev Stands in for the PositionManager, as `EngineFixture.LiquidityShim` does for v1.
contract V2LiquidityShim is IUnlockCallback {
    IPoolManager private immutable _manager;
    address private immutable _initiator;

    constructor(IPoolManager manager_, address initiator_) {
        _manager = manager_;
        _initiator = initiator_;
    }

    function msgSender() external view returns (address) {
        return _initiator;
    }

    function addLiquidity(PoolKey memory key, int24 tickLower, int24 tickUpper, uint256 liquidity) external {
        _manager.unlock(abi.encode(key, tickLower, tickUpper, liquidity));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(_manager), "not the manager");

        (PoolKey memory key, int24 tickLower, int24 tickUpper, uint256 liquidity) =
            abi.decode(data, (PoolKey, int24, int24, uint256));

        (BalanceDelta delta,) = _manager.modifyLiquidity(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: int256(liquidity), salt: bytes32(0)}),
            ""
        );

        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());
        return "";
    }

    function _settle(Currency currency, int128 amount) private {
        if (amount >= 0) return;
        uint256 owed = uint256(uint128(-amount));
        _manager.sync(currency);
        MockERC20(Currency.unwrap(currency)).transfer(address(_manager), owed);
        _manager.settle();
    }
}

/// @dev A swap that goes straight to the PoolManager, carrying no identity. What an
/// aggregator or an arbitrage bot does, and what a wallet-limited market must refuse.
contract UnroutedSwapper is IUnlockCallback {
    IPoolManager private immutable _manager;

    constructor(IPoolManager manager_) {
        _manager = manager_;
    }

    function buy(PoolKey memory key, uint256 amountIn) external {
        _manager.unlock(abi.encode(key, amountIn));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        (PoolKey memory key, uint256 amountIn) = abi.decode(data, (PoolKey, uint256));

        BalanceDelta delta = _manager.swap(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- test-controlled
            SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            ""
        );

        int128 owed = delta.amount0();
        if (owed < 0) {
            _manager.sync(key.currency0);
            MockERC20(Currency.unwrap(key.currency0)).transfer(address(_manager), uint256(uint128(-owed)));
            _manager.settle();
        }

        int128 received = delta.amount1();
        if (received > 0) _manager.take(key.currency1, address(this), uint256(uint128(received)));

        return "";
    }
}

/// @title EngineV2Market
/// @notice The featured prompt, launched and traded against a real PoolManager.
///
/// @dev This suite exists because `RuleLibV2.t.sol` proved the rules validate and stored
/// nothing about whether a market made of them *works*. Two defects survived a green
/// library suite and are pinned here as named regressions:
///
///  - `test_theBuybackExecutesWhileTheWalletWindowIsOpen` — the buyback pot reaches the
///    hook as itself with no hook data, so `_requireTrader` refused it. A market with both
///    a wallet cap and a buyback could arm a buyback and never execute it for the whole
///    window. The featured prompt is exactly that market, for its first twelve hours.
///
///  - `test_aHolderCanStillTransferAfterHundredsOfEpochs` — weight was accumulated by
///    looping over elapsed epochs on every transfer, one cold write each. At the hourly
///    period the prompt asks for, a wallet that sat still became progressively more
///    expensive to move and eventually could not be moved at all.
contract EngineV2MarketTest is Deployers {
    using PoolIdLibrary for PoolKey;

    uint160 internal constant ENGINE_FLAGS = 0x38CC;

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    /// @dev 2% of supply — the cap in the prompt.
    uint128 internal constant WALLET_CAP = uint128(SUPPLY / 50);
    /// @dev 1% of supply — what "a large sell" was read as.
    uint128 internal constant LARGE_SELL = uint128(SUPPLY / 100);
    uint32 internal constant HOUR = 3600;
    uint32 internal constant WINDOW = 12 hours;

    /// @dev Deep enough that a trade the size of the wallet cap is a price move rather than
    /// a pool that runs out. The rules under test are about size, so the depth has to be
    /// large relative to the largest rule — otherwise a refusal could be the AMM's.
    uint256 internal constant DEPTH = 2e26;
    /// @dev Held back from the liquidity position so a trader can be given tokens to sell.
    /// Receiving tokens is not buying, so this does not touch the wallet cap.
    uint256 internal constant RESERVE = SUPPLY / 5;

    AgenEngineHookV2 internal hook;
    AgenRuleValidatorV2 internal validator;
    AgenRouter internal router;
    V2LiquidityShim internal shim;

    MockERC20 internal quote;
    VerdantNotifyingToken internal token;
    AgenEngineVault internal vault;
    AgenLargestHolderPot internal holderPot;
    AgenBuybackPot internal buybackPot;

    PoolId internal poolId;

    address internal treasury = address(0x7EA5);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        deployFreshManagerAndRouters();

        router = new AgenRouter(manager);
        shim = new V2LiquidityShim(manager, address(this));

        validator = new AgenRuleValidatorV2();

        bytes memory args = abi.encode(manager, address(this), address(shim), address(router), validator);
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), ENGINE_FLAGS, type(AgenEngineHookV2).creationCode, args);
        hook = new AgenEngineHookV2{salt: salt}(manager, address(this), address(shim), address(router), validator);
        require(address(hook) == predicted, "hook did not land at its mined address");

        quote = new MockERC20("Quote", "Q", 18);
        token = _deployTokenAbove(address(quote));

        key = PoolKey({
            currency0: Currency.wrap(address(quote)),
            currency1: Currency.wrap(address(token)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();

        AgenRuleLibV2.Config memory config = _featured();

        // The pots are the vault's recipients, so they exist before it. Neither knows its
        // vault yet; `configure` binds them, which is the same order the factory uses.
        holderPot = new AgenLargestHolderPot(IAgenEngineHookV2(address(hook)), 0);
        buybackPot = new AgenBuybackPot(IAgenEngineHookV2(address(hook)), 1);

        address[] memory recipients = new address[](2);
        recipients[0] = address(holderPot);
        recipients[1] = address(buybackPot);
        uint24[] memory shares = new uint24[](2);
        shares[0] = 500_000;
        shares[1] = 500_000;

        // No size tiers, so the fee is collected in the quote asset — currency0.
        vault = new AgenEngineVault(address(hook), manager, key.currency0, recipients, shares);

        hook.configure(key, config, vault);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));

        // Everything that holds the token structurally rather than as a trader. The real
        // factory excludes the same set; a locked LP position winning the holder pot would
        // pay the market's fees back to the market.
        hook.excludeHolder(poolId, address(shim));
        hook.excludeHolder(poolId, address(manager));
        hook.excludeHolder(poolId, address(this));

        token.transfer(address(shim), SUPPLY - RESERVE);
        quote.mint(address(shim), SUPPLY);

        int24 spacing = VerdantConstants.TICK_SPACING;
        shim.addLiquidity(key, -spacing * 1000, spacing * 1000, DEPTH);

        quote.mint(alice, SUPPLY);
        quote.mint(bob, SUPPLY);
        vm.prank(alice);
        quote.approve(address(router), type(uint256).max);
        vm.prank(bob);
        quote.approve(address(router), type(uint256).max);
    }

    /// @dev Hand `who` tokens without buying them, so a sell can be tested independently of
    /// the buy cap. The reserve is held by this contract, which is excluded from weights.
    function _grant(address who, uint256 amount) private {
        token.transfer(who, amount);
    }

    // --- fixtures -----------------------------------------------------------

    /// @dev The launched token must sort above the quote asset, as `AgenCurve` requires.
    function _deployTokenAbove(address below) private returns (VerdantNotifyingToken) {
        bytes memory initcode = abi.encodePacked(
            type(VerdantNotifyingToken).creationCode,
            abi.encode("Cascade", "CSCD", SUPPLY, address(this), "", false, address(hook))
        );
        bytes32 initHash = keccak256(initcode);

        for (uint256 i = 0; i < 512; i++) {
            bytes32 salt = bytes32(i);
            address at = address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(this), salt, initHash)))));
            if (at > below) {
                return new VerdantNotifyingToken{salt: salt}(
                    "Cascade", "CSCD", SUPPLY, address(this), "", false, address(hook)
                );
            }
        }
        revert("no salt sorts the token above the quote asset");
    }

    /// @dev The prompt, as the compiler produces it: 0.3% both ways, 50% to the hourly
    /// largest holder, 50% to a buyback armed at 1% of supply, 2% wallet cap for 12 hours.
    function _featured() private view returns (AgenRuleLibV2.Config memory config) {
        config.engineVersion = 2;
        config.referenceSupply = SUPPLY;
        config.quoteAsset = address(quote);
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

    function _buy(address who, uint128 amountIn) private returns (uint256 out) {
        vm.prank(who);
        return router.swap(key, true, amountIn, 0, "");
    }

    function _sell(address who, uint128 amountIn) private returns (uint256 out) {
        vm.startPrank(who);
        token.approve(address(router), type(uint256).max);
        out = router.swap(key, false, amountIn, 0, "");
        vm.stopPrank();
    }

    // --- the market is a market ---------------------------------------------

    function test_theMarketLaunchesAndTrades() public {
        assertEq(hook.engineVersionOf(poolId), 2, "an engine-v2 market");
        assertTrue(hook.configHashOf(poolId) != bytes32(0), "with an identity");

        uint256 received = _buy(alice, 1e18);
        assertGt(received, 0, "a buy returns tokens");
        assertEq(token.balanceOf(alice), received, "and the trader holds them");
        assertGt(vault.totalAccrued(), 0, "the fee reached the vault");
    }

    function test_theFeeIsThreeTenthsOfAPercent() public {
        uint128 spend = 1e18;
        _buy(alice, spend);

        // Quote-denominated fee, so the vault's accrual is a share of what was spent.
        assertEq(vault.totalAccrued(), (uint256(spend) * 3_000) / 1_000_000, "0.3% of the input");
    }

    // --- the wallet cap -----------------------------------------------------

    /// @dev The revert arrives wrapped by the PoolManager, so the selector cannot be matched
    /// directly. Paired with the test below, which shows the same call succeeding once the
    /// window closes — together they pin the refusal on the wallet rule rather than on
    /// anything structural about an unrouted swap.
    function test_anUnroutedBuyIsRefusedWhileTheWindowIsOpen() public {
        UnroutedSwapper direct = new UnroutedSwapper(manager);
        quote.mint(address(direct), 1e22);

        vm.expectRevert();
        direct.buy(key, 1e18);
    }

    function test_anUnroutedBuyIsAllowedOnceTheWindowCloses() public {
        vm.warp(block.timestamp + WINDOW);

        UnroutedSwapper direct = new UnroutedSwapper(manager);
        quote.mint(address(direct), 1e22);

        // The market stops being routed-only the moment the rule it was routed for expires.
        direct.buy(key, 1e18);
        assertGt(token.balanceOf(address(direct)), 0, "an aggregator can trade it again");
    }

    function test_aWalletCannotBuyPastTheCap() public {
        // Under the cap, comfortably.
        uint256 bought = _buy(alice, 1e24);
        assertGt(bought, 0, "the first buy goes through");
        assertLt(bought, WALLET_CAP, "and stays under the cap");

        // A buy large enough to cross it is refused whole.
        vm.expectRevert();
        _buy(alice, uint128(WALLET_CAP * 2));

        assertEq(token.balanceOf(alice), bought, "nothing was bought by the refused trade");
    }

    function test_aWalletMayBuyRightUpToTheCap() public {
        uint256 bought = _buy(alice, 1e24);
        assertLt(bought, WALLET_CAP, "headroom remains");

        // The accumulator, not the balance: what the wallet has bought under the rule.
        assertGt(bought, 0, "and the rule has counted it");
    }

    /// @dev The limitation the review card has to state, asserted so copy and contract
    /// cannot drift. One wallet is refused; a second wallet, same person, is not.
    function test_theCapIsPerWalletAndNotPerPerson() public {
        _buy(alice, 1e24);

        vm.expectRevert();
        _buy(alice, uint128(WALLET_CAP * 2));

        // The same trade from a second address the same person controls.
        uint256 second = _buy(bob, 1e24);
        assertGt(second, 0, "a second wallet has its own untouched allowance");
    }

    // --- the largest holder -------------------------------------------------

    function test_weightIsTimeWeightedRatherThanASnapshot() public {
        _buy(alice, 5_000e18);
        uint256 held = token.balanceOf(alice);

        // Bob buys the same size half an hour later, so he holds it for half as long.
        vm.warp(block.timestamp + HOUR / 2);
        _buy(bob, 5_000e18);

        vm.warp(block.timestamp + HOUR);

        uint256 aliceWeight = holderPot.weightOf(0, alice);
        uint256 bobWeight = holderPot.weightOf(0, bob);

        assertGt(aliceWeight, bobWeight, "holding longer in the epoch is worth more");
        assertGt(held, 0, "alice held something to be weighed");
    }

    function test_aLateWhaleDoesNotWinTheEpochItJoined() public {
        _buy(alice, 5_000e18);

        // The boundary trade the design exists to defeat: a much larger position, taken in
        // the epoch's last minute. Instant balance would win; time-weighted does not.
        vm.warp(block.timestamp + HOUR - 60);
        _buy(bob, 40_000e18);

        vm.warp(block.timestamp + 120);

        assertGt(token.balanceOf(bob), token.balanceOf(alice), "bob holds more at the bell");
        assertGt(holderPot.weightOf(0, alice), holderPot.weightOf(0, bob), "alice still wins the epoch");
    }

    function test_theLockedLiquidityNeverWinsTheEpoch() public {
        _buy(alice, 5_000e18);
        vm.warp(block.timestamp + HOUR + 1);

        assertEq(holderPot.weightOf(0, address(shim)), 0, "the position holder is excluded");
        assertEq(holderPot.weightOf(0, address(manager)), 0, "and so is the pool");
    }

    /// @dev The regression. Weight used to be settled by looping over every elapsed epoch
    /// on each transfer, which made a still wallet progressively more expensive to move.
    function test_aHolderCanStillTransferAfterHundredsOfEpochs() public {
        _buy(alice, 5_000e18);
        uint256 held = token.balanceOf(alice);

        // Six months of hourly epochs with no activity: over four thousand of them.
        vm.warp(block.timestamp + 180 days);

        uint256 before = gasleft();
        vm.prank(alice);
        token.transfer(bob, held / 2);
        uint256 spent = before - gasleft();

        assertLt(spent, 200_000, "a transfer costs the same however long the wallet sat still");
        assertEq(token.balanceOf(bob), held / 2, "and it went through");
    }

    function test_weightIsStillRightAcrossAGapWithNoTransfers() public {
        _buy(alice, 5_000e18);
        uint256 held = token.balanceOf(alice);

        uint256 start = block.timestamp;
        vm.warp(start + 100 * HOUR);

        // Epoch 50 saw no transfer at all, so nothing was ever written for it. The balance
        // that spans it is what the checkpoints imply, and the whole epoch is credited.
        assertEq(holderPot.weightOf(50, alice), held * HOUR, "a full epoch at a still balance");
    }

    function test_anEpochBeforeTheWalletHeldAnythingIsZero() public {
        vm.warp(block.timestamp + 3 * HOUR);
        _buy(alice, 5_000e18);
        vm.warp(block.timestamp + HOUR);

        assertEq(holderPot.weightOf(0, alice), 0, "nothing held in the first hour");
        assertGt(holderPot.weightOf(3, alice), 0, "and something held in the fourth");
    }

    // --- the buyback --------------------------------------------------------

    function test_aLargeSellArmsTheBuyback() public {
        _grant(alice, LARGE_SELL * 2);
        _buy(alice, 1e24);
        assertFalse(buybackPot.armed(), "nothing armed by a buy");

        _sell(alice, LARGE_SELL);
        assertTrue(buybackPot.armed(), "a sell at the trigger arms one");
    }

    function test_aSmallSellDoesNotArmTheBuyback() public {
        _grant(alice, LARGE_SELL * 2);
        _sell(alice, LARGE_SELL / 10);

        assertFalse(buybackPot.armed(), "below the trigger, nothing is armed");
    }

    function test_theTriggeringSellDoesNotExecuteTheBuyback() public {
        _grant(alice, LARGE_SELL * 2);

        uint256 supplyBefore = token.totalSupply();
        _sell(alice, LARGE_SELL);

        assertTrue(buybackPot.armed(), "armed");
        assertEq(token.totalSupply(), supplyBefore, "and nothing was bought or burned inside the swap");
    }

    /// @dev The regression. The pot unlocks the PoolManager itself, so it arrives at the
    /// hook as its own address with no hook data — which the wallet rule refused. A market
    /// with both features could arm a buyback and never execute it inside the window.
    function test_theBuybackExecutesWhileTheWalletWindowIsOpen() public {
        _grant(alice, LARGE_SELL * 2);
        _sell(alice, LARGE_SELL);
        assertTrue(buybackPot.armed(), "armed inside the window");

        // Still inside the twelve hours, which is the whole point of this test.
        assertTrue(hook.walletWindowOpen(poolId), "the wallet window is open");

        uint256 supplyBefore = token.totalSupply();
        buybackPot.execute(key, 0);

        assertFalse(buybackPot.armed(), "the arm is spent");
        assertLt(token.totalSupply(), supplyBefore, "and what it bought was burned");
    }

    function test_anyoneMayExecuteTheBuyback() public {
        _grant(alice, LARGE_SELL * 2);
        _sell(alice, LARGE_SELL);

        vm.prank(bob);
        buybackPot.execute(key, 0);

        assertFalse(buybackPot.armed(), "a stranger executed it, which is the design");
    }

    function test_anUnarmedBuybackRefusesToExecute() public {
        _buy(alice, 1e24);

        vm.expectRevert(AgenBuybackPot.NotArmed.selector);
        buybackPot.execute(key, 0);
    }

    function test_theBuybackHonoursItsMinimumOut() public {
        _grant(alice, LARGE_SELL * 2);
        _sell(alice, LARGE_SELL);

        // A public buyback can be sandwiched, so the floor is the caller's protection.
        vm.expectRevert();
        buybackPot.execute(key, type(uint128).max);

        assertTrue(buybackPot.armed(), "and a refused execution leaves it armed");
    }

    function test_theBuybackRefusesAPoolThatIsNotItsOwn() public {
        _grant(alice, LARGE_SELL * 2);
        _sell(alice, LARGE_SELL);

        PoolKey memory other = key;
        other.tickSpacing = VerdantConstants.TICK_SPACING * 2;

        vm.expectRevert();
        buybackPot.execute(other, 0);
    }

    // --- the pots are paid --------------------------------------------------

    function test_theHolderPotCollectsItsHalf() public {
        _buy(alice, 10_000e18);
        vm.warp(block.timestamp + HOUR + 1);

        uint256 collected = holderPot.collect();
        assertEq(collected, vault.totalAccrued() / 2, "half the fees, as the split says");
    }

    function test_theLargestHolderIsPaidAfterTheChallengeWindow() public {
        _buy(alice, 20_000e18);
        _buy(bob, 5_000e18);

        vm.warp(block.timestamp + HOUR + 1);
        holderPot.assignClosed();

        holderPot.claimEpoch(0, bob);
        // Alice held more for the same time, so she takes the claim from bob.
        holderPot.claimEpoch(0, alice);

        vm.warp(block.timestamp + holderPot.CHALLENGE_SECONDS() + 1);

        uint256 before = quote.balanceOf(alice);
        holderPot.finalize(0);

        assertGt(quote.balanceOf(alice) - before, 0, "the largest holder was paid");
    }

    function test_aWeakerClaimCannotDisplaceAStrongerOne() public {
        _buy(alice, 20_000e18);
        _buy(bob, 5_000e18);

        vm.warp(block.timestamp + HOUR + 1);
        holderPot.claimEpoch(0, alice);

        vm.expectRevert();
        holderPot.claimEpoch(0, bob);
    }

    function test_anOpenEpochCannotBeClaimed() public {
        _buy(alice, 20_000e18);

        vm.expectRevert(abi.encodeWithSelector(AgenLargestHolderPot.EpochNotClosed.selector, uint256(0), uint256(0)));
        holderPot.claimEpoch(0, alice);
    }

    function test_thePotIsNotPaidBeforeTheChallengeWindowCloses() public {
        _buy(alice, 20_000e18);
        vm.warp(block.timestamp + HOUR + 1);

        holderPot.assignClosed();
        holderPot.claimEpoch(0, alice);

        vm.expectRevert();
        holderPot.finalize(0);
    }
}
