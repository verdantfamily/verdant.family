// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {PositionLocker} from "../../src/PositionLocker.sol";
import {VerdantFactory} from "../../src/VerdantFactory.sol";
import {VerdantToken} from "../../src/VerdantToken.sol";
import {LaunchBounds} from "../../src/libraries/LaunchBounds.sol";
import {ScheduleLib} from "../../src/libraries/ScheduleLib.sol";
import {VerdantConstants} from "../../src/libraries/VerdantConstants.sol";
import {InjectedDeployHarness} from "../utils/DeployHarness.sol";

/// @notice The one function of the Universal Router this suite needs.
/// @dev Declared here rather than vendored: `universal-router` is not among the pinned
/// dependencies, and adding a repository to answer one question would be a worse trade
/// than restating one signature. The command and action encodings below are checked
/// against the deployed bytecode by the test itself — a wrong encoding reverts.
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title A launch against the Uniswap that is actually deployed
///
/// @notice Every other test in this suite compiles Uniswap from vendored source and
/// runs against that. This one runs against the bytecode on chain 4663.
///
/// @dev The distinction is not pedantic, and there is a number that proves it: this
/// repository builds `PoolManager` to 26 988 bytes and the one deployed on 4663 is
/// 24 009 (V1 in docs/verification.md). Same source, different optimizer settings,
/// different bytecode. Until this file runs, three of the launch path's load-bearing
/// behaviours are claims about a build nobody uses:
///
///   1. `IMsgSender.msgSender()` exists on the deployed PositionManager and reports
///      the factory (ADR-006). The entire liquidity guard rests on it, and it is the
///      single thing most likely to differ between commits.
///   2. The initial mint settles one-sided, with `amount0Max: 0` — a launch that
///      needs no ETH because the pool opens at the top of the position's range.
///   3. A zero-liquidity decrease collects fees and moves no principal (V13).
///   4. `V4Quoter` executes the hook and quotes the scheduled fee rather than the
///      pool's stored one (V12). The trade panel has no other honest source: the
///      stored fee is stale by construction, as the schedule test below pins.
///
/// It is excluded from the default profile, so `forge test` and `forge coverage`
/// need no network. CI runs it as its own job under `FOUNDRY_PROFILE=fork`, allowed
/// to fail: a red mark here means somebody else's chain moved, which is information
/// rather than a broken commit.
contract LaunchForkTest is Test {
    using StateLibrary for IPoolManager;

    /// @dev From packages/config/src/chains.ts, verified present with identical
    /// bytecode on both Robinhood chains (V1).
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;

    /// @dev The lengths V1 recorded. Asserted so that a redeployment or an upgrade of
    /// Uniswap on 4663 fails here, loudly, instead of being absorbed by a test that
    /// still passes for the wrong reason.
    uint256 internal constant POOL_MANAGER_SIZE = 24_009;
    uint256 internal constant POSITION_MANAGER_SIZE = 23_877;
    uint256 internal constant V4_QUOTER_SIZE = 6_118;
    uint256 internal constant UNIVERSAL_ROUTER_SIZE = 24_546;

    /// @dev `Commands.V4_SWAP` in the Universal Router's own encoding.
    uint8 internal constant V4_SWAP = 0x10;

    /// @dev `ArbGasInfo.getGasAccountingParams()` reports 32 000 000 as the
    /// per-transaction ceiling on 4663. An atomic launch has to fit inside it, which
    /// is the question V9 asked.
    uint256 internal constant MAX_TX_GAS = 32_000_000;

    int24 internal constant INITIAL_TICK = 204_200;
    uint256 internal constant SUPPLY_TOKENS = 1_000_000_000;
    uint24 internal constant STAGE0_FEE = 10_000;
    uint24 internal constant STAGE1_FEE = 3_000;

    IPoolManager internal manager = IPoolManager(POOL_MANAGER);
    IPositionManager internal posm = IPositionManager(POSITION_MANAGER);
    IV4Quoter internal quoter = IV4Quoter(V4_QUOTER);
    IUniversalRouter internal universalRouter = IUniversalRouter(UNIVERSAL_ROUTER);
    PoolSwapTest internal swapRouter;

    address internal registryOwner = makeAddr("registry owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");

    Deploy.Deployment internal d;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("robinhood"));

        assertEq(POOL_MANAGER.code.length, POOL_MANAGER_SIZE, "the PoolManager on 4663 is not the one V1 recorded");
        assertEq(
            POSITION_MANAGER.code.length,
            POSITION_MANAGER_SIZE,
            "the PositionManager on 4663 is not the one V1 recorded"
        );

        // Ours, and it does nothing but call the real manager. The deployed bundle's
        // router is the UniversalRouter, which takes commands rather than a PoolKey.
        swapRouter = new PoolSwapTest(manager);

        d = new InjectedDeployHarness(POOL_MANAGER, POSITION_MANAGER, treasury, registryOwner).run();

        vm.deal(trader, 100 ether);
        vm.deal(creator, 10 ether);
    }

    /// @dev The gas is logged rather than snapshotted: it is measured against a
    /// forked chain whose state moves, so it belongs in a run's output as evidence,
    /// not in a committed baseline that would churn.
    function test_aLaunchWorksAgainstTheDeployedUniswap() public {
        uint256 managerBalanceBefore = POOL_MANAGER.balance;

        vm.prank(creator);
        uint256 gasBefore = gasleft();
        VerdantFactory.Created memory created = d.factory.create(_params(_fixedStages()));
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("create() gas against the deployed v4", gasUsed);
        assertLt(gasUsed, MAX_TX_GAS, "a launch must fit in one transaction on 4663");

        VerdantToken token = VerdantToken(created.token);
        uint256 supply = SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE;

        assertEq(token.totalSupply(), supply, "supply");
        assertEq(IERC721(POSITION_MANAGER).ownerOf(created.positionTokenId), created.locker, "the position is locked");
        assertEq(posm.getPositionLiquidity(created.positionTokenId), created.liquidity, "reported liquidity");
        assertGt(created.liquidity, 0, "a market with no liquidity is not a market");

        // A delta, not an absolute: the forked PoolManager holds every other market's
        // ETH already.
        assertEq(POOL_MANAGER.balance, managerBalanceBefore, "a one-sided launch takes no ETH");

        (uint160 sqrtPriceX96, int24 tick,, uint24 lpFee) = manager.getSlot0(created.poolId);
        assertEq(sqrtPriceX96, TickMath.getSqrtPriceAtTick(INITIAL_TICK), "opening price");
        assertEq(tick, INITIAL_TICK, "opening tick");
        assertEq(lpFee, STAGE0_FEE, "the first stage's fee, written by afterInitialize");
    }

    /// @dev The schedule, the fees and the payout in one pass, because on a fork they
    /// are one question: does a Verdant market work here.
    ///
    /// The fee is measured rather than read. `beforeSwap` returns
    /// `feePpm | OVERRIDE_FEE_FLAG`, which applies to that swap and does **not** write
    /// the pool's stored fee, so `slot0.lpFee` holds whatever `afterInitialize` set at
    /// the open and is stale for the rest of the market's life. Asserting against it
    /// is how this test was wrong on its first run: it read 10 000 after the
    /// transition and concluded the schedule had not moved, when what had actually
    /// happened is that the deployed PoolManager charged 3 000 without recording it.
    ///
    /// So the assertion is on fees the pool really earned, on both sides of the
    /// boundary, which is also the only way to show that the *deployed* PoolManager
    /// honours the override flag at all.
    function test_theScheduleTheFeesAndTheClaimAllWorkOnChain() public {
        vm.prank(creator);
        VerdantFactory.Created memory created = d.factory.create(_params(_progressiveStages()));

        uint256 openedAt = block.timestamp;
        assertEq(d.hook.feeAt(created.poolId, openedAt), STAGE0_FEE, "stage 0 at the open");
        assertEq(d.hook.nextTransition(created.poolId, openedAt), openedAt + 7 days, "the transition");

        uint256 firstFees = _feesEarnedBy(created, 1 ether);

        // Nobody touches the pool in between. The fee moves because the hook reads the
        // schedule on the next swap, not because anyone updated anything.
        vm.warp(openedAt + 7 days);
        assertEq(d.hook.feeAt(created.poolId, block.timestamp), STAGE1_FEE, "stage 1 after the transition");

        uint256 secondFees = _feesEarnedBy(created, 1 ether);

        assertGt(firstFees, secondFees, "the later stage is cheaper to trade");
        assertApproxEqRel(
            firstFees * uint256(STAGE1_FEE),
            secondFees * uint256(STAGE0_FEE),
            1e16,
            "the deployed PoolManager honours the override, in the ratio the schedule names"
        );

        // Pinned deliberately: the stored fee is stale, and an interface or indexer
        // that reads it will quote the opening fee forever. Anything wanting the
        // current fee must ask the hook. See V12 in docs/verification.md.
        (,,, uint24 storedFee) = manager.getSlot0(created.poolId);
        assertEq(storedFee, STAGE0_FEE, "slot0 still holds the opening fee, an hour or a year later");

        // The fees those trades earned are in the splitter, and both parties can take
        // their share out. `_feesEarnedBy` already collected twice, which is the
        // check that collecting more than once is harmless.
        FeeSplitter splitter = FeeSplitter(payable(created.splitter));
        assertEq(
            posm.getPositionLiquidity(created.positionTokenId), created.liquidity, "collecting moved no principal (V13)"
        );

        (uint256 creatorNative, uint256 creatorToken) = splitter.claimable(creator);
        (uint256 treasuryNative, uint256 treasuryToken) = splitter.claimable(treasury);
        assertGt(creatorNative + creatorToken, treasuryNative + treasuryToken, "the creator's 90% exceeds the 10%");

        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        splitter.claim();
        vm.prank(treasury);
        splitter.claim();

        assertEq(creator.balance - creatorBefore, creatorNative, "the creator was paid what they were owed");
        assertEq(address(splitter).balance, 0, "and nothing is left stranded");
    }

    /// @dev Buys `ethIn` and returns the native fees that buy left in the position,
    /// measured by collecting them. Collection is permissionless, so the trader does
    /// it.
    function _feesEarnedBy(VerdantFactory.Created memory created, uint256 ethIn) internal returns (uint256) {
        uint256 before = created.splitter.balance;
        _buy(created, ethIn);

        vm.prank(trader);
        PositionLocker(created.locker).collect();

        return created.splitter.balance - before;
    }

    /// @dev ADR-006's other half. That the deployed PositionManager implements
    /// `IMsgSender` at all is proven by the launch above having succeeded; this is
    /// the part that says everyone else is refused.
    function test_nobodyCanAddLiquidityToALiveMarketOnChain() public {
        vm.prank(creator);
        VerdantFactory.Created memory created = d.factory.create(_params(_fixedStages()));

        PoolKey memory key = d.factory.poolKeyFor(address(0), created.token);

        // A well-formed mint from a would-be liquidity provider, through the same
        // PositionManager the factory used, refused because the initiator is not the
        // factory — which after creation is true of everybody.
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            VerdantConstants.MIN_USABLE_TICK,
            INITIAL_TICK,
            uint256(1e18),
            uint128(0),
            type(uint128).max,
            trader,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);

        vm.prank(trader);
        vm.expectRevert();
        posm.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    /// @dev The most expensive launch the bounds permit, which is the half of V9 the
    /// first test does not answer.
    ///
    /// A typical launch is not the question — a ceiling is only cleared by the worst
    /// case that can reach it. So: eight stages, the maximum the schedule packs and the
    /// one that writes ScheduleLib's second word; the maximum creator allocation with a
    /// real cliff and duration, so a TokenVesting is deployed and funded rather than
    /// skipped; name, symbol and metadata URI all at their maximum lengths, with
    /// metadata left mutable so the string is stored rather than hashed; and a
    /// non-zero salt.
    ///
    /// Every one of those is a bound from packages/config rather than a number chosen
    /// here, so the figure this logs is the ceiling of what any creator can spend, not
    /// an example of what one did.
    function test_theMostExpensiveLaunchTheBoundsAllowStillFits() public {
        VerdantFactory.CreateParams memory params = _params(_eightStages());
        params.name = "Thirty Two Characters Of Name Ok";
        params.symbol = "ELEVENCHARS";
        params.metadataURI = _maxMetadataURI();
        params.metadataMutable = true;
        params.creatorAllocationBps = 2_000;
        params.vestingCliff = 30 days;
        params.vestingDuration = 730 days;
        params.salt = keccak256("worst case");

        assertEq(bytes(params.name).length, LaunchBounds.MAX_NAME_LENGTH, "name at the bound");
        assertEq(bytes(params.symbol).length, LaunchBounds.MAX_SYMBOL_LENGTH, "symbol at the bound");
        assertEq(bytes(params.metadataURI).length, LaunchBounds.MAX_METADATA_URI_LENGTH, "URI at the bound");
        assertEq(params.stages.length, ScheduleLib.MAX_STAGES, "stages at the bound");

        vm.prank(creator);
        uint256 before = gasleft();
        VerdantFactory.Created memory created = d.factory.create(params);
        uint256 used = before - gasleft();

        emit log_named_uint("worst-case create() gas against the deployed v4", used);
        assertLt(used, MAX_TX_GAS, "the worst launch the bounds allow fits in one transaction");

        // The measurement only means anything if the expensive parts actually happened.
        assertTrue(created.vesting != address(0), "a vesting contract was deployed");
        assertGt(created.vesting.code.length, 0, "and it has code");
        assertEq(
            IERC20(created.token).balanceOf(created.vesting),
            (SUPPLY_TOKENS * 1e18 * 2_000) / 10_000,
            "the creator's allocation is locked in it, not paid out"
        );
        assertEq(d.hook.feeAt(created.poolId, block.timestamp), STAGE0_FEE, "and the eight-stage schedule is live");
        assertEq(
            d.hook.feeAt(created.poolId, block.timestamp + 210 days), 3_000, "including its last stage, in word two"
        );
    }

    /// @dev V12: does the deployed quoter see a fee that exists only inside the hook?
    ///
    /// It has to, for a reason that is structural rather than hopeful — the quoter
    /// simulates the swap through the PoolManager, so `beforeSwap` runs and returns the
    /// override exactly as it would in a real trade. But "has to" is what V12 said for
    /// weeks, and the neighbouring test is a standing reminder of what happens when a
    /// fee is read from the plausible place instead of the right one.
    ///
    /// The assertion that settles it is not the ratio between two quotes; it is a quote
    /// against the swap that follows it. Nothing touches the pool in between, so an
    /// honest quote must equal the executed output to the wei. A quoter that read
    /// `slot0.lpFee` would still return a plausible number here and would disagree with
    /// the swap by the ratio of 10 000 to 3 000 — which is to say this test fails loudly
    /// in the one case anybody cares about.
    function test_theQuoterSeesTheHooksFeeAndAgreesWithTheSwap() public {
        assertEq(V4_QUOTER.code.length, V4_QUOTER_SIZE, "the quoter on 4663 is the one V1 recorded");

        vm.prank(creator);
        VerdantFactory.Created memory created = d.factory.create(_params(_progressiveStages()));

        PoolKey memory key = d.factory.poolKeyFor(address(0), created.token);
        uint256 openedAt = block.timestamp;

        uint256 stage0Quote = _quote(key, 1 ether);

        // Only the clock moves. No swap, no liquidity change, no transaction of any
        // kind against this pool between the two quotes.
        vm.warp(openedAt + 7 days);
        uint256 stage1Quote = _quote(key, 1 ether);

        assertGt(stage1Quote, stage0Quote, "the cheaper stage quotes more tokens out");
        assertApproxEqRel(
            stage0Quote * (1e6 - uint256(STAGE1_FEE)),
            stage1Quote * (1e6 - uint256(STAGE0_FEE)),
            1e16,
            "and quotes it in the ratio of the two stages' net-of-fee shares"
        );

        uint256 heldBefore = IERC20(created.token).balanceOf(trader);
        _buy(created, 1 ether);
        uint256 received = IERC20(created.token).balanceOf(trader) - heldBefore;

        assertEq(received, stage1Quote, "the quote is exactly what the swap paid out");
    }

    /// @dev `quoteExactInputSingle` is non-view: it simulates the swap and reverts to
    /// return the result, which is why a quote costs a call rather than a read.
    function _quote(PoolKey memory key, uint128 ethIn) internal returns (uint256 amountOut) {
        (amountOut,) = quoter.quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: key, zeroForOne: true, exactAmount: ethIn, hookData: ""})
        );
    }

    /// @dev V5: does a third-party router charge the fee the schedule names?
    ///
    /// This is the question that decides whether Verdant needs a router of its own. If
    /// the Universal Router handles a hooked dynamic-fee pool correctly, every wallet
    /// and aggregator that already routes through it works on day one and there is
    /// nothing to build. If it does not, a `VerdantRouter` is required — a new contract,
    /// new audit surface, and a swap path the interface has to steer people towards.
    ///
    /// The test is run *after* a stage transition, which is the case a router can get
    /// wrong in a way that looks fine. The pool's stored fee is stage 0's forever (see
    /// the schedule test), so a router that consults `slot0` rather than executing the
    /// hook would quote and charge 1% while the market's schedule says 0.3%. Comparing
    /// against the quoter is legitimate now that the quoter itself is verified to the
    /// wei against an executed swap.
    function test_aThirdPartyRouterChargesTheScheduledFee() public {
        assertEq(UNIVERSAL_ROUTER.code.length, UNIVERSAL_ROUTER_SIZE, "the router on 4663 is the one V1 recorded");

        vm.prank(creator);
        VerdantFactory.Created memory created = d.factory.create(_params(_progressiveStages()));

        PoolKey memory key = d.factory.poolKeyFor(address(0), created.token);

        vm.warp(block.timestamp + 7 days);
        assertEq(d.hook.feeAt(created.poolId, block.timestamp), STAGE1_FEE, "the schedule has moved to stage 1");

        uint256 expected = _quote(key, 1 ether);

        uint256 heldBefore = IERC20(created.token).balanceOf(trader);
        _buyThroughUniversalRouter(key, 1 ether);
        uint256 received = IERC20(created.token).balanceOf(trader) - heldBefore;

        assertEq(received, expected, "the Universal Router charged exactly the scheduled fee");

        // And the tokens reached the trader rather than being left in the router, which
        // is the other way a third-party integration quietly goes wrong.
        assertEq(IERC20(created.token).balanceOf(UNIVERSAL_ROUTER), 0, "nothing stranded in the router");
        assertEq(UNIVERSAL_ROUTER.balance, 0, "and no ETH either");
    }

    /// @dev One `V4_SWAP` command carrying the three actions a single-hop exact-input
    /// swap needs: do the swap, pay the input, take the output. `TAKE_ALL` sends to the
    /// router's view of the original caller, which is why the trader ends up with the
    /// tokens without being named anywhere.
    function _buyThroughUniversalRouter(PoolKey memory key, uint128 ethIn) internal {
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key, zeroForOne: true, amountIn: ethIn, amountOutMinimum: 0, hookData: ""
            })
        );
        params[1] = abi.encode(key.currency0, ethIn);
        params[2] = abi.encode(key.currency1, 0);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        vm.prank(trader);
        universalRouter.execute{value: ethIn}(abi.encodePacked(V4_SWAP), inputs, block.timestamp);
    }

    // --- fixtures ------------------------------------------------------------

    function _buy(VerdantFactory.Created memory created, uint256 ethIn) internal {
        PoolKey memory key = d.factory.poolKeyFor(address(0), created.token);

        vm.prank(trader);
        swapRouter.swap{value: ethIn}(
            key,
            SwapParams({
                zeroForOne: true,
                // forge-lint: disable-next-line(unsafe-typecast) -- test amounts, far below int256
                amountSpecified: -int256(ethIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Eight stages: the packing maximum. Offsets rise by 30 days, so the last
    /// begins at 210 days — inside the two-year horizon the bounds allow — and the
    /// fees fall the whole way, which is what makes it a progressive schedule.
    function _eightStages() internal pure returns (ScheduleLib.Stage[] memory stages) {
        uint24[8] memory fees = [STAGE0_FEE, 8_000, 7_000, 6_000, 5_000, 4_500, 4_000, STAGE1_FEE];
        stages = new ScheduleLib.Stage[](8);
        for (uint256 i = 0; i < 8; i++) {
            // The largest offset is 7 * 30 days = 18 144 000, four orders below uint32.
            // forge-lint: disable-next-line(unsafe-typecast)
            stages[i] = ScheduleLib.Stage({startOffset: uint32(i * 30 days), feePpm: fees[i]});
        }
    }

    function _maxMetadataURI() internal pure returns (string memory uri) {
        bytes memory b = new bytes(LaunchBounds.MAX_METADATA_URI_LENGTH);
        for (uint256 i = 0; i < b.length; i++) {
            b[i] = "a";
        }
        b[0] = "i";
        b[1] = "p";
        b[2] = "f";
        b[3] = "s";
        b[4] = ":";
        b[5] = "/";
        b[6] = "/";
        return string(b);
    }

    function _fixedStages() internal pure returns (ScheduleLib.Stage[] memory stages) {
        stages = new ScheduleLib.Stage[](1);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: STAGE0_FEE});
    }

    function _progressiveStages() internal pure returns (ScheduleLib.Stage[] memory stages) {
        stages = new ScheduleLib.Stage[](2);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: STAGE0_FEE});
        stages[1] = ScheduleLib.Stage({startOffset: uint32(7 days), feePpm: STAGE1_FEE});
    }

    function _params(ScheduleLib.Stage[] memory stages) internal view returns (VerdantFactory.CreateParams memory) {
        return VerdantFactory.CreateParams({
            name: "Fork Market",
            symbol: "FORK",
            metadataURI: "ipfs://fork",
            metadataMutable: false,
            supplyTokens: SUPPLY_TOKENS,
            model: stages.length == 1 ? 0 : 1,
            quoteAsset: address(0),
            stages: stages,
            initialTick: INITIAL_TICK,
            creatorAllocationBps: 500,
            vestingCliff: 0,
            vestingDuration: 0,
            feeRecipient: creator,
            salt: bytes32(0),
            // Zero, so that what this suite measures against the deployed bytecode is
            // the launch itself rather than a launch plus a swap.
            initialBuyAmount: 0,
            initialBuyMinTokens: 0
        });
    }
}
