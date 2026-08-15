// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";

import {AgenRouter} from "../src/agen/AgenRouter.sol";
import {BoostEscrow, IAgenRouter, IInstantFactory} from "../src/BoostEscrow.sol";
import {BoostTreasury} from "../src/BoostTreasury.sol";
import {BoostEscrowFactory} from "../src/BoostEscrowFactory.sol";
import {InstantDeployer} from "../src/InstantDeployer.sol";
import {InstantFactory} from "../src/InstantFactory.sol";
import {InstantFeeVault} from "../src/InstantFeeVault.sol";
import {InstantHook} from "../src/InstantHook.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {InstantFees} from "../src/libraries/InstantFees.sol";

/// @title Agen Boost, against the real Instant stack
/// @notice A creator's 1.00% turned into buybacks that end at the dead address, proved on a
/// real PoolManager, a real PositionManager, a real `InstantFactory` launch and real swaps.
///
/// @dev Nothing here is mocked. The escrow is named as a launch's `feeRecipient`, which is
/// the entire mechanism, so a test that stubbed the vault would be testing the idea rather
/// than the thing. The `InstantFactory` wiring below is `InstantFactory.t.sol`'s, unchanged,
/// because Boost's whole claim is that it changes nothing about a launch.
///
/// The two properties worth reading the file for:
///
///  - **the cutoff.** `test_disablingBoostCannotStealCommittedFees` is the one that matters.
///    A creator who watches a large trade accrue and then disables Boost must not be able to
///    claim it, and the mechanism is that both toggles settle before they flip.
///  - **no recursion.** A buyback pays the market's own 1.50%, 1.00% of which returns as more
///    budget. `test_buybackFeeDripDoesNotFundAnotherBuyback` pins that it converges rather
///    than loops.
contract BoostEscrowTest is Deployers {
    InstantFactory internal factory;
    InstantDeployer internal instantDeployer;
    InstantHook internal hook;
    MarketRegistry internal registry;
    PositionManager internal posm;
    AgenRouter internal router;
    BoostEscrowFactory internal escrows;
    BoostTreasury internal boostTreasury;

    BoostEscrow internal escrow;
    address internal token;
    InstantFeeVault internal vault;

    address internal creator = makeAddr("creator");
    /// @dev Agen's own address: where the platform 0.50% ends up when Boost is off.
    address internal agenTreasury = makeAddr("agenTreasury");
    address internal trader = makeAddr("trader");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    /**
     * The whole stack, in the one order that works.
     *
     * Three cycles have to be broken, and all of them the same way the repo already breaks
     * `InstantDeployer`/`InstantFactory`: compute an address before deploying to it, and assert
     * afterwards that the computation was right.
     *
     *  - the hook, deployer and registry each name the Instant factory, which names all three;
     *  - `BoostTreasury` names the escrow factory, which names the treasury;
     *  - the Instant factory names the treasury, and the treasury's escrows need the Instant
     *    factory to derive pool keys.
     *
     * The last is the one that matters in production: **`BoostTreasury` has to exist before the
     * Instant stack that pays it.** `InstantFactory.treasury` is an immutable and every vault
     * snapshots it at creation, so an Instant deployed against an ordinary address can never have
     * its platform fee Boosted, ever, for any market.
     */
    function setUp() public {
        deployFreshManagerAndRouters();

        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        uint64 nonce = vm.getNonce(address(this));
        // Counted from the CREATEs below in order: router, deployer, registry, escrow factory,
        // treasury, Instant factory. `deployCodeTo` etches rather than creates and consumes no nonce.
        address predictedFactory = vm.computeCreateAddress(address(this), nonce + 5);

        address hookAt = address(uint160(FLAGS) | uint160(uint256(0x4444) << 144));
        deployCodeTo("InstantHook.sol:InstantHook", abi.encode(manager, predictedFactory, address(posm)), hookAt);
        hook = InstantHook(hookAt);

        router = new AgenRouter(manager);
        instantDeployer = new InstantDeployer(predictedFactory);
        registry = new MarketRegistry(predictedFactory);

        // No prediction and no cycle: the escrow factory does not name the treasury, because an
        // escrow reads its market's platform route from that market's own vault. So this is simply
        // an order — escrows, then the treasury that trusts them, then the factory that pays it.
        escrows = new BoostEscrowFactory(
            registry, IInstantFactory(predictedFactory), IAgenRouter(address(router)), manager
        );
        boostTreasury = new BoostTreasury(agenTreasury, escrows);

        // The line that makes the platform half of Boost possible at all: this deployment pays its
        // 0.50% to `BoostTreasury` rather than to an address Agen holds a key for.
        factory = new InstantFactory(
            manager, IPositionManager(address(posm)), hook, instantDeployer, registry, address(boostTreasury)
        );
        assertEq(address(factory), predictedFactory, "setup: the factory did not land where predicted");
        assertEq(factory.treasury(), address(boostTreasury), "setup: the factory pays the Boost treasury");

        vm.deal(creator, 100 ether);
        vm.deal(trader, 10_000 ether);
        vm.deal(stranger, 100 ether);

        // A Boost-capable launch: the escrow is deployed first and named as the fee
        // recipient. This is the only difference from an ordinary Instant launch.
        escrow = escrows.deploy(creator);
        token = _launch(address(escrow), bytes32(uint256(1)));
        vault = InstantFeeVault(payable(registry.marketByToken(token).splitter));
        escrow.enroll(token);
    }

    // --- helpers ----------------------------------------------------------------

    function _launch(address feeRecipient, bytes32 salt) internal returns (address launched) {
        vm.prank(creator);
        InstantFactory.Created memory created = factory.create(
            InstantFactory.CreateParams({
                name: "Instant",
                symbol: "INST",
                metadataURI: "ipfs://example",
                feeRecipient: feeRecipient,
                salt: salt,
                initialBuyAmount: 0,
                initialBuyMinTokens: 0
            })
        );
        launched = created.token;
        key = factory.poolKeyFor(launched);
    }

    function _settings() internal pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    /// @dev An ordinary trader's buy, through v4's own test router rather than Agen's, so
    /// that organic trading and Boost buybacks are distinguishable in the pool's own events.
    function _buy(uint256 ethIn) internal {
        vm.prank(trader);
        swapRouter.swap{value: ethIn}(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- a test amount far inside int256
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            bytes("")
        );
    }

    /// @dev The floor the escrow will demand, so a test does not have to guess one.
    function _floor(uint128 amountIn) internal view returns (uint128) {
        // forge-lint: disable-next-line(unsafe-typecast) -- a token amount far inside uint128
        return uint128(escrow.slippageFloor(token, amountIn));
    }

    /// @dev What a cycle will spend, which is both streams and not just the creator's.
    ///
    /// `pending` is what the escrow already holds, `vaultClaimable` is the creator's 1.00% still in
    /// the vault, and `platformPending` is Agen's 0.50% waiting at the treasury plus whatever of it
    /// the vault has not paid over. A helper that summed only the first two would compute a floor
    /// for two thirds of the trade and every buyback would revert `SlippageTooLoose` — which is
    /// exactly what happened when the platform stream was first wired in.
    function _queued() internal view returns (uint128) {
        BoostEscrow.BoostState memory state = escrow.boostStateOf(token);
        return uint128(state.pending + state.platformPending + (state.enabled ? state.vaultClaimable : 0));
    }

    function _boost() internal returns (uint256 spent, uint256 bought, uint256 sunk) {
        uint128 amountIn = _queued();

        vm.prank(keeper);
        return escrow.boost(token, _floor(amountIn));
    }

    // --- 1-5: Instant itself is untouched ---------------------------------------

    /// @notice A launch that names a wallet is exactly what it was before Boost existed.
    function test_anOrdinaryInstantLaunchStillWorks() public {
        address wallet = makeAddr("plainWallet");
        address plain = _launch(wallet, bytes32(uint256(99)));

        MarketRegistry.Market memory record = registry.marketByToken(plain);
        InstantFeeVault plainVault = InstantFeeVault(payable(record.splitter));

        assertEq(plainVault.creator(), wallet, "a plain launch pays the wallet it named");
        assertEq(plainVault.treasury(), address(boostTreasury), "and this deployment's treasury, unchanged");

        _buy(1 ether);
        assertGt(plainVault.claimable(wallet), 0, "fees accrue for it exactly as before");

        // And it claims straight to the wallet, with no escrow anywhere in the path.
        uint256 owed = plainVault.claimable(wallet);
        plainVault.claimCreator();
        assertEq(wallet.balance, owed, "the wallet was paid directly");
    }

    /// @notice A market that named a wallet cannot be enrolled in somebody's escrow.
    /// @dev This is the guard on legacy markets. Their fee recipient is an immutable EOA, and
    /// enrolment refuses anything whose vault does not already pay the escrow.
    function test_aLegacyMarketCannotBeEnrolled() public {
        address wallet = makeAddr("legacyWallet");
        address legacy = _launch(wallet, bytes32(uint256(98)));
        address legacyVault = registry.marketByToken(legacy).splitter;

        vm.expectRevert(abi.encodeWithSelector(BoostEscrow.VaultPaysSomeoneElse.selector, legacy, legacyVault, wallet));
        escrow.enroll(legacy);
    }

    /// @notice Trading is unaffected, and the split is still exactly 1.00% and 0.50%.
    function test_theFeeSplitIsUnchangedByBoost() public {
        vm.prank(creator);
        escrow.enableBoost(token);

        uint256 spend = 3 ether;
        _buy(spend);

        (uint256 creatorShare, uint256 platformShare, uint256 total) = InstantFees.split(spend);

        assertEq(vault.creatorAccrued(), creatorShare, "the creator's ledger is exactly 1.00% of the leg");
        assertEq(vault.platformAccrued(), platformShare, "the platform's is exactly 0.50%");
        assertEq(creatorShare + platformShare, total, "and they sum to the whole charge");

        // Stated as the rates themselves, not just as the library's own output.
        assertEq(total, (spend * 15_000) / 1_000_000, "1.50% total");
        assertEq(platformShare, (spend * 5_000) / 1_000_000, "0.50% platform");
    }

    /// @notice Boost off: the creator gets exactly 1.00% and Agen gets exactly 0.50%.
    ///
    /// @dev The baseline the whole feature is measured against. Both figures are asserted against
    /// the rates themselves rather than against the library's own output, so a change to
    /// `InstantFees` that broke the split would fail here rather than agree with itself.
    function test_boostOffPaysTheCreatorOnePercentAndAgenAHalf() public {
        uint256 spend = 4 ether;
        _buy(spend);

        assertEq(vault.creatorAccrued(), (spend * 10_000) / 1_000_000, "creator accrued exactly 1.00%");
        assertEq(vault.platformAccrued(), (spend * 5_000) / 1_000_000, "Agen accrued exactly 0.50%");

        // The creator's side, through the escrow, into their wallet.
        vm.prank(creator);
        escrow.pull(token);
        assertEq(creator.balance, 100 ether + (spend * 10_000) / 1_000_000, "the creator was paid 1.00%");

        // Agen's side, through the treasury, into Agen's own address.
        boostTreasury.settle(address(vault));
        boostTreasury.withdrawAgen(address(vault));
        assertEq(agenTreasury.balance, (spend * 5_000) / 1_000_000, "Agen was paid 0.50%");

        // And nothing was committed to Boost by either.
        assertEq(escrow.boostStateOf(token).pending, 0, "no Boost funds exist");
        assertEq(boostTreasury.platformStateOf(address(vault)).routedToBoost, 0);
    }

    /// @notice Boost on: the creator gets nothing, Agen gets nothing, and Boost gets all 1.50%.
    ///
    /// @dev The claim the product makes, as an equality. Not "roughly the total" — the two shares
    /// summed against the trader's own fee, so there is no third party to it and no rounding
    /// stranded anywhere.
    function test_boostOnSendsTheFullFifteenBasisPointsToBoost() public {
        vm.prank(creator);
        escrow.enableBoost(token);

        uint256 spend = 8 ether;
        _buy(spend);

        (uint256 creatorShare, uint256 platformShare, uint256 total) = InstantFees.split(spend);

        // Claim both streams the way a buyback would.
        escrow.settle(token);
        boostTreasury.settle(address(vault));

        BoostEscrow.BoostState memory state = escrow.boostStateOf(token);
        BoostTreasury.PlatformState memory platform = boostTreasury.platformStateOf(address(vault));

        assertEq(state.creatorPending, 0, "the creator is owed nothing");
        assertEq(platform.agenPending, 0, "Agen is owed nothing");

        // The creator's 1.00% is in the escrow; Agen's 0.50% is at the treasury waiting to be
        // pulled. Together they are the whole 1.50% the trader paid.
        assertEq(state.pending, creatorShare, "the creator's 1.00% is committed");
        assertEq(platform.boostPending, platformShare, "and Agen's 0.50% is committed");
        assertEq(state.pending + platform.boostPending, total, "which is all 1.50%");
        assertEq(total, (spend * 15_000) / 1_000_000, "and 1.50% is what it was");

        // A cycle spends both.
        (uint256 spent,, uint256 sunk) = _boost();
        assertEq(spent, total, "the buyback spent the whole 1.50%");
        assertGt(sunk, 0);

        assertEq(escrow.boostStateOf(token).platformRouted, platformShare, "routed, not donated");
        assertEq(agenTreasury.balance, 0, "Agen received none of it");
    }

    /// @notice The trader pays exactly 1.50%, Boost or no Boost. Boost is not a second fee.
    function test_theTraderPaysExactlyFifteenBasisPointsEitherWay() public {
        // Off.
        uint256 before = trader.balance;
        _buy(5 ether);
        uint256 offCost = before - trader.balance;

        // On, in a second market so the pool state is comparable rather than moved.
        address second = _launch(address(escrow), bytes32(uint256(41)));
        key = factory.poolKeyFor(second);
        vm.prank(creator);
        escrow.enableBoost(second);

        before = trader.balance;
        _buy(5 ether);
        uint256 onCost = before - trader.balance;

        // The trader spends what they said, in both cases: the fee comes out of the ether they
        // put in rather than being charged on top.
        assertEq(offCost, 5 ether, "the trader spent what they specified with Boost off");
        assertEq(onCost, 5 ether, "and the same with Boost on");

        address secondVault = registry.marketByToken(second).splitter;
        (,, uint256 total) = InstantFees.split(5 ether);

        assertEq(
            InstantFeeVault(payable(secondVault)).creatorAccrued()
                + InstantFeeVault(payable(secondVault)).platformAccrued(),
            total,
            "and the market took exactly 1.50% of it, no more"
        );
    }

    // --- 6-8: the switch ---------------------------------------------------------

    /// @notice Boost starts off, and fees are the creator's as usual.
    function test_boostStartsOffAndCreatorClaimsWork() public {
        BoostEscrow.BoostState memory state = escrow.boostStateOf(token);
        assertTrue(state.enrolled, "the market is Boost-capable");
        assertFalse(state.enabled, "but Boost is off until asked for");
        assertFalse(state.locked);

        _buy(1 ether);

        (uint256 expected,,) = InstantFees.split(1 ether);
        vm.prank(creator);
        (uint256 claimed, uint256 paid) = escrow.pull(token);

        assertEq(claimed, expected, "one signature claims the fee out of the vault");
        assertEq(paid, expected, "and pays it straight through to the creator");
        assertEq(creator.balance, 100 ether + expected, "which is the wallet's own balance");
        assertEq(escrow.boostStateOf(token).pending, 0, "nothing was committed to Boost");
    }

    /// @notice Enabling Boost cannot take fees earned before it was enabled.
    function test_enablingBoostLeavesEarlierFeesWithTheCreator() public {
        _buy(1 ether);
        (uint256 earnedBefore,,) = InstantFees.split(1 ether);

        vm.prank(creator);
        uint256 settled = escrow.enableBoost(token);

        assertEq(settled, earnedBefore, "the toggle settled what was outstanding");
        assertEq(escrow.boostStateOf(token).creatorPending, earnedBefore, "to the creator's side of the ledger");
        assertEq(escrow.boostStateOf(token).pending, 0, "and committed none of it");

        vm.prank(creator);
        escrow.withdraw(token);
        assertEq(creator.balance, 100 ether + earnedBefore, "the creator can still take it");
    }

    /// @notice Fees earned after enabling Boost become Boost funds and are not withdrawable.
    function test_feesAfterEnablingBecomeBoostFunds() public {
        vm.prank(creator);
        escrow.enableBoost(token);

        _buy(2 ether);
        (uint256 earned,,) = InstantFees.split(2 ether);

        escrow.settle(token);

        assertEq(escrow.boostStateOf(token).pending, earned, "committed to buybacks");
        assertEq(escrow.boostStateOf(token).creatorPending, 0, "and nothing is the creator's");

        vm.prank(creator);
        vm.expectRevert(BoostEscrow.NothingToWithdraw.selector);
        escrow.withdraw(token);
    }

    // --- 9-11: the buyback -------------------------------------------------------

    /// @notice A buyback buys the market's own token and sends every one of them to the dead
    /// address.
    function test_buybackBuysTheRightTokenAndSinksIt() public {
        vm.prank(creator);
        escrow.enableBoost(token);
        _buy(20 ether);

        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        uint256 supplyBefore = IERC20(token).totalSupply();

        (uint256 spent, uint256 bought, uint256 sunk) = _boost();

        assertGt(spent, 0, "ether was spent");
        assertGt(bought, 0, "tokens were bought");
        assertEq(sunk, bought, "and every token bought was sunk");
        assertEq(IERC20(token).balanceOf(DEAD), deadBefore + sunk, "at the dead address");
        assertEq(IERC20(token).balanceOf(address(escrow)), 0, "with none left in the escrow");

        // The honesty requirement: this is a sink, not a burn.
        assertEq(IERC20(token).totalSupply(), supplyBefore, "totalSupply does not decrease");

        BoostEscrow.BoostState memory state = escrow.boostStateOf(token);
        assertEq(state.sunk, sunk, "and the market's own accounting agrees");
        assertEq(state.bought, bought);
        assertEq(state.spent, spent);
        assertEq(state.deadBalance, deadBefore + sunk, "read from the token, not from the tally");
        assertEq(state.boostCount, 1);
    }

    /// @notice A buyback cannot be aimed at another market's token.
    function test_aBuybackOnlyEverBuysItsOwnToken() public {
        address other = _launch(makeAddr("otherWallet"), bytes32(uint256(77)));

        // `_launch` leaves `key` pointing at whatever it just created, so trading has to be
        // aimed back at the market under test.
        key = factory.poolKeyFor(token);

        vm.prank(creator);
        escrow.enableBoost(token);
        _buy(20 ether);
        escrow.settle(token);

        // `other` is a real Instant market with a real pool, and it is refused because its
        // vault pays somebody else — not merely because it has not been attached here. That
        // distinction is the point: enrolment is derived from the chain, so there is no
        // argument to `boost` that reaches a market this escrow is not the recipient of.
        address otherVault = registry.marketByToken(other).splitter;
        vm.expectRevert(
            abi.encodeWithSelector(
                BoostEscrow.VaultPaysSomeoneElse.selector, other, otherVault, makeAddr("otherWallet")
            )
        );
        escrow.boost(other, 1);

        _boost();
        assertEq(IERC20(other).balanceOf(DEAD), 0, "the other market's token was never touched");
    }

    /// @notice The buyback is a real trade in the market's real pool.
    function test_theBuybackMovesTheRealPool() public {
        vm.prank(creator);
        escrow.enableBoost(token);
        _buy(20 ether);
        escrow.settle(token);

        uint256 vaultBefore = vault.creatorAccrued();
        (uint256 spent, uint256 bought,) = _boost();

        assertGt(bought, 0);
        // The buyback paid the market's own fee, like any other trade, which is what makes
        // it a real trade rather than a transfer dressed as one.
        (uint256 feeToCreator,,) = InstantFees.split(spent);
        assertEq(vault.creatorAccrued(), vaultBefore + feeToCreator, "the hook charged the buyback too");
    }

    // --- 12-14: the cutoff and the lock ------------------------------------------

    /// @notice Disabling Boost cannot claw back fees that were already committed.
    /// @dev The test this whole design exists for. A creator watches a large trade land, then
    /// disables Boost hoping to claim it. The toggle settles first, so the fee is committed
    /// before the switch flips and the creator gets nothing.
    function test_disablingBoostCannotStealCommittedFees() public {
        vm.prank(creator);
        escrow.enableBoost(token);

        _buy(30 ether);
        (uint256 earnedWhileOn,,) = InstantFees.split(30 ether);

        uint256 creatorBefore = creator.balance;

        vm.prank(creator);
        uint256 settled = escrow.disableBoost(token);

        assertEq(settled, earnedWhileOn, "the disable settled what Boost had earned");
        assertEq(escrow.boostStateOf(token).pending, earnedWhileOn, "and it stayed committed");
        assertEq(escrow.boostStateOf(token).creatorPending, 0, "none of it became the creator's");

        vm.prank(creator);
        vm.expectRevert(BoostEscrow.NothingToWithdraw.selector);
        escrow.withdraw(token);
        assertEq(creator.balance, creatorBefore, "the creator is no richer for switching off");

        // And the committed ether still gets spent, even though Boost is now off.
        (, uint256 bought, uint256 sunk) = _boost();
        assertGt(bought, 0, "committed funds are still spent on buybacks");
        assertEq(sunk, bought, "and still sunk");
    }

    /// @notice Disabling Boost restores normal creator income for everything after it.
    function test_disablingBoostRestoresNormalFeesGoingForward() public {
        vm.prank(creator);
        escrow.enableBoost(token);
        _buy(5 ether);

        vm.prank(creator);
        escrow.disableBoost(token);

        uint256 committed = escrow.boostStateOf(token).pending;
        assertGt(committed, 0, "what was earned while on is committed");

        _buy(4 ether);
        escrow.settle(token);

        (uint256 earnedAfter,,) = InstantFees.split(4 ether);
        assertEq(escrow.boostStateOf(token).creatorPending, earnedAfter, "everything after the cutoff is the creator's");
        assertEq(escrow.boostStateOf(token).pending, committed, "and Boost's commitment did not grow");
    }

    /// @notice A locked market can never be switched off.
    function test_lockedBoostCannotBeDisabled() public {
        vm.startPrank(creator);
        escrow.enableBoost(token);
        escrow.lockBoostForever(token);
        vm.stopPrank();

        assertTrue(escrow.boostStateOf(token).locked, "the lock is visible");

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BoostEscrow.BoostAlreadyLocked.selector, token));
        escrow.disableBoost(token);

        // Locking twice is refused too, so there is no path that clears the flag by
        // re-running the only function that sets it.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BoostEscrow.BoostAlreadyLocked.selector, token));
        escrow.lockBoostForever(token);

        // And it still buys back, which is the point of locking rather than merely enabling.
        _buy(20 ether);
        (, uint256 bought, uint256 sunk) = _boost();
        assertEq(sunk, bought);
        assertTrue(escrow.boostStateOf(token).locked, "and it is still locked afterwards");
    }

    /// @notice Only the creator can touch the switch.
    function test_onlyTheOwnerCanToggleBoost() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BoostEscrow.NotOwner.selector, stranger));
        escrow.enableBoost(token);

        vm.prank(creator);
        escrow.enableBoost(token);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BoostEscrow.NotOwner.selector, stranger));
        escrow.disableBoost(token);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BoostEscrow.NotOwner.selector, stranger));
        escrow.lockBoostForever(token);
    }

    // --- 15-16: thresholds and recursion ----------------------------------------

    /// @notice A balance too small to be worth the gas is refused rather than spent.
    function test_dustIsSkipped() public {
        vm.prank(creator);
        escrow.enableBoost(token);

        // A trade whose whole 1.50% is well under the threshold — both streams together, since
        // both fund a cycle now.
        _buy(0.01 ether);
        escrow.settle(token);
        boostTreasury.settle(address(vault));

        uint256 pending = escrow.boostStateOf(token).pending + escrow.boostStateOf(token).platformPending;
        assertGt(pending, 0, "there is something committed");
        assertLt(pending, escrow.MIN_BOOST_WEI(), "but less than the minimum");
        assertFalse(escrow.boostStateOf(token).ready, "so the market is not ready");

        vm.expectRevert(abi.encodeWithSelector(BoostEscrow.BelowThreshold.selector, pending, escrow.MIN_BOOST_WEI()));
        escrow.boost(token, 1);
    }

    /// @notice The fee a buyback pays converges to nothing instead of looping.
    ///
    /// @dev The recursion question, answered with the actual numbers rather than with the
    /// reassuring version. A buyback is a real trade, so it pays the market's own 1.50% and
    /// 1.00% of that comes back here as fresh budget. That is **not** immediately below the
    /// threshold — a spend two hundred times `MIN_BOOST_WEI` returns twice it — so a second
    /// and a third cycle really do run.
    ///
    /// What makes it safe is the ratio: each cycle returns one hundredth of what it spent, so
    /// the sequence falls by two orders of magnitude a round and crosses the threshold within
    /// a handful of them. This drives it to exhaustion and counts, so a change to the fee, the
    /// threshold or the split that turned convergence into a treadmill would fail here rather
    /// than on chain.
    ///
    /// Nothing reenters at any point: the fee lands in the vault's ledger and needs a separate
    /// transaction to move, and `BOOST_INTERVAL` means those transactions are half an hour
    /// apart. A keeper cannot spin even while the tail is still non-zero.
    function test_theBuybackFeeDripConvergesInsteadOfLooping() public {
        vm.prank(creator);
        escrow.enableBoost(token);
        _buy(20 ether);

        (uint256 firstSpend,,) = _boost();

        // Immediately after, the interval refuses a second cycle whatever is available.
        uint40 last = escrow.boostStateOf(token).lastBoostAt;
        vm.expectRevert(abi.encodeWithSelector(BoostEscrow.TooSoon.selector, last, last + escrow.BOOST_INTERVAL()));
        escrow.boost(token, 1);

        // Now run the tail to exhaustion, with no further trading, and count the rounds.
        uint256 previousSpend = firstSpend;
        uint256 rounds;

        while (true) {
            vm.warp(block.timestamp + escrow.BOOST_INTERVAL() + 1);
            escrow.settle(token);
            boostTreasury.settle(address(vault));

            // Both streams come back now, so a round's budget is the whole 1.50% of the last spend
            // rather than the creator's 1.00% of it. That makes the decay about 1/66 a round
            // instead of 1/100 — still convergent, and still a handful of rounds, which is the
            // property under test rather than the exact ratio.
            uint256 available = _queued();
            (,, uint256 expected) = InstantFees.split(previousSpend);
            assertEq(available, expected, "each round's budget is exactly the last one's whole fee");
            assertLe(available * 50, previousSpend, "which is at least fifty times smaller");

            if (available < escrow.MIN_BOOST_WEI()) break;

            (uint256 spent,,) = _boost();
            previousSpend = spent;
            rounds += 1;
            assertLt(rounds, 6, "the tail must terminate in a handful of rounds, not grind on");
        }

        uint256 stranded = _queued();
        assertLt(stranded, escrow.MIN_BOOST_WEI(), "the residue is below the threshold");
        assertGt(stranded, 0, "and is left committed rather than returned to either side");

        vm.expectRevert();
        escrow.boost(token, 1);

        // Neither side can take the residue back.
        assertEq(agenTreasury.balance, 0, "Agen received nothing from a Boosted market");

        // The residue is Boost's, not the creator's, even after the chain has stopped.
        vm.prank(creator);
        vm.expectRevert(BoostEscrow.NothingToWithdraw.selector);
        escrow.withdraw(token);
    }

    /// @notice One cycle per market per interval, enforced on chain rather than by the keeper.
    function test_onlyOneCyclePerInterval() public {
        vm.prank(creator);
        escrow.enableBoost(token);
        _buy(200 ether);

        _boost();
        uint40 last = escrow.boostStateOf(token).lastBoostAt;

        vm.expectRevert(abi.encodeWithSelector(BoostEscrow.TooSoon.selector, last, last + escrow.BOOST_INTERVAL()));
        escrow.boost(token, 1);

        vm.warp(uint256(last) + escrow.BOOST_INTERVAL());
        _buy(50 ether);
        (, uint256 bought,) = _boost();
        assertGt(bought, 0, "and permitted once the interval has passed");
    }

    // --- 17-18: slippage and malicious callers ----------------------------------

    /// @notice A caller cannot ask for a buyback at any price.
    function test_slippageFloorIsEnforced() public {
        vm.prank(creator);
        escrow.enableBoost(token);
        _buy(20 ether);
        escrow.settle(token);

        uint128 pending = _queued();
        uint256 floor = escrow.slippageFloor(token, pending);
        assertGt(floor, 0, "there is a real floor");

        vm.expectRevert(BoostEscrow.ZeroMinimumOut.selector);
        escrow.boost(token, 0);

        vm.expectRevert(abi.encodeWithSelector(BoostEscrow.SlippageTooLoose.selector, 1, floor));
        escrow.boost(token, 1);

        // A tighter bound than the floor is the caller's own business and is accepted.
        // forge-lint: disable-next-line(unsafe-typecast) -- a token amount far inside uint128
        escrow.boost(token, uint128(floor + 1));
    }

    /// @notice A stranger can run the keeper's job but cannot redirect anything by doing so.
    function test_aStrangerCanBoostButGainsNothing() public {
        vm.prank(creator);
        escrow.enableBoost(token);
        _buy(20 ether);

        uint256 strangerBefore = stranger.balance;

        uint128 amountIn = _queued();
        vm.prank(stranger);
        (, uint256 bought, uint256 sunk) = escrow.boost(token, _floor(amountIn));

        assertEq(sunk, bought, "the tokens went to the dead address");
        assertEq(IERC20(token).balanceOf(stranger), 0, "and none to the caller");
        assertLe(stranger.balance, strangerBefore, "who is only out the gas");
    }

    /// @notice Withdrawals only ever reach the owner, whoever asks.
    function test_withdrawalsOnlyEverReachTheOwner() public {
        _buy(1 ether);
        escrow.settle(token);

        uint256 owed = escrow.boostStateOf(token).creatorPending;
        assertGt(owed, 0);

        // A stranger triggering it pays the creator, which is the `FeeForwarder` property.
        vm.prank(stranger);
        escrow.withdraw(token);

        assertEq(creator.balance, 100 ether + owed, "the owner was paid");
        assertEq(escrow.boostStateOf(token).creatorPending, 0);
        assertEq(address(escrow).balance, 0, "and the escrow holds nothing between cycles");
    }

    /// @notice The burn destination and the owner are fixed, so nothing can point them
    /// elsewhere.
    ///
    /// @dev `DEAD` is a `constant` and `owner` is an `immutable`, which is a stronger claim
    /// than "no setter is written": the values live in the contract's own bytecode and there
    /// is no storage slot for a setter to reach even if one were added later by mistake. The
    /// absence of a destination *parameter* is what the rest of this file exercises —
    /// `withdraw(token)` and `boost(token, min)` take no destination, so there is nothing to aim.
    function test_theBurnDestinationAndOwnerAreFixed() public view {
        assertEq(escrow.DEAD(), DEAD, "the sink is the canonical dead address");
        assertEq(escrow.owner(), creator, "and the payout address is the creator");
    }

    /// @notice A market cannot be re-enrolled onto a different vault.
    function test_enrolmentIsIdempotentAndCannotBeRepointed() public {
        assertEq(escrow.enroll(token), address(vault), "a second enrolment is a no-op");
        assertEq(escrow.tokenOfVault(address(vault)), token, "and the reverse mapping holds");

        // A token with no Instant market at all has nothing to resolve.
        vm.expectRevert();
        escrow.enroll(makeAddr("notAToken"));
    }

    // --- 19: Boost volume is distinguishable ------------------------------------

    /// @notice Every buyback announces itself, so Boost volume is separable from organic.
    function test_everyBuybackIsVisibleOnChain() public {
        vm.prank(creator);
        escrow.enableBoost(token);
        _buy(20 ether);
        escrow.settle(token);

        uint128 pending = _queued();
        uint128 floor = _floor(pending);

        vm.recordLogs();
        vm.prank(keeper);
        (uint256 spent, uint256 bought, uint256 sunk) = escrow.boost(token, floor);

        // The router's own event names this contract as the trader, which is what lets an
        // indexer attribute the swap without matching amounts.
        bool sawAgenSwap;
        bool sawBoostExecuted;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("AgenSwap(bytes32,address,bool,uint256,uint256)")) {
                assertEq(address(uint160(uint256(logs[i].topics[2]))), address(escrow), "trader is the escrow");
                sawAgenSwap = true;
            }
            if (
                logs[i].topics[0] == keccak256("BoostExecuted(address,address,uint256,uint256,uint256,uint256,uint256)")
            ) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), token, "for this token");
                sawBoostExecuted = true;
            }
        }

        assertTrue(sawAgenSwap, "the trade is attributable to the escrow");
        assertTrue(sawBoostExecuted, "and the cycle is announced with its own numbers");
        assertGt(spent, 0);
        assertEq(sunk, bought);
    }

    // --- 20: what the interface reads -------------------------------------------

    /// @notice The state an interface renders is complete and consistent.
    function test_boostStateReportsEverythingTheInterfaceShows() public {
        BoostEscrow.BoostState memory off = escrow.boostStateOf(token);
        assertTrue(off.enrolled);
        assertFalse(off.enabled);
        assertFalse(off.locked);
        assertEq(off.nextBoostAt, 0, "no cycle has run, so none is pending");

        vm.prank(creator);
        escrow.enableBoost(token);
        _buy(20 ether);

        BoostEscrow.BoostState memory armed = escrow.boostStateOf(token);
        assertTrue(armed.enabled);
        assertGt(armed.vaultClaimable, 0, "fees are waiting in the vault");
        assertTrue(armed.ready, "and a cycle would run");

        (uint256 spent, uint256 bought, uint256 sunk) = _boost();

        BoostEscrow.BoostState memory done = escrow.boostStateOf(token);
        assertEq(done.spent, spent);
        assertEq(done.bought, bought);
        assertEq(done.sunk, sunk);
        assertEq(done.deadBalance, sunk);
        assertGt(done.lastBoostAt, 0, "the last cycle is recorded");
        assertEq(done.nextBoostAt, done.lastBoostAt + escrow.BOOST_INTERVAL(), "and the next is derivable");
        assertFalse(done.ready, "which is why it is not ready again yet");
        assertEq(done.boostCount, 1);
    }

    /// @notice Agen's contribution is tracked apart from the creator's own fees.
    function test_agenContributionsAreCountedSeparately() public {
        vm.prank(creator);
        escrow.enableBoost(token);
        _buy(10 ether);
        escrow.settle(token);

        uint256 fromFees = escrow.boostStateOf(token).pending;

        // Agen sending its platform share, which it does by choice rather than by routing.
        vm.deal(agenTreasury, 5 ether);
        vm.prank(agenTreasury);
        escrow.contribute{value: 1 ether}(token);

        BoostEscrow.BoostState memory state = escrow.boostStateOf(token);
        assertEq(state.pending, fromFees + 1 ether, "both fund the same buyback");
        assertEq(state.agenContributed, 1 ether, "but the contribution is named as one");
        assertLt(state.agenContributed, state.pending, "so it is never presented as the whole");
    }

    /// @notice One escrow serves every market its creator launches.
    function test_oneEscrowServesManyMarkets() public {
        address second = _launch(address(escrow), bytes32(uint256(2)));
        escrow.enroll(second);

        assertEq(escrow.enrolledCount(), 2, "both markets are enrolled");
        assertEq(escrows.escrowOf(creator), address(escrow), "at the address derived from the creator");
        assertTrue(escrows.isGenuine(creator, address(escrow)), "and it is verifiably this factory's");
        assertFalse(escrows.isGenuine(stranger, address(escrow)), "not somebody else's");

        // The toggles are per market, not per creator.
        vm.prank(creator);
        escrow.enableBoost(second);
        assertTrue(escrow.boostStateOf(second).enabled);
        assertFalse(escrow.boostStateOf(token).enabled, "the first market is unaffected");
    }

    /// @notice One creator's two markets keep separate books.
    ///
    /// @dev The reason the creator's side is per market rather than one pooled balance. A
    /// profile lists a row per market, and a pooled figure would show the same money on every
    /// row — so "what this market owes you" has to have its own answer. This also pins that
    /// Boost on one market cannot touch what another market owes.
    function test_twoMarketsKeepSeparateBooks() public {
        address second = _launch(address(escrow), bytes32(uint256(3)));
        key = factory.poolKeyFor(token);

        // Boost on for the first market only.
        vm.prank(creator);
        escrow.enableBoost(token);

        _buy(6 ether);
        escrow.settle(token);

        key = factory.poolKeyFor(second);
        _buy(4 ether);
        escrow.settle(second);

        (uint256 firstFee,,) = InstantFees.split(6 ether);
        (uint256 secondFee,,) = InstantFees.split(4 ether);

        BoostEscrow.BoostState memory boosted = escrow.boostStateOf(token);
        BoostEscrow.BoostState memory plain = escrow.boostStateOf(second);

        assertEq(boosted.pending, firstFee, "the Boosted market committed its own fees");
        assertEq(boosted.creatorPending, 0, "and owes the creator nothing");
        assertEq(plain.pending, 0, "the other market committed nothing");
        assertEq(plain.creatorPending, secondFee, "and owes the creator its own fees");

        // Withdrawing one pays only that market's balance.
        vm.prank(creator);
        uint256 paid = escrow.withdraw(second);
        assertEq(paid, secondFee, "exactly the second market's fees");
        assertEq(creator.balance, 100 ether + secondFee);

        // And the Boosted market's commitment is untouched by that withdrawal.
        assertEq(escrow.boostStateOf(token).pending, firstFee, "still committed");

        vm.prank(creator);
        vm.expectRevert(BoostEscrow.NothingToWithdraw.selector);
        escrow.withdraw(token);
    }

    // --- both streams at the toggle boundaries ----------------------------------

    /**
     * @notice Platform fees earned before Boost was enabled stay Agen's.
     *
     * @dev The mirror of `test_enablingBoostLeavesEarlierFeesWithTheCreator`, for the side that
     * Agen gives up. Enabling Boost must not retroactively take revenue Agen had already earned —
     * and the mechanism is that `enableBoost` claims the platform fee while the treasury's mirror
     * is still off, so it lands in Agen's ledger before the flag moves.
     */
    function test_enablingBoostLeavesEarlierPlatformFeesWithAgen() public {
        _buy(3 ether);
        (, uint256 platformBefore,) = InstantFees.split(3 ether);

        vm.prank(creator);
        escrow.enableBoost(token);

        BoostTreasury.PlatformState memory platform = boostTreasury.platformStateOf(address(vault));
        assertEq(platform.agenPending, platformBefore, "settled to Agen by the toggle itself");
        assertEq(platform.boostPending, 0, "and none of it was committed to Boost");
        assertTrue(platform.boosting, "with the mirror now on for everything after");

        // And Agen can still take it, after Boost is on.
        boostTreasury.withdrawAgen(address(vault));
        assertEq(agenTreasury.balance, platformBefore, "Agen was paid what it had already earned");

        // Everything from here is Boost's.
        _buy(3 ether);
        boostTreasury.settle(address(vault));
        assertEq(
            boostTreasury.platformStateOf(address(vault)).boostPending,
            platformBefore,
            "the next 0.50% went to Boost instead"
        );
        assertEq(boostTreasury.platformStateOf(address(vault)).agenPending, 0, "and Agen is owed nothing new");
    }

    /**
     * @notice Disabling Boost cannot hand Agen back platform fees earned while it was on.
     *
     * @dev The symmetric attack to the creator's, and the more subtle one because Agen controls
     * the keeper: if disabling released the platform fees accrued under Boost, then "all 1.50% is
     * recycled" would be false in retrospect for trades that had already happened under it.
     */
    function test_disablingBoostCannotReturnCommittedPlatformFeesToAgen() public {
        vm.prank(creator);
        escrow.enableBoost(token);

        _buy(12 ether);
        (, uint256 platformUnderBoost,) = InstantFees.split(12 ether);

        vm.prank(creator);
        escrow.disableBoost(token);

        BoostTreasury.PlatformState memory platform = boostTreasury.platformStateOf(address(vault));
        assertEq(platform.boostPending, platformUnderBoost, "still committed to buybacks");
        assertEq(platform.agenPending, 0, "and not owed to Agen");
        assertFalse(platform.boosting, "even though the mirror is now off");

        vm.expectRevert(abi.encodeWithSelector(BoostTreasury.NothingToWithdraw.selector, address(vault)));
        boostTreasury.withdrawAgen(address(vault));

        // It gets spent, exactly as the creator's committed share does.
        (uint256 spent,, uint256 sunk) = _boost();
        assertGe(spent, platformUnderBoost, "the committed platform fee was spent on the buyback");
        assertGt(sunk, 0);
        assertEq(agenTreasury.balance, 0, "Agen never received it");

        // And subsequent fees resume the normal split.
        //
        // Measured as a delta rather than an absolute, because the buyback above was itself a trade
        // and paid the market's 1.50% like any other — and with Boost now off, that fee is the
        // creator's and Agen's. Asserting an absolute here would be asserting that a buyback is
        // somehow exempt from the fee, which it is not and must not be.
        escrow.settle(token);
        boostTreasury.settle(address(vault));
        uint256 creatorBefore = escrow.boostStateOf(token).creatorPending;
        uint256 agenBefore = boostTreasury.platformStateOf(address(vault)).agenPending;

        _buy(4 ether);
        (uint256 creatorAfter, uint256 platformAfter,) = InstantFees.split(4 ether);
        escrow.settle(token);
        boostTreasury.settle(address(vault));

        assertEq(escrow.boostStateOf(token).creatorPending - creatorBefore, creatorAfter, "creator gets 1.00% again");
        assertEq(
            boostTreasury.platformStateOf(address(vault)).agenPending - agenBefore,
            platformAfter,
            "Agen gets 0.50% again"
        );
        assertEq(escrow.boostStateOf(token).pending, 0, "and Boost is committed nothing new");
    }

    /**
     * @notice Nothing is created or destroyed across a full enable/disable cycle.
     *
     * @dev The conservation check, and the one that would catch a boundary that dropped a fee
     * rather than misrouting it. Every wei the hook charged over the whole run is accounted for in
     * exactly one of four places, and the four sum to 1.50% of the traded volume.
     */
    function test_noFeeDisappearsAcrossTheToggleBoundaries() public {
        uint256 before = 3 ether;
        uint256 during = 7 ether;
        uint256 after_ = 2 ether;

        _buy(before);
        vm.prank(creator);
        escrow.enableBoost(token);

        _buy(during);
        vm.prank(creator);
        escrow.disableBoost(token);

        _buy(after_);
        escrow.settle(token);
        boostTreasury.settle(address(vault));

        BoostEscrow.BoostState memory state = escrow.boostStateOf(token);
        BoostTreasury.PlatformState memory platform = boostTreasury.platformStateOf(address(vault));

        (uint256 cBefore, uint256 pBefore,) = InstantFees.split(before);
        (uint256 cDuring, uint256 pDuring,) = InstantFees.split(during);
        (uint256 cAfter, uint256 pAfter,) = InstantFees.split(after_);

        // The creator's side: before + after are theirs, during is committed.
        assertEq(state.creatorPending, cBefore + cAfter, "the creator holds what they earned outside Boost");
        assertEq(state.pending, cDuring, "and Boost holds what they earned inside it");

        // Agen's side, the same shape.
        assertEq(platform.agenPending, pBefore + pAfter, "Agen holds what it earned outside Boost");
        assertEq(platform.boostPending, pDuring, "and Boost holds what it earned inside it");

        // Nothing anywhere else, and nothing missing.
        assertEq(vault.creatorAccrued(), vault.creatorClaimed(), "the vault's creator ledger is empty");
        assertEq(vault.platformAccrued(), vault.platformClaimed(), "and so is its platform ledger");
        assertEq(escrow.unattributed(), 0, "the escrow booked everything it received");
        assertEq(boostTreasury.unattributed(), 0, "and so did the treasury");

        (,, uint256 totalFee) = InstantFees.split(before + during + after_);
        assertEq(
            state.creatorPending + state.pending + platform.agenPending + platform.boostPending,
            totalFee,
            "and the four places sum to exactly 1.50% of everything traded"
        );
    }

    /// @notice A locked market commits both streams, permanently.
    function test_lockingCommitsBothStreamsForever() public {
        vm.startPrank(creator);
        escrow.enableBoost(token);
        escrow.lockBoostForever(token);
        vm.stopPrank();

        _buy(9 ether);
        escrow.settle(token);
        boostTreasury.settle(address(vault));

        (uint256 creatorShare, uint256 platformShare, uint256 total) = InstantFees.split(9 ether);
        assertEq(escrow.boostStateOf(token).pending, creatorShare);
        assertEq(boostTreasury.platformStateOf(address(vault)).boostPending, platformShare);
        assertEq(escrow.boostStateOf(token).pending + escrow.boostStateOf(token).platformPending, total);

        // Neither party can undo it, and neither can reach the money.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BoostEscrow.BoostAlreadyLocked.selector, token));
        escrow.disableBoost(token);

        vm.prank(agenTreasury);
        vm.expectRevert(abi.encodeWithSelector(BoostEscrow.NotOwner.selector, agenTreasury));
        escrow.disableBoost(token);

        vm.expectRevert(abi.encodeWithSelector(BoostTreasury.NothingToWithdraw.selector, address(vault)));
        boostTreasury.withdrawAgen(address(vault));
    }

    // --- the platform stream cannot be hijacked ----------------------------------

    /**
     * @notice An ordinary creator cannot point their market's platform fee at themselves.
     *
     * @dev The attack the escrow-genuineness check exists for. Without it, a market whose vault
     * names a wallet as its creator would let that wallet call `setBoost` and then `pullForBoost`,
     * and walk off with Agen's half percent. `BoostTreasury` requires the caller to be both the
     * address the vault pays *and* an escrow the factory derived.
     */
    function test_aWalletCannotDivertThePlatformFee() public {
        address thief = makeAddr("thief");
        vm.deal(thief, 10 ether);

        vm.prank(thief);
        address theirToken =
            factory.create(
            InstantFactory.CreateParams({
                name: "Theirs",
                symbol: "THRS",
                metadataURI: "",
                feeRecipient: thief,
                salt: bytes32(uint256(66)),
                initialBuyAmount: 0,
                initialBuyMinTokens: 0
            })
        )
        .token;

        address theirVault = registry.marketByToken(theirToken).splitter;
        assertEq(InstantFeeVault(payable(theirVault)).creator(), thief, "their vault pays their wallet");
        assertEq(InstantFeeVault(payable(theirVault)).treasury(), address(boostTreasury), "and Agen's share comes here");

        // They are the address the vault pays, so the first check passes — and the second refuses,
        // because a wallet has no `owner()` for the factory to derive against.
        vm.prank(thief);
        vm.expectRevert();
        boostTreasury.setBoost(theirVault, true, 0);

        vm.prank(thief);
        vm.expectRevert();
        boostTreasury.pullForBoost(theirVault);

        // And a genuine escrow cannot act for a market it is not the recipient of. It refuses at
        // enrolment, before the treasury is ever consulted — the earlier of the two checks.
        vm.expectRevert(
            abi.encodeWithSelector(BoostEscrow.VaultPaysSomeoneElse.selector, theirToken, theirVault, thief)
        );
        escrow.enroll(theirToken);
    }

    /// @notice Agen cannot switch a market's Boost on or off, in either direction.
    ///
    /// @dev Worth pinning explicitly now that Agen's own revenue is at stake. Agen gives up its
    /// share by deploying an Instant whose treasury is this contract; after that the decision
    /// belongs to the creator alone, which is the only arrangement under which "Agen also gives up
    /// its fee" is a property of the market rather than of Agen's continued goodwill.
    function test_agenCannotToggleAMarketsBoost() public {
        vm.prank(agenTreasury);
        vm.expectRevert(abi.encodeWithSelector(BoostEscrow.NotOwner.selector, agenTreasury));
        escrow.enableBoost(token);

        // Nor by going at the treasury directly: it only takes instructions from the market's own
        // escrow, and Agen is not one.
        vm.prank(agenTreasury);
        vm.expectRevert();
        boostTreasury.setBoost(address(vault), true, 0);
    }

    /// @notice The treasury pays Agen and nothing else, whoever asks.
    function test_theTreasuryOnlyEverPaysAgen() public {
        _buy(2 ether);
        boostTreasury.settle(address(vault));

        (, uint256 owed,) = InstantFees.split(2 ether);
        assertEq(boostTreasury.platformStateOf(address(vault)).agenPending, owed);

        // A stranger triggering it pays Agen, which is the same property `claimPlatform` has.
        vm.prank(stranger);
        boostTreasury.withdrawAgen(address(vault));

        assertEq(agenTreasury.balance, owed, "Agen was paid");
        assertEq(boostTreasury.agenTreasury(), agenTreasury, "and the destination is an immutable");
        assertEq(address(boostTreasury).balance, 0, "the treasury holds nothing between claims");
    }

    /// @notice Deploying an escrow twice returns the same one.
    function test_escrowDeploymentIsIdempotent() public {
        BoostEscrow again = escrows.deploy(creator);
        assertEq(address(again), address(escrow), "the same address, no second contract");
        assertTrue(escrows.isDeployed(creator));
        assertFalse(escrows.isDeployed(makeAddr("nobody")));
    }
}
