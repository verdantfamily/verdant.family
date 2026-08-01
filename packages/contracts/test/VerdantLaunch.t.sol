// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

import {FeeSplitter} from "../src/FeeSplitter.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";
import {PositionLocker} from "../src/PositionLocker.sol";
import {TokenVesting} from "../src/TokenVesting.sol";
import {VerdantDeployer} from "../src/VerdantDeployer.sol";
import {VerdantFactory} from "../src/VerdantFactory.sol";
import {VerdantHook} from "../src/VerdantHook.sol";
import {VerdantToken} from "../src/VerdantToken.sol";
import {LaunchBounds} from "../src/libraries/LaunchBounds.sol";
import {ScheduleLib} from "../src/libraries/ScheduleLib.sol";
import {VerdantConstants} from "../src/libraries/VerdantConstants.sol";

/// @title A launch, end to end
/// @notice The test that decides whether Verdant works. Everything else in this
/// suite checks a contract in isolation; this one runs a real launch against the
/// real PoolManager and the real PositionManager, then trades against the market it
/// produced, collects the fees that trade earned, and pays them out.
///
/// The properties it exists to prove, in the order a creator would care about them:
///
///   1. One transaction produces a token, a pool, and a position that cannot be
///      withdrawn — or it produces nothing at all.
///   2. The market is immediately tradeable, at the fee its schedule names, and the
///      fee changes when the schedule says it changes.
///   3. The fees that trade earns reach the creator and the protocol, in the shares
///      the market was created with, and nobody has to be trusted to make that
///      happen.
///   4. Nobody can add liquidity to the pool afterwards, and nobody — including the
///      creator and including Verdant — can take the locked liquidity out.
///
/// The setup is worth reading rather than skipping, because the deployment order is
/// part of the design: three contracts are deployed against the factory's address
/// before the factory exists, and each of them asserts afterwards that the address
/// was right.
contract VerdantLaunchTest is Deployers {
    using StateLibrary for IPoolManager;

    /// @dev Any address whose low 14 bits are 0x3880. Mined for real in
    /// `VerdantHook.permissions.t.sol`; here it only has to carry the bits.
    address internal constant HOOK_ADDRESS = address(uint160(0xC0FFEE0000 | 0x3880));

    /// @dev 1.0001^204200 raw token per raw ETH, which for an 18-decimal token and a
    /// billion of supply is an opening valuation around 1.4 ETH. Chosen because it is
    /// on the 200 grid and in the range a real launch would use.
    int24 internal constant INITIAL_TICK = 204_200;

    uint256 internal constant SUPPLY_TOKENS = 1_000_000_000;
    uint16 internal constant PROTOCOL_BPS = 1_000;
    uint16 internal constant MAX_PROTOCOL_BPS = 2_000;
    uint24 internal constant STAGE0_FEE = 10_000; // 1%
    uint24 internal constant STAGE1_FEE = 3_000; // 0.3%

    /// @dev Held as a constant rather than repeated, because the stock-paired cases
    /// below have to predict a token's address before it exists and a prediction is
    /// only right if every constructor argument matches the launch exactly.
    string internal constant METADATA_URI = "ipfs://metadata";
    string internal constant STOCK_NAME = "Stock Paired Market";
    string internal constant STOCK_SYMBOL = "STOCK";

    uint256 internal constant CREATED_AT = 1_800_000_000;
    // forge-lint: disable-next-line(unsafe-typecast) -- uint40 holds timestamps to year 36812
    uint40 internal constant CREATED_AT_40 = uint40(CREATED_AT);

    PositionManager internal posm;
    VerdantHook internal hook;
    VerdantDeployer internal deployer;
    VerdantFactory internal factory;
    ModelRegistry internal modelRegistry;
    MarketRegistry internal marketRegistry;

    address internal registryOwner = makeAddr("registry owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");

    function setUp() public {
        deployFreshManagerAndRouters();

        // Permit2 and the descriptor are never reached: the factory settles the
        // token side from the PositionManager's own balance rather than through an
        // allowance, and nothing here renders a position's SVG.
        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        modelRegistry =
            new ModelRegistry(registryOwner, MAX_PROTOCOL_BPS, PROTOCOL_BPS, _modelBounds(), new address[](0));

        // The factory is deployed last but referenced first, so its address is
        // predicted here. Plain CREATE makes that possible: the address depends on
        // this account and its nonce, not on the factory's own arguments, which is
        // what breaks the cycle between a hook that must know its factory and a
        // factory that must know its hook.
        //
        // Two `new` calls happen between this prediction and the factory's own, so
        // the offset is two. `deployCodeTo` does not create a contract from here and
        // therefore does not move the nonce.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);

        marketRegistry = new MarketRegistry(predicted);
        deployer = new VerdantDeployer(predicted);

        deployCodeTo("VerdantHook.sol:VerdantHook", abi.encode(manager, predicted, posm), HOOK_ADDRESS);
        hook = VerdantHook(HOOK_ADDRESS);

        factory = new VerdantFactory(manager, posm, hook, deployer, modelRegistry, marketRegistry, treasury);
        assertEq(address(factory), predicted, "the prediction the whole deployment rests on");

        vm.warp(CREATED_AT);
        vm.deal(trader, 100 ether);
        vm.deal(creator, 10 ether);
    }

    // --- fixtures ------------------------------------------------------------

    function _modelBounds() internal pure returns (ModelRegistry.ModelBounds[] memory bounds) {
        bounds = new ModelRegistry.ModelBounds[](3);
        bounds[0] =
            ModelRegistry.ModelBounds({enabled: true, minStages: 1, maxStages: 1, minReserveBps: 0, maxReserveBps: 0});
        bounds[1] =
            ModelRegistry.ModelBounds({enabled: true, minStages: 2, maxStages: 8, minReserveBps: 0, maxReserveBps: 0});
        bounds[2] = ModelRegistry.ModelBounds({
            enabled: true, minStages: 1, maxStages: 8, minReserveBps: 1_000, maxReserveBps: 8_000
        });
    }

    /// @dev Fixed, one stage, 1% forever.
    function _fixedStages() internal pure returns (ScheduleLib.Stage[] memory stages) {
        stages = new ScheduleLib.Stage[](1);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: STAGE0_FEE});
    }

    /// @dev Progressive: 1% for the first week, 0.3% after.
    function _progressiveStages() internal pure returns (ScheduleLib.Stage[] memory stages) {
        stages = new ScheduleLib.Stage[](2);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: STAGE0_FEE});
        stages[1] = ScheduleLib.Stage({startOffset: uint32(7 days), feePpm: STAGE1_FEE});
    }

    function _params() internal view returns (VerdantFactory.CreateParams memory) {
        return VerdantFactory.CreateParams({
            name: "Verdant Test",
            symbol: "VTEST",
            metadataURI: METADATA_URI,
            metadataMutable: false,
            supplyTokens: SUPPLY_TOKENS,
            model: 0,
            quoteAsset: address(0),
            stages: _fixedStages(),
            initialTick: INITIAL_TICK,
            creatorAllocationBps: 500,
            vestingCliff: 0,
            vestingDuration: 0,
            feeRecipient: creator,
            salt: bytes32(0),
            // No first buy by default, so that every test written before the buy
            // existed still describes the launch it was written against. The cases
            // that exercise the buy set these two fields and say that they do.
            initialBuyAmount: 0,
            initialBuyMinTokens: 0
        });
    }

    function _launch() internal returns (VerdantFactory.Created memory created) {
        vm.prank(creator);
        created = factory.create(_params());
    }

    function _launchWith(VerdantFactory.CreateParams memory params)
        internal
        returns (VerdantFactory.Created memory created)
    {
        vm.prank(creator);
        created = factory.create(params);
    }

    function _buy(VerdantFactory.Created memory created, uint256 ethIn) internal returns (BalanceDelta) {
        PoolKey memory key = factory.poolKeyFor(address(0), created.token);

        vm.prank(trader);
        return swapRouter.swap{value: ethIn}(
            key,
            SwapParams({
                zeroForOne: true,
                // Negative is exact-input: spend exactly this much ETH.
                // forge-lint: disable-next-line(unsafe-typecast) -- test amounts, far below int256
                amountSpecified: -int256(ethIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // --- 1. the launch itself ------------------------------------------------

    function test_aLaunchProducesATokenAPoolAndALockedPosition() public {
        VerdantFactory.Created memory created = _launch();

        VerdantToken token = VerdantToken(created.token);
        uint256 supply = SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE;

        assertEq(token.totalSupply(), supply, "supply");
        assertEq(token.name(), "Verdant Test", "name");
        assertEq(token.symbol(), "VTEST", "symbol");
        assertEq(token.creator(), creator, "the creator holds the metadata authority");

        // The pool exists, opened at the tick the creator asked for, and carries the
        // first stage's fee.
        (uint160 sqrtPriceX96, int24 tick,, uint24 lpFee) = manager.getSlot0(created.poolId);
        assertEq(sqrtPriceX96, TickMath.getSqrtPriceAtTick(INITIAL_TICK), "opening price");
        assertEq(tick, INITIAL_TICK, "opening tick");
        assertEq(lpFee, STAGE0_FEE, "the pool's stored fee is stage 0's");

        // Every token is accounted for: 95% in the position, 5% with the creator,
        // and nothing anywhere else. The creator's balance is their allocation plus
        // the dust left by converting an amount of token into a whole number of
        // units of liquidity — a few thousand wei on a supply of 1e27.
        uint256 creatorAmount = (supply * 500) / 10_000;
        assertGe(token.balanceOf(creator), creatorAmount, "the creator's allocation, at least");
        assertLt(token.balanceOf(creator) - creatorAmount, 1e12, "and dust rather than a second allocation");
        assertEq(token.balanceOf(address(factory)), 0, "the factory keeps nothing");
        assertEq(token.balanceOf(address(deployer)), 0, "the deployer keeps nothing");
        assertEq(
            token.balanceOf(address(manager)) + token.balanceOf(creator), supply, "and every token is in one of them"
        );

        // The position is owned by the locker, and the locker is the only thing that
        // can ever act on it.
        assertEq(IERC721(address(posm)).ownerOf(created.positionTokenId), created.locker, "the position is locked");
        assertEq(posm.getPositionLiquidity(created.positionTokenId), created.liquidity, "reported liquidity");
        assertGt(created.liquidity, 0, "a market with no liquidity is not a market");

        // No ETH was needed to launch.
        assertEq(address(manager).balance, 0, "a one-sided launch takes no ETH");
    }

    function test_theRegistryRecordsTheMarketExactlyOnce() public {
        VerdantFactory.Created memory created = _launch();

        MarketRegistry.Market memory market = marketRegistry.marketOf(PoolId.unwrap(created.poolId));

        assertEq(market.token, created.token, "token");
        assertEq(market.creator, creator, "creator");
        assertEq(market.model, 0, "model");
        assertEq(market.createdAt, CREATED_AT_40, "createdAt");
        assertEq(market.protocolBps, PROTOCOL_BPS, "the protocol share, snapshotted");
        assertEq(market.creatorBps, 10_000 - PROTOCOL_BPS, "the creator share, derived");
        assertEq(market.reserveBps, 0, "no reserve share in v1");
        assertEq(market.locker, created.locker, "locker");
        assertEq(market.splitter, created.splitter, "splitter");
        assertEq(market.vesting, address(0), "no vesting was configured");
        assertEq(market.positionTokenId, created.positionTokenId, "position");

        assertEq(marketRegistry.marketCount(), 1, "one market");
        assertEq(marketRegistry.marketsByCreator(creator).length, 1, "indexed by creator");
        assertEq(marketRegistry.marketByToken(created.token).creator, creator, "indexed by token");
    }

    /// @dev The registry's protocol share is read once, at creation. Changing it
    /// afterwards must not reach a market that exists — that is the whole reason the
    /// value is snapshotted rather than looked up.
    function test_changingTheRegistryDoesNotReachAnExistingMarket() public {
        VerdantFactory.Created memory created = _launch();

        vm.prank(registryOwner);
        modelRegistry.setProtocolBps(MAX_PROTOCOL_BPS);

        assertEq(
            FeeSplitter(payable(created.splitter)).protocolBps(),
            PROTOCOL_BPS,
            "the splitter's share is the one it was created with"
        );
        assertEq(
            marketRegistry.marketOf(PoolId.unwrap(created.poolId)).protocolBps,
            PROTOCOL_BPS,
            "and so is the record of it"
        );
    }

    function test_twoLaunchesFromOneCreatorNeedDifferentSalts() public {
        _launch();

        // Same salt, same creator, same parameters: the token's address is already
        // taken, and CREATE2 cannot deploy twice to one address.
        vm.prank(creator);
        vm.expectRevert();
        factory.create(_params());

        VerdantFactory.CreateParams memory second = _params();
        second.salt = bytes32(uint256(1));
        VerdantFactory.Created memory created = _launchWith(second);

        assertEq(marketRegistry.marketCount(), 2, "both markets exist");
        assertGt(created.liquidity, 0, "and the second one is real");
    }

    function test_aLaunchCanVestTheCreatorsAllocation() public {
        VerdantFactory.CreateParams memory params = _params();
        params.vestingDuration = 90 days;
        params.vestingCliff = 30 days;

        VerdantFactory.Created memory created = _launchWith(params);

        uint256 supply = SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE;
        uint256 creatorAmount = (supply * 500) / 10_000;

        TokenVesting vesting = TokenVesting(created.vesting);
        assertEq(IERC20(created.token).balanceOf(created.vesting), creatorAmount, "the allocation is in the vesting");
        assertEq(vesting.beneficiary(), creator, "beneficiary");
        assertEq(vesting.totalAllocation(), creatorAmount, "allocation");
        assertEq(vesting.cliff(), CREATED_AT + 30 days, "cliff");

        // Before the cliff, nothing. After it, the accrued portion at once.
        vm.expectRevert(TokenVesting.NothingToRelease.selector);
        vesting.release();

        vm.warp(CREATED_AT + 45 days);
        vesting.release();
        assertApproxEqRel(
            IERC20(created.token).balanceOf(creator), creatorAmount / 2, 1e15, "half the schedule, half the tokens"
        );
    }

    function test_aLaunchCanKeepNothingBack() public {
        VerdantFactory.CreateParams memory params = _params();
        params.creatorAllocationBps = 0;

        VerdantFactory.Created memory created = _launchWith(params);
        uint256 supply = SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE;

        // The dust from converting an amount into whole units of liquidity is the
        // only thing the creator receives, and it is a rounding error rather than an
        // allocation.
        assertLt(IERC20(created.token).balanceOf(creator), 1e18, "the creator kept nothing material");
        assertApproxEqRel(IERC20(created.token).balanceOf(address(manager)), supply, 1e12, "it all went in the pool");
    }

    /// @dev The addresses of a launch are predictable before it is sent, which is
    /// what lets an interface show a creator their token's address while they are
    /// still filling in the form. They derive from the deployer, the salt, and the
    /// artefact's creation code — and the salt is namespaced by the creator, so one
    /// creator cannot occupy an address another was about to use.
    function test_aLaunchesAddressesArePredictableInAdvance() public {
        VerdantFactory.CreateParams memory params = _params();
        params.salt = keccak256("a vanity attempt");

        bytes32 salt = factory.saltFor(creator, params.salt);
        assertEq(salt, keccak256(abi.encode(creator, params.salt)), "the salt is the creator and their bytes");
        assertTrue(salt != factory.saltFor(trader, params.salt), "and somebody else's same bytes give a different salt");

        address expectedToken = vm.computeCreate2Address(
            salt,
            keccak256(
                abi.encodePacked(
                    type(VerdantToken).creationCode,
                    abi.encode(
                        params.name,
                        params.symbol,
                        SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE,
                        creator,
                        params.metadataURI,
                        params.metadataMutable
                    )
                )
            ),
            address(deployer)
        );

        VerdantFactory.Created memory created = _launchWith(params);
        assertEq(created.token, expectedToken, "the token landed where it was predicted to");
    }

    // --- 2. the market trades, at the scheduled fee --------------------------

    function test_theFirstBuyPaysTheFirstStagesFee() public {
        VerdantFactory.Created memory created = _launch();

        uint256 ethIn = 1 ether;
        _buy(created, ethIn);

        // The trader received tokens, and the pool received the ETH.
        assertGt(IERC20(created.token).balanceOf(trader), 0, "the trader bought something");
        assertEq(address(manager).balance, ethIn, "the pool holds the ETH");

        // The fee charged is the schedule's, which for a one-stage market is 1% for
        // ever. Asserted through the hook's own view so that the number being
        // compared is the one v4 was handed.
        assertEq(hook.feeAt(created.poolId, block.timestamp), STAGE0_FEE, "the scheduled fee");
        assertEq(hook.stageAt(created.poolId, block.timestamp), 0, "stage 0");
    }

    function test_theFeeFollowsTheScheduleAcrossATransition() public {
        VerdantFactory.CreateParams memory params = _params();
        params.model = 1;
        params.stages = _progressiveStages();

        VerdantFactory.Created memory created = _launchWith(params);

        assertEq(hook.feeAt(created.poolId, block.timestamp), STAGE0_FEE, "before the transition");
        assertEq(hook.nextTransition(created.poolId, block.timestamp), CREATED_AT + 7 days, "the transition");

        // A swap on each side of the boundary, and the fees they earn differ in the
        // ratio the schedule says they should.
        uint256 firstFees = _feesEarnedBy(created, 1 ether);

        vm.warp(CREATED_AT + 7 days);
        assertEq(hook.feeAt(created.poolId, block.timestamp), STAGE1_FEE, "after the transition");

        uint256 secondFees = _feesEarnedBy(created, 1 ether);

        assertGt(firstFees, secondFees, "the later stage is cheaper to trade");
        assertApproxEqRel(
            firstFees * uint256(STAGE1_FEE),
            secondFees * uint256(STAGE0_FEE),
            1e16,
            "and cheaper by the ratio of the two fees"
        );
    }

    /// @dev Buys `ethIn` and returns the native fees that buy left in the position,
    /// measured by collecting them.
    function _feesEarnedBy(VerdantFactory.Created memory created, uint256 ethIn) internal returns (uint256) {
        uint256 before = created.splitter.balance;
        _buy(created, ethIn);
        PositionLocker(created.locker).collect();
        return created.splitter.balance - before;
    }

    // --- 3. fees reach the creator and the protocol --------------------------

    function test_feesCollectedFromTheLockedPositionSplitOnTheMarketsShares() public {
        VerdantFactory.Created memory created = _launch();
        FeeSplitter splitter = FeeSplitter(payable(created.splitter));

        _buy(created, 10 ether);

        // Collection is permissionless: anybody may push the button, and it changes
        // nothing about where the money goes.
        vm.prank(makeAddr("a passer-by"));
        PositionLocker(created.locker).collect();

        uint256 collected = created.splitter.balance;
        assertApproxEqRel(collected, 10 ether * uint256(STAGE0_FEE) / 1_000_000, 1e16, "1% of the trade, as fees");

        (uint256 creatorNative,) = splitter.claimable(creator);
        (uint256 treasuryNative,) = splitter.claimable(treasury);

        assertEq(treasuryNative, collected * uint256(PROTOCOL_BPS) / 10_000, "the protocol's share");
        assertEq(creatorNative, collected - treasuryNative, "the creator's, which is the remainder");
        assertEq(creatorNative + treasuryNative, collected, "and the two are the whole");

        vm.prank(creator);
        splitter.claim();
        vm.prank(treasury);
        splitter.claim();

        assertEq(creator.balance, 10 ether + creatorNative, "the creator was paid");
        assertEq(treasury.balance, treasuryNative, "the treasury was paid");
        assertEq(created.splitter.balance, 0, "and nothing is left over");
    }

    function test_feesAccrueInBothCurrencies() public {
        VerdantFactory.Created memory created = _launch();
        FeeSplitter splitter = FeeSplitter(payable(created.splitter));

        // Buy, then sell back, so that fees accrue on both sides of the pair.
        _buy(created, 5 ether);

        uint256 held = IERC20(created.token).balanceOf(trader);
        vm.startPrank(trader);
        IERC20(created.token).approve(address(swapRouter), held);
        swapRouter.swap(
            factory.poolKeyFor(address(0), created.token),
            SwapParams({
                zeroForOne: false,
                // forge-lint: disable-next-line(unsafe-typecast) -- half a token supply, far below int256
                amountSpecified: -int256(held / 2),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        PositionLocker(created.locker).collect();

        assertGt(created.splitter.balance, 0, "native fees");
        assertGt(IERC20(created.token).balanceOf(created.splitter), 0, "token fees");

        (uint256 creatorNative, uint256 creatorToken) = splitter.claimable(creator);
        assertGt(creatorNative, 0, "the creator is owed ETH");
        assertGt(creatorToken, 0, "and tokens");

        vm.prank(creator);
        (uint256 paidNative, uint256 paidToken) = splitter.claim();
        assertEq(paidNative, creatorNative, "paid what was claimable, in ETH");
        assertEq(paidToken, creatorToken, "and in tokens");
    }

    function test_collectingTwiceWithNoTradesInBetweenIsHarmless() public {
        VerdantFactory.Created memory created = _launch();
        _buy(created, 1 ether);

        PositionLocker(created.locker).collect();
        uint256 afterFirst = created.splitter.balance;

        PositionLocker(created.locker).collect();
        assertEq(created.splitter.balance, afterFirst, "a second collection finds nothing and does nothing");
    }

    /// @dev The property that makes the locker's `collect` safe to leave open: it
    /// cannot move principal, only fees. Asserted by measuring the position's
    /// liquidity across a collection rather than by reading the code.
    function test_collectingDoesNotRemoveLiquidity() public {
        VerdantFactory.Created memory created = _launch();
        _buy(created, 5 ether);

        uint128 before = posm.getPositionLiquidity(created.positionTokenId);
        PositionLocker(created.locker).collect();

        assertEq(posm.getPositionLiquidity(created.positionTokenId), before, "liquidity is untouched");
    }

    // --- 4. the pool is closed to everyone else ------------------------------

    function test_nobodyCanAddLiquidityToAVerdantPool() public {
        VerdantFactory.Created memory created = _launch();
        PoolKey memory key = factory.poolKeyFor(address(0), created.token);

        // A well-formed mint from a would-be liquidity provider, through the same
        // PositionManager the factory used. It is refused because the initiator is
        // not the factory, which after creation is true of everybody.
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

    function test_notEvenTheCreatorCanAddLiquidity() public {
        VerdantFactory.Created memory created = _launch();
        PoolKey memory key = factory.poolKeyFor(address(0), created.token);

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            VerdantConstants.MIN_USABLE_TICK,
            INITIAL_TICK,
            uint256(1e18),
            uint128(0),
            type(uint128).max,
            creator,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);

        vm.prank(creator);
        vm.expectRevert();
        posm.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    function test_theLockedPositionCannotBeWithdrawnByAnyone() public {
        VerdantFactory.Created memory created = _launch();

        // Decreasing liquidity requires being the position's owner or approved by
        // them. The owner is the locker, which has no function that decreases by any
        // amount but zero and no function that approves anybody.
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(created.positionTokenId, uint256(created.liquidity), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(Currency.wrap(address(0)), Currency.wrap(created.token), creator);

        vm.prank(creator);
        vm.expectRevert();
        posm.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        vm.prank(trader);
        vm.expectRevert();
        posm.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        // And the position is still there.
        assertEq(posm.getPositionLiquidity(created.positionTokenId), created.liquidity, "liquidity is intact");
        assertEq(IERC721(address(posm)).ownerOf(created.positionTokenId), created.locker, "and still locked");
    }

    function test_theLockerHasNoWayToMoveTheNft() public {
        VerdantFactory.Created memory created = _launch();

        // The locker's whole ABI. If a function that could transfer, approve or burn
        // the position appeared, it would appear here.
        assertEq(PositionLocker(created.locker).tokenId(), created.positionTokenId, "the locker knows its own position");
        assertEq(PositionLocker(created.locker).splitter(), created.splitter, "and where fees go");

        // A transfer attempted by anybody else fails at the ERC-721 level, because
        // they are neither the owner nor approved, and there is nobody who can
        // approve them.
        vm.prank(creator);
        vm.expectRevert();
        IERC721(address(posm)).transferFrom(created.locker, creator, created.positionTokenId);
    }

    /// @dev A second pool with the same key cannot be created, and a pool with this
    /// hook cannot be created by anyone but the factory. Both are the hook's checks;
    /// this asserts they hold when reached through v4 rather than directly.
    function test_nobodyCanOpenAPoolWithTheVerdantHook() public {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(makeAddr("some token")),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: hook
        });

        vm.prank(trader);
        vm.expectRevert();
        manager.initialize(key, TickMath.getSqrtPriceAtTick(INITIAL_TICK));
    }

    // --- 5. a market quoted in an equity rather than in ether ----------------

    /// @dev The second model, and everything about it that the four sections above
    /// cannot reach: the quote side is an ERC-20 the registry had to admit, the pair
    /// is ordered by two real addresses rather than by ether being zero, and every
    /// payment in and out of the market is a transfer instead of a value send.
    function test_aStockPairedLaunchOpensAPoolQuotedInTheEquity() public {
        MockERC20 equity = _admittedEquity();
        VerdantFactory.Created memory created = _launchAgainst(equity);

        PoolKey memory key = factory.poolKeyFor(address(equity), created.token);
        assertEq(Currency.unwrap(key.currency0), address(equity), "the equity is currency0");
        assertEq(Currency.unwrap(key.currency1), created.token, "and the launch token is currency1");
        assertEq(PoolId.unwrap(key.toId()), PoolId.unwrap(created.poolId), "which is the pool that was opened");

        (uint160 sqrtPriceX96, int24 tick,, uint24 lpFee) = manager.getSlot0(created.poolId);
        assertEq(sqrtPriceX96, TickMath.getSqrtPriceAtTick(INITIAL_TICK), "opening price");
        assertEq(tick, INITIAL_TICK, "opening tick");
        assertEq(lpFee, STAGE0_FEE, "the schedule's first stage");

        // The record has to carry the quote asset, because it is the one field of
        // the pool key that cannot be derived from the token.
        MarketRegistry.Market memory market = marketRegistry.marketOf(PoolId.unwrap(created.poolId));
        assertEq(market.quoteAsset, address(equity), "the record names the quote asset");
        assertEq(market.token, created.token, "and the token");

        // The market's own contracts agree with it, which is what makes a collection
        // pay out to the right pair.
        assertEq(FeeSplitter(payable(created.splitter)).quote(), address(equity), "the splitter's quote asset");
        assertFalse(FeeSplitter(payable(created.splitter)).quoteIsNative(), "which is not ether");
        assertEq(
            Currency.unwrap(PositionLocker(created.locker).currency0()), address(equity), "the locker's quote side"
        );
    }

    /// @dev `amount0Max: 0` on the mint is the assertion that a launch needs none of
    /// the quote asset, and it is not weaker for the quote asset being something the
    /// creator could actually have been asked for: the position opens at exactly the
    /// top of its range, so v4 puts all of it in `currency1`. A launch that needed
    /// any equity at all would revert rather than quietly take some.
    function test_aStockPairedLaunchNeedsNoneOfTheQuoteAsset() public {
        MockERC20 equity = _admittedEquity();

        equity.mint(creator, 1_000e18);
        uint256 held = equity.balanceOf(creator);

        VerdantFactory.Created memory created = _launchAgainst(equity);

        assertEq(equity.balanceOf(creator), held, "the creator paid no equity to launch");
        assertEq(equity.balanceOf(address(manager)), 0, "and the pool holds none of it");
        assertEq(equity.balanceOf(address(factory)), 0, "nor does the factory");
        assertGt(created.liquidity, 0, "a one-sided position was still minted");
    }

    function test_aBuyPaidInTheEquityMovesThePriceAndIsChargedTheScheduledFee() public {
        MockERC20 equity = _admittedEquity();
        VerdantFactory.Created memory created = _launchAgainst(equity);

        (, int24 openedAt,,) = manager.getSlot0(created.poolId);

        uint256 spent = 10e18;
        _buyWithEquity(equity, created, spent);

        (, int24 nowAt,,) = manager.getSlot0(created.poolId);
        assertLt(nowAt, openedAt, "buying the token with the equity moves the price down the range");
        assertGt(IERC20(created.token).balanceOf(trader), 0, "and the trader is holding the token");
        assertEq(equity.balanceOf(address(manager)), spent, "the equity is in the pool");

        // The fee is the schedule's, not the pool's stored one, and the amount that
        // reaches the splitter is what proves it.
        PositionLocker(created.locker).collect();
        assertApproxEqRel(
            equity.balanceOf(created.splitter),
            spent * uint256(STAGE0_FEE) / 1_000_000,
            1e16,
            "1% of the trade, in the equity"
        );
    }

    function test_collectForwardsQuoteAssetFeesToTheSplitterAndBothRecipientsCanClaim() public {
        MockERC20 equity = _admittedEquity();
        VerdantFactory.Created memory created = _launchAgainst(equity);
        FeeSplitter splitter = FeeSplitter(payable(created.splitter));

        _buyWithEquity(equity, created, 10e18);

        // Permissionless, as for an ether-quoted market: who pushes the button
        // cannot change where the money goes.
        vm.prank(makeAddr("a passer-by"));
        PositionLocker(created.locker).collect();

        uint256 collected = equity.balanceOf(created.splitter);
        assertGt(collected, 0, "the fees arrived in the equity");

        (uint256 creatorQuote,) = splitter.claimable(creator);
        (uint256 treasuryQuote,) = splitter.claimable(treasury);
        assertEq(treasuryQuote, collected * uint256(PROTOCOL_BPS) / 10_000, "the protocol's share");
        assertEq(creatorQuote, collected - treasuryQuote, "the creator's, which is the remainder");

        vm.prank(creator);
        splitter.claim();
        vm.prank(treasury);
        splitter.claim();

        assertEq(equity.balanceOf(creator), creatorQuote, "the creator was paid in the equity");
        assertEq(equity.balanceOf(treasury), treasuryQuote, "and so was the treasury");
        assertEq(equity.balanceOf(created.splitter), 0, "and nothing is left over");
    }

    /// @dev A splitter for an equity-quoted market pays out exactly two assets and
    /// neither of them is ether, so ether accepted here would be owed to nobody and
    /// reachable by no one.
    function test_aStockPairedSplitterRefusesEther() public {
        MockERC20 equity = _admittedEquity();
        VerdantFactory.Created memory created = _launchAgainst(equity);

        vm.deal(address(this), 1 ether);
        (bool ok, bytes memory reason) = created.splitter.call{value: 1 ether}("");

        assertFalse(ok, "the ether was refused");
        assertEq(reason, abi.encodeWithSelector(FeeSplitter.NativeNotAccepted.selector), "and said why");
        assertEq(created.splitter.balance, 0, "nothing was kept");
    }

    /// @dev Ether is admitted unconditionally and everything else has to have been
    /// reviewed, which is what makes "the quote side of a Verdant market was
    /// admitted" a claim a contract enforces rather than an interface.
    function test_aQuoteAssetTheRegistryHasNotAdmittedIsRefused() public {
        MockERC20 equity = new MockERC20("Mock NVDA Robinhood Token", "mNVDA", 18);

        VerdantFactory.CreateParams memory params = _stockParams(address(equity), bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(VerdantFactory.QuoteAssetNotAdmitted.selector, address(equity)));
        vm.prank(creator);
        factory.create(params);
    }

    /// @dev v4 orders a pair by address, so a token that sorts below its quote asset
    /// would be `currency0` and the market would be inverted. The creator's remedy
    /// is another salt; this constructs the failure deliberately by searching for
    /// one that sorts the wrong way.
    function test_aTokenThatSortsBelowTheQuoteAssetIsRefused() public {
        MockERC20 equity = _admittedEquity();

        bytes32 salt = _saltSorting(address(equity), false);
        VerdantFactory.CreateParams memory params = _stockParams(address(equity), salt);

        address predicted = _predictToken(salt);
        assertLt(uint160(predicted), uint160(address(equity)), "the salt search found a token below the equity");

        vm.expectRevert(abi.encodeWithSelector(VerdantFactory.TokenNotAboveQuote.selector, predicted, address(equity)));
        vm.prank(creator);
        factory.create(params);
    }

    // --- stock-paired fixtures ------------------------------------------------

    /// @dev A stand-in for one of Robinhood Chain's equity tokens, admitted by the
    /// registry's owner the way a reviewed asset is admitted on a real chain.
    function _admittedEquity() internal returns (MockERC20 equity) {
        equity = new MockERC20("Mock NVDA Robinhood Token", "mNVDA", 18);

        vm.prank(registryOwner);
        modelRegistry.setQuoteAsset(address(equity), true);
    }

    function _stockParams(address equity, bytes32 salt)
        internal
        view
        returns (VerdantFactory.CreateParams memory params)
    {
        params = _params();
        params.name = STOCK_NAME;
        params.symbol = STOCK_SYMBOL;
        params.quoteAsset = equity;
        params.salt = salt;
    }

    function _launchAgainst(MockERC20 equity) internal returns (VerdantFactory.Created memory created) {
        return _launchWith(_stockParams(address(equity), _saltSorting(address(equity), true)));
    }

    /// @dev The address the launch token would be created at under `salt`, computed
    /// the way a creator computes it: one init code hash from the deployer, and
    /// CREATE2 arithmetic from there.
    function _predictToken(bytes32 salt) internal view returns (address) {
        bytes32 initCodeHash = deployer.tokenInitCodeHash(
            STOCK_NAME, STOCK_SYMBOL, SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE, creator, METADATA_URI, false
        );
        return vm.computeCreate2Address(factory.saltFor(creator, salt), initCodeHash, address(deployer));
    }

    /// @dev A salt whose token sorts above `equity`, or below it. Roughly half of
    /// all salts do either, so both searches finish in a handful of tries; the bound
    /// is here so a broken prediction fails loudly rather than spinning.
    function _saltSorting(address equity, bool above) internal view returns (bytes32) {
        for (uint256 i = 0; i < 256; i++) {
            bytes32 candidate = bytes32(i);
            if ((uint160(_predictToken(candidate)) > uint160(equity)) == above) return candidate;
        }

        revert("no candidate salt sorted the launch token that way");
    }

    /// @dev A buy paid in the equity. The router settles a token side by pulling it
    /// from the caller, so it is approved rather than sent — which is the whole of
    /// what a trader does differently on a stock-paired market.
    function _buyWithEquity(MockERC20 equity, VerdantFactory.Created memory created, uint256 amountIn) internal {
        equity.mint(trader, amountIn);

        vm.startPrank(trader);
        equity.approve(address(swapRouter), amountIn);
        swapRouter.swap(
            factory.poolKeyFor(address(equity), created.token),
            SwapParams({
                zeroForOne: true,
                // forge-lint: disable-next-line(unsafe-typecast) -- test amounts, far below int256
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    // --- 6. the first buy happens inside the launch --------------------------

    /// @dev Why this is a contract change and not an interface one. A pool opened with
    /// one-sided liquidity and left alone until the next transaction sits at the best
    /// price it will ever offer, in public, for anybody watching to take. The creator's
    /// own launch is the easiest thing on the chain to front-run, and they are the one
    /// funding it. This test asserts there is no such interval: one transaction, and
    /// the market is already two-sided at a price that has already moved.
    function test_anEtherQuotedLaunchDeliversTheCreatorsFirstBuyInTheSameTransaction() public {
        VerdantFactory.CreateParams memory params = _params();
        params.initialBuyAmount = 1 ether;

        uint256 spent = params.initialBuyAmount;
        VerdantFactory.Created memory created = _launchBuying(params);

        // The creator holds the tokens the buy delivered, on top of the allocation the
        // launch withheld for them, and the launch reports how many those were.
        assertGt(created.initialBuyTokens, 0, "the launch bought something");

        uint256 allocation = (SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE * 500) / 10_000;
        uint256 held = IERC20(created.token).balanceOf(creator);
        assertGe(held, allocation + created.initialBuyTokens, "the allocation and the buy, at least");
        assertLt(held - allocation - created.initialBuyTokens, 1e12, "and dust rather than a third thing");

        // The pool is two-sided before `create` returns.
        assertEq(address(manager).balance, spent, "the ether the creator spent is in the pool");

        // And it is no longer at the tick it opened at, which is the price a bot
        // reading the launch transaction would have been taking.
        (, int24 tick,,) = manager.getSlot0(created.poolId);
        assertLt(tick, INITIAL_TICK, "the first buy moved the price down the range");

        // The buy is charged exactly like anybody else's trade: the schedule's first
        // stage, accruing to the locked position and out to the splitter from there.
        // The creator pays the launch fee on their own first buy, which is intended.
        assertEq(hook.feeAt(created.poolId, block.timestamp), STAGE0_FEE, "stage zero's fee applied");
        PositionLocker(created.locker).collect();
        assertApproxEqRel(
            created.splitter.balance,
            spent * uint256(STAGE0_FEE) / 1_000_000,
            1e16,
            "1% of the creator's own first buy, as fees"
        );

        assertEq(address(factory).balance, 0, "and the factory ends the call holding nothing");
    }

    /// @dev The same property for a market quoted in an equity, where the creator pays
    /// by allowance rather than by value and the factory has to pull what it spends.
    function test_anEquityQuotedLaunchBuysWithAnAllowanceRatherThanWithValue() public {
        MockERC20 equity = _admittedEquity();
        uint128 spent = 10e18;

        equity.mint(creator, 100e18);
        uint256 heldBefore = equity.balanceOf(creator);

        VerdantFactory.Created memory created = _launchAgainstBuying(equity, spent);

        assertEq(equity.balanceOf(creator), heldBefore - spent, "the equity left the creator");
        assertEq(equity.balanceOf(address(manager)), spent, "and is in the pool");
        assertEq(equity.balanceOf(address(factory)), 0, "the factory kept none of it");

        assertGt(created.initialBuyTokens, 0, "the buy delivered tokens");
        assertEq(
            IERC20(created.token).balanceOf(creator),
            _allocationWithDust(created) + created.initialBuyTokens,
            "and they came back to the creator rather than staying in the pair"
        );
        assertEq(IERC20(created.token).balanceOf(address(factory)), 0, "nothing stopped here on the way");

        (, int24 tick,,) = manager.getSlot0(created.poolId);
        assertLt(tick, INITIAL_TICK, "the price moved off the opening tick");

        assertEq(hook.feeAt(created.poolId, block.timestamp), STAGE0_FEE, "charged at stage zero");
        PositionLocker(created.locker).collect();
        assertApproxEqRel(
            equity.balanceOf(created.splitter),
            uint256(spent) * uint256(STAGE0_FEE) / 1_000_000,
            1e16,
            "1% of the buy, in the equity"
        );
    }

    /// @dev A buy of zero is a real choice and not an omission, so it has to leave the
    /// market in exactly the state a launch left it in before the buy existed. Every
    /// other test in this file relies on that, because none of them names the field.
    function test_aLaunchThatBuysNothingOpensExactlyTheMarketItAlwaysDid() public {
        VerdantFactory.Created memory created = _launch();

        assertEq(created.initialBuyTokens, 0, "nothing was bought");

        (uint160 sqrtPriceX96, int24 tick,,) = manager.getSlot0(created.poolId);
        assertEq(sqrtPriceX96, TickMath.getSqrtPriceAtTick(INITIAL_TICK), "the pool is at its opening price");
        assertEq(tick, INITIAL_TICK, "and its opening tick");
        assertEq(address(manager).balance, 0, "no ether entered the pool");
        assertEq(address(factory).balance, 0, "and none is here");

        // The allocation and its dust, and not one token more: no swap happened, so
        // there was nothing to deliver.
        assertEq(
            IERC20(created.token).balanceOf(creator), _allocationWithDust(created), "the creator received no tokens"
        );
    }

    function test_anEtherQuotedLaunchRefusesAValueThatIsNotTheBuyItNamed() public {
        VerdantFactory.CreateParams memory params = _params();
        params.initialBuyAmount = 1 ether;

        // Too little, too much, and none at all. All three are the same mistake, and
        // accepting any of them would mean either buying with ether the creator did
        // not offer or keeping ether they did.
        _expectValueRefusal(params, 0.5 ether);
        _expectValueRefusal(params, 2 ether);
        _expectValueRefusal(params, 0);

        // And the other direction: a launch that buys nothing must send nothing, or
        // the ether has arrived somewhere with no path back out.
        params.initialBuyAmount = 0;
        _expectValueRefusal(params, 1 ether);
    }

    function test_anEquityQuotedLaunchRefusesEtherAltogether() public {
        MockERC20 equity = _admittedEquity();
        equity.mint(creator, 100e18);

        VerdantFactory.CreateParams memory params = _stockParams(address(equity), _saltSorting(address(equity), true));
        params.initialBuyAmount = 10e18;

        vm.startPrank(creator);
        equity.approve(address(factory), params.initialBuyAmount);

        // Nothing in this launch is denominated in ether — the buy settles in the
        // equity — so there is no amount of it the factory could spend or return.
        vm.expectRevert(
            abi.encodeWithSelector(VerdantFactory.NativeSentForTokenQuote.selector, address(equity), 1 ether)
        );
        factory.create{value: 1 ether}(params);

        params.initialBuyAmount = 0;
        vm.expectRevert(
            abi.encodeWithSelector(VerdantFactory.NativeSentForTokenQuote.selector, address(equity), 1 ether)
        );
        factory.create{value: 1 ether}(params);
        vm.stopPrank();
    }

    /// @dev A floor the pool cannot meet takes the whole launch down with it, rather
    /// than opening the market and skipping the buy. A creator who named a floor was
    /// describing the market they wanted to exist, and a market that opened without it
    /// is one they cannot undo.
    function test_aFirstBuyThatCannotMeetItsFloorRevertsTheEntireLaunch() public {
        VerdantFactory.CreateParams memory params = _params();
        params.initialBuyAmount = 1 ether;
        // More tokens than the market has, so no pool could ever deliver it.
        params.initialBuyMinTokens = type(uint128).max;

        address predicted = _predictDefaultToken(params.salt);

        vm.prank(creator);
        // Partial, because the amount the pool would have delivered is only knowable
        // by performing the swap this call reverts out of.
        vm.expectPartialRevert(VerdantFactory.InitialBuyBelowMinimum.selector);
        factory.create{value: params.initialBuyAmount}(params);

        // And the revert took everything with it. This is the property that makes a
        // slippage floor safe to offer at all: there is no half-launched market left
        // behind for the creator to discover or for anybody else to trade.
        assertEq(predicted.code.length, 0, "no token was deployed");
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(factory.poolKeyFor(address(0), predicted).toId());
        assertEq(sqrtPriceX96, 0, "no pool was opened");
        assertEq(marketRegistry.marketCount(), 0, "and nothing was recorded");
        assertEq(creator.balance, 10 ether, "the creator's ether never left");
    }

    /// @dev The launch position is finite: it holds a fixed amount of the token, so a
    /// buy larger than the whole position can be filled only in part. v4 consumes what
    /// it can and hands the rest back as an unsettled delta, which means the factory is
    /// holding it — and a factory that can end a transaction holding somebody's money
    /// is the failure this repository exists to avoid.
    ///
    /// Reaching the exhaustion needs a deliberately shallow market: the smallest supply
    /// Verdant allows, opened at the very top of the usable tick range, where the whole
    /// position is worth roughly its own token count in the quote asset.
    function test_aFirstBuyLargerThanTheLaunchPositionCanServeIsRefundedTheRemainder() public {
        VerdantFactory.CreateParams memory params = _params();
        params.supplyTokens = LaunchBounds.MIN_SUPPLY_TOKENS;
        params.initialTick = VerdantConstants.MAX_USABLE_TICK;
        params.initialBuyAmount = 2_000_000 ether;

        vm.deal(creator, 3_000_000 ether);
        uint256 before = creator.balance;

        VerdantFactory.Created memory created = _launchBuying(params);

        uint256 taken = address(manager).balance;
        assertGt(taken, 0, "the pool took what it could serve");
        assertLt(taken, params.initialBuyAmount, "which was less than the creator offered");

        assertEq(before - creator.balance, taken, "the creator paid exactly that; the remainder came back");
        assertEq(address(factory).balance, 0, "and the factory holds nothing at all");
        assertGt(created.initialBuyTokens, 0, "the creator still received the tokens the pool could sell");
    }

    /// @dev The callback is reachable only through the factory's own `unlock`, because
    /// the PoolManager calls back whoever called it. A direct call would be asking the
    /// factory to settle a swap that no lock is open for, so it is refused by name.
    function test_theUnlockCallbackRefusesEveryCallerButThePoolManager() public {
        // Well-formed calldata, so that what is being refused is the caller and not
        // the argument. Encoded before the expectation is armed, because building it
        // reads the factory and that read is a call of its own.
        bytes memory buy = abi.encode(
            VerdantFactory.InitialBuy({
                key: factory.poolKeyFor(address(0), makeAddr("some token")),
                creator: trader,
                amountIn: 1 ether,
                minTokens: 0
            })
        );

        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(VerdantFactory.NotPoolManager.selector, trader));
        factory.unlockCallback(buy);

        vm.expectRevert(abi.encodeWithSelector(VerdantFactory.NotPoolManager.selector, address(this)));
        factory.unlockCallback(buy);

        // Empty calldata too: the caller is checked before the data is looked at, so
        // there is no shape of input that reaches the swap from outside a lock.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(VerdantFactory.NotPoolManager.selector, creator));
        factory.unlockCallback("");
    }

    /// @dev An admitted quote asset is still somebody else's code, and the launch calls
    /// it — `transferFrom` to take the first buy, `transfer` to settle it — while the
    /// market is half-built. A second launch started from inside the first would mint a
    /// position against a PositionManager token id the outer one has already read and is
    /// about to assert on, so the guard refuses it before it can look at anything.
    function test_aQuoteAssetThatReentersTheLaunchIsRefused() public {
        ReentrantQuoteAsset quote = new ReentrantQuoteAsset(factory);

        vm.prank(registryOwner);
        modelRegistry.setQuoteAsset(address(quote), true);

        quote.mint(creator, 100e18);
        quote.arm(_stockParams(address(quote), bytes32(uint256(1))));

        VerdantFactory.CreateParams memory params = _stockParams(address(quote), _saltSorting(address(quote), true));
        params.initialBuyAmount = 10e18;

        vm.startPrank(creator);
        quote.approve(address(factory), params.initialBuyAmount);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        factory.create(params);
        vm.stopPrank();

        assertEq(marketRegistry.marketCount(), 0, "neither launch happened");
    }

    // --- first-buy fixtures ---------------------------------------------------

    /// @dev A launch that buys, paid in ether. The value equals the buy exactly,
    /// because that is the factory's own rule and the tests above assert it separately.
    function _launchBuying(VerdantFactory.CreateParams memory params)
        internal
        returns (VerdantFactory.Created memory created)
    {
        vm.prank(creator);
        created = factory.create{value: params.initialBuyAmount}(params);
    }

    /// @dev The same against an equity, which the factory pulls rather than is sent —
    /// so the creator's one extra step is an allowance to the factory itself.
    function _launchAgainstBuying(MockERC20 equity, uint128 amountIn)
        internal
        returns (VerdantFactory.Created memory created)
    {
        VerdantFactory.CreateParams memory params = _stockParams(address(equity), _saltSorting(address(equity), true));
        params.initialBuyAmount = amountIn;

        vm.startPrank(creator);
        equity.approve(address(factory), amountIn);
        created = factory.create(params);
        vm.stopPrank();
    }

    /// @dev What the creator holds from the launch alone: their allocation plus the
    /// dust left by converting an amount of token into whole units of liquidity.
    /// Derived from the position rather than assumed, so that a test can subtract it
    /// and be left with exactly what the buy delivered.
    function _allocationWithDust(VerdantFactory.Created memory created) internal view returns (uint256) {
        uint256 supply = IERC20(created.token).totalSupply();
        return supply - IERC20(created.token).balanceOf(address(manager)) - created.initialBuyTokens;
    }

    /// @dev The address `_params()`'s token would be created at, for the cases that
    /// have to assert a launch left nothing behind.
    function _predictDefaultToken(bytes32 salt) internal view returns (address) {
        bytes32 initCodeHash = deployer.tokenInitCodeHash(
            "Verdant Test", "VTEST", SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE, creator, METADATA_URI, false
        );
        return vm.computeCreate2Address(factory.saltFor(creator, salt), initCodeHash, address(deployer));
    }

    function _expectValueRefusal(VerdantFactory.CreateParams memory params, uint256 value) internal {
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(VerdantFactory.InitialBuyValueMismatch.selector, value, params.initialBuyAmount)
        );
        factory.create{value: value}(params);
    }

    // --- the guards on creation ---------------------------------------------

    function test_creationIsRefusedWhenTheRegistryPausesIt() public {
        vm.prank(registryOwner);
        modelRegistry.setCreationPaused(true);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(VerdantFactory.CreationNotAllowed.selector, 0, 1));
        factory.create(_params());
    }

    /// @dev The bug this test exists for. Model 2's fixture is enabled and demands a
    /// reserve share of at least 1 000; the factory always asks for zero, because
    /// nothing in v1 consumes a reserve (ADR-005). So the launch is refused — and
    /// before the parameter register disabled Evergreen, that combination was
    /// reachable from an interface, which reads `enabled` to decide what to offer.
    ///
    /// The register is the fix and `BoundsParity.t.sol` is the guard. This is the
    /// record of what the factory does when the two disagree anyway.
    function test_aModelThatDemandsAReserveShareCannotBeCreatedInV1() public {
        VerdantFactory.CreateParams memory params = _params();
        params.model = 2;
        params.stages = _progressiveStages();

        assertTrue(modelRegistry.boundsOf(2).enabled, "the fixture has it enabled, which is the point");
        assertGt(modelRegistry.boundsOf(2).minReserveBps, 0, "and demanding a reserve share");

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(VerdantFactory.CreationNotAllowed.selector, uint8(2), params.stages.length)
        );
        factory.create(params);
    }

    function test_creationIsRefusedWhenTheModelIsDisabled() public {
        vm.prank(registryOwner);
        modelRegistry.setModelEnabled(0, false);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(VerdantFactory.CreationNotAllowed.selector, 0, 1));
        factory.create(_params());
    }

    function test_creationIsRefusedWhenTheStageCountIsWrongForTheModel() public {
        VerdantFactory.CreateParams memory params = _params();
        params.stages = _progressiveStages(); // two stages, but model 0 allows one

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(VerdantFactory.CreationNotAllowed.selector, 0, 2));
        factory.create(params);
    }

    function test_everyTokenBoundIsEnforced() public {
        VerdantFactory.CreateParams memory params = _params();

        params.name = "";
        _expectRefusal(params, abi.encodeWithSelector(VerdantFactory.NameLengthOutOfBounds.selector, 0, 1, 32));

        params = _params();
        params.name = "a name that is far too long to fit in thirty-two bytes";
        _expectRefusal(params, abi.encodeWithSelector(VerdantFactory.NameLengthOutOfBounds.selector, 54, 1, 32));

        params = _params();
        params.symbol = "";
        _expectRefusal(params, abi.encodeWithSelector(VerdantFactory.SymbolLengthOutOfBounds.selector, 0, 1, 11));

        params = _params();
        params.symbol = "TWELVECHARSX";
        _expectRefusal(params, abi.encodeWithSelector(VerdantFactory.SymbolLengthOutOfBounds.selector, 12, 1, 11));

        params = _params();
        params.supplyTokens = LaunchBounds.MIN_SUPPLY_TOKENS - 1;
        _expectRefusal(
            params,
            abi.encodeWithSelector(
                VerdantFactory.SupplyOutOfBounds.selector,
                LaunchBounds.MIN_SUPPLY_TOKENS - 1,
                LaunchBounds.MIN_SUPPLY_TOKENS,
                LaunchBounds.MAX_SUPPLY_TOKENS
            )
        );

        params = _params();
        params.supplyTokens = LaunchBounds.MAX_SUPPLY_TOKENS + 1;
        _expectRefusal(
            params,
            abi.encodeWithSelector(
                VerdantFactory.SupplyOutOfBounds.selector,
                LaunchBounds.MAX_SUPPLY_TOKENS + 1,
                LaunchBounds.MIN_SUPPLY_TOKENS,
                LaunchBounds.MAX_SUPPLY_TOKENS
            )
        );

        params = _params();
        params.creatorAllocationBps = LaunchBounds.MAX_CREATOR_ALLOCATION_BPS + 1;
        _expectRefusal(
            params,
            abi.encodeWithSelector(
                VerdantFactory.CreatorAllocationTooLarge.selector,
                LaunchBounds.MAX_CREATOR_ALLOCATION_BPS + 1,
                LaunchBounds.MAX_CREATOR_ALLOCATION_BPS
            )
        );

        params = _params();
        params.feeRecipient = address(0);
        _expectRefusal(params, abi.encodeWithSelector(VerdantFactory.ZeroFeeRecipient.selector));
    }

    function test_theMetadataUriIsLengthBounded() public {
        VerdantFactory.CreateParams memory params = _params();
        params.metadataURI = new string(LaunchBounds.MAX_METADATA_URI_LENGTH + 1);

        _expectRefusal(
            params,
            abi.encodeWithSelector(
                VerdantFactory.MetadataURITooLong.selector,
                LaunchBounds.MAX_METADATA_URI_LENGTH + 1,
                LaunchBounds.MAX_METADATA_URI_LENGTH
            )
        );
    }

    function test_theOpeningTickMustBeOnTheGridAndInRange() public {
        VerdantFactory.CreateParams memory params = _params();

        params.initialTick = INITIAL_TICK + 1;
        _expectRefusal(params, abi.encodeWithSelector(VerdantFactory.InitialTickInvalid.selector, INITIAL_TICK + 1));

        params.initialTick = VerdantConstants.MAX_USABLE_TICK + VerdantConstants.TICK_SPACING;
        _expectRefusal(
            params,
            abi.encodeWithSelector(
                VerdantFactory.InitialTickInvalid.selector,
                VerdantConstants.MAX_USABLE_TICK + VerdantConstants.TICK_SPACING
            )
        );

        // The bottom of the range is excluded: a position from the bottom tick to
        // the bottom tick has no width.
        params.initialTick = VerdantConstants.MIN_USABLE_TICK;
        _expectRefusal(
            params, abi.encodeWithSelector(VerdantFactory.InitialTickInvalid.selector, VerdantConstants.MIN_USABLE_TICK)
        );
    }

    function test_theVestingScheduleMustBeRealOrAbsent() public {
        VerdantFactory.CreateParams memory params = _params();

        params.vestingDuration = 1 days;
        _expectRefusal(
            params,
            abi.encodeWithSelector(
                VerdantFactory.VestingDurationOutOfBounds.selector,
                uint64(1 days),
                LaunchBounds.MIN_VESTING_DURATION,
                LaunchBounds.MAX_VESTING_DURATION
            )
        );

        params.vestingDuration = LaunchBounds.MAX_VESTING_DURATION + 1;
        _expectRefusal(
            params,
            abi.encodeWithSelector(
                VerdantFactory.VestingDurationOutOfBounds.selector,
                LaunchBounds.MAX_VESTING_DURATION + 1,
                LaunchBounds.MIN_VESTING_DURATION,
                LaunchBounds.MAX_VESTING_DURATION
            )
        );

        // A schedule with nothing to release is refused rather than deployed.
        params.vestingDuration = 90 days;
        params.creatorAllocationBps = 0;
        _expectRefusal(params, abi.encodeWithSelector(VerdantFactory.VestingWithoutAllocation.selector));
    }

    function test_aScheduleThatScheduleLibRefusesIsRefusedHere() public {
        VerdantFactory.CreateParams memory params = _params();
        params.stages[0] = ScheduleLib.Stage({startOffset: 1, feePpm: STAGE0_FEE});

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ScheduleLib.FirstOffsetNonZero.selector, uint32(1)));
        factory.create(params);
    }

    function _expectRefusal(VerdantFactory.CreateParams memory params, bytes memory expected) internal {
        vm.prank(creator);
        vm.expectRevert(expected);
        factory.create(params);
    }

    // --- the wiring the deployment rests on ----------------------------------

    function test_theFactoryRefusesToDeployAgainstAHookThatDoesNotKnowIt() public {
        // A hook mined for a different factory. Deploying a factory that names it
        // must fail, because the pair could never create a market: the hook would
        // reject every call.
        address otherFactory = makeAddr("another factory");
        address otherHookAddress = address(uint160(0xBEEF0000 | 0x3880));
        deployCodeTo("VerdantHook.sol:VerdantHook", abi.encode(manager, otherFactory, posm), otherHookAddress);

        vm.expectRevert(
            abi.encodeWithSelector(VerdantFactory.HookNotBoundToThisFactory.selector, otherHookAddress, otherFactory)
        );
        new VerdantFactory(
            manager, posm, VerdantHook(otherHookAddress), deployer, modelRegistry, marketRegistry, treasury
        );
    }

    function test_theFactoryRefusesEveryZeroDependency() public {
        vm.expectRevert(VerdantFactory.ZeroPoolManager.selector);
        new VerdantFactory(IPoolManager(address(0)), posm, hook, deployer, modelRegistry, marketRegistry, treasury);

        vm.expectRevert(VerdantFactory.ZeroPositionManager.selector);
        new VerdantFactory(
            manager, IPositionManager(address(0)), hook, deployer, modelRegistry, marketRegistry, treasury
        );

        vm.expectRevert(VerdantFactory.ZeroModelRegistry.selector);
        new VerdantFactory(manager, posm, hook, deployer, ModelRegistry(address(0)), marketRegistry, treasury);

        vm.expectRevert(VerdantFactory.ZeroMarketRegistry.selector);
        new VerdantFactory(manager, posm, hook, deployer, modelRegistry, MarketRegistry(address(0)), treasury);

        vm.expectRevert(VerdantFactory.ZeroTreasury.selector);
        new VerdantFactory(manager, posm, hook, deployer, modelRegistry, marketRegistry, address(0));
    }

    /// @dev A hook that knows this factory but was mined against a different
    /// PoolManager or PositionManager would produce markets whose pools it cannot
    /// serve or whose liquidity nobody can mint. Both are refused at deployment.
    function test_theFactoryRefusesAHookThatWasMinedForDifferentPeriphery() public {
        // `deployCodeTo` creates nothing from this account, so the factory below is
        // the next contract this test creates and the offset is zero.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address otherManager = makeAddr("another pool manager");
        address wrongManagerHook = address(uint160(0xAAAA0000 | 0x3880));
        deployCodeTo("VerdantHook.sol:VerdantHook", abi.encode(otherManager, predicted, posm), wrongManagerHook);

        vm.expectRevert(
            abi.encodeWithSelector(VerdantFactory.PoolManagerMismatch.selector, otherManager, address(manager))
        );
        new VerdantFactory(
            manager, posm, VerdantHook(wrongManagerHook), deployer, modelRegistry, marketRegistry, treasury
        );

        predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address otherPosm = makeAddr("another position manager");
        address wrongPosmHook = address(uint160(0xBBBB0000 | 0x3880));
        deployCodeTo("VerdantHook.sol:VerdantHook", abi.encode(manager, predicted, otherPosm), wrongPosmHook);

        vm.expectRevert(
            abi.encodeWithSelector(VerdantFactory.PositionManagerMismatch.selector, otherPosm, address(posm))
        );
        new VerdantFactory(manager, posm, VerdantHook(wrongPosmHook), deployer, modelRegistry, marketRegistry, treasury);
    }

    /// @dev The assertion the permanence claim rests on, exercised by making it
    /// false. Nothing in the code below can produce this — the position is minted
    /// straight to the locker — so the PositionManager is made to report a different
    /// owner, which is the only way the check could ever fire.
    function test_creationRevertsIfThePositionDoesNotEndUpWithTheLocker() public {
        address thief = makeAddr("thief");
        vm.mockCall(address(posm), abi.encodeWithSelector(IERC721.ownerOf.selector, uint256(1)), abi.encode(thief));

        vm.prank(creator);
        vm.expectRevert();
        factory.create(_params());

        vm.clearMockedCalls();
    }

    function test_theFactoryRefusesADeployerThatAnswersToSomeoneElse() public {
        // The hook check runs first, so this needs a hook that names the factory
        // *about to be deployed* — otherwise the constructor fails on the hook and
        // never reaches the deployer. One `new` happens between the prediction and
        // the factory's own, so the offset is one.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        VerdantDeployer otherDeployer = new VerdantDeployer(makeAddr("another factory"));

        address stubHook = address(uint160(0xDEAD0000 | 0x3880));
        deployCodeTo("VerdantHook.sol:VerdantHook", abi.encode(manager, predicted, posm), stubHook);

        vm.expectRevert(
            abi.encodeWithSelector(
                VerdantFactory.DeployerNotBoundToThisFactory.selector, address(otherDeployer), otherDeployer.factory()
            )
        );
        new VerdantFactory(manager, posm, VerdantHook(stubHook), otherDeployer, modelRegistry, marketRegistry, treasury);
    }

    function test_theFactoryRefusesARegistryItCannotWriteTo() public {
        // Two `new` calls happen before the factory's own here, so the offset is two.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        MarketRegistry otherRegistry = new MarketRegistry(makeAddr("another factory"));

        address stubHook = address(uint160(0xFEED0000 | 0x3880));
        deployCodeTo("VerdantHook.sol:VerdantHook", abi.encode(manager, predicted, posm), stubHook);

        VerdantDeployer boundDeployer = new VerdantDeployer(predicted);

        vm.expectRevert(
            abi.encodeWithSelector(
                VerdantFactory.RegistryNotWritableByThisFactory.selector, address(otherRegistry), otherRegistry.writer()
            )
        );
        new VerdantFactory(manager, posm, VerdantHook(stubHook), boundDeployer, modelRegistry, otherRegistry, treasury);
    }

    function test_onlyTheFactoryCanDeployAMarketsContracts() public {
        vm.expectRevert(abi.encodeWithSelector(VerdantDeployer.NotFactory.selector, address(this)));
        deployer.deploySplitter(bytes32(0), creator, treasury, address(0), makeAddr("token"), PROTOCOL_BPS);

        vm.expectRevert(abi.encodeWithSelector(VerdantDeployer.NotFactory.selector, address(this)));
        deployer.deployToken(bytes32(0), "n", "S", 1e18, creator, "", false);

        vm.expectRevert(abi.encodeWithSelector(VerdantDeployer.NotFactory.selector, address(this)));
        deployer.deployLocker(
            bytes32(0), posm, 1, makeAddr("splitter"), Currency.wrap(address(0)), Currency.wrap(makeAddr("token"))
        );

        vm.expectRevert(abi.encodeWithSelector(VerdantDeployer.NotFactory.selector, address(this)));
        deployer.deployVesting(bytes32(0), makeAddr("token"), creator, 1e18, uint64(block.timestamp), 0, 90 days);
    }

    /// @dev The factory has no owner, so there is no function on it that treats one
    /// caller differently from another. Asserted here as the absence of the
    /// signatures such a function would have.
    function test_theFactoryHasNoAdministrativeSurface() public view {
        assertEq(factory.treasury(), treasury, "the treasury is fixed at construction");
        assertEq(address(factory.hook()), address(hook), "and so is the hook");
        assertEq(address(factory.deployer()), address(deployer), "and the deployer");
        assertEq(address(factory.modelRegistry()), address(modelRegistry), "and the model registry");
        assertEq(address(factory.marketRegistry()), address(marketRegistry), "and the market registry");
    }
}

/// @title A quote asset that attacks the launch paying it
///
/// @notice The one thing an admitted quote asset can still do that ether cannot: run
/// its own code while the factory is in the middle of building a market.
///
/// @dev Admission (ADR-008) is a statement about a token's transfer *arithmetic* — that
/// it moves what it says it moves — and not a promise that its `transfer` does nothing
/// else. The factory calls this token twice inside one launch, to take the creator's
/// first buy and again to settle it, and at both of those moments the market is half
/// built: the token exists, the pool exists, the position id has been read but not yet
/// asserted on. A launch started from in there is what `nonReentrant` refuses.
///
/// It reenters once and then stops, so that a guard which did not fire would produce a
/// failed assertion rather than an out-of-gas.
contract ReentrantQuoteAsset is MockERC20 {
    using Address for address;

    VerdantFactory public immutable factory;

    /// @dev The launch this token will try to start from inside somebody else's, as
    /// calldata. Held encoded because `CreateParams` carries an array of structs and
    /// Solidity cannot copy one of those into storage.
    bytes private nested;

    constructor(VerdantFactory factory_) MockERC20("Reentrant Quote", "REENT", 18) {
        factory = factory_;
    }

    function arm(VerdantFactory.CreateParams memory params) external {
        nested = abi.encodeCall(VerdantFactory.create, (params));
    }

    /// @dev The attack. Called by the factory to take the creator's first buy, which is
    /// the earliest point at which this token gets control inside a launch.
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (nested.length != 0) {
            bytes memory attempt = nested;
            nested = "";
            // `functionCall` rather than a bare `call`, because it bubbles the revert
            // it was given — so the guard's own reason reaches the test instead of
            // being restated as a failed transfer.
            address(factory).functionCall(attempt);
        }
        return super.transferFrom(from, to, amount);
    }
}
