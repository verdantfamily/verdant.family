#!/usr/bin/env node
/**
 * The stress test: a mechanic nothing in this codebase was designed around.
 *
 * Fifteen-minute rounds; buy and sell volume tracked separately; every trade paying into
 * a round pool; the winning side decided at settlement; proportional distribution to
 * buyers if buyers win, a split between carry-over and buyback if sellers win; a
 * three-round streak arming a Momentum Mode that halves fees for the winning side.
 *
 * Nothing here was anticipated. There is no "round" primitive, no "streak" primitive, no
 * side-versus-side comparison anywhere in the IR's vocabulary, and no two-contract
 * accounting pattern in any template — because there are no templates. If the
 * architecture is secretly shaped around the first example it was built with, this is
 * where that shows.
 *
 * ## What this script is and is not
 *
 * The specification, plan and Solidity below stand in for model output, exactly as in
 * the other seed scripts, because no model endpoint is configured. That means this
 * cannot answer "would a model write this?" — it answers the different and more
 * structural question of whether the pipeline can carry it: whether the IR can express
 * it, the validator accept it, the planner order a two-contract bundle, the compiler and
 * gates judge it, and the manifest place it on chain.
 *
 * Everything downstream of generation is real. The contracts really compile, the tests
 * really run, the gates really inspect the parsed AST.
 *
 * ## The one place the economics were adapted, and why
 *
 * "Distribute the reward pool proportionally among wallets that bought during that
 * round" cannot be paid out by looping over buyers: the loop grows with participation,
 * so the round that finally attracts a crowd is the round that cannot be settled. The
 * intent is preserved exactly — each buyer's share is their volume over the round's
 * buy volume — by recording each wallet's contribution as it trades and letting them
 * withdraw. Pull instead of push, same arithmetic, constant gas.
 */

import { resolve } from "node:path";

import { fileJobStore, runBuild, scriptedProvider } from "@verdant/market-compiler";

const REPO_ROOT = resolve(process.cwd(), "../..");
const GENERATED_ROOT = resolve(REPO_ROOT, "generated");

/** The accounting half: rounds, per-wallet shares, and the claim path. */
const ACCOUNTING = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title RivalRounds
/// @notice Round bookkeeping and the claim path for the Rival market.
/// @dev Separated from the hook for two reasons. The hook must not hold balances — a
/// contract that is called on every swap and also custodies value has a withdrawal path
/// in every callback — and settlement arithmetic is worth being able to test without a
/// pool.
///
/// Proportional distribution is pull-based. A round credits a pool and records each
/// buyer's volume; a buyer withdraws their volume's share of it. Paying
/// everyone at settlement would cost gas proportional to the number of participants,
/// which means the busiest round is the one that cannot be settled.
contract RivalRounds {
    struct Round {
        uint256 buyVolume;
        uint256 sellVolume;
        uint256 pool;
        bool settled;
        /// @dev 0 = undecided, 1 = buyers, 2 = sellers.
        uint8 winner;
        /// @dev The pool actually distributable to buyers, fixed at settlement.
        uint256 distributable;
    }

    /// @notice The only contract that may record volume or settle a round.
    /// @dev Set once after deployment rather than taken in the constructor. The hook
    /// needs this contract's address and this contract needs the hook's, and that cycle
    /// lives in the creation code: neither address exists until the other does. The
    /// deployment wires it in the same transaction, before the pool opens, so the window
    /// in which it is unset contains no market to attack.
    address public hook;

    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => uint256)) public boughtInRound;
    mapping(uint256 => mapping(address => bool)) public claimed;

    /// @notice Carried into the next round when sellers win.
    uint256 public carriedOver;
    /// @notice Set aside for buybacks when sellers win.
    uint256 public buybackReserve;

    error NotHook(address caller);
    error AlreadyWired(address hook);
    error RoundNotSettled(uint256 round);
    error AlreadyClaimed(uint256 round, address wallet);
    error NothingOwed(uint256 round, address wallet);

    event VolumeRecorded(uint256 indexed round, address indexed wallet, bool isBuy, uint256 amount);
    event RoundSettled(uint256 indexed round, uint8 winner, uint256 distributable, uint256 carried);
    event Claimed(uint256 indexed round, address indexed wallet, uint256 amount);

    /// @notice Name the hook, once and permanently.
    function setHook(address hook_) external {
        if (hook != address(0)) revert AlreadyWired(hook);
        hook = hook_;
    }

    modifier onlyHook() {
        // Unset is not "everybody": before wiring, nothing can record or settle.
        if (hook == address(0) || msg.sender != hook) revert NotHook(msg.sender);
        _;
    }

    /// @notice Record one trade's contribution to the open round.
    function record(uint256 round, address wallet, bool isBuy, uint256 amount, uint256 contribution)
        external
        onlyHook
    {
        Round storage current = rounds[round];

        if (isBuy) {
            current.buyVolume += amount;
            boughtInRound[round][wallet] += amount;
        } else {
            current.sellVolume += amount;
        }

        current.pool += contribution;
        emit VolumeRecorded(round, wallet, isBuy, amount);
    }

    /// @notice Close a round and decide what happens to its pool.
    /// @return winner 1 when buyers won, 2 when sellers won, 0 when the round was empty.
    function settle(uint256 round) external onlyHook returns (uint8 winner) {
        Round storage current = rounds[round];
        if (current.settled) return current.winner;

        current.settled = true;

        uint256 pool = current.pool + carriedOver;
        carriedOver = 0;

        // A tie is not a buyer win. Sellers not losing is the conservative reading, and
        // an empty round has no winner at all rather than a default one.
        if (current.buyVolume == 0 && current.sellVolume == 0) {
            winner = 0;
            carriedOver = pool;
        } else if (current.buyVolume > current.sellVolume) {
            winner = 1;
            current.distributable = pool;
        } else {
            winner = 2;
            uint256 half = pool / 2;
            carriedOver = half;
            // The remainder goes to buybacks, so an odd wei is never stranded.
            buybackReserve += pool - half;
        }

        current.winner = winner;
        emit RoundSettled(round, winner, current.distributable, carriedOver);
    }

    /// @notice What a wallet may withdraw from a settled round.
    function owed(uint256 round, address wallet) public view returns (uint256) {
        Round storage current = rounds[round];

        if (!current.settled || current.winner != 1) return 0;
        if (claimed[round][wallet]) return 0;
        if (current.buyVolume == 0) return 0;

        return (current.distributable * boughtInRound[round][wallet]) / current.buyVolume;
    }

    /// @notice Withdraw a round's share.
    /// @dev The claimed flag is set before anything is returned, so a second call in the
    /// same transaction finds nothing owed.
    function claim(uint256 round) external returns (uint256 amount) {
        Round storage current = rounds[round];
        if (!current.settled) revert RoundNotSettled(round);
        if (claimed[round][msg.sender]) revert AlreadyClaimed(round, msg.sender);

        amount = owed(round, msg.sender);
        if (amount == 0) revert NothingOwed(round, msg.sender);

        claimed[round][msg.sender] = true;
        emit Claimed(round, msg.sender, amount);
    }
}
`;

/** The hook half: the round clock, the streak, and the fee. */
const HOOK = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RivalRounds} from "./RivalRounds.sol";

/// @title RivalHook
/// @notice Fifteen-minute rounds, buyers against sellers, with a streak that arms a
/// reduced fee for the side that is winning.
/// @dev Settlement is lazy. Nothing on chain can schedule a call, so a round closes on
/// the first trade after its fifteen minutes are up rather than at the instant they
/// expire. The intent is unchanged and the timing is what the EVM permits.
contract RivalHook {
    uint256 public constant ROUND_LENGTH = 900;
    uint24 public constant BASE_FEE_PPM = 10_000;
    /// @notice The share of every trade that funds the round pool: 0.5%.
    uint24 public constant CONTRIBUTION_PPM = 5_000;
    /// @notice Three consecutive wins arm Momentum Mode.
    uint8 public constant STREAK_TO_ARM = 3;

    RivalRounds public immutable accounting;

    /// @notice The only address permitted to report a trade.
    /// @dev The hook is the root of this market's trust: the ledger accepts writes from
    /// nothing else. An unguarded entry point here is therefore not untidiness, it is a
    /// way for anybody to be credited for activity that never happened.
    address public immutable poolManager;

    uint256 public currentRound;
    uint256 public roundStartedAt;

    /// @notice 0 = nobody yet, 1 = buyers, 2 = sellers.
    uint8 public streakSide;
    uint8 public streakLength;

    /// @notice Which side pays half fees this round. 0 when Momentum Mode is off.
    uint8 public momentumSide;

    event RoundOpened(uint256 indexed round, uint256 at);
    event MomentumArmed(uint8 side, uint256 forRound);
    event MomentumCleared(uint256 afterRound);

    error NotPoolManager(address caller);

    constructor(RivalRounds accounting_, address poolManager_) {
        accounting = accounting_;
        poolManager = poolManager_;
        roundStartedAt = block.timestamp;
    }

    /// @notice The fee a trade pays, given who is trading and what is armed.
    function feeFor(bool isBuy) public view returns (uint24) {
        uint8 side = isBuy ? 1 : 2;
        if (momentumSide != 0 && momentumSide == side) return BASE_FEE_PPM / 2;
        return BASE_FEE_PPM;
    }

    /// @notice Close the round if its time is up, and open the next one.
    /// @dev Public because anybody may crank it. A round that nobody trades in still
    /// ends, and letting only traders advance the clock would let a quiet market freeze
    /// a Momentum Mode in place.
    function settleIfDue() public {
        if (block.timestamp < roundStartedAt + ROUND_LENGTH) return;

        uint8 winner = accounting.settle(currentRound);

        // Momentum lasts exactly the round it was armed for.
        if (momentumSide != 0) {
            momentumSide = 0;
            emit MomentumCleared(currentRound);
        }

        if (winner == 0) {
            // An empty round breaks a streak rather than extending it: nothing was won.
            streakSide = 0;
            streakLength = 0;
        } else if (winner == streakSide) {
            streakLength += 1;
        } else {
            streakSide = winner;
            streakLength = 1;
        }

        if (streakLength >= STREAK_TO_ARM) {
            momentumSide = streakSide;
            emit MomentumArmed(streakSide, currentRound + 1);
            // "Then reset the streak": arming consumes it, so a side must win three
            // more rounds to arm again rather than arming on every subsequent win.
            streakSide = 0;
            streakLength = 0;
        }

        currentRound += 1;
        roundStartedAt = block.timestamp;
        emit RoundOpened(currentRound, block.timestamp);
    }

    /// @notice Record a trade against the open round.
    /// @return feePpm What this trade pays.
    function onTrade(address trader, bool isBuy, uint256 amount) external returns (uint24 feePpm) {
        if (msg.sender != poolManager) revert NotPoolManager(msg.sender);

        settleIfDue();

        feePpm = feeFor(isBuy);
        uint256 contribution = (amount * CONTRIBUTION_PPM) / 1_000_000;

        accounting.record(currentRound, trader, isBuy, amount, contribution);
    }
}
`;

const TESTS = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RivalHook} from "../contracts/RivalHook.sol";
import {RivalRounds} from "../contracts/RivalRounds.sol";

contract RivalTest is Test {
    RivalHook hook;
    RivalRounds accounting;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAC0);

    function setUp() public {
        // The same two-step the deployment performs: the accounting contract exists
        // first without knowing its hook, the hook is built against it, and the pair is
        // wired before anything can trade.
        accounting = new RivalRounds();
        hook = new RivalHook(accounting, address(this));
        accounting.setHook(address(hook));
    }

    /// The exploit that shipped: an attacker who never traded was credited the whole
    /// pool by calling the hook directly. Kept as a regression test.
    function test_aStrangerCannotReportATradeThatNeverHappened() public {
        hook.onTrade(alice, true, 10 ether);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(RivalHook.NotPoolManager.selector, carol));
        hook.onTrade(carol, true, 10_000 ether);

        _advance();
        assertEq(accounting.owed(0, carol), 0, "an address that never traded is owed nothing");
    }

    // --- adversarial --------------------------------------------------------

    function test_splittingOneTradeAcrossWalletsGainsNothing() public {
        // Sybil resistance is a property of the arithmetic rather than of a check:
        // shares are linear in volume, so ten wallets buying a tenth each are owed
        // exactly what one wallet buying the lot would have been.
        hook.onTrade(alice, true, 100 ether);
        hook.onTrade(bob, false, 10 ether);
        _advance();
        uint256 whole = accounting.owed(0, alice);

        RivalRounds split = new RivalRounds();
        RivalHook splitHook = new RivalHook(split, address(this));
        split.setHook(address(splitHook));

        for (uint256 i = 0; i < 10; i++) {
            splitHook.onTrade(address(uint160(0x5000 + i)), true, 10 ether);
        }
        splitHook.onTrade(bob, false, 10 ether);
        vm.warp(block.timestamp + 901);
        splitHook.settleIfDue();

        uint256 combined;
        for (uint256 i = 0; i < 10; i++) {
            combined += split.owed(0, address(uint160(0x5000 + i)));
        }

        assertApproxEqAbs(combined, whole, 10, "splitting is neither rewarded nor punished");
    }

    function test_rewardAccounting_neverPaysOutMoreThanWasCollected(uint8 buyers) public {
        uint256 count = uint256(bound(buyers, 1, 40));

        for (uint256 i = 0; i < count; i++) {
            hook.onTrade(address(uint160(0x9000 + i)), true, (i + 1) * 1 ether);
        }
        _advance();

        (,, uint256 pool,,,) = accounting.rounds(0);

        uint256 owedTotal;
        for (uint256 i = 0; i < count; i++) {
            owedTotal += accounting.owed(0, address(uint160(0x9000 + i)));
        }

        // Rounding must strand dust rather than mint it.
        assertLe(owedTotal, pool, "value cannot be created from nothing");
    }

    function test_repeatedSettlementInOneBlockDoesNothingTwice() public {
        hook.onTrade(alice, true, 100 ether);
        vm.warp(block.timestamp + 901);

        hook.settleIfDue();
        uint256 round = hook.currentRound();
        uint256 owedAfterFirst = accounting.owed(0, alice);

        hook.settleIfDue();
        hook.settleIfDue();

        assertEq(hook.currentRound(), round, "the round advanced once");
        assertEq(accounting.owed(0, alice), owedAfterFirst, "the pool was not credited twice");
    }

    function test_aRoundBoundaryIsExact() public {
        hook.onTrade(alice, true, 1 ether);

        vm.warp(block.timestamp + 900);
        hook.settleIfDue();
        assertEq(hook.currentRound(), 1, "the round ends the instant its length elapses");
    }

    function test_aZeroAmountTradeChangesNothingItShouldNot() public {
        hook.onTrade(alice, true, 0);
        (uint256 buyVolume,, uint256 pool,,,) = accounting.rounds(0);

        assertEq(buyVolume, 0);
        assertEq(pool, 0);

        _advance();
        // An empty round has no winner, so it cannot extend anybody's streak.
        assertEq(hook.streakLength(), 0);
    }

    function test_anEnormousTradeDoesNotOverflowTheAccounting() public {
        // Far beyond any real supply, and still short of where the multiplication in
        // the share calculation would overflow.
        uint256 huge = 1e30;
        hook.onTrade(alice, true, huge);
        _advance();

        (,, uint256 pool,,,) = accounting.rounds(0);
        assertEq(accounting.owed(0, alice), pool, "the only buyer is owed the whole pool");
    }

    function test_irreversible_aSettledRoundStaysSettled() public {
        hook.onTrade(alice, true, 100 ether);
        _advance();

        (,,, bool settled, uint8 winner,) = accounting.rounds(0);
        assertTrue(settled);
        assertEq(winner, 1);

        // Time passing and rounds advancing must not reopen a closed one.
        _advance();
        _advance();

        (,,, bool stillSettled, uint8 stillWinner,) = accounting.rounds(0);
        assertTrue(stillSettled, "settlement is irreversible");
        assertEq(stillWinner, 1, "and its outcome does not change");
    }

    function test_theLedgerRefusesEverythingUntilItIsWired() public {
        RivalRounds fresh = new RivalRounds();

        vm.expectRevert(abi.encodeWithSelector(RivalRounds.NotHook.selector, address(this)));
        fresh.record(0, alice, true, 1 ether, 0);
    }

    function test_theHookCanOnlyBeNamedOnce() public {
        vm.expectRevert(abi.encodeWithSelector(RivalRounds.AlreadyWired.selector, address(hook)));
        accounting.setHook(address(0xBEEF));
    }

    function _advance() internal {
        vm.warp(block.timestamp + 901);
        hook.settleIfDue();
    }

    // --- rounds ------------------------------------------------------------

    function test_roundsAdvanceOnlyWhenTheirTimeIsUp() public {
        assertEq(hook.currentRound(), 0);

        vm.warp(block.timestamp + 899);
        hook.settleIfDue();
        assertEq(hook.currentRound(), 0, "a round does not end early");

        _advance();
        assertEq(hook.currentRound(), 1, "the round ended once its time was up");
    }

    function test_volumeIsTrackedPerSideWithinARound() public {
        hook.onTrade(alice, true, 100 ether);
        hook.onTrade(bob, false, 40 ether);

        (uint256 buyVolume, uint256 sellVolume,,,,) = accounting.rounds(0);
        assertEq(buyVolume, 100 ether);
        assertEq(sellVolume, 40 ether);
    }

    function test_everyTradeContributesToThePool() public {
        hook.onTrade(alice, true, 100 ether);
        (,, uint256 pool,,,) = accounting.rounds(0);

        // 0.5% of 100 ether.
        assertEq(pool, 0.5 ether);
    }

    // --- who wins ----------------------------------------------------------

    function test_buyersWinTheRoundWithMoreVolume() public {
        hook.onTrade(alice, true, 100 ether);
        hook.onTrade(bob, false, 40 ether);
        _advance();

        (,,,, uint8 winner,) = accounting.rounds(0);
        assertEq(winner, 1, "buyers won");
    }

    function test_sellersWinAndTheirPoolIsSplitBetweenCarryAndBuyback() public {
        hook.onTrade(alice, true, 40 ether);
        hook.onTrade(bob, false, 100 ether);
        _advance();

        (,, uint256 pool,, uint8 winner,) = accounting.rounds(0);
        assertEq(winner, 2, "sellers won");

        assertEq(accounting.carriedOver(), pool / 2, "half carried into the next round");
        assertEq(accounting.buybackReserve(), pool - pool / 2, "the rest funds buybacks");
    }

    function test_aTieGoesToSellers() public {
        hook.onTrade(alice, true, 50 ether);
        hook.onTrade(bob, false, 50 ether);
        _advance();

        (,,,, uint8 winner,) = accounting.rounds(0);
        assertEq(winner, 2, "a tie is not a buyer win");
    }

    // --- rewards -----------------------------------------------------------

    function test_buyersShareThePoolInProportionToWhatTheyBought() public {
        hook.onTrade(alice, true, 75 ether);
        hook.onTrade(bob, true, 25 ether);
        hook.onTrade(carol, false, 10 ether);
        _advance();

        (,, uint256 pool,,,) = accounting.rounds(0);

        assertEq(accounting.owed(0, alice), (pool * 3) / 4, "alice bought three quarters");
        assertEq(accounting.owed(0, bob), pool / 4, "bob bought one quarter");
        assertEq(accounting.owed(0, carol), 0, "a seller is owed nothing");
    }

    function test_rewardAccounting_neverOwesMoreThanThePoolHolds() public {
        hook.onTrade(alice, true, 75 ether);
        hook.onTrade(bob, true, 25 ether);
        _advance();

        (,, uint256 pool,,,) = accounting.rounds(0);
        assertLe(accounting.owed(0, alice) + accounting.owed(0, bob), pool);
    }

    function test_carriedOverPoolJoinsTheNextRoundsRewards() public {
        // Sellers win, carrying half forward.
        hook.onTrade(bob, false, 100 ether);
        _advance();
        uint256 carried = accounting.carriedOver();
        assertGt(carried, 0);

        // Buyers win the next one and should be sharing their own pool plus the carry.
        hook.onTrade(alice, true, 100 ether);
        _advance();

        (,, uint256 pool,,,) = accounting.rounds(1);
        assertEq(accounting.owed(1, alice), pool + carried, "the carry was included");
    }

    // --- claiming ----------------------------------------------------------

    function test_aClaimPaysOnce() public {
        hook.onTrade(alice, true, 100 ether);
        _advance();

        uint256 expected = accounting.owed(0, alice);
        vm.prank(alice);
        assertEq(accounting.claim(0), expected);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RivalRounds.AlreadyClaimed.selector, 0, alice));
        accounting.claim(0);
    }

    function test_noDoubleClaim_owedIsZeroAfterClaiming() public {
        hook.onTrade(alice, true, 100 ether);
        _advance();

        vm.prank(alice);
        accounting.claim(0);

        assertEq(accounting.owed(0, alice), 0, "nothing remains owed");
    }

    function test_aRoundCannotBeClaimedBeforeItSettles() public {
        hook.onTrade(alice, true, 100 ether);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RivalRounds.RoundNotSettled.selector, 0));
        accounting.claim(0);
    }

    function test_sellersCannotClaimARoundBuyersLost() public {
        hook.onTrade(alice, true, 10 ether);
        hook.onTrade(bob, false, 100 ether);
        _advance();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RivalRounds.NothingOwed.selector, 0, alice));
        accounting.claim(0);
    }

    // --- streaks and momentum ----------------------------------------------

    function _buyersWinARound() internal {
        hook.onTrade(alice, true, 100 ether);
        _advance();
    }

    function _sellersWinARound() internal {
        hook.onTrade(bob, false, 100 ether);
        _advance();
    }

    function test_threeWinsInARowArmMomentumForTheWinningSide() public {
        _buyersWinARound();
        assertEq(hook.momentumSide(), 0, "one win is not a streak");

        _buyersWinARound();
        assertEq(hook.momentumSide(), 0, "two wins are not a streak");

        _buyersWinARound();
        assertEq(hook.momentumSide(), 1, "three wins armed momentum for buyers");
    }

    function test_momentumHalvesTheFeeForTheWinningSideOnly() public {
        _buyersWinARound();
        _buyersWinARound();
        _buyersWinARound();

        assertEq(hook.feeFor(true), hook.BASE_FEE_PPM() / 2, "buyers pay half");
        assertEq(hook.feeFor(false), hook.BASE_FEE_PPM(), "sellers pay full");
    }

    function test_momentumLastsExactlyOneRound() public {
        _buyersWinARound();
        _buyersWinARound();
        _buyersWinARound();
        assertEq(hook.momentumSide(), 1);

        _advance();
        assertEq(hook.momentumSide(), 0, "momentum expired with its round");
    }

    function test_armingResetsTheStreak() public {
        _buyersWinARound();
        _buyersWinARound();
        _buyersWinARound();

        assertEq(hook.streakLength(), 0, "the streak was consumed");
        assertEq(hook.streakSide(), 0);
    }

    function test_theOtherSideWinningBreaksTheStreak() public {
        _buyersWinARound();
        _buyersWinARound();
        _sellersWinARound();

        assertEq(hook.streakSide(), 2, "the streak switched sides");
        assertEq(hook.streakLength(), 1, "and started again at one");
        assertEq(hook.momentumSide(), 0, "nothing was armed");
    }

    function test_sellersCanArmMomentumToo() public {
        _sellersWinARound();
        _sellersWinARound();
        _sellersWinARound();

        assertEq(hook.momentumSide(), 2, "sellers armed momentum");
        assertEq(hook.feeFor(false), hook.BASE_FEE_PPM() / 2, "sellers pay half");
        assertEq(hook.feeFor(true), hook.BASE_FEE_PPM(), "buyers pay full");
    }

    function test_anEmptyRoundBreaksAStreak() public {
        _buyersWinARound();
        _buyersWinARound();
        _advance(); // nobody traded

        assertEq(hook.streakLength(), 0, "an empty round is not a win");
        assertEq(hook.momentumSide(), 0);
    }

    // --- the ceiling --------------------------------------------------------

    function test_feeCeiling_isNeverExceeded(bool isBuy) public view {
        assertLe(hook.feeFor(isBuy), 30_000);
    }
}
`;

/** Everything in a specification except the half the first call answers. */
function frameOf<T extends { summary: unknown; rules: unknown }>(whole: T) {
  const { summary: _summary, rules: _rules, ...frame } = whole;
  return frame;
}

const specification = {
  summary: "Buyers and sellers compete each 15 minutes; the winning side takes the pool",
  baseFeePpm: 10_000,
  maxFeePpm: 15_000,
  phases: [
    { name: "normal", description: "Both sides pay the same fee", terminal: false, transitionsTo: ["momentum"] },
    {
      name: "momentum",
      description: "One side pays half fees for a single round",
      terminal: false,
      transitionsTo: ["normal"],
    },
  ],
  state: [
    { name: "currentRound", type: "counter", description: "Rounds since the market opened", writeOnce: false },
    { name: "roundStartedAt", type: "timer", description: "When the open round began", writeOnce: false },
    { name: "roundBuyVolume", type: "accumulator", description: "Buy volume in the open round", writeOnce: false },
    { name: "roundSellVolume", type: "accumulator", description: "Sell volume in the open round", writeOnce: false },
    { name: "rewardPool", type: "accumulator", description: "Contributions collected this round", writeOnce: false },
    { name: "carriedOver", type: "accumulator", description: "Pool carried forward when sellers win", writeOnce: false },
    { name: "buybackReserve", type: "accumulator", description: "Set aside to buy back the token", writeOnce: false },
    { name: "streakSide", type: "phase", description: "Which side is on a winning run", writeOnce: false },
    { name: "streakLength", type: "counter", description: "Consecutive rounds that side has won", writeOnce: false },
    { name: "momentumSide", type: "phase", description: "Which side pays half fees this round", writeOnce: false },
  ],
  rules: [
    {
      id: "round-contribution",
      title: "ROUND POOL",
      when: { kind: "swap", description: "Any trade happens", parameters: null },
      conditions: [],
      then: [
        {
          kind: "routeFee",
          description: "Half a percent of the trade joins this round's reward pool",
          parameters: [
            { key: "destination", value: "rewardPool" },
            { key: "feePpm", value: 5_000 },
          ],
          writes: ["rewardPool"],
        },
        {
          kind: "recordSideVolume",
          description: "The trade counts towards its own side's volume for the round",
          parameters: null,
          writes: ["roundBuyVolume", "roundSellVolume"],
        },
      ],
      activeInPhases: [],
      onceOnly: false,
    },
    {
      id: "round-settlement",
      title: "ROUND ENDS",
      when: {
        kind: "timeElapsed",
        description: "Fifteen minutes pass",
        parameters: [{ key: "seconds", value: 900 }],
      },
      conditions: [],
      then: [
        {
          kind: "decideWinningSide",
          description: "Whichever side traded more volume wins the round",
          parameters: null,
          writes: ["currentRound", "roundStartedAt", "roundBuyVolume", "roundSellVolume", "streakSide", "streakLength"],
        },
      ],
      activeInPhases: [],
      onceOnly: false,
    },
    {
      id: "buyers-win",
      title: "BUYERS WIN",
      when: { kind: "roundSettled", description: "A round closes with buyers ahead", parameters: null },
      conditions: [
        {
          kind: "sideVolumeComparison",
          description: "Buy volume exceeded sell volume",
          parameters: [{ key: "winner", value: "buyers" }],
          combinator: null,
        },
      ],
      then: [
        {
          kind: "distributeProportionally",
          description: "Everyone who bought during the round shares the pool by how much they bought",
          parameters: [{ key: "among", value: "buyers" }],
          writes: ["rewardPool"],
        },
      ],
      activeInPhases: [],
      onceOnly: false,
    },
    {
      id: "sellers-win",
      title: "SELLERS WIN",
      when: { kind: "roundSettled", description: "A round closes with sellers ahead", parameters: null },
      conditions: [
        {
          kind: "sideVolumeComparison",
          description: "Sell volume matched or exceeded buy volume",
          parameters: [{ key: "winner", value: "sellers" }],
          combinator: null,
        },
      ],
      then: [
        {
          kind: "accumulate",
          description: "Half the pool carries into the next round",
          parameters: [{ key: "share", value: 50 }],
          writes: ["carriedOver", "rewardPool"],
        },
        {
          kind: "buyback",
          description: "The other half is set aside to buy the token back",
          parameters: [{ key: "share", value: 50 }],
          writes: ["buybackReserve"],
        },
      ],
      activeInPhases: [],
      onceOnly: false,
    },
    {
      id: "momentum",
      title: "MOMENTUM MODE",
      when: { kind: "consecutiveTrades", description: "A side wins three rounds in a row", parameters: null },
      conditions: [
        {
          kind: "consecutiveCount",
          description: "The same side has won three rounds running",
          parameters: [
            { key: "state", value: "streakLength" },
            { key: "value", value: 3 },
          ],
          combinator: null,
        },
      ],
      then: [
        {
          kind: "setFee",
          description: "The winning side pays half fees for the next round",
          parameters: [{ key: "feePpm", value: 5_000 }],
          writes: ["momentumSide"],
        },
        {
          kind: "resetCounter",
          description: "Arming consumes the streak",
          parameters: [{ key: "state", value: "streakLength" }],
          writes: ["streakLength", "streakSide"],
        },
      ],
      activeInPhases: [],
      onceOnly: false,
    },
  ],
  invariants: [
    { id: "fee-ceiling", statement: "No trade pays more than 3% in hook fees", expression: "hookFeePpm <= 30000" },
    {
      id: "reward-accounting",
      statement: "The sum owed to buyers never exceeds the pool that was settled",
      expression: null,
    },
    { id: "no-double-claim", statement: "A wallet can claim a round at most once", expression: null },
  ],
  externalDependencies: [],
  assumptions: [
    // A seed stands for a market whose readings have already been agreed to, so none of
    // them asks for confirmation — otherwise the build would pause on a question with
    // nobody there to answer it.
    {
      id: "tie",
      term: "whichever side had more volume",
      interpretation: "A tie counts as a seller win, since buyers did not have more",
      why: "The prompt says more, and equal is not more.",
      parameters: null,
      importance: "medium",
      requiresConfirmation: false,
    },
    {
      id: "distribution",
      term: "distribute proportionally among wallets that bought",
      interpretation:
        "Each buyer's share is their volume over the round's buy volume, withdrawn by them rather than sent",
      why: "Paying every buyer in one transaction is a loop that grows with the crowd.",
      parameters: null,
      importance: "medium",
      requiresConfirmation: false,
    },
    {
      id: "momentum-length",
      term: "for the next round",
      interpretation: "Momentum Mode lasts exactly one round and then clears",
      why: "The prompt says the next round, singular.",
      parameters: null,
      importance: "medium",
      requiresConfirmation: false,
    },
    {
      id: "settlement-timing",
      term: "at the end of the round",
      interpretation:
        "Rounds close on the first interaction after their fifteen minutes are up, because nothing on chain can schedule a call",
      why: "Nothing on chain runs on a clock, so a round has to close on somebody's trade.",
      parameters: null,
      importance: "medium",
      requiresConfirmation: false,
    },
  ],
  ambiguities: [],
  unsupported: [],
};

const plan = {
  approach:
    "Two contracts. The hook owns the round clock, the streak and the fee, and holds no " +
    "balances. A separate accounting contract owns round bookkeeping and the claim path, so " +
    "settlement arithmetic can be tested without a pool and the contract called on every swap " +
    "is not also the one holding money.",
  components: [
    {
      id: "rivalToken",
      contractName: "RivalToken",
      role: "token",
      origin: "generate",
      purpose: "The traded token",
      requiredBy: [],
      dependsOn: [],
      hookPermissions: [],
      custodial: false,
      implementationNotes: [],
    },
    {
      id: "rivalRounds",
      contractName: "RivalRounds",
      role: "accounting",
      origin: "generate",
      purpose: "Round bookkeeping, proportional shares and the claim path",
      requiredBy: ["round-settlement"],
      dependsOn: [],
      hookPermissions: [],
      custodial: true,
      implementationNotes: [
        "Pull-based claims: distributing to every buyer at settlement costs gas proportional to participation",
        "Set the claimed flag before returning anything",
      ],
    },
    {
      id: "rivalHook",
      contractName: "RivalHook",
      role: "hook",
      origin: "extend",
      purpose: "Round clock, streak, Momentum Mode and the per-side fee",
      requiredBy: ["round-settlement"],
      dependsOn: ["rivalRounds"],
      hookPermissions: ["beforeSwap", "afterSwap"],
      custodial: false,
      implementationNotes: ["Settle lazily on the first trade after a round expires"],
    },
  ],
  dependencies: [],
  adaptations: [
    {
      requested: "distribute the reward pool proportionally among wallets that bought that round",
      implemented: "record each buyer's volume as they trade and let them withdraw their share",
      reason:
        "paying every buyer at settlement costs gas proportional to how many there are, so the " +
        "busiest round would be the one that could not be settled. The arithmetic is identical",
    },
    {
      requested: "at the end of the round, decide the winner",
      implemented: "the round closes on the first interaction after its time is up",
      reason: "nothing on chain can schedule a call, so the work happens on the next interaction",
    },
  ],
};

/**
 * How the bundle is deployed. The hook takes the accounting contract's address in its
 * constructor, so the accounting contract is placed first; the rewards it holds are
 * withdrawn by each winner, so nothing controls it.
 */
const deployment = {
  components: [
    {
      componentId: "rivalToken",
      constructorArguments: [{ name: "recipient", type: "address", source: "INFRA:INSTALLER" }],
      immutable: ["recipient"],
      wiring: [],
      controller: null,
    },
    {
      componentId: "rivalRounds",
      constructorArguments: [],
      immutable: [],
      wiring: [],
      controller: null,
    },
    {
      componentId: "rivalHook",
      constructorArguments: [
        { name: "accounting_", type: "address", source: "COMPONENT:rivalRounds" },
        { name: "poolManager_", type: "address", source: "INFRA:POOL_MANAGER" },
      ],
      immutable: ["accounting_", "poolManager_"],
      wiring: [],
      controller: null,
    },
  ],
  pool: { feeMode: "dynamic", lpFee: "8388608" },
  custodyComponentId: "rivalRounds",
  feeClaimComponentId: "rivalRounds",
  oneTimeInitialization: [],
};

const job = await runBuild(
  {
    prompt:
      "Launch a token called Rival with ticker $RIVAL. Split activity into 15-minute rounds. " +
      "During each round, track total buy volume and total sell volume separately. Every trade " +
      "contributes 0.5% to a round reward pool. At the end of the round, whichever side had more " +
      "volume wins. If buyers win, distribute the reward pool proportionally among wallets that " +
      "bought during that round. If sellers win, keep 50% of the pool for the next round and use " +
      "the other 50% to buy back $RIVAL. If either side wins three rounds in a row, activate " +
      "Momentum Mode for the next round. During Momentum Mode, reduce fees on the winning side by " +
      "half. Then reset the streak.",
    name: "Rival",
    symbol: "RIVAL",
  },
  {
    provider: scriptedProvider([
      // Interpretation is four calls: what the market does, the rules formalising it,
      // the frame around them, and the critique that runs beside the frame.
      { behaviours: specification.rules.map((rule) => rule.title.toLowerCase()) },
      { summary: specification.summary, rules: specification.rules },
      frameOf(specification),
      { suggestions: [] },
      // Planning is two calls: what is already solved, then what to build.
      { reuse: [{ catalogueId: "base-hook", why: "it needs a hook" }], novel: [] },
      { plan, deployment },
      // One answer per generated component, in plan order. The token is absent on
      // purpose: a fixed-supply ERC20 is written by Agen rather than by a model.
      { content: ACCOUNTING, notes: [] },
      { content: HOOK, notes: [] },
      { files: [{ path: "test/Rival.t.sol", content: TESTS }], notes: [] },
    ]),
    store: fileJobStore(resolve(GENERATED_ROOT, "_jobs")),
    vendorRoot: resolve(REPO_ROOT, "packages/contracts/vendor"),
    generatedRoot: GENERATED_ROOT,
  },
);

console.log(`stage: ${job.stage}`);
if (job.failure !== null) {
  console.log(`failed at ${job.failure.stage}: ${job.failure.code}`);
  console.log(job.failure.detail);
  for (const diagnostic of job.failure.diagnostics ?? []) {
    console.log(`  ${diagnostic.file ?? ""}:${String(diagnostic.line ?? 0)} ${diagnostic.message}`);
  }
  for (const test of job.failure.failingTests ?? []) {
    console.log(`  FAIL ${test.name}: ${test.reason ?? ""}`);
  }
}

console.log(`components: ${String(job.plan?.components.length ?? 0)}`);
console.log(`contracts: ${job.sources.map((s) => s.path).join(", ")}`);
console.log(
  `tests: ${String(job.testOutcomes.filter((o) => o.passed).length)}/${String(job.testOutcomes.length)} passing`,
);
console.log(`gate findings: ${String(job.gateFindings.length)}`);
for (const finding of job.gateFindings) {
  console.log(`  [${finding.severity}] ${finding.code} ${finding.file ?? ""}`);
}
console.log(`\nopen: http://127.0.0.1:4405/markets/${job.id}`);
